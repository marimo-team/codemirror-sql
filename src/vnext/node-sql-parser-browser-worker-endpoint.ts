import {
  createNodeSqlParserBackend,
  type NodeSqlParserBackendOutcome,
  type NodeSqlParserModuleLoadOutcome,
} from "./node-sql-parser-backend.js";
import {
  decodeNodeSqlParserWireRequest,
  encodeNodeSqlParserWireBackendOutcome,
  encodeNodeSqlParserWireProtocolError,
  encodeNodeSqlParserWireReady,
  type NodeSqlParserWireGrammar,
  type NodeSqlParserWireRequest,
} from "./node-sql-parser-wire.js";

const GUARDED_GLOBAL_KEYS = [
  "NodeSQLParser",
  "global",
] as const;

interface BrowserWorkerMessageEvent {
  readonly data: unknown;
}

type BrowserWorkerMessageListener = (
  event: BrowserWorkerMessageEvent,
) => void;

export interface NodeSqlParserBrowserWorkerScope {
  readonly self: unknown;
  readonly addEventListener: (
    type: "message",
    listener: BrowserWorkerMessageListener,
  ) => void;
  readonly removeEventListener?: (
    type: "message",
    listener: BrowserWorkerMessageListener,
  ) => void;
  readonly postMessage: (message: unknown) => void;
  readonly close: () => void;
}

export type NodeSqlParserBrowserWorkerModuleLoaders = Readonly<
  Record<NodeSqlParserWireGrammar, () => Promise<unknown>>
>;

interface GlobalDescriptorSnapshot {
  readonly descriptor: PropertyDescriptor | undefined;
  readonly key: (typeof GUARDED_GLOBAL_KEYS)[number];
}

interface GuardedBackendRunner {
  readonly isPoisoned: () => boolean;
  readonly parse: (
    operation: () => Promise<NodeSqlParserBackendOutcome>,
  ) => Promise<NodeSqlParserBackendOutcome>;
}

type EndpointState = "active" | "closed" | "idle";

function failedModuleLoad(
  code: "backend" | "module-load",
  retryable: boolean,
): NodeSqlParserModuleLoadOutcome {
  return Object.freeze({
    code,
    kind: "failed",
    retryable,
  });
}

function descriptorsEqual(
  left: PropertyDescriptor | undefined,
  right: PropertyDescriptor | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  if (
    left.configurable !== right.configurable ||
    left.enumerable !== right.enumerable
  ) {
    return false;
  }
  if ("value" in left || "value" in right) {
    return (
      "value" in left &&
      "value" in right &&
      left.writable === right.writable &&
      Object.is(left.value, right.value)
    );
  }
  return left.get === right.get && left.set === right.set;
}

function snapshotGuardedGlobals(
  target: object,
): readonly GlobalDescriptorSnapshot[] | null {
  const snapshots: GlobalDescriptorSnapshot[] = [];
  try {
    for (const key of GUARDED_GLOBAL_KEYS) {
      snapshots.push({
        descriptor: Object.getOwnPropertyDescriptor(target, key),
        key,
      });
    }
  } catch {
    return null;
  }
  return snapshots;
}

function restoreGuardedGlobals(
  target: object,
  snapshots: readonly GlobalDescriptorSnapshot[],
): boolean {
  let restored = true;
  for (const { descriptor, key } of snapshots) {
    try {
      if (descriptor === undefined) {
        if (!Reflect.deleteProperty(target, key)) {
          restored = false;
        }
      } else {
        Object.defineProperty(target, key, descriptor);
      }
    } catch {
      restored = false;
    }

    try {
      if (
        !descriptorsEqual(
          descriptor,
          Object.getOwnPropertyDescriptor(target, key),
        )
      ) {
        restored = false;
      }
    } catch {
      restored = false;
    }
  }
  return restored;
}

function failedBackend(): NodeSqlParserBackendOutcome {
  return Object.freeze({
    code: "backend",
    kind: "failed",
    retryable: false,
  });
}

function createModuleLoader(
  loadModule: () => Promise<unknown>,
): () => Promise<NodeSqlParserModuleLoadOutcome> {
  return async () => {
    try {
      return Object.freeze({
        kind: "loaded" as const,
        moduleValue: await loadModule(),
      });
    } catch {
      return failedModuleLoad("module-load", true);
    }
  };
}

function createGuardedBackendRunner(
  target: object,
): GuardedBackendRunner {
  let poisoned = false;

  return Object.freeze({
    isPoisoned: () => poisoned,
    async parse(
      operation: () => Promise<NodeSqlParserBackendOutcome>,
    ): Promise<NodeSqlParserBackendOutcome> {
      if (poisoned) {
        return failedBackend();
      }
      const snapshots = snapshotGuardedGlobals(target);
      if (snapshots === null) {
        poisoned = true;
        return failedBackend();
      }

      let completed = false;
      let outcome: NodeSqlParserBackendOutcome = failedBackend();
      try {
        outcome = await operation();
        completed = true;
      } catch {
        // The wire outcome deliberately carries no raw backend error.
      }

      const restored = restoreGuardedGlobals(target, snapshots);
      if (!restored) {
        poisoned = true;
        return failedBackend();
      }
      return completed ? outcome : failedBackend();
    },
  });
}

function isDedicatedWorkerRealm(
  scope: NodeSqlParserBrowserWorkerScope,
): boolean {
  try {
    return (
      scope.self === scope &&
      !("window" in scope) &&
      !("document" in scope)
    );
  } catch {
    return false;
  }
}

function shouldCloseAfterOutcome(
  outcome: NodeSqlParserBackendOutcome,
  guard: GuardedBackendRunner,
): boolean {
  return (
    guard.isPoisoned() ||
    (outcome.kind === "failed" && outcome.code === "module-load")
  );
}

export function installNodeSqlParserBrowserWorkerEndpoint(
  scope: NodeSqlParserBrowserWorkerScope,
  loaders: NodeSqlParserBrowserWorkerModuleLoaders,
): void {
  if (!isDedicatedWorkerRealm(scope)) {
    throw new Error(
      "node-sql-parser endpoint requires a dedicated worker realm",
    );
  }

  let state: EndpointState = "idle";
  let listenerInstalled = false;

  const guard = createGuardedBackendRunner(scope);
  const backends = Object.freeze({
    bigquery: createNodeSqlParserBackend(
      createModuleLoader(loaders.bigquery),
    ),
    postgresql: createNodeSqlParserBackend(
      createModuleLoader(loaders.postgresql),
    ),
  } satisfies Record<NodeSqlParserWireGrammar, unknown>);

  function closeEndpoint(): void {
    state = "closed";
    if (listenerInstalled) {
      try {
        scope.removeEventListener?.("message", onMessage);
      } catch {
        // Closing the worker is still attempted if listener cleanup fails.
      }
    }
    try {
      scope.close();
    } catch {
      // Worker settlement must not surface host or test-double errors.
    }
  }

  function postProtocolErrorAndClose(): void {
    state = "closed";
    try {
      scope.postMessage(encodeNodeSqlParserWireProtocolError());
    } catch {
      // The endpoint closes below even when encoding or posting fails.
    }
    closeEndpoint();
  }

  async function handleRequest(
    request: NodeSqlParserWireRequest,
  ): Promise<void> {
    try {
      const outcome = await guard.parse(() =>
        backends[request.grammar].parse(request.text),
      );
      if (state !== "active") {
        return;
      }

      const closeAfterSettlement = shouldCloseAfterOutcome(
        outcome,
        guard,
      );
      state = closeAfterSettlement ? "closed" : "idle";
      try {
        scope.postMessage(
          encodeNodeSqlParserWireBackendOutcome(
            request.requestId,
            outcome,
          ),
        );
      } catch {
        closeEndpoint();
        return;
      }
      if (closeAfterSettlement) {
        closeEndpoint();
      }
    } catch {
      closeEndpoint();
    }
  }

  function onMessage(event: BrowserWorkerMessageEvent): void {
    if (state === "closed") {
      return;
    }

    const request = decodeNodeSqlParserWireRequest(event.data);
    if (request === null || state === "active") {
      postProtocolErrorAndClose();
      return;
    }

    state = "active";
    void handleRequest(request);
  }

  try {
    scope.addEventListener("message", onMessage);
    listenerInstalled = true;
  } catch {
    closeEndpoint();
    return;
  }

  try {
    scope.postMessage(encodeNodeSqlParserWireReady());
  } catch {
    closeEndpoint();
  }
}
