// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  MAX_NODE_SQL_PARSER_STATEMENT_LENGTH,
  type NodeSqlParserBackendOutcome,
} from "../node-sql-parser-backend.js";
import {
  decodeNodeSqlParserWireMessage,
  decodeNodeSqlParserWireRequest,
  encodeNodeSqlParserWireBackendOutcome,
  encodeNodeSqlParserWireProtocolError,
  encodeNodeSqlParserWireReady,
  encodeNodeSqlParserWireRequest,
  isNodeSqlParserWireFailureRetryable,
  NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
  type NodeSqlParserWireMessage,
} from "../node-sql-parser-wire.js";
import type { SqlStatementKind } from "../syntax.js";

const statementKinds = [
  "alter",
  "create",
  "delete",
  "drop",
  "insert",
  "merge",
  "other",
  "query",
  "transaction",
  "update",
] as const satisfies readonly SqlStatementKind[];

const validRequest = {
  grammar: "postgresql",
  kind: "parse",
  protocolVersion: NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
  requestId: 1,
  text: "SELECT 1",
} as const;

const validMessages: readonly NodeSqlParserWireMessage[] = [
  {
    kind: "ready",
    protocolVersion: NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
  },
  ...statementKinds.map(
    (statementKind): NodeSqlParserWireMessage => ({
      kind: "parsed",
      protocolVersion: NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
      requestId: 1,
      statementKind,
    }),
  ),
  {
    kind: "syntax-rejected",
    protocolVersion: NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
    requestId: 1,
  },
  {
    kind: "unsupported",
    protocolVersion: NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
    reason: "multiple-statements",
    requestId: 1,
  },
  {
    kind: "unsupported",
    protocolVersion: NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
    reason: "resource-limit",
    requestId: 1,
  },
  {
    code: "backend",
    kind: "failed",
    protocolVersion: NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
    requestId: 1,
  },
  {
    code: "malformed-output",
    kind: "failed",
    protocolVersion: NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
    requestId: 1,
  },
  {
    code: "module-load",
    kind: "failed",
    protocolVersion: NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
    requestId: 1,
  },
  {
    code: "invalid-request",
    kind: "protocol-error",
    protocolVersion: NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
  },
];

function expectFreshFrozenPlain<T extends object>(
  source: object,
  decoded: T | null,
): asserts decoded is T {
  expect(decoded).not.toBeNull();
  expect(decoded).not.toBe(source);
  expect(Object.isFrozen(decoded)).toBe(true);
  expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
}

function omitKey(
  value: Readonly<Record<string, unknown>>,
  omitted: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== omitted),
  );
}

function hostileRecords(): {
  readonly assertAccessorsUntouched: () => void;
  readonly values: readonly unknown[];
} {
  const accessor = { ...validRequest };
  let invoked = false;
  Object.defineProperty(accessor, "text", {
    enumerable: true,
    get() {
      invoked = true;
      throw new Error("private accessor detail");
    },
  });
  const nonEnumerable = { ...validRequest };
  Object.defineProperty(nonEnumerable, "text", {
    enumerable: false,
    value: validRequest.text,
  });
  const ownKeysTrap = new Proxy(
    { ...validRequest },
    {
      ownKeys() {
        throw new Error("private ownKeys detail");
      },
    },
  );
  const descriptorTrap = new Proxy(
    { ...validRequest },
    {
      getOwnPropertyDescriptor() {
        throw new Error("private descriptor detail");
      },
    },
  );
  const prototypeTrap = new Proxy(
    { ...validRequest },
    {
      getPrototypeOf() {
        throw new Error("private prototype detail");
      },
    },
  );
  const revoked = Proxy.revocable({ ...validRequest }, {});
  revoked.revoke();
  const withSymbol = { ...validRequest };
  Object.defineProperty(withSymbol, Symbol("private"), {
    enumerable: false,
    value: "secret",
  });

  const values: unknown[] = [
    null,
    undefined,
    true,
    1,
    "record",
    () => validRequest,
    [],
    new Date(),
    Object.assign(Object.create(null), validRequest),
    Object.assign(
      Object.create({ inherited: true }),
      validRequest,
    ),
    accessor,
    nonEnumerable,
    ownKeysTrap,
    descriptorTrap,
    prototypeTrap,
    revoked.proxy,
    withSymbol,
  ];
  return {
    assertAccessorsUntouched() {
      expect(invoked).toBe(false);
    },
    values,
  };
}

describe("node-sql-parser wire request codec", () => {
  it.each(["postgresql", "bigquery"] as const)(
    "round trips the %s grammar through a fresh frozen record",
    (grammar) => {
      const encoded = encodeNodeSqlParserWireRequest(
        grammar,
        Number.MAX_SAFE_INTEGER,
        " SELECT 1\n",
      );
      const decoded = decodeNodeSqlParserWireRequest(encoded);

      expect(encoded).toStrictEqual({
        grammar,
        kind: "parse",
        protocolVersion: 1,
        requestId: Number.MAX_SAFE_INTEGER,
        text: " SELECT 1\n",
      });
      expectFreshFrozenPlain(encoded, decoded);
      expect(decoded).toStrictEqual(encoded);
    },
  );

  it.each([
    "",
    "x".repeat(MAX_NODE_SQL_PARSER_STATEMENT_LENGTH),
  ])("accepts bounded exact text %#", (text) => {
    expect(
      decodeNodeSqlParserWireRequest({
        ...validRequest,
        text,
      }),
    ).toStrictEqual({ ...validRequest, text });
  });

  it("rejects every missing request key and any extra key", () => {
    for (const key of Object.keys(validRequest)) {
      expect(
        decodeNodeSqlParserWireRequest(omitKey(validRequest, key)),
      ).toBeNull();
    }
    expect(
      decodeNodeSqlParserWireRequest({
        ...validRequest,
        extra: true,
      }),
    ).toBeNull();
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "1",
    1n,
  ])("rejects invalid request ID %#", (requestId) => {
    expect(
      decodeNodeSqlParserWireRequest({
        ...validRequest,
        requestId,
      }),
    ).toBeNull();
  });

  it.each([
    "duckdb",
    "PostgreSQL",
    "",
    null,
    1,
  ])("rejects invalid grammar %#", (grammar) => {
    expect(
      decodeNodeSqlParserWireRequest({
        ...validRequest,
        grammar,
      }),
    ).toBeNull();
  });

  it.each([
    "x".repeat(MAX_NODE_SQL_PARSER_STATEMENT_LENGTH + 1),
    null,
    1,
    {},
  ])("rejects invalid text %#", (text) => {
    expect(
      decodeNodeSqlParserWireRequest({
        ...validRequest,
        text,
      }),
    ).toBeNull();
  });

  it.each([0, 2, "1", null])(
    "rejects protocol version %#",
    (protocolVersion) => {
      expect(
        decodeNodeSqlParserWireRequest({
          ...validRequest,
          protocolVersion,
        }),
      ).toBeNull();
    },
  );

  it("rejects hostile and non-plain records without invoking accessors", () => {
    const hostile = hostileRecords();
    for (const value of hostile.values) {
      expect(decodeNodeSqlParserWireRequest(value)).toBeNull();
    }
    hostile.assertAccessorsUntouched();
  });

  it("rejects invalid values at the encoder boundary", () => {
    expect(() =>
      encodeNodeSqlParserWireRequest(
        "duckdb" as "postgresql",
        1,
        "SELECT 1",
      ),
    ).toThrow(TypeError);
    expect(() =>
      encodeNodeSqlParserWireRequest("postgresql", 0, "SELECT 1"),
    ).toThrow(TypeError);
    expect(() =>
      encodeNodeSqlParserWireRequest(
        "postgresql",
        1,
        "x".repeat(MAX_NODE_SQL_PARSER_STATEMENT_LENGTH + 1),
      ),
    ).toThrow(TypeError);
  });
});

describe("node-sql-parser wire message codec", () => {
  it.each(validMessages)(
    "decodes good variant $kind as a fresh frozen record",
    (message) => {
      const decoded = decodeNodeSqlParserWireMessage(message);

      expectFreshFrozenPlain(message, decoded);
      expect(decoded).toStrictEqual(message);
    },
  );

  it.each(statementKinds)(
    "encodes parsed statement kind %s",
    (statementKind) => {
      const outcome: NodeSqlParserBackendOutcome = {
        kind: "parsed",
        root: { private: true },
        statementKind,
      };

      expect(
        encodeNodeSqlParserWireBackendOutcome(7, outcome),
      ).toStrictEqual({
        kind: "parsed",
        protocolVersion: 1,
        requestId: 7,
        statementKind,
      });
    },
  );

  it("encodes every backend outcome and ready state", () => {
    const cases: readonly [
      NodeSqlParserBackendOutcome,
      NodeSqlParserWireMessage,
    ][] = [
      [
        { kind: "syntax-rejected" },
        {
          kind: "syntax-rejected",
          protocolVersion: 1,
          requestId: 3,
        },
      ],
      [
        { kind: "unsupported", reason: "multiple-statements" },
        {
          kind: "unsupported",
          protocolVersion: 1,
          reason: "multiple-statements",
          requestId: 3,
        },
      ],
      [
        { kind: "unsupported", reason: "resource-limit" },
        {
          kind: "unsupported",
          protocolVersion: 1,
          reason: "resource-limit",
          requestId: 3,
        },
      ],
      [
        { code: "backend", kind: "failed", retryable: false },
        {
          code: "backend",
          kind: "failed",
          protocolVersion: 1,
          requestId: 3,
        },
      ],
      [
        {
          code: "malformed-output",
          kind: "failed",
          retryable: false,
        },
        {
          code: "malformed-output",
          kind: "failed",
          protocolVersion: 1,
          requestId: 3,
        },
      ],
      [
        { code: "module-load", kind: "failed", retryable: true },
        {
          code: "module-load",
          kind: "failed",
          protocolVersion: 1,
          requestId: 3,
        },
      ],
    ];

    const ready = encodeNodeSqlParserWireReady();
    expect(ready).toStrictEqual({
      kind: "ready",
      protocolVersion: 1,
    });
    expect(Object.isFrozen(ready)).toBe(true);
    for (const [outcome, expected] of cases) {
      const encoded = encodeNodeSqlParserWireBackendOutcome(
        3,
        outcome,
      );
      expect(encoded).toStrictEqual(expected);
      expect(Object.isFrozen(encoded)).toBe(true);
      expect(Object.getPrototypeOf(encoded)).toBe(Object.prototype);
    }
  });

  it("never transports a parsed root or failure retryable flag", () => {
    const root = new Proxy(
      { type: "select" },
      {
        get() {
          throw new Error("wire inspected private AST root");
        },
        getOwnPropertyDescriptor() {
          throw new Error("wire inspected private AST root");
        },
        ownKeys() {
          throw new Error("wire inspected private AST root");
        },
      },
    );
    const parsed = encodeNodeSqlParserWireBackendOutcome(1, {
      kind: "parsed",
      root,
      statementKind: "query",
    });
    const failed = encodeNodeSqlParserWireBackendOutcome(1, {
      code: "module-load",
      kind: "failed",
      retryable: true,
    });

    expect(Reflect.ownKeys(parsed)).toStrictEqual([
      "kind",
      "protocolVersion",
      "requestId",
      "statementKind",
    ]);
    expect(Reflect.ownKeys(failed)).toStrictEqual([
      "code",
      "kind",
      "protocolVersion",
      "requestId",
    ]);
    expect(JSON.stringify(parsed)).not.toContain("root");
    expect(JSON.stringify(failed)).not.toContain("retryable");
  });

  it("derives retryability only from the closed failure code", () => {
    expect(isNodeSqlParserWireFailureRetryable("module-load")).toBe(
      true,
    );
    expect(isNodeSqlParserWireFailureRetryable("backend")).toBe(false);
    expect(
      isNodeSqlParserWireFailureRetryable("malformed-output"),
    ).toBe(false);
    expect(() =>
      isNodeSqlParserWireFailureRetryable(
        "timeout" as "module-load",
      ),
    ).toThrow(TypeError);
  });

  it("emits one closed protocol error without echoing an invalid ID", () => {
    const invalidRequest = {
      ...validRequest,
      requestId: "private invalid identifier",
    };
    expect(decodeNodeSqlParserWireRequest(invalidRequest)).toBeNull();

    const protocolError = encodeNodeSqlParserWireProtocolError();
    expect(protocolError).toStrictEqual({
      code: "invalid-request",
      kind: "protocol-error",
      protocolVersion: 1,
    });
    expect(Reflect.ownKeys(protocolError)).not.toContain("requestId");
    expect(Object.isFrozen(protocolError)).toBe(true);
  });

  it("rejects missing and extra keys for every message variant", () => {
    for (const message of validMessages) {
      for (const key of Object.keys(message)) {
        expect(
          decodeNodeSqlParserWireMessage(
            omitKey(message, key),
          ),
        ).toBeNull();
      }
      expect(
        decodeNodeSqlParserWireMessage({
          ...message,
          extra: "private",
        }),
      ).toBeNull();
    }
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "1",
  ])("rejects invalid response request ID %#", (requestId) => {
    expect(
      decodeNodeSqlParserWireMessage({
        kind: "syntax-rejected",
        protocolVersion: 1,
        requestId,
      }),
    ).toBeNull();
  });

  it.each([
    "select",
    "QUERY",
    "",
    null,
    1,
  ])("rejects statement kind %#", (statementKind) => {
    expect(
      decodeNodeSqlParserWireMessage({
        kind: "parsed",
        protocolVersion: 1,
        requestId: 1,
        statementKind,
      }),
    ).toBeNull();
  });

  it.each([
    "timeout",
    "multiple-statement",
    "",
    null,
  ])("rejects unsupported reason %#", (reason) => {
    expect(
      decodeNodeSqlParserWireMessage({
        kind: "unsupported",
        protocolVersion: 1,
        reason,
        requestId: 1,
      }),
    ).toBeNull();
  });

  it.each([
    "timeout",
    "syntax",
    "",
    null,
  ])("rejects failure code %#", (code) => {
    expect(
      decodeNodeSqlParserWireMessage({
        code,
        kind: "failed",
        protocolVersion: 1,
        requestId: 1,
      }),
    ).toBeNull();
  });

  it.each([
    "parse",
    "unknown",
    "",
    null,
  ])("rejects response kind %#", (kind) => {
    expect(
      decodeNodeSqlParserWireMessage({
        kind,
        protocolVersion: 1,
      }),
    ).toBeNull();
  });

  it.each([0, 2, "1", null])(
    "rejects response protocol version %#",
    (protocolVersion) => {
      expect(
        decodeNodeSqlParserWireMessage({
          kind: "ready",
          protocolVersion,
        }),
      ).toBeNull();
    },
  );

  it("rejects retryable on failed messages and IDs on protocol errors", () => {
    expect(
      decodeNodeSqlParserWireMessage({
        code: "module-load",
        kind: "failed",
        protocolVersion: 1,
        requestId: 1,
        retryable: true,
      }),
    ).toBeNull();
    expect(
      decodeNodeSqlParserWireMessage({
        code: "invalid-request",
        kind: "protocol-error",
        protocolVersion: 1,
        requestId: 1,
      }),
    ).toBeNull();
  });

  it("rejects hostile and non-plain message records", () => {
    const hostile = hostileRecords();
    for (const value of hostile.values) {
      expect(decodeNodeSqlParserWireMessage(value)).toBeNull();
    }
    hostile.assertAccessorsUntouched();
  });

  it("rejects invalid values at backend outcome encoder boundary", () => {
    expect(() =>
      encodeNodeSqlParserWireBackendOutcome(0, {
        kind: "syntax-rejected",
      }),
    ).toThrow(TypeError);
    expect(() =>
      encodeNodeSqlParserWireBackendOutcome(1, {
        kind: "parsed",
        root: {},
        statementKind: "select" as "query",
      }),
    ).toThrow(TypeError);
    expect(() =>
      encodeNodeSqlParserWireBackendOutcome(1, {
        kind: "unsupported",
        reason: "timeout" as "resource-limit",
      }),
    ).toThrow(TypeError);
    expect(() =>
      encodeNodeSqlParserWireBackendOutcome(1, {
        code: "timeout" as "backend",
        kind: "failed",
        retryable: false,
      }),
    ).toThrow(TypeError);
  });
});
