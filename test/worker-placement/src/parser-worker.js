const GLOBAL_KEYS = ["NodeSQLParser", "global"];
const MAX_STATEMENT_LENGTH = 16 * 1024;
const PARSER_OPTIONS = Object.freeze({
  parseOptions: Object.freeze({
    includeLocations: true,
  }),
  trimQuery: false,
});

function readOwnDataProperty(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) {
    return { kind: "missing" };
  }
  if (!("value" in descriptor)) {
    return { kind: "invalid" };
  }
  return { kind: "value", value: descriptor.value };
}

function moduleCandidates(moduleValue) {
  if (
    (typeof moduleValue !== "object" || moduleValue === null) &&
    typeof moduleValue !== "function"
  ) {
    return [moduleValue];
  }
  const candidates = [moduleValue];
  for (const key of ["default", "module.exports"]) {
    const property = readOwnDataProperty(moduleValue, key);
    if (property.kind === "value") {
      candidates.push(property.value);
    }
  }
  return candidates;
}

function findParserConstructor(moduleValue) {
  for (const candidate of moduleCandidates(moduleValue)) {
    if (typeof candidate === "function") {
      return candidate;
    }
    if (typeof candidate !== "object" || candidate === null) {
      continue;
    }
    const parser = readOwnDataProperty(candidate, "Parser");
    if (parser.kind === "value" && typeof parser.value === "function") {
      return parser.value;
    }
  }
  throw new Error("The dialect bundle did not expose a Parser constructor");
}

function snapshotGlobals(target) {
  return GLOBAL_KEYS.map((key) => ({
    descriptor: Object.getOwnPropertyDescriptor(target, key),
    key,
  }));
}

function descriptorsEqual(left, right) {
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
  return (
    left.get === right.get &&
    left.set === right.set
  );
}

function restoreGlobals(target, snapshots) {
  for (const { descriptor, key } of snapshots) {
    if (descriptor === undefined) {
      if (!Reflect.deleteProperty(target, key)) {
        throw new Error(`Could not remove worker global ${key}`);
      }
    } else {
      Object.defineProperty(target, key, descriptor);
    }
  }
  return Object.fromEntries(
    snapshots.map(({ descriptor, key }) => [
      key,
      descriptorsEqual(
        descriptor,
        Object.getOwnPropertyDescriptor(target, key),
      ),
    ]),
  );
}

function createGuardedModuleLoader(target) {
  let poisoned = false;
  return async (loadModule) => {
    if (poisoned) {
      throw new Error("The guarded module loader is poisoned");
    }
    const snapshots = snapshotGlobals(target);
    let moduleValue;
    let loadError;
    try {
      moduleValue = await loadModule();
    } catch (error) {
      loadError = error;
    }
    let descriptorEquality;
    try {
      descriptorEquality = restoreGlobals(target, snapshots);
    } catch (error) {
      poisoned = true;
      throw error;
    }
    if (loadError !== undefined) {
      throw loadError;
    }
    return { descriptorEquality, moduleValue };
  };
}

function assertDedicatedWorkerRealm() {
  if (
    globalThis.self !== globalThis ||
    "window" in globalThis ||
    "document" in globalThis
  ) {
    throw new Error("Parser fixture did not start in a dedicated worker");
  }
}

function resourceEntries() {
  return performance.getEntriesByType("resource").map((entry) => ({
    decodedBodySize: entry.decodedBodySize,
    encodedBodySize: entry.encodedBodySize,
    initiatorType: entry.initiatorType,
    name: entry.name,
    transferSize: entry.transferSize,
  }));
}

async function syntheticCleanupEvidence() {
  const successfulTarget = {};
  const originalNodeSqlParser = Object.freeze({
    owner: "original-node-sql-parser",
  });
  const originalGlobal = () => "original-global";
  Object.defineProperties(successfulTarget, {
    NodeSQLParser: {
      configurable: true,
      enumerable: true,
      value: originalNodeSqlParser,
      writable: false,
    },
    global: {
      configurable: true,
      enumerable: false,
      get: originalGlobal,
    },
  });
  const successfulLoad = createGuardedModuleLoader(successfulTarget);
  let successfulEvaluations = 0;
  const successful = await successfulLoad(async () => {
    successfulEvaluations += 1;
    Object.defineProperties(successfulTarget, {
      NodeSQLParser: {
        configurable: true,
        enumerable: false,
        value: "temporary-node-sql-parser",
        writable: true,
      },
      global: {
        configurable: true,
        enumerable: true,
        value: "temporary-global",
        writable: true,
      },
    });
    return "first-load";
  });
  const reusable = await successfulLoad(async () => {
    successfulEvaluations += 1;
    return "second-load";
  });

  const target = {};
  const load = createGuardedModuleLoader(target);
  let poisonedEvaluations = 0;
  let cleanupFailed = false;
  try {
    await load(async () => {
      poisonedEvaluations += 1;
      Object.defineProperty(target, "NodeSQLParser", {
        configurable: false,
        value: "synthetic-pollution",
      });
      return {};
    });
  } catch {
    cleanupFailed = true;
  }
  let poisonedRetryFailed = false;
  try {
    await load(async () => {
      poisonedEvaluations += 1;
      return {};
    });
  } catch {
    poisonedRetryFailed = true;
  }
  return {
    cleanupFailed,
    poisonedEvaluations,
    poisonedRetryFailed,
    successfulDescriptorEquality: successful.descriptorEquality,
    successfulEvaluations,
    successfulModuleValues:
      successful.moduleValue === "first-load" &&
      reusable.moduleValue === "second-load",
  };
}

export function installParserWorker(moduleLoaders) {
  assertDedicatedWorkerRealm();
  const guardedLoad = createGuardedModuleLoader(globalThis);
  const parsers = new Map();

  async function getParser(grammar) {
    const cached = parsers.get(grammar);
    if (cached !== undefined) {
      return {
        cached: true,
        grammarLoadAndInitMs: 0,
        ...cached,
      };
    }
    const startedAt = performance.now();
    const loadModule = moduleLoaders[grammar];
    const { descriptorEquality, moduleValue } =
      await guardedLoad(loadModule);
    const Parser = findParserConstructor(moduleValue);
    const parser = Reflect.construct(Parser, []);
    if (
      typeof parser !== "object" ||
      parser === null ||
      typeof parser.astify !== "function"
    ) {
      throw new Error("The dialect Parser did not expose astify");
    }
    const initialized = {
      descriptorEquality,
      parser,
    };
    parsers.set(grammar, initialized);
    return {
      cached: false,
      grammarLoadAndInitMs: performance.now() - startedAt,
      ...initialized,
    };
  }

  globalThis.addEventListener("message", async (event) => {
    const request = event.data;
    if (
      typeof request !== "object" ||
      request === null ||
      !Number.isSafeInteger(request.id) ||
      request.id < 0
    ) {
      globalThis.postMessage({
        error: "invalid-request",
        id: -1,
        kind: "result",
        resources: resourceEntries(),
        status: "failed",
      });
      return;
    }
    if (request.kind === "test-cleanup") {
      globalThis.postMessage({
        evidence: await syntheticCleanupEvidence(),
        id: request.id,
        kind: "cleanup-result",
        resources: resourceEntries(),
      });
      return;
    }
    if (
      request.kind !== "parse" ||
      (request.grammar !== "postgresql" &&
        request.grammar !== "bigquery") ||
      typeof request.text !== "string" ||
      request.text.length > MAX_STATEMENT_LENGTH
    ) {
      globalThis.postMessage({
        error: "invalid-request",
        id: request.id,
        kind: "result",
        resources: resourceEntries(),
        status: "failed",
      });
      return;
    }

    try {
      const loaded = await getParser(request.grammar);
      const astifyStartedAt = performance.now();
      const output = loaded.parser.astify(
        request.text,
        PARSER_OPTIONS,
      );
      const astifyMs = performance.now() - astifyStartedAt;
      const root = Array.isArray(output) ? output[0] : output;
      if (
        typeof root !== "object" ||
        root === null ||
        typeof root.type !== "string"
      ) {
        throw new Error("The dialect parser returned no typed AST root");
      }
      globalThis.postMessage({
        astType: root.type,
        astifyMs,
        descriptorEquality: loaded.descriptorEquality,
        grammar: request.grammar,
        grammarLoadAndInitMs: loaded.grammarLoadAndInitMs,
        id: request.id,
        kind: "result",
        moduleCached: loaded.cached,
        resources: resourceEntries(),
        status: "parsed",
      });
    } catch {
      globalThis.postMessage({
        error: "parse-failed",
        id: request.id,
        kind: "result",
        resources: resourceEntries(),
        status: "failed",
      });
    }
  });

  globalThis.postMessage({
    kind: "ready",
    resources: resourceEntries(),
  });
}
