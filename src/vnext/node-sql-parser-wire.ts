import {
  MAX_NODE_SQL_PARSER_STATEMENT_LENGTH,
  type NodeSqlParserBackendOutcome,
} from "./node-sql-parser-backend.js";
import type { SqlStatementKind } from "./syntax.js";

export const NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION = 1 as const;

// The parse request is the largest closed protocol shape.
const MAX_NODE_SQL_PARSER_WIRE_RECORD_KEYS = 5;

export type NodeSqlParserWireGrammar = "bigquery" | "postgresql";

export type NodeSqlParserWireFailureCode =
  | "backend"
  | "malformed-output"
  | "module-load";

export interface NodeSqlParserWireRequest {
  readonly protocolVersion: 1;
  readonly kind: "parse";
  readonly requestId: number;
  readonly grammar: NodeSqlParserWireGrammar;
  readonly text: string;
}

export type NodeSqlParserWireMessage =
  | {
      readonly protocolVersion: 1;
      readonly kind: "ready";
    }
  | {
      readonly protocolVersion: 1;
      readonly kind: "parsed";
      readonly requestId: number;
      readonly statementKind: SqlStatementKind;
    }
  | {
      readonly protocolVersion: 1;
      readonly kind: "syntax-rejected";
      readonly requestId: number;
    }
  | {
      readonly protocolVersion: 1;
      readonly kind: "unsupported";
      readonly requestId: number;
      readonly reason: "multiple-statements" | "resource-limit";
    }
  | {
      readonly protocolVersion: 1;
      readonly kind: "failed";
      readonly requestId: number;
      readonly code: NodeSqlParserWireFailureCode;
    }
  | {
      readonly protocolVersion: 1;
      readonly kind: "protocol-error";
      readonly code: "invalid-request";
    };

interface InspectedRecord {
  readonly values: ReadonlyMap<string, unknown>;
}

function inspectRecord(value: unknown): InspectedRecord | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  try {
    if (
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return null;
    }

    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_NODE_SQL_PARSER_WIRE_RECORD_KEYS) {
      return null;
    }
    const values = new Map<string, unknown>();
    for (const key of keys) {
      if (typeof key !== "string") {
        return null;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        return null;
      }
      values.set(key, descriptor.value);
    }
    return { values };
  } catch {
    return null;
  }
}

function hasExactKeys(
  record: InspectedRecord,
  keys: readonly string[],
): boolean {
  if (record.values.size !== keys.length) {
    return false;
  }
  return keys.every((key) => record.values.has(key));
}

function hasCurrentProtocolVersion(record: InspectedRecord): boolean {
  return (
    record.values.get("protocolVersion") ===
    NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION
  );
}

function isRequestId(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

function isGrammar(
  value: unknown,
): value is NodeSqlParserWireGrammar {
  return value === "bigquery" || value === "postgresql";
}

function isStatementKind(value: unknown): value is SqlStatementKind {
  switch (value) {
    case "alter":
    case "create":
    case "delete":
    case "drop":
    case "insert":
    case "merge":
    case "other":
    case "query":
    case "transaction":
    case "update":
      return true;
    default:
      return false;
  }
}

function isUnsupportedReason(
  value: unknown,
): value is "multiple-statements" | "resource-limit" {
  return (
    value === "multiple-statements" || value === "resource-limit"
  );
}

function isFailureCode(
  value: unknown,
): value is NodeSqlParserWireFailureCode {
  return (
    value === "backend" ||
    value === "malformed-output" ||
    value === "module-load"
  );
}

function isRequestText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_NODE_SQL_PARSER_STATEMENT_LENGTH
  );
}

function requireRequestId(value: number): void {
  if (!isRequestId(value)) {
    throw new TypeError(
      "node-sql-parser wire request ID must be a positive safe integer",
    );
  }
}

function requireGrammar(value: NodeSqlParserWireGrammar): void {
  if (!isGrammar(value)) {
    throw new TypeError(
      "node-sql-parser wire grammar must be a closed grammar ID",
    );
  }
}

function requireRequestText(value: string): void {
  if (!isRequestText(value)) {
    throw new TypeError(
      "node-sql-parser wire text exceeds the statement input limit",
    );
  }
}

function requireStatementKind(value: SqlStatementKind): void {
  if (!isStatementKind(value)) {
    throw new TypeError(
      "node-sql-parser wire statement kind must be closed",
    );
  }
}

function requireUnsupportedReason(
  value: "multiple-statements" | "resource-limit",
): void {
  if (!isUnsupportedReason(value)) {
    throw new TypeError(
      "node-sql-parser wire unsupported reason must be closed",
    );
  }
}

function requireFailureCode(
  value: NodeSqlParserWireFailureCode,
): void {
  if (!isFailureCode(value)) {
    throw new TypeError(
      "node-sql-parser wire failure code must be closed",
    );
  }
}

export function encodeNodeSqlParserWireRequest(
  grammar: NodeSqlParserWireGrammar,
  requestId: number,
  text: string,
): NodeSqlParserWireRequest {
  requireGrammar(grammar);
  requireRequestId(requestId);
  requireRequestText(text);
  return Object.freeze({
    grammar,
    kind: "parse",
    protocolVersion: NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
    requestId,
    text,
  });
}

export function decodeNodeSqlParserWireRequest(
  value: unknown,
): NodeSqlParserWireRequest | null {
  const record = inspectRecord(value);
  if (
    record === null ||
    !hasExactKeys(record, [
      "protocolVersion",
      "kind",
      "requestId",
      "grammar",
      "text",
    ]) ||
    !hasCurrentProtocolVersion(record) ||
    record.values.get("kind") !== "parse"
  ) {
    return null;
  }

  const requestId = record.values.get("requestId");
  const grammar = record.values.get("grammar");
  const text = record.values.get("text");
  if (
    !isRequestId(requestId) ||
    !isGrammar(grammar) ||
    !isRequestText(text)
  ) {
    return null;
  }
  return encodeNodeSqlParserWireRequest(grammar, requestId, text);
}

export function encodeNodeSqlParserWireReady(): Extract<
  NodeSqlParserWireMessage,
  { readonly kind: "ready" }
> {
  return Object.freeze({
    kind: "ready",
    protocolVersion: NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
  });
}

export function encodeNodeSqlParserWireProtocolError(): Extract<
  NodeSqlParserWireMessage,
  { readonly kind: "protocol-error" }
> {
  return Object.freeze({
    code: "invalid-request",
    kind: "protocol-error",
    protocolVersion: NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
  });
}

export function encodeNodeSqlParserWireBackendOutcome(
  requestId: number,
  outcome: NodeSqlParserBackendOutcome,
): Exclude<
  NodeSqlParserWireMessage,
  { readonly kind: "protocol-error" | "ready" }
> {
  requireRequestId(requestId);
  switch (outcome.kind) {
    case "parsed":
      requireStatementKind(outcome.statementKind);
      return Object.freeze({
        kind: "parsed",
        protocolVersion: NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
        requestId,
        statementKind: outcome.statementKind,
      });
    case "syntax-rejected":
      return Object.freeze({
        kind: "syntax-rejected",
        protocolVersion: NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
        requestId,
      });
    case "unsupported":
      requireUnsupportedReason(outcome.reason);
      return Object.freeze({
        kind: "unsupported",
        protocolVersion: NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
        reason: outcome.reason,
        requestId,
      });
    case "failed":
      requireFailureCode(outcome.code);
      return Object.freeze({
        code: outcome.code,
        kind: "failed",
        protocolVersion: NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
        requestId,
      });
    default:
      throw new TypeError(
        "node-sql-parser wire backend outcome kind must be closed",
      );
  }
}

export function decodeNodeSqlParserWireMessage(
  value: unknown,
): NodeSqlParserWireMessage | null {
  const record = inspectRecord(value);
  if (
    record === null ||
    !hasCurrentProtocolVersion(record)
  ) {
    return null;
  }

  const kind = record.values.get("kind");
  const requestId = record.values.get("requestId");
  switch (kind) {
    case "ready":
      return hasExactKeys(record, ["protocolVersion", "kind"])
        ? encodeNodeSqlParserWireReady()
        : null;
    case "parsed": {
      const statementKind = record.values.get("statementKind");
      if (
        !hasExactKeys(record, [
          "protocolVersion",
          "kind",
          "requestId",
          "statementKind",
        ]) ||
        !isRequestId(requestId) ||
        !isStatementKind(statementKind)
      ) {
        return null;
      }
      return Object.freeze({
        kind: "parsed",
        protocolVersion: NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
        requestId,
        statementKind,
      });
    }
    case "syntax-rejected":
      return hasExactKeys(record, [
        "protocolVersion",
        "kind",
        "requestId",
      ]) && isRequestId(requestId)
        ? Object.freeze({
            kind: "syntax-rejected",
            protocolVersion:
              NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
            requestId,
          })
        : null;
    case "unsupported": {
      const reason = record.values.get("reason");
      if (
        !hasExactKeys(record, [
          "protocolVersion",
          "kind",
          "requestId",
          "reason",
        ]) ||
        !isRequestId(requestId) ||
        !isUnsupportedReason(reason)
      ) {
        return null;
      }
      return Object.freeze({
        kind: "unsupported",
        protocolVersion: NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
        reason,
        requestId,
      });
    }
    case "failed": {
      const code = record.values.get("code");
      if (
        !hasExactKeys(record, [
          "protocolVersion",
          "kind",
          "requestId",
          "code",
        ]) ||
        !isRequestId(requestId) ||
        !isFailureCode(code)
      ) {
        return null;
      }
      return Object.freeze({
        code,
        kind: "failed",
        protocolVersion: NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
        requestId,
      });
    }
    case "protocol-error":
      return hasExactKeys(record, [
        "protocolVersion",
        "kind",
        "code",
      ]) && record.values.get("code") === "invalid-request"
        ? encodeNodeSqlParserWireProtocolError()
        : null;
    default:
      return null;
  }
}

export function isNodeSqlParserWireFailureRetryable(
  code: NodeSqlParserWireFailureCode,
): boolean {
  requireFailureCode(code);
  return code === "module-load";
}
