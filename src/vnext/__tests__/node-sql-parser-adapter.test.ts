// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  exportedForTesting,
  getBigQueryNodeSqlStatementParser,
  getDuckDbCompatibilityNodeSqlStatementParser,
  getPostgresqlNodeSqlStatementParser,
  MAX_NODE_SQL_PARSER_STATEMENT_LENGTH,
} from "../node-sql-parser-adapter.js";
import {
  createSqlStatementParseRequest,
  runSqlStatementParser,
  type SqlStatementParser,
} from "../syntax.js";

type ModuleShape =
  | "constructor"
  | "default-constructor"
  | "default-named"
  | "module-exports"
  | "named";

function invokeWithUnknown(
  callback: (...values: never[]) => unknown,
  ...values: unknown[]
): unknown {
  return Reflect.apply(callback, undefined, values);
}

function createBackendModule(
  astify: (statementText: string, options: unknown) => unknown,
  shape: ModuleShape = "named",
): unknown {
  class Parser {
    astify(statementText: string, options: unknown): unknown {
      return astify(statementText, options);
    }
  }

  switch (shape) {
    case "constructor":
      return Parser;
    case "default-constructor":
      return { default: Parser };
    case "default-named":
      return { default: { Parser } };
    case "module-exports":
      return { "module.exports": { Parser } };
    case "named":
      return { Parser };
  }
}

function createFakeParser(
  astify: (statementText: string, options: unknown) => unknown,
  policy: "dialect-compatibility" | "target-grammar" = "target-grammar",
  shape: ModuleShape = "named",
): SqlStatementParser {
  return exportedForTesting.createParser(
    policy,
    async () => createBackendModule(astify, shape),
  );
}

async function parse(
  parser: SqlStatementParser,
  text = "SELECT 1",
  signal: AbortSignal = new AbortController().signal,
) {
  return await runSqlStatementParser(
    parser,
    createSqlStatementParseRequest(text, signal),
  );
}

function syntaxError(
  message: string,
  from: number,
  to: number,
): object {
  return {
    location: {
      end: { offset: to },
      start: { offset: from },
    },
    message,
    name: "SyntaxError",
  };
}

function expectFailed(
  state: Awaited<ReturnType<typeof parse>>,
  reason: "backend-failure" | "malformed-output",
): void {
  expect(state.analysis).toMatchObject({
    reason,
    status: "failed",
  });
}

describe("node-sql-parser module boundary", () => {
  it("returns stable frozen parsers with scoped authority identities", () => {
    const postgresql = getPostgresqlNodeSqlStatementParser();
    const bigQuery = getBigQueryNodeSqlStatementParser();
    const duckDb = getDuckDbCompatibilityNodeSqlStatementParser();

    expect(getPostgresqlNodeSqlStatementParser()).toBe(postgresql);
    expect(getBigQueryNodeSqlStatementParser()).toBe(bigQuery);
    expect(getDuckDbCompatibilityNodeSqlStatementParser()).toBe(duckDb);
    expect(Object.isFrozen(postgresql)).toBe(true);
    expect(Object.isFrozen(bigQuery)).toBe(true);
    expect(Object.isFrozen(duckDb)).toBe(true);
    expect(duckDb.authority.backendIdentity).toBe(
      postgresql.authority.backendIdentity,
    );
    expect(duckDb.authority.configurationIdentity).not.toBe(
      postgresql.authority.configurationIdentity,
    );
    expect(duckDb.authority.dialectIdentity).not.toBe(
      postgresql.authority.dialectIdentity,
    );
    expect(bigQuery.authority.backendIdentity).not.toBe(
      postgresql.authority.backendIdentity,
    );
  });

  it.each<ModuleShape>([
    "constructor",
    "default-constructor",
    "default-named",
    "module-exports",
    "named",
  ])("accepts the supported %s module shape", async (shape) => {
    const parser = createFakeParser(
      () => ({ type: "select" }),
      "target-grammar",
      shape,
    );

    const state = await parse(parser);

    expect(state.analysis).toMatchObject({
      artifact: { kind: "query", range: { from: 0, to: 8 } },
      mode: "compatibility",
      status: "parsed",
    });
  });

  it("passes immutable location-preserving options and exact source", async () => {
    const source = "  SELECT 1\n";
    let receivedText: string | undefined;
    let receivedOptions: unknown;
    const parser = createFakeParser((text, options) => {
      receivedText = text;
      receivedOptions = options;
      return { type: "select" };
    });

    await parse(parser, source);

    expect(receivedText).toBe(source);
    expect(receivedOptions).toEqual({
      parseOptions: { includeLocations: true },
      trimQuery: false,
    });
    expect(Object.isFrozen(receivedOptions)).toBe(true);
    if (receivedOptions === null || typeof receivedOptions !== "object") {
      throw new Error("Expected parser options");
    }
    const parseOptions = Reflect.get(receivedOptions, "parseOptions");
    expect(Object.isFrozen(parseOptions)).toBe(true);
  });

  it("deduplicates concurrent module loads", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let loads = 0;
    const parser = exportedForTesting.createParser(
      "target-grammar",
      async () => {
        loads += 1;
        await gate;
        return createBackendModule(() => ({ type: "select" }));
      },
    );

    const first = parse(parser, "SELECT 1");
    const second = parse(parser, "SELECT 2");
    await Promise.resolve();
    await Promise.resolve();
    expect(loads).toBe(1);
    if (release === undefined) {
      throw new Error("Module load gate was not initialized");
    }
    release();

    await expect(first).resolves.toMatchObject({
      analysis: { status: "parsed" },
    });
    await expect(second).resolves.toMatchObject({
      analysis: { status: "parsed" },
    });
    expect(loads).toBe(1);
  });

  it("clears a rejected load so the next request can retry", async () => {
    let loads = 0;
    const parser = exportedForTesting.createParser(
      "target-grammar",
      async () => {
        loads += 1;
        if (loads === 1) {
          throw new Error("private loader details");
        }
        return createBackendModule(() => ({ type: "select" }));
      },
    );

    const first = await parse(parser);
    expect(first.analysis).toEqual(
      expect.objectContaining({
        message: "node-sql-parser failed to load",
        reason: "backend-failure",
        retryable: true,
        status: "failed",
      }),
    );
    expect(JSON.stringify(first)).not.toContain("private loader details");

    const second = await parse(parser);
    expect(second.analysis).toMatchObject({
      mode: "compatibility",
      status: "parsed",
    });
    expect(loads).toBe(2);
  });

  it("classifies and caches a constructor exception as a backend failure", async () => {
    let constructions = 0;
    class Parser {
      constructor() {
        constructions += 1;
        throw new Error("private constructor details");
      }
    }
    const parser = exportedForTesting.createParser(
      "target-grammar",
      async () => ({ Parser }),
    );

    const state = await parse(parser);

    expectFailed(state, "backend-failure");
    expect(state.analysis).toMatchObject({
      message: "node-sql-parser backend failed",
      retryable: false,
    });
    expect(JSON.stringify(state)).not.toContain("private");
    expectFailed(await parse(parser), "backend-failure");
    expect(constructions).toBe(1);
  });

  it.each([
    null,
    {},
    { Parser: null },
    { Parser: class MissingAstify {} },
    {
      Parser: class InvalidAstify {
        readonly astify = "not callable";
      },
    },
  ])("normalizes malformed module shape %#", async (moduleValue) => {
    const parser = exportedForTesting.createParser(
      "target-grammar",
      async () => moduleValue,
    );

    const state = await parse(parser);

    expectFailed(state, "malformed-output");
    expect(state.analysis).toMatchObject({
      message: "node-sql-parser returned malformed output",
      retryable: false,
    });
  });

  it("caches a non-retryable malformed module shape", async () => {
    let loads = 0;
    const parser = exportedForTesting.createParser(
      "target-grammar",
      async () => {
        loads += 1;
        return {};
      },
    );

    expectFailed(await parse(parser), "malformed-output");
    expectFailed(await parse(parser), "malformed-output");
    expect(loads).toBe(1);
  });

  it("does not invoke an accessor-backed astify method", async () => {
    let invoked = false;
    class Parser {
      get astify(): never {
        invoked = true;
        throw new Error("private accessor details");
      }
    }
    const parser = exportedForTesting.createParser(
      "target-grammar",
      async () => ({ Parser }),
    );

    const state = await parse(parser);

    expectFailed(state, "malformed-output");
    expect(invoked).toBe(false);
  });

  it("normalizes a prototype-trapping parser instance", async () => {
    const parserInstance = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("private prototype details");
        },
      },
    );
    function Parser(): object {
      return parserInstance;
    }
    const parser = exportedForTesting.createParser(
      "target-grammar",
      async () => ({ Parser }),
    );

    const state = await parse(parser);

    expectFailed(state, "malformed-output");
    expect(JSON.stringify(state)).not.toContain("private");
  });

  it("restores globals and recovers from a synchronous load failure", () => {
    const sentinel = {};
    const descriptor: PropertyDescriptor = {
      configurable: true,
      enumerable: false,
      value: sentinel,
      writable: true,
    };
    const syntheticGlobal = {};
    Object.defineProperty(
      syntheticGlobal,
      "NodeSQLParser",
      descriptor,
    );
    const loadSynchronously =
      exportedForTesting.createSynchronousModuleLoader(
        syntheticGlobal,
      );

    expect(() =>
      loadSynchronously(() => {
        Object.defineProperty(
          syntheticGlobal,
          "NodeSQLParser",
          {
            configurable: true,
            value: "temporary",
          },
        );
        throw new Error("private load details");
      }),
    ).toThrow("private load details");
    expect(
      Object.getOwnPropertyDescriptor(
        syntheticGlobal,
        "NodeSQLParser",
      ),
    ).toStrictEqual(descriptor);
    expect(loadSynchronously(() => "loaded")).toBe("loaded");
  });

  it("permanently poisons synchronous loading after cleanup failure", async () => {
    const syntheticGlobal = {};
    const loadSynchronously =
      exportedForTesting.createSynchronousModuleLoader(
        syntheticGlobal,
      );
    let firstLoads = 0;
    const firstParser = exportedForTesting.createParser(
      "target-grammar",
      async () =>
        loadSynchronously(() => {
          firstLoads += 1;
          Object.defineProperty(
            syntheticGlobal,
            "NodeSQLParser",
            {
              configurable: false,
              value: "pollution",
            },
          );
          return createBackendModule(() => ({ type: "select" }));
        }),
    );

    const first = await parse(firstParser);

    expectFailed(first, "backend-failure");
    expect(first.analysis).toMatchObject({ retryable: false });
    expect(firstLoads).toBe(1);

    let laterLoads = 0;
    const laterParser = exportedForTesting.createParser(
      "target-grammar",
      async () =>
        loadSynchronously(() => {
          laterLoads += 1;
          return createBackendModule(() => ({ type: "select" }));
        }),
    );

    const later = await parse(laterParser);

    expectFailed(later, "backend-failure");
    expect(later.analysis).toMatchObject({ retryable: false });
    expect(laterLoads).toBe(0);
    expect(
      Reflect.get(syntheticGlobal, "NodeSQLParser"),
    ).toBe("pollution");
  });

  it("permanently poisons synchronous loading after snapshot failure", () => {
    let inspections = 0;
    const syntheticGlobal = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          inspections += 1;
          throw new Error("private snapshot details");
        },
      },
    );
    const loadSynchronously =
      exportedForTesting.createSynchronousModuleLoader(
        syntheticGlobal,
      );
    let loads = 0;

    expect(() =>
      loadSynchronously(() => {
        loads += 1;
      }),
    ).toThrow();
    const inspectionsAfterFirst = inspections;
    expect(() =>
      loadSynchronously(() => {
        loads += 1;
      }),
    ).toThrow();
    expect(inspections).toBe(inspectionsAfterFirst);
    expect(loads).toBe(0);
  });
});

describe("node-sql-parser result decoding", () => {
  it.each([
    ["select", "query"],
    ["UNION", "query"],
    ["insert", "insert"],
    ["replace", "insert"],
    ["update", "update"],
    ["delete", "delete"],
    ["create", "create"],
    ["alter", "alter"],
    ["drop", "drop"],
    ["merge", "merge"],
    ["transaction", "transaction"],
    ["truncate", "other"],
  ] as const)("maps backend kind %s to %s", async (backend, expected) => {
    const state = await parse(
      createFakeParser(() => ({ type: backend })),
    );

    expect(state.analysis).toMatchObject({
      artifact: { kind: expected },
      mode: "compatibility",
      status: "parsed",
    });
  });

  it("accepts a one-element AST array", async () => {
    const state = await parse(
      createFakeParser(() => [{ type: "select" }]),
    );

    expect(state.analysis).toMatchObject({
      artifact: { kind: "query" },
      status: "parsed",
    });
  });

  it.each([
    [[]],
    [[{ type: "select" }, { type: "select" }]],
  ] as const)("classifies non-singleton AST arrays as unsupported", async (root) => {
    const state = await parse(createFakeParser(() => root));

    expect(state.analysis).toEqual(
      expect.objectContaining({
        reason: "uncovered-construct",
        status: "unsupported",
      }),
    );
  });

  it.each([
    null,
    undefined,
    1,
    "select",
    {},
    { type: "" },
    { type: " select" },
    { type: "select " },
    { type: "x".repeat(129) },
    [null],
    Array(1),
  ])("rejects malformed root %#", async (root) => {
    const state = await parse(createFakeParser(() => root));

    expectFailed(state, "malformed-output");
  });

  it("rejects an accessor-backed type without invoking it", async () => {
    let invoked = false;
    const root = {};
    Object.defineProperty(root, "type", {
      get() {
        invoked = true;
        throw new Error("private accessor details");
      },
    });

    const state = await parse(createFakeParser(() => root));

    expectFailed(state, "malformed-output");
    expect(invoked).toBe(false);
    expect(JSON.stringify(state)).not.toContain("private accessor details");
  });

  it("normalizes a descriptor-trapping root proxy as malformed", async () => {
    const root = new Proxy(
      { type: "select" },
      {
        getOwnPropertyDescriptor() {
          throw new Error("private proxy details");
        },
      },
    );

    const state = await parse(createFakeParser(() => root));

    expectFailed(state, "malformed-output");
    expect(JSON.stringify(state)).not.toContain("private proxy details");
  });

  it("normalizes revoked and array-length-trapping proxies as malformed", async () => {
    const revoked = Proxy.revocable({ type: "select" }, {});
    revoked.revoke();
    const arrayProxy = new Proxy(
      [{ type: "select" }],
      {
        getOwnPropertyDescriptor(target, key) {
          if (key === "length") {
            throw new Error("private array proxy details");
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );

    for (const root of [revoked.proxy, arrayProxy]) {
      const state = await parse(createFakeParser(() => root));
      expectFailed(state, "malformed-output");
      expect(JSON.stringify(state)).not.toContain("private");
    }
  });

  it("rejects callable AST roots", async () => {
    function root(): void {
      // A parser AST is data, never executable.
    }
    Object.defineProperty(root, "type", {
      value: "select",
    });

    const state = await parse(createFakeParser(() => root));

    expectFailed(state, "malformed-output");
  });
});

describe("node-sql-parser error boundary", () => {
  it.each([
    ["target-grammar", "uncovered-construct"],
    ["dialect-compatibility", "compatibility-rejected"],
  ] as const)(
    "keeps a %s grammar rejection non-authoritative",
    async (policy, expected) => {
      const parser = createFakeParser(() => {
        throw syntaxError("Unexpected token", 7, 8);
      }, policy);

      const state = await parse(parser);

      expect(state.analysis).toEqual(
        expect.objectContaining({
          reason: expected,
          status: "unsupported",
        }),
      );
      expect(JSON.stringify(state)).not.toContain("Unexpected token");
    },
  );

  it.each([
    [
      "PostgreSQL",
      getPostgresqlNodeSqlStatementParser,
      "SELECT `value` FROM `items`",
    ],
    [
      "BigQuery",
      getBigQueryNodeSqlStatementParser,
      "SELECT value FROM dataset.items LIMIT 1, 2",
    ],
  ] as const)(
    "does not claim direct %s conformance for an over-accepted construct",
    async (_dialect, getParser, source) => {
      const state = await parse(getParser(), source);

      expect(state.analysis).toMatchObject({
        limitations: ["partial-artifact"],
        mode: "compatibility",
        status: "parsed",
      });
    },
  );

  it.each([
    { location: null, message: "bad", name: "SyntaxError" },
    { location: {}, message: "bad", name: "SyntaxError" },
    {
      location: { end: { offset: 1 }, start: { offset: -1 } },
      message: "bad",
      name: "SyntaxError",
    },
    {
      location: { end: { offset: 1 }, start: { offset: 2 } },
      message: "bad",
      name: "SyntaxError",
    },
    {
      location: { end: { offset: 9 }, start: { offset: 0 } },
      message: "bad",
      name: "SyntaxError",
    },
    {
      location: { end: { offset: 1.5 }, start: { offset: 0 } },
      message: "bad",
      name: "SyntaxError",
    },
    {
      location: { end: {}, start: { offset: 0 } },
      message: "bad",
      name: "SyntaxError",
    },
    syntaxError("", 0, 1),
    syntaxError("x".repeat(8_193), 0, 1),
  ])("rejects malformed SyntaxError %#", async (error) => {
    const state = await parse(
      createFakeParser(() => {
        throw error;
      }),
    );

    expectFailed(state, "malformed-output");
  });

  it("does not invoke accessor-backed SyntaxError fields", async () => {
    let invoked = false;
    const error = {
      message: "bad",
      name: "SyntaxError",
    };
    Object.defineProperty(error, "location", {
      get() {
        invoked = true;
        throw new Error("private accessor details");
      },
    });

    const state = await parse(
      createFakeParser(() => {
        throw error;
      }),
    );

    expectFailed(state, "malformed-output");
    expect(invoked).toBe(false);
  });

  it.each([
    new Error("private backend stack and message"),
    "private primitive rejection",
    null,
  ])("normalizes backend failure %# without raw leakage", async (error) => {
    const state = await parse(
      createFakeParser(() => {
        throw error;
      }),
    );

    expectFailed(state, "backend-failure");
    expect(state.analysis).toMatchObject({
      message: "node-sql-parser backend failed",
      retryable: false,
    });
    expect(JSON.stringify(state)).not.toContain("private");
  });
});

describe("node-sql-parser resource and cancellation boundary", () => {
  it("rejects oversized input without loading the backend", async () => {
    let loads = 0;
    const parser = exportedForTesting.createParser(
      "target-grammar",
      async () => {
        loads += 1;
        return createBackendModule(() => ({ type: "select" }));
      },
    );

    const state = await parse(
      parser,
      "x".repeat(MAX_NODE_SQL_PARSER_STATEMENT_LENGTH + 1),
    );

    expect(state.analysis).toEqual(
      expect.objectContaining({
        reason: "resource-limit",
        status: "unsupported",
      }),
    );
    expect(loads).toBe(0);
  });

  it("accepts the exact adapter input boundary", async () => {
    let calls = 0;
    const parser = createFakeParser(() => {
      calls += 1;
      return { type: "select" };
    });

    const state = await parse(
      parser,
      "x".repeat(MAX_NODE_SQL_PARSER_STATEMENT_LENGTH),
    );

    expect(state.analysis).toMatchObject({
      mode: "compatibility",
      status: "parsed",
    });
    expect(calls).toBe(1);
  });

  it("does not load for a pre-aborted request", async () => {
    let loads = 0;
    const reason = Object.freeze({ reason: "pre-aborted" });
    const controller = new AbortController();
    controller.abort(reason);
    const parser = exportedForTesting.createParser(
      "target-grammar",
      async () => {
        loads += 1;
        return createBackendModule(() => ({ type: "select" }));
      },
    );

    await expect(
      parse(parser, "SELECT 1", controller.signal),
    ).rejects.toBe(reason);
    expect(loads).toBe(0);
  });

  it("propagates exact abort during module load and never parses", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let astifyCalls = 0;
    const parser = exportedForTesting.createParser(
      "target-grammar",
      async () => {
        await gate;
        return createBackendModule(() => {
          astifyCalls += 1;
          return { type: "select" };
        });
      },
    );
    const controller = new AbortController();
    const reason = Object.freeze({ reason: "during-load" });

    const result = parse(parser, "SELECT 1", controller.signal);
    await Promise.resolve();
    controller.abort(reason);
    if (release === undefined) {
      throw new Error("Module load gate was not initialized");
    }
    release();

    await expect(result).rejects.toBe(reason);
    expect(astifyCalls).toBe(0);
  });

  it("does not publish when the backend aborts synchronously", async () => {
    const controller = new AbortController();
    const reason = Object.freeze({ reason: "during-parse" });
    const parser = createFakeParser(() => {
      controller.abort(reason);
      return { type: "select" };
    });

    await expect(
      parse(parser, "SELECT 1", controller.signal),
    ).rejects.toBe(reason);
  });
});

describe("real node-sql-parser builds", () => {
  it.each([
    [
      "PostgreSQL",
      getPostgresqlNodeSqlStatementParser,
      "  SELECT 1\nFROM users",
      "query",
    ],
    [
      "PostgreSQL",
      getPostgresqlNodeSqlStatementParser,
      "BEGIN",
      "transaction",
    ],
    [
      "BigQuery",
      getBigQueryNodeSqlStatementParser,
      "SELECT `project.dataset.table`.id FROM `project.dataset.table`",
      "query",
    ],
    [
      "BigQuery",
      getBigQueryNodeSqlStatementParser,
      "CREATE TABLE dataset.result (id INT64)",
      "create",
    ],
  ] as const)(
    "parses a valid %s statement",
    async (_dialect, getParser, source, expectedKind) => {
      const state = await parse(getParser(), source);

      expect(state.analysis).toMatchObject({
        artifact: {
          kind: expectedKind,
          range: { from: 0, to: source.length },
        },
        limitations: ["partial-artifact"],
        mode: "compatibility",
        status: "parsed",
      });
    },
  );

  it.each([
    [
      "PostgreSQL",
      getPostgresqlNodeSqlStatementParser,
      "MERGE INTO target USING source ON target.id = source.id WHEN MATCHED THEN UPDATE SET value = source.value",
    ],
    [
      "BigQuery",
      getBigQueryNodeSqlStatementParser,
      "SELECT value FROM dataset.table QUALIFY ROW_NUMBER() OVER () = 1",
    ],
    [
      "PostgreSQL typo",
      getPostgresqlNodeSqlStatementParser,
      "SELEC 1",
    ],
    [
      "BigQuery typo",
      getBigQueryNodeSqlStatementParser,
      "SELEC 1",
    ],
  ] as const)(
    "classifies %s syntax rejection as unsupported",
    async (_dialect, getParser, source) => {
      const state = await parse(getParser(), source);

      expect(state.analysis).toEqual(
        expect.objectContaining({
          reason: "uncovered-construct",
          status: "unsupported",
        }),
      );
    },
  );

  it("marks DuckDB's PostgreSQL subset as compatibility evidence", async () => {
    const state = await parse(
      getDuckDbCompatibilityNodeSqlStatementParser(),
      "SELECT 1",
    );

    expect(state.analysis).toMatchObject({
      artifact: { kind: "query" },
      limitations: ["dialect-compatibility", "partial-artifact"],
      mode: "compatibility",
      status: "parsed",
    });
  });

  it("never turns a DuckDB compatibility rejection into invalid SQL", async () => {
    const state = await parse(
      getDuckDbCompatibilityNodeSqlStatementParser(),
      "FROM 'data.parquet'",
    );

    expect(state.analysis).toEqual(
      expect.objectContaining({
        reason: "compatibility-rejected",
        status: "unsupported",
      }),
    );
  });
});

describe("backend artifact privacy", () => {
  it("retains backend data only behind the authentic artifact", async () => {
    const backendRoot = {
      privateBackendField: "must-not-leak",
      type: "select",
    };
    const state = await parse(createFakeParser(() => backendRoot));
    if (
      state.analysis.status !== "parsed"
    ) {
      throw new Error("Expected a parsed analysis");
    }
    const { artifact } = state.analysis;

    expect(exportedForTesting.hasBackendPayload(artifact)).toBe(true);
    expect(Object.keys(artifact)).toEqual(["kind", "range"]);
    expect(JSON.stringify(state)).not.toContain("must-not-leak");
    expect(Reflect.ownKeys(artifact)).not.toContain("privateBackendField");

    const structuralCopy = {
      kind: artifact.kind,
      range: artifact.range,
    };
    expect(
      invokeWithUnknown(
        exportedForTesting.hasBackendPayload,
        structuralCopy,
      ),
    ).toBe(false);
  });

  it("does not retain malformed or unsupported backend values", async () => {
    const malformedState = await parse(createFakeParser(() => null));
    const unsupportedState = await parse(createFakeParser(() => []));

    for (const state of [malformedState, unsupportedState]) {
      expect(state.analysis.status).not.toBe("parsed");
      const fabricated = {
        kind: "other",
        range: { from: 0, to: 0 },
      };
      expect(
        invokeWithUnknown(
          exportedForTesting.hasBackendPayload,
          fabricated,
        ),
      ).toBe(false);
    }
  });
});

describe("execution realm boundary", () => {
  it.each(["self", "window"] as const)(
    "rejects and caches a distinct %s alias before import",
    async (alias) => {
      const original = Object.getOwnPropertyDescriptor(
        globalThis,
        alias,
      );
      const sentinel = {};
      Object.defineProperty(globalThis, alias, {
        configurable: true,
        value: sentinel,
      });

      try {
        vi.resetModules();
        const isolatedAdapter = await import(
          "../node-sql-parser-adapter.js"
        );
        const isolatedSyntax = await import("../syntax.js");
        const parser =
          isolatedAdapter.getPostgresqlNodeSqlStatementParser();
        const run = async () =>
          await isolatedSyntax.runSqlStatementParser(
            parser,
            isolatedSyntax.createSqlStatementParseRequest(
              "SELECT 1",
              new AbortController().signal,
            ),
          );

        const first = await run();
        expect(first.analysis).toMatchObject({
          reason: "backend-failure",
          retryable: false,
          status: "failed",
        });
        expect(Reflect.deleteProperty(globalThis, alias)).toBe(true);

        const second = await run();
        expect(second.analysis).toMatchObject({
          reason: "backend-failure",
          retryable: false,
          status: "failed",
        });
        expect(
          Object.getOwnPropertyDescriptor(
            sentinel,
            "NodeSQLParser",
          ),
        ).toBeUndefined();
      } finally {
        if (original === undefined) {
          Reflect.deleteProperty(globalThis, alias);
        } else {
          Object.defineProperty(globalThis, alias, original);
        }
        vi.resetModules();
      }
    },
  );

  it("rejects and caches an inherited self alias", async () => {
    const prototype = Object.getPrototypeOf(globalThis);
    if (prototype === null) {
      throw new Error("Expected a global prototype");
    }
    const original = Object.getOwnPropertyDescriptor(
      prototype,
      "self",
    );
    const sentinel = {};
    Object.defineProperty(prototype, "self", {
      configurable: true,
      value: sentinel,
    });

    try {
      vi.resetModules();
      const isolatedAdapter = await import(
        "../node-sql-parser-adapter.js"
      );
      const isolatedSyntax = await import("../syntax.js");
      const parser =
        isolatedAdapter.getPostgresqlNodeSqlStatementParser();
      const run = async () =>
        await isolatedSyntax.runSqlStatementParser(
          parser,
          isolatedSyntax.createSqlStatementParseRequest(
            "SELECT 1",
            new AbortController().signal,
          ),
        );

      expect((await run()).analysis).toMatchObject({
        reason: "backend-failure",
        retryable: false,
        status: "failed",
      });
      expect(Reflect.deleteProperty(prototype, "self")).toBe(true);
      expect((await run()).analysis).toMatchObject({
        reason: "backend-failure",
        retryable: false,
        status: "failed",
      });
      expect(
        Object.getOwnPropertyDescriptor(
          sentinel,
          "NodeSQLParser",
        ),
      ).toBeUndefined();
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(prototype, "self");
      } else {
        Object.defineProperty(prototype, "self", original);
      }
      vi.resetModules();
    }
  });

  it("rejects an inherited window accessor without invoking it", async () => {
    const prototype = Object.getPrototypeOf(globalThis);
    if (prototype === null) {
      throw new Error("Expected a global prototype");
    }
    const original = Object.getOwnPropertyDescriptor(
      prototype,
      "window",
    );
    let invoked = false;
    Object.defineProperty(prototype, "window", {
      configurable: true,
      get() {
        invoked = true;
        return {};
      },
    });

    try {
      vi.resetModules();
      const isolatedAdapter = await import(
        "../node-sql-parser-adapter.js"
      );
      const isolatedSyntax = await import("../syntax.js");
      const state = await isolatedSyntax.runSqlStatementParser(
        isolatedAdapter.getPostgresqlNodeSqlStatementParser(),
        isolatedSyntax.createSqlStatementParseRequest(
          "SELECT 1",
          new AbortController().signal,
        ),
      );

      expect(state.analysis).toMatchObject({
        reason: "backend-failure",
        retryable: false,
        status: "failed",
      });
      expect(invoked).toBe(false);
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(prototype, "window");
      } else {
        Object.defineProperty(prototype, "window", original);
      }
      vi.resetModules();
    }
  });
});
