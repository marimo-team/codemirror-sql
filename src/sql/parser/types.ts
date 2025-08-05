import type { SQLNamespace } from "@codemirror/lang-sql";
import type { EditorState } from "@codemirror/state";
import type { AST, Option } from "node-sql-parser";
import type { SqlParseResult } from "../types.js";

export interface LocationInfo {
  start?: { line: number; column: number };
  end?: { line: number; column: number };
}

export interface SqlReference {
  type: "table" | "column";
  name: string;
  tableName?: string;
  tableAlias?: string;
  line: number;
  column: number;
  context: "select" | "from" | "where" | "join" | "order_by" | "group_by" | "having";
}

export interface SchemaValidationError {
  message: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  type: "missing_table" | "missing_column" | "invalid_reference";
}

export interface QueryContext {
  tables: string[];
  columns: string[];
  aliases: Map<string, string>;
  primaryTable?: string;
}

export interface NodeSqlParseResult extends SqlParseResult {
  ast?: AST | AST[];
}

export interface NodeSqlParserOptions {
  getParserOptions?: (state: EditorState) => Option;
  schema?: SQLNamespace | ((state: EditorState) => SQLNamespace);
}

/**
 * Type guards for AST nodes
 */
export const isNode = (node: unknown): node is Record<string, unknown> =>
  typeof node === "object" && node !== null;

export const isNodeOfType = (node: unknown, type: string): node is Record<string, unknown> =>
  isNode(node) && "type" in node && node.type === type;

export const isColumnRef = (node: unknown): node is Record<string, unknown> =>
  isNodeOfType(node, "column_ref") && "column" in node;

export const isTableRef = (node: unknown): node is Record<string, unknown> =>
  isNode(node) && "table" in node && typeof node.table === "string";

export const isSelectStmt = (node: unknown): node is Record<string, unknown> =>
  isNodeOfType(node, "select");

export const isJoinClause = (node: unknown): node is Record<string, unknown> =>
  isNodeOfType(node, "join");
