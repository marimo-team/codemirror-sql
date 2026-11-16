import type { SqlParseResult } from "./types.js";

export type AstNode = Record<string, unknown>;

type AstParseOutcome =
  | { kind: "parsed"; statements: readonly AstNode[] }
  | { kind: "invalid" | "skipped" };

export function readAst(result: SqlParseResult): AstParseOutcome {
  if (!result.success) return { kind: "invalid" };
  const statements = Array.isArray(result.ast) ? nodes(result.ast) : nodes([result.ast]);
  return statements.length > 0 ? { kind: "parsed", statements } : { kind: "skipped" };
}

export function isRecord(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function record(value: unknown): AstNode | undefined {
  return isRecord(value) ? value : undefined;
}

export function values(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function nodes(value: unknown): AstNode[] {
  return values(value).filter(isRecord);
}

export function isSelectNode(value: unknown): value is AstNode & { type: "select" } {
  return isRecord(value) && value.type === "select";
}

export function nameValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  return isRecord(value) && typeof value.value === "string" ? value.value : null;
}

export function columnName(value: unknown): string | null {
  const column = record(value)?.column;
  return nameValue(record(column)?.expr) ?? nameValue(column);
}
