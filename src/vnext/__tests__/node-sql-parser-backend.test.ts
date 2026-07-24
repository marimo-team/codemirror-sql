// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createNodeSqlParserBackend,
  MAX_NODE_SQL_PARSER_STATEMENT_LENGTH,
  type NodeSqlParserModuleLoadOutcome,
} from "../node-sql-parser-backend.js";

type ModuleShape =
  | "constructor"
  | "default-constructor"
  | "default-named"
  | "module-exports"
  | "named";

function loaded(moduleValue: unknown): NodeSqlParserModuleLoadOutcome {
  return {
    kind: "loaded",
    moduleValue,
  };
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

function backendFor(
  astify: (statementText: string, options: unknown) => unknown,
  shape: ModuleShape = "named",
) {
  return createNodeSqlParserBackend(async () =>
    loaded(createBackendModule(astify, shape)),
  );
}

describe("realm-neutral node-sql-parser backend", () => {
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
  ] as const)("maps backend type %s to %s", async (type, expected) => {
    const root = { type };
    const backend = backendFor(() => root);

    const outcome = await backend.parse("SELECT 1");

    expect(outcome).toStrictEqual({
      kind: "parsed",
      root,
      statementKind: expected,
    });
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(backend)).toBe(true);
  });

  it("passes exact source and immutable location-preserving options", async () => {
    const source = "  SELECT 1\nFROM users";
    let receivedSource: string | undefined;
    let receivedOptions: unknown;
    const backend = backendFor((statementText, options) => {
      receivedSource = statementText;
      receivedOptions = options;
      return { type: "select" };
    });

    await backend.parse(source);

    expect(receivedSource).toBe(source);
    expect(receivedOptions).toStrictEqual({
      parseOptions: { includeLocations: true },
      trimQuery: false,
    });
    expect(Object.isFrozen(receivedOptions)).toBe(true);
    expect(
      Object.isFrozen(
        (receivedOptions as { parseOptions: object }).parseOptions,
      ),
    ).toBe(true);
  });

  it.each([
    "constructor",
    "default-constructor",
    "default-named",
    "module-exports",
    "named",
  ] as const)("accepts the %s module shape", async (shape) => {
    const backend = backendFor(
      () => ({ type: "select" }),
      shape,
    );

    await expect(backend.parse("SELECT 1")).resolves.toMatchObject({
      kind: "parsed",
      statementKind: "query",
    });
  });

  it("does not load or checkpoint oversized input", async () => {
    let loads = 0;
    let checkpoints = 0;
    const backend = createNodeSqlParserBackend(async () => {
      loads += 1;
      return loaded(
        createBackendModule(() => ({ type: "select" })),
      );
    });

    const outcome = await backend.parse(
      "x".repeat(MAX_NODE_SQL_PARSER_STATEMENT_LENGTH + 1),
      () => {
        checkpoints += 1;
      },
    );

    expect(outcome).toStrictEqual({
      kind: "unsupported",
      reason: "resource-limit",
    });
    expect(loads).toBe(0);
    expect(checkpoints).toBe(0);
  });

  it("accepts the exact input boundary", async () => {
    let calls = 0;
    const backend = backendFor(() => {
      calls += 1;
      return { type: "select" };
    });

    const outcome = await backend.parse(
      "x".repeat(MAX_NODE_SQL_PARSER_STATEMENT_LENGTH),
    );

    expect(outcome).toMatchObject({ kind: "parsed" });
    expect(calls).toBe(1);
  });

  it("runs checkpoints before load, after load, and after astify", async () => {
    const events: string[] = [];
    let checkpoints = 0;
    const backend = createNodeSqlParserBackend(async () => {
      events.push("load");
      return loaded(
        createBackendModule(() => {
          events.push("astify");
          return { type: "select" };
        }),
      );
    });

    await backend.parse("SELECT 1", () => {
      checkpoints += 1;
      events.push(`checkpoint-${checkpoints}`);
    });

    expect(events).toStrictEqual([
      "checkpoint-1",
      "load",
      "checkpoint-2",
      "astify",
      "checkpoint-3",
    ]);
  });

  it("propagates the exact checkpoint error before loading", async () => {
    const reason = Object.freeze({ checkpoint: "before-load" });
    let loads = 0;
    const backend = createNodeSqlParserBackend(async () => {
      loads += 1;
      return loaded({});
    });

    await expect(
      backend.parse("SELECT 1", () => {
        throw reason;
      }),
    ).rejects.toBe(reason);
    expect(loads).toBe(0);
  });

  it("propagates the exact checkpoint error after loading", async () => {
    const reason = Object.freeze({ checkpoint: "after-load" });
    let checkpoints = 0;
    let astifyCalls = 0;
    const backend = backendFor(() => {
      astifyCalls += 1;
      return { type: "select" };
    });

    await expect(
      backend.parse("SELECT 1", () => {
        checkpoints += 1;
        if (checkpoints === 2) {
          throw reason;
        }
      }),
    ).rejects.toBe(reason);
    expect(astifyCalls).toBe(0);

    await expect(backend.parse("SELECT 1")).resolves.toMatchObject({
      kind: "parsed",
    });
    expect(astifyCalls).toBe(1);
  });

  it("propagates the exact checkpoint error after astify", async () => {
    const reason = Object.freeze({ checkpoint: "after-astify" });
    let checkpoints = 0;
    let astifyCalls = 0;
    const backend = backendFor(() => {
      astifyCalls += 1;
      return { type: "select" };
    });

    await expect(
      backend.parse("SELECT 1", () => {
        checkpoints += 1;
        if (checkpoints === 3) {
          throw reason;
        }
      }),
    ).rejects.toBe(reason);
    expect(astifyCalls).toBe(1);
  });

  it("checks cancellation after a throwing astify before classifying it", async () => {
    const backendError = new Error("private backend failure");
    const checkpointError = Object.freeze({
      checkpoint: "after-throw",
    });
    let checkpoints = 0;
    const backend = backendFor(() => {
      throw backendError;
    });

    await expect(
      backend.parse("SELECT 1", () => {
        checkpoints += 1;
        if (checkpoints === 3) {
          throw checkpointError;
        }
      }),
    ).rejects.toBe(checkpointError);
  });
});

describe("node-sql-parser backend loading", () => {
  it("deduplicates concurrent module loads", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let loads = 0;
    const backend = createNodeSqlParserBackend(async () => {
      loads += 1;
      await gate;
      return loaded(
        createBackendModule(() => ({ type: "select" })),
      );
    });

    const first = backend.parse("SELECT 1");
    const second = backend.parse("SELECT 2");
    await Promise.resolve();
    await Promise.resolve();
    expect(loads).toBe(1);
    if (release === undefined) {
      throw new Error("Load gate was not initialized");
    }
    release();

    await expect(first).resolves.toMatchObject({ kind: "parsed" });
    await expect(second).resolves.toMatchObject({ kind: "parsed" });
    expect(loads).toBe(1);
  });

  it("clears a retryable failed load", async () => {
    let loads = 0;
    const backend = createNodeSqlParserBackend(async () => {
      loads += 1;
      if (loads === 1) {
        return {
          code: "module-load",
          kind: "failed",
          retryable: true,
        };
      }
      return loaded(
        createBackendModule(() => ({ type: "select" })),
      );
    });

    await expect(backend.parse("SELECT 1")).resolves.toStrictEqual({
      code: "module-load",
      kind: "failed",
      retryable: true,
    });
    await expect(backend.parse("SELECT 1")).resolves.toMatchObject({
      kind: "parsed",
    });
    expect(loads).toBe(2);
  });

  it("caches a non-retryable failed load", async () => {
    let loads = 0;
    const backend = createNodeSqlParserBackend(async () => {
      loads += 1;
      return {
        code: "backend",
        kind: "failed",
        retryable: false,
      };
    });

    const expected = {
      code: "backend",
      kind: "failed",
      retryable: false,
    };
    await expect(backend.parse("SELECT 1")).resolves.toStrictEqual(
      expected,
    );
    await expect(backend.parse("SELECT 2")).resolves.toStrictEqual(
      expected,
    );
    expect(loads).toBe(1);
  });

  it("normalizes a rejected loader and permits retry", async () => {
    let loads = 0;
    const backend = createNodeSqlParserBackend(async () => {
      loads += 1;
      if (loads === 1) {
        throw new Error("private load rejection");
      }
      return loaded(
        createBackendModule(() => ({ type: "select" })),
      );
    });

    await expect(backend.parse("SELECT 1")).resolves.toStrictEqual({
      code: "module-load",
      kind: "failed",
      retryable: true,
    });
    await expect(backend.parse("SELECT 1")).resolves.toMatchObject({
      kind: "parsed",
    });
    expect(loads).toBe(2);
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
  ])("caches malformed module shape %#", async (moduleValue) => {
    let loads = 0;
    const backend = createNodeSqlParserBackend(async () => {
      loads += 1;
      return loaded(moduleValue);
    });

    const expected = {
      code: "malformed-output",
      kind: "failed",
      retryable: false,
    };
    await expect(backend.parse("SELECT 1")).resolves.toStrictEqual(
      expected,
    );
    await expect(backend.parse("SELECT 2")).resolves.toStrictEqual(
      expected,
    );
    expect(loads).toBe(1);
  });

  it("caches a constructor failure without leaking it", async () => {
    let constructions = 0;
    class Parser {
      constructor() {
        constructions += 1;
        throw new Error("private constructor detail");
      }
    }
    const backend = createNodeSqlParserBackend(async () =>
      loaded({ Parser }),
    );

    const first = await backend.parse("SELECT 1");
    const second = await backend.parse("SELECT 2");

    expect(first).toStrictEqual({
      code: "backend",
      kind: "failed",
      retryable: false,
    });
    expect(second).toStrictEqual(first);
    expect(JSON.stringify(first)).not.toContain("private");
    expect(constructions).toBe(1);
  });

  it("does not invoke accessor-backed module or astify properties", async () => {
    let moduleAccessorInvoked = false;
    const moduleValue = {};
    Object.defineProperty(moduleValue, "Parser", {
      get() {
        moduleAccessorInvoked = true;
        throw new Error("private module accessor");
      },
    });
    const moduleBackend = createNodeSqlParserBackend(async () =>
      loaded(moduleValue),
    );

    await expect(
      moduleBackend.parse("SELECT 1"),
    ).resolves.toMatchObject({
      code: "malformed-output",
      kind: "failed",
    });
    expect(moduleAccessorInvoked).toBe(false);

    let astifyAccessorInvoked = false;
    class Parser {
      get astify(): never {
        astifyAccessorInvoked = true;
        throw new Error("private astify accessor");
      }
    }
    const astifyBackend = createNodeSqlParserBackend(async () =>
      loaded({ Parser }),
    );

    await expect(
      astifyBackend.parse("SELECT 1"),
    ).resolves.toMatchObject({
      code: "malformed-output",
      kind: "failed",
    });
    expect(astifyAccessorInvoked).toBe(false);
  });

  it("normalizes a prototype-trapping parser", async () => {
    const parser = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("private prototype trap");
        },
      },
    );
    function Parser(): object {
      return parser;
    }
    const backend = createNodeSqlParserBackend(async () =>
      loaded({ Parser }),
    );

    const outcome = await backend.parse("SELECT 1");

    expect(outcome).toStrictEqual({
      code: "malformed-output",
      kind: "failed",
      retryable: false,
    });
    expect(JSON.stringify(outcome)).not.toContain("private");
  });
});

describe("node-sql-parser backend output decoding", () => {
  it("accepts a one-element AST array", async () => {
    const root = { type: "select" };
    const backend = backendFor(() => [root]);

    await expect(backend.parse("SELECT 1")).resolves.toStrictEqual({
      kind: "parsed",
      root,
      statementKind: "query",
    });
  });

  it.each([
    [[]],
    [[{ type: "select" }, { type: "select" }]],
  ] as const)(
    "classifies AST array %# as multiple statements",
    async (root) => {
      const backend = backendFor(() => root);

      await expect(backend.parse("SELECT 1")).resolves.toStrictEqual({
        kind: "unsupported",
        reason: "multiple-statements",
      });
    },
  );

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
    const backend = backendFor(() => root);

    await expect(backend.parse("SELECT 1")).resolves.toStrictEqual({
      code: "malformed-output",
      kind: "failed",
      retryable: false,
    });
  });

  it.each(["1", Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an array with a spoofed length descriptor %#",
    async (length) => {
      const root = new Proxy([{ type: "select" }], {
        getOwnPropertyDescriptor(target, key) {
          if (key === "length") {
            return {
              configurable: false,
              enumerable: false,
              value: length,
              writable: true,
            };
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
      const backend = backendFor(() => root);

      await expect(backend.parse("SELECT 1")).resolves.toStrictEqual({
        code: "malformed-output",
        kind: "failed",
        retryable: false,
      });
    },
  );

  it("does not invoke an accessor-backed root type", async () => {
    let invoked = false;
    const root = {};
    Object.defineProperty(root, "type", {
      get() {
        invoked = true;
        throw new Error("private type accessor");
      },
    });
    const backend = backendFor(() => root);

    const outcome = await backend.parse("SELECT 1");

    expect(outcome).toMatchObject({
      code: "malformed-output",
      kind: "failed",
    });
    expect(invoked).toBe(false);
  });

  it("normalizes descriptor-trapping and revoked roots", async () => {
    const descriptorTrap = new Proxy(
      { type: "select" },
      {
        getOwnPropertyDescriptor() {
          throw new Error("private descriptor trap");
        },
      },
    );
    const revoked = Proxy.revocable({ type: "select" }, {});
    revoked.revoke();

    for (const root of [descriptorTrap, revoked.proxy]) {
      const outcome = await backendFor(() => root).parse("SELECT 1");
      expect(outcome).toStrictEqual({
        code: "malformed-output",
        kind: "failed",
        retryable: false,
      });
      expect(JSON.stringify(outcome)).not.toContain("private");
    }
  });

  it("rejects a callable AST root", async () => {
    function root(): void {
      // Backend AST roots are data.
    }
    Object.defineProperty(root, "type", {
      value: "select",
    });

    await expect(
      backendFor(() => root).parse("SELECT 1"),
    ).resolves.toStrictEqual({
      code: "malformed-output",
      kind: "failed",
      retryable: false,
    });
  });
});

describe("node-sql-parser backend error decoding", () => {
  it("classifies a bounded SyntaxError without exposing its message", async () => {
    const backend = backendFor(() => {
      throw syntaxError("private syntax detail", 0, 1);
    });

    const outcome = await backend.parse("SELECT 1");

    expect(outcome).toStrictEqual({ kind: "syntax-rejected" });
    expect(JSON.stringify(outcome)).not.toContain("private");
  });

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
    const backend = backendFor(() => {
      throw error;
    });

    await expect(backend.parse("SELECT 1")).resolves.toStrictEqual({
      code: "malformed-output",
      kind: "failed",
      retryable: false,
    });
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
        throw new Error("private location accessor");
      },
    });
    const backend = backendFor(() => {
      throw error;
    });

    const outcome = await backend.parse("SELECT 1");

    expect(outcome).toMatchObject({
      code: "malformed-output",
      kind: "failed",
    });
    expect(invoked).toBe(false);
  });

  it.each([
    new Error("private backend stack and message"),
    "private primitive rejection",
    null,
  ])("normalizes backend failure %#", async (error) => {
    const backend = backendFor(() => {
      throw error;
    });

    const outcome = await backend.parse("SELECT 1");

    expect(outcome).toStrictEqual({
      code: "backend",
      kind: "failed",
      retryable: false,
    });
    expect(JSON.stringify(outcome)).not.toContain("private");
  });
});

describe("node-sql-parser backend ambient boundary", () => {
  it("does not reference environment-specific globals or modules", () => {
    const source = readFileSync(
      new URL("../node-sql-parser-backend.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(
      /\b(?:globalThis|window|self|Worker)\b|node:module/,
    );
  });

  it("parses while ambient realm getters throw", async () => {
    const keys = ["window", "self", "Worker"] as const;
    const snapshots = keys.map((key) => ({
      descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
      key,
    }));
    try {
      for (const key of keys) {
        Object.defineProperty(globalThis, key, {
          configurable: true,
          get() {
            throw new Error(`Backend read ambient ${key}`);
          },
        });
      }
      const backend = backendFor(() => ({ type: "select" }));

      await expect(backend.parse("SELECT 1")).resolves.toMatchObject({
        kind: "parsed",
        statementKind: "query",
      });
    } finally {
      for (const { descriptor, key } of snapshots) {
        if (descriptor === undefined) {
          Reflect.deleteProperty(globalThis, key);
        } else {
          Object.defineProperty(globalThis, key, descriptor);
        }
      }
    }
  });
});
