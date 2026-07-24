// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  installNodeSqlParserBrowserWorkerEndpoint,
  type NodeSqlParserBrowserWorkerModuleLoaders,
  type NodeSqlParserBrowserWorkerScope,
} from "../node-sql-parser-browser-worker-endpoint.js";
import {
  encodeNodeSqlParserWireRequest,
  type NodeSqlParserWireGrammar,
} from "../node-sql-parser-wire.js";

type MessageListener = (event: { readonly data: unknown }) => void;

interface TestWorkerScope
  extends NodeSqlParserBrowserWorkerScope {
  readonly messages: unknown[];
  readonly closeCalls: () => number;
  readonly listenerCount: () => number;
  readonly removeCalls: () => number;
  readonly dispatch: (data: unknown) => void;
  readonly setPostHook: (
    hook: ((message: unknown) => void) | undefined,
  ) => void;
}

interface TestWorkerScopeOptions {
  readonly add?: () => void;
  readonly close?: () => void;
  readonly post?: (message: unknown) => void;
}

function createTestWorkerScope(
  options: TestWorkerScopeOptions = {},
): TestWorkerScope {
  const listeners = new Set<MessageListener>();
  const messages: unknown[] = [];
  let closes = 0;
  let removals = 0;
  let postHook = options.post;

  const scope = {
    self: undefined as unknown,
    addEventListener(
      type: "message",
      listener: MessageListener,
    ): void {
      expect(type).toBe("message");
      options.add?.();
      listeners.add(listener);
    },
    close(): void {
      closes += 1;
      options.close?.();
    },
    closeCalls: () => closes,
    dispatch(data: unknown): void {
      for (const listener of listeners) {
        listener({ data });
      }
    },
    listenerCount: () => listeners.size,
    messages,
    postMessage(message: unknown): void {
      messages.push(message);
      postHook?.(message);
    },
    removeCalls: () => removals,
    removeEventListener(
      type: "message",
      listener: MessageListener,
    ): void {
      expect(type).toBe("message");
      removals += 1;
      listeners.delete(listener);
    },
    setPostHook(
      hook: ((message: unknown) => void) | undefined,
    ): void {
      postHook = hook;
    },
  };
  Object.defineProperty(scope, "self", {
    configurable: true,
    enumerable: true,
    value: scope,
    writable: false,
  });
  return scope;
}

function parserModule(
  astify: (statementText: string) => unknown = () => ({
    type: "select",
  }),
): unknown {
  return {
    Parser: class Parser {
      astify(statementText: string): unknown {
        return astify(statementText);
      }
    },
  };
}

function loaders(
  overrides: Partial<
    NodeSqlParserBrowserWorkerModuleLoaders
  > = {},
): NodeSqlParserBrowserWorkerModuleLoaders {
  return {
    bigquery: async () => parserModule(),
    postgresql: async () => parserModule(),
    ...overrides,
  };
}

function request(
  requestId: number,
  grammar: NodeSqlParserWireGrammar = "postgresql",
  text = "SELECT 1",
): unknown {
  return encodeNodeSqlParserWireRequest(
    grammar,
    requestId,
    text,
  );
}

async function waitForMessageCount(
  scope: TestWorkerScope,
  count: number,
): Promise<void> {
  await vi.waitFor(() => {
    expect(scope.messages).toHaveLength(count);
  });
}

describe("node-sql-parser browser worker endpoint", () => {
  it("installs one listener, posts ready, and lazily routes both grammars", async () => {
    const scope = createTestWorkerScope();
    const evaluations = {
      bigquery: 0,
      postgresql: 0,
    };

    installNodeSqlParserBrowserWorkerEndpoint(
      scope,
      loaders({
        bigquery: async () => {
          evaluations.bigquery += 1;
          return parserModule(() => ({ type: "select" }));
        },
        postgresql: async () => {
          evaluations.postgresql += 1;
          return parserModule(() => ({ type: "insert" }));
        },
      }),
    );

    expect(scope.listenerCount()).toBe(1);
    expect(scope.messages).toStrictEqual([
      { kind: "ready", protocolVersion: 1 },
    ]);
    expect(evaluations).toStrictEqual({
      bigquery: 0,
      postgresql: 0,
    });

    scope.dispatch(request(1, "bigquery"));
    await waitForMessageCount(scope, 2);
    expect(scope.messages[1]).toStrictEqual({
      kind: "parsed",
      protocolVersion: 1,
      requestId: 1,
      statementKind: "query",
    });
    expect(evaluations).toStrictEqual({
      bigquery: 1,
      postgresql: 0,
    });

    scope.dispatch(request(2, "postgresql"));
    await waitForMessageCount(scope, 3);
    expect(scope.messages[2]).toStrictEqual({
      kind: "parsed",
      protocolVersion: 1,
      requestId: 2,
      statementKind: "insert",
    });

    scope.dispatch(request(3, "bigquery"));
    await waitForMessageCount(scope, 4);
    expect(evaluations).toStrictEqual({
      bigquery: 1,
      postgresql: 1,
    });
    expect(scope.closeCalls()).toBe(0);
  });

  it("restores exact data and accessor descriptors after each async import", async () => {
    const scope = createTestWorkerScope();
    const originalNodeSqlParser = Object.freeze({
      owner: "worker",
    });
    const originalGetter = () => "original-global";
    const originalSetter = (_value: unknown) => undefined;
    Object.defineProperties(scope, {
      NodeSQLParser: {
        configurable: true,
        enumerable: true,
        value: originalNodeSqlParser,
        writable: false,
      },
      global: {
        configurable: true,
        enumerable: false,
        get: originalGetter,
        set: originalSetter,
      },
    });
    const nodeSqlParserDescriptor =
      Object.getOwnPropertyDescriptor(scope, "NodeSQLParser");
    const globalDescriptor = Object.getOwnPropertyDescriptor(
      scope,
      "global",
    );

    const pollutingLoader = async () => {
      Object.defineProperties(scope, {
        NodeSQLParser: {
          configurable: true,
          enumerable: false,
          value: "temporary-parser",
          writable: true,
        },
        global: {
          configurable: true,
          enumerable: true,
          value: "temporary-global",
          writable: true,
        },
      });
      await Promise.resolve();
      return parserModule();
    };

    installNodeSqlParserBrowserWorkerEndpoint(
      scope,
      loaders({
        bigquery: pollutingLoader,
        postgresql: pollutingLoader,
      }),
    );

    scope.dispatch(request(1, "postgresql"));
    await waitForMessageCount(scope, 2);
    expect(
      Object.getOwnPropertyDescriptor(scope, "NodeSQLParser"),
    ).toStrictEqual(nodeSqlParserDescriptor);
    expect(
      Object.getOwnPropertyDescriptor(scope, "global"),
    ).toStrictEqual(globalDescriptor);

    scope.dispatch(request(2, "bigquery"));
    await waitForMessageCount(scope, 3);
    expect(
      Object.getOwnPropertyDescriptor(scope, "NodeSQLParser"),
    ).toStrictEqual(nodeSqlParserDescriptor);
    expect(
      Object.getOwnPropertyDescriptor(scope, "global"),
    ).toStrictEqual(globalDescriptor);
    expect(scope.closeCalls()).toBe(0);
  });

  it("cleans up a rejected import and encodes only retry policy code", async () => {
    const scope = createTestWorkerScope();
    const rawImportError = Object.freeze({
      message: "secret import path",
      source: "/private/backend.js",
    });
    installNodeSqlParserBrowserWorkerEndpoint(
      scope,
      loaders({
        postgresql: async () => {
          Object.defineProperties(scope, {
            NodeSQLParser: {
              configurable: true,
              value: "temporary-parser",
            },
            global: {
              configurable: true,
              get: () => "temporary-global",
            },
          });
          throw rawImportError;
        },
      }),
    );

    scope.dispatch(request(17));
    await waitForMessageCount(scope, 2);

    expect(scope.messages[1]).toStrictEqual({
      code: "module-load",
      kind: "failed",
      protocolVersion: 1,
      requestId: 17,
    });
    expect(JSON.stringify(scope.messages[1])).not.toContain(
      "secret import path",
    );
    expect(JSON.stringify(scope.messages[1])).not.toContain(
      "/private/backend.js",
    );
    expect(
      Object.getOwnPropertyDescriptor(scope, "NodeSQLParser"),
    ).toBeUndefined();
    expect(
      Object.getOwnPropertyDescriptor(scope, "global"),
    ).toBeUndefined();
    expect(scope.closeCalls()).toBe(1);
    expect(scope.listenerCount()).toBe(0);
  });

  it("permanently poisons both grammar paths after restoration failure", async () => {
    const scope = createTestWorkerScope();
    let postgresqlEvaluations = 0;
    let bigqueryEvaluations = 0;
    installNodeSqlParserBrowserWorkerEndpoint(
      scope,
      loaders({
        bigquery: async () => {
          bigqueryEvaluations += 1;
          return parserModule();
        },
        postgresql: async () => {
          postgresqlEvaluations += 1;
          Object.defineProperty(scope, "NodeSQLParser", {
            configurable: false,
            value: "permanent-pollution",
          });
          return parserModule();
        },
      }),
    );

    scope.dispatch(request(1, "postgresql"));
    await waitForMessageCount(scope, 2);
    expect(scope.messages[1]).toStrictEqual({
      code: "backend",
      kind: "failed",
      protocolVersion: 1,
      requestId: 1,
    });
    expect(scope.closeCalls()).toBe(1);

    scope.dispatch(request(2, "bigquery"));
    await Promise.resolve();
    expect(postgresqlEvaluations).toBe(1);
    expect(bigqueryEvaluations).toBe(0);
    expect(scope.messages).toHaveLength(2);
  });

  it("poisons when an original descriptor cannot be restored", async () => {
    const scope = createTestWorkerScope();
    Object.defineProperty(scope, "NodeSQLParser", {
      configurable: true,
      value: "original-parser",
    });
    installNodeSqlParserBrowserWorkerEndpoint(
      scope,
      loaders({
        postgresql: async () => {
          Object.defineProperty(scope, "NodeSQLParser", {
            configurable: false,
            value: "permanent-parser",
          });
          return parserModule();
        },
      }),
    );

    scope.dispatch(request(8));
    await waitForMessageCount(scope, 2);

    expect(scope.messages[1]).toStrictEqual({
      code: "backend",
      kind: "failed",
      protocolVersion: 1,
      requestId: 8,
    });
    expect(scope.closeCalls()).toBe(1);
  });

  it("poisons when restoration reports success without descriptor equality", async () => {
    const target = createTestWorkerScope();
    Object.defineProperty(target, "NodeSQLParser", {
      configurable: true,
      enumerable: true,
      value: "original-parser",
      writable: true,
    });
    let ignoreRestoration = false;
    const scope = new Proxy(target, {
      defineProperty(value, key, descriptor) {
        if (ignoreRestoration && key === "NodeSQLParser") {
          return true;
        }
        return Reflect.defineProperty(value, key, descriptor);
      },
    });
    Object.defineProperty(target, "self", {
      configurable: true,
      enumerable: true,
      value: scope,
      writable: false,
    });
    installNodeSqlParserBrowserWorkerEndpoint(
      scope,
      loaders({
        postgresql: async () => {
          Object.defineProperty(target, "NodeSQLParser", {
            configurable: true,
            enumerable: false,
            value: "temporary-parser",
            writable: false,
          });
          ignoreRestoration = true;
          return parserModule();
        },
      }),
    );

    scope.dispatch(request(10));
    await waitForMessageCount(scope, 2);

    expect(scope.messages[1]).toStrictEqual({
      code: "backend",
      kind: "failed",
      protocolVersion: 1,
      requestId: 10,
    });
    expect(scope.closeCalls()).toBe(1);
  });

  it("poisons when restored descriptors cannot be verified", async () => {
    const target = createTestWorkerScope();
    let trapVerification = false;
    const scope = new Proxy(target, {
      getOwnPropertyDescriptor(value, key) {
        if (trapVerification && key === "NodeSQLParser") {
          throw new Error("private verification trap");
        }
        return Reflect.getOwnPropertyDescriptor(value, key);
      },
    });
    Object.defineProperty(target, "self", {
      configurable: true,
      enumerable: true,
      value: scope,
      writable: false,
    });
    installNodeSqlParserBrowserWorkerEndpoint(
      scope,
      loaders({
        postgresql: async () => {
          trapVerification = true;
          return parserModule();
        },
      }),
    );

    scope.dispatch(request(11));
    await waitForMessageCount(scope, 2);

    expect(scope.messages[1]).toStrictEqual({
      code: "backend",
      kind: "failed",
      protocolVersion: 1,
      requestId: 11,
    });
    expect(JSON.stringify(scope.messages[1])).not.toContain(
      "private verification trap",
    );
    expect(scope.closeCalls()).toBe(1);
  });

  it("maps descriptor snapshot failures to a terminal backend failure", async () => {
    const target = createTestWorkerScope();
    let evaluations = 0;
    const scope = new Proxy(target, {
      getOwnPropertyDescriptor(value, key) {
        if (key === "NodeSQLParser") {
          throw new Error("private descriptor trap");
        }
        return Reflect.getOwnPropertyDescriptor(value, key);
      },
    });
    Object.defineProperty(target, "self", {
      configurable: true,
      enumerable: true,
      value: scope,
      writable: false,
    });
    installNodeSqlParserBrowserWorkerEndpoint(
      scope,
      loaders({
        postgresql: async () => {
          evaluations += 1;
          return parserModule();
        },
      }),
    );

    scope.dispatch(request(9));
    await waitForMessageCount(scope, 2);

    expect(scope.messages[1]).toStrictEqual({
      code: "backend",
      kind: "failed",
      protocolVersion: 1,
      requestId: 9,
    });
    expect(evaluations).toBe(0);
    expect(scope.closeCalls()).toBe(1);
  });

  it("treats overlapping requests as a terminal protocol error", async () => {
    const scope = createTestWorkerScope();
    let resolveImport: ((value: unknown) => void) | undefined;
    let postgresqlEvaluations = 0;
    let bigqueryEvaluations = 0;
    const importPromise = new Promise<unknown>((resolve) => {
      resolveImport = resolve;
    });
    installNodeSqlParserBrowserWorkerEndpoint(
      scope,
      loaders({
        bigquery: async () => {
          bigqueryEvaluations += 1;
          return parserModule();
        },
        postgresql: async () => {
          postgresqlEvaluations += 1;
          return await importPromise;
        },
      }),
    );

    scope.dispatch(request(1, "postgresql"));
    scope.dispatch(request(2, "bigquery"));
    expect(scope.messages[1]).toStrictEqual({
      code: "invalid-request",
      kind: "protocol-error",
      protocolVersion: 1,
    });
    expect(scope.closeCalls()).toBe(1);
    expect(scope.listenerCount()).toBe(0);

    resolveImport?.(parserModule());
    await vi.waitFor(() => {
      expect(postgresqlEvaluations).toBe(1);
    });
    await Promise.resolve();
    expect(bigqueryEvaluations).toBe(0);
    expect(scope.messages).toHaveLength(2);
  });

  it("strictly rejects malformed requests and closes", () => {
    const scope = createTestWorkerScope();
    installNodeSqlParserBrowserWorkerEndpoint(scope, loaders());
    const valid = request(1) as object;

    scope.dispatch({ ...valid, extra: true });

    expect(scope.messages).toStrictEqual([
      { kind: "ready", protocolVersion: 1 },
      {
        code: "invalid-request",
        kind: "protocol-error",
        protocolVersion: 1,
      },
    ]);
    expect(scope.closeCalls()).toBe(1);
    expect(scope.listenerCount()).toBe(0);
  });

  it("elides parser roots and source text from parsed messages", async () => {
    const scope = createTestWorkerScope();
    const source = "SELECT super_secret_column FROM private_table";
    const root = {
      source,
      type: "select",
      nested: {
        rawError: new Error("secret backend error"),
      },
    };
    installNodeSqlParserBrowserWorkerEndpoint(
      scope,
      loaders({
        postgresql: async () => parserModule(() => root),
      }),
    );

    scope.dispatch(request(23, "postgresql", source));
    await waitForMessageCount(scope, 2);

    expect(scope.messages[1]).toStrictEqual({
      kind: "parsed",
      protocolVersion: 1,
      requestId: 23,
      statementKind: "query",
    });
    expect(scope.messages[1]).not.toHaveProperty("root");
    expect(JSON.stringify(scope.messages[1])).not.toContain(source);
    expect(JSON.stringify(scope.messages[1])).not.toContain(
      "secret backend error",
    );
  });

  it.each([
    {
      code: undefined,
      expected: {
        kind: "syntax-rejected",
        protocolVersion: 1,
        requestId: 4,
      },
      moduleValue: parserModule(() => {
        throw {
          location: {
            end: { offset: 8 },
            start: { offset: 7 },
          },
          message: "syntax rejected",
          name: "SyntaxError",
        };
      }),
    },
    {
      code: undefined,
      expected: {
        kind: "unsupported",
        protocolVersion: 1,
        reason: "multiple-statements",
        requestId: 4,
      },
      moduleValue: parserModule(() => [
        { type: "select" },
        { type: "select" },
      ]),
    },
    {
      code: "backend",
      expected: {
        code: "backend",
        kind: "failed",
        protocolVersion: 1,
        requestId: 4,
      },
      moduleValue: parserModule(() => {
        throw new Error("ordinary backend failure");
      }),
    },
    {
      code: "malformed-output",
      expected: {
        code: "malformed-output",
        kind: "failed",
        protocolVersion: 1,
        requestId: 4,
      },
      moduleValue: {},
    },
  ])(
    "keeps the worker open after ordinary $code outcomes",
    async ({ expected, moduleValue }) => {
      const scope = createTestWorkerScope();
      installNodeSqlParserBrowserWorkerEndpoint(
        scope,
        loaders({
          postgresql: async () => moduleValue,
        }),
      );

      scope.dispatch(request(4));
      await waitForMessageCount(scope, 2);

      expect(scope.messages[1]).toStrictEqual(expected);
      expect(scope.closeCalls()).toBe(0);
      expect(scope.listenerCount()).toBe(1);
    },
  );

  it("mutates state before posting a successful settlement", async () => {
    const scope = createTestWorkerScope();
    let dispatchedReentrantly = false;
    scope.setPostHook((message) => {
      if (
        !dispatchedReentrantly &&
        (message as { readonly kind?: unknown }).kind === "parsed"
      ) {
        dispatchedReentrantly = true;
        scope.dispatch(request(2));
      }
    });
    installNodeSqlParserBrowserWorkerEndpoint(scope, loaders());

    scope.dispatch(request(1));
    await waitForMessageCount(scope, 3);

    expect(scope.messages.map((message) =>
      (message as { readonly kind: string }).kind,
    )).toStrictEqual(["ready", "parsed", "parsed"]);
    expect(scope.closeCalls()).toBe(0);
  });

  it("closes without leaking ready-post, result-post, or close failures", async () => {
    const readyFailure = createTestWorkerScope({
      post(message) {
        if (
          (message as { readonly kind?: unknown }).kind === "ready"
        ) {
          throw new Error("ready post failed");
        }
      },
    });
    expect(() =>
      installNodeSqlParserBrowserWorkerEndpoint(
        readyFailure,
        loaders(),
      ),
    ).not.toThrow();
    expect(readyFailure.closeCalls()).toBe(1);

    const resultFailure = createTestWorkerScope();
    installNodeSqlParserBrowserWorkerEndpoint(
      resultFailure,
      loaders(),
    );
    resultFailure.setPostHook((message) => {
      if (
        (message as { readonly kind?: unknown }).kind === "parsed"
      ) {
        throw new Error("result post failed");
      }
    });
    resultFailure.dispatch(request(1));
    await vi.waitFor(() => {
      expect(resultFailure.closeCalls()).toBe(1);
    });
    expect(resultFailure.listenerCount()).toBe(0);

    const closeFailure = createTestWorkerScope({
      close() {
        throw new Error("close failed");
      },
    });
    installNodeSqlParserBrowserWorkerEndpoint(
      closeFailure,
      loaders(),
    );
    expect(() => closeFailure.dispatch({ invalid: true })).not.toThrow();
    expect(closeFailure.closeCalls()).toBe(1);
    expect(closeFailure.listenerCount()).toBe(0);
  });

  it("closes when listener installation fails", () => {
    const scope = createTestWorkerScope({
      add() {
        throw new Error("listener installation failed");
      },
    });

    expect(() =>
      installNodeSqlParserBrowserWorkerEndpoint(scope, loaders()),
    ).not.toThrow();
    expect(scope.messages).toHaveLength(0);
    expect(scope.listenerCount()).toBe(0);
    expect(scope.closeCalls()).toBe(1);
  });

  it("ignores events after closure when listener removal is unavailable", () => {
    const scope = createTestWorkerScope();
    Object.defineProperty(scope, "removeEventListener", {
      configurable: true,
      value: undefined,
    });
    installNodeSqlParserBrowserWorkerEndpoint(scope, loaders());

    scope.dispatch({ invalid: true });
    scope.dispatch(request(1));

    expect(scope.messages).toStrictEqual([
      { kind: "ready", protocolVersion: 1 },
      {
        code: "invalid-request",
        kind: "protocol-error",
        protocolVersion: 1,
      },
    ]);
    expect(scope.closeCalls()).toBe(1);
    expect(scope.listenerCount()).toBe(1);
  });

  it("rejects a window-like realm without closing, installing, or posting", () => {
    const scope = createTestWorkerScope() as TestWorkerScope & {
      window?: unknown;
    };
    scope.window = scope;

    expect(() =>
      installNodeSqlParserBrowserWorkerEndpoint(scope, loaders()),
    ).toThrowError(
      "node-sql-parser endpoint requires a dedicated worker realm",
    );

    expect(scope.messages).toHaveLength(0);
    expect(scope.listenerCount()).toBe(0);
    expect(scope.closeCalls()).toBe(0);
  });

  it("rejects a realm whose shape cannot be inspected", () => {
    const target = createTestWorkerScope();
    const scope = new Proxy(target, {
      has() {
        throw new Error("private realm trap");
      },
    });
    Object.defineProperty(target, "self", {
      configurable: true,
      enumerable: true,
      value: scope,
      writable: false,
    });

    expect(() =>
      installNodeSqlParserBrowserWorkerEndpoint(scope, loaders()),
    ).toThrowError(
      "node-sql-parser endpoint requires a dedicated worker realm",
    );
    expect(scope.messages).toHaveLength(0);
    expect(scope.closeCalls()).toBe(0);
  });
});
