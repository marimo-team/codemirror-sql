import type { EditorState } from "@codemirror/state";
import { debug } from "../debug.js";
import { NodeSqlParser } from "./parser.js";
import type { SqlParser } from "./types.js";

/**
 * A table-like source referenced by a statement (FROM/JOIN entries and
 * INSERT/UPDATE/DELETE targets).
 */
export interface QueryContextTable {
  /** Unqualified table name (quotes stripped) */
  name: string;
  /** Full dotted path as written, e.g. ["mydb", "users"] (quotes stripped) */
  path: string[];
  /** Alias as written (quotes stripped), if any */
  alias?: string;
}

/**
 * A CTE declared in the statement's WITH clause
 */
export interface QueryContextCte {
  name: string;
  /** Declared or inferred output columns (empty when unknown) */
  columns: string[];
  /** Start of the CTE name in the statement text (-1 when not found) */
  from: number;
  /** End of the CTE name in the statement text (-1 when not found) */
  to: number;
}

/**
 * Statement-scoped analysis of table references, aliases, and CTEs, used to
 * resolve alias-qualified identifiers in hover tooltips and completions.
 */
export interface QueryContext {
  tables: QueryContextTable[];
  ctes: QueryContextCte[];
  /** alias (lowercase) -> dotted table path / CTE name as written */
  aliases: Map<string, string>;
  /** AS aliases in the top-level select list */
  selectAliases: string[];
}

function emptyContext(): QueryContext {
  return { tables: [], ctes: [], aliases: new Map(), selectAliases: [] };
}

/** Loosely-typed node-sql-parser AST node */
interface AstNode {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): AstNode[] {
  return Array.isArray(value) ? (value as AstNode[]) : [];
}

/**
 * Strips one layer of identifier quoting: "x", 'x', `x`, [x]
 */
export function stripIdentifierQuotes(identifier: string): string {
  const first = identifier[0];
  const last = identifier[identifier.length - 1];
  if (
    identifier.length >= 2 &&
    ((first === '"' && last === '"') ||
      (first === "'" && last === "'") ||
      (first === "`" && last === "`") ||
      (first === "[" && last === "]"))
  ) {
    return identifier.slice(1, -1);
  }
  return identifier;
}

/** Extracts a name that may be a plain string or a `{value}` wrapper node */
function nameValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value) && typeof value.value === "string") {
    return value.value;
  }
  return null;
}

/** Extracts the column name from a column_ref-like node */
function columnRefName(expr: unknown): string | null {
  if (!isRecord(expr) || expr.type !== "column_ref") {
    return null;
  }
  const column = expr.column;
  if (typeof column === "string") {
    return column;
  }
  if (isRecord(column)) {
    const inner = column.expr;
    const value = isRecord(inner) ? inner.value : column.value;
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}

/** Output columns of a CTE: the declared list, else its SELECT list */
function cteColumns(cte: AstNode): string[] {
  const declared = asArray(cte.columns)
    .map((col) => nameValue(col) ?? columnRefName(col) ?? nameValue((col as AstNode).column))
    .filter((name): name is string => typeof name === "string");
  if (declared.length > 0) {
    return declared;
  }

  const stmt = cte.stmt;
  const body = isRecord(stmt) ? ((stmt.ast ?? stmt) as AstNode) : null;
  if (!isRecord(body) || body.type !== "select") {
    return [];
  }
  const columns: string[] = [];
  for (const col of asArray(body.columns)) {
    if (typeof col.as === "string") {
      columns.push(col.as);
    } else {
      const name = columnRefName(col.expr);
      if (name) {
        columns.push(name);
      }
    }
  }
  return columns;
}

interface MutableContext {
  tables: QueryContextTable[];
  ctes: QueryContextCte[];
  selectAliases: string[];
  seenTables: Set<string>;
  seenCtes: Set<string>;
}

/**
 * Records a FROM/target entry of shape `{db?, catalog?, schema?, table, as?}`.
 * Expression sources (subqueries, table functions) carry no `table` string and
 * are skipped; their inner SELECTs are reached by the generic walk.
 */
function recordTableEntry(entry: AstNode, ctx: MutableContext): void {
  if (typeof entry.table !== "string" || entry.table.length === 0) {
    return;
  }
  const qualifier = entry.db ?? entry.catalog;
  const path = [qualifier, entry.schema, entry.table]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .map(stripIdentifierQuotes);
  const alias = typeof entry.as === "string" ? stripIdentifierQuotes(entry.as) : undefined;

  const key = `${path.join(".").toLowerCase()}::${alias?.toLowerCase() ?? ""}`;
  if (ctx.seenTables.has(key)) {
    return;
  }
  ctx.seenTables.add(key);
  ctx.tables.push({
    name: stripIdentifierQuotes(entry.table),
    path,
    ...(alias ? { alias } : {}),
  });
}

/**
 * Defensive recursive walk over a node-sql-parser AST. Shapes vary by
 * statement type and dialect, so unknown structures are skipped, never thrown
 * on.
 */
function walkAst(value: unknown, ctx: MutableContext, seen: Set<unknown>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      walkAst(item, ctx, seen);
    }
    return;
  }
  if (!isRecord(value) || seen.has(value)) {
    return;
  }
  seen.add(value);

  // WITH clauses: register CTE names and output columns
  for (const cte of asArray(value.with)) {
    const name = nameValue(cte.name);
    if (name && !ctx.seenCtes.has(name.toLowerCase())) {
      ctx.seenCtes.add(name.toLowerCase());
      ctx.ctes.push({
        name: stripIdentifierQuotes(name),
        columns: cteColumns(cte).map(stripIdentifierQuotes),
        from: -1,
        to: -1,
      });
    }
  }

  // Table sources: FROM lists and DML/DDL targets
  for (const key of ["from", "table"]) {
    for (const entry of asArray(value[key])) {
      recordTableEntry(entry, ctx);
    }
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === "loc" || key === "tableList" || key === "columnList") {
      continue;
    }
    walkAst(child, ctx, seen);
  }
}

/** Collects `SELECT expr AS alias` names from the statement's own select list */
function collectSelectAliases(ast: AstNode, ctx: MutableContext): void {
  if (ast.type !== "select") {
    return;
  }
  for (const col of asArray(ast.columns)) {
    if (typeof col.as === "string") {
      ctx.selectAliases.push(stripIdentifierQuotes(col.as));
    }
  }
}

/**
 * Locates CTE name definitions (`name [(cols)] AS (`) in the statement text so
 * `QueryContextCte.from/to` can point at the declaration.
 */
function findCteSpan(sql: string, name: string): { from: number; to: number } {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b(${escaped})\\s*(?:\\([^)]*\\)\\s*)?AS\\s*\\(`, "i");
  const match = pattern.exec(sql);
  if (!match || match.index < 0) {
    return { from: -1, to: -1 };
  }
  return { from: match.index, to: match.index + name.length };
}

/** Keywords that can directly follow a table reference and are never aliases */
const NON_ALIAS_KEYWORDS = new Set([
  "as",
  "on",
  "using",
  "where",
  "join",
  "inner",
  "left",
  "right",
  "full",
  "cross",
  "outer",
  "natural",
  "lateral",
  "group",
  "order",
  "limit",
  "offset",
  "having",
  "union",
  "intersect",
  "except",
  "select",
  "set",
  "values",
  "when",
  "then",
  "and",
  "or",
  "not",
  "in",
  "is",
  "asc",
  "desc",
  "fetch",
  "window",
  "qualify",
  "returning",
  "with",
]);

const IDENT = String.raw`(?:[\w$]+|"[^"]+"|\`[^\`]+\`|\[[^\]]+\])`;
const TABLE_REF_PATTERN = new RegExp(
  String.raw`\b(?:from|join)\s+(${IDENT}(?:\.${IDENT})*)(?:\s+(?:as\s+)?(${IDENT}))?`,
  "gi",
);

/**
 * Regex-based fallback used when the statement doesn't parse (e.g. mid-edit),
 * so aliases still resolve. Matches `FROM|JOIN <table> [AS] <alias>` forms.
 */
function buildContextByRegex(sql: string): QueryContext {
  const ctx: MutableContext = {
    tables: [],
    ctes: [],
    selectAliases: [],
    seenTables: new Set(),
    seenCtes: new Set(),
  };

  extractCtesByRegex(sql, ctx);

  TABLE_REF_PATTERN.lastIndex = 0;
  let match = TABLE_REF_PATTERN.exec(sql);
  while (match !== null) {
    const rawPath = match[1];
    const rawAlias = match[2];
    if (rawPath) {
      const path = rawPath.split(".").map(stripIdentifierQuotes);
      const name = path[path.length - 1] ?? "";
      const alias =
        rawAlias && !NON_ALIAS_KEYWORDS.has(rawAlias.toLowerCase())
          ? stripIdentifierQuotes(rawAlias)
          : undefined;
      const key = `${path.join(".").toLowerCase()}::${alias?.toLowerCase() ?? ""}`;
      if (name && !ctx.seenTables.has(key)) {
        ctx.seenTables.add(key);
        ctx.tables.push({ name, path, ...(alias ? { alias } : {}) });
      }
    }
    match = TABLE_REF_PATTERN.exec(sql);
  }

  return finalizeContext(ctx);
}

/**
 * Extracts CTE declarations (name, declared column list, position) with the
 * same paren-tracking approach as the CTE completion source.
 */
function extractCtesByRegex(sql: string, ctx: MutableContext): void {
  const withPattern = /\bWITH\s+(?:RECURSIVE\s+)?/gi;
  const ctePattern = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\(([^)]*)\)\s*)?AS\s*\(/i;

  let withMatch = withPattern.exec(sql);
  while (withMatch !== null) {
    let pos = withMatch.index + withMatch[0].length;

    for (;;) {
      const cteMatch = ctePattern.exec(sql.slice(pos));
      const cteName = cteMatch?.[1];
      if (!cteMatch || !cteName) {
        break;
      }
      // Skip past the CTE body, tracking nested parentheses
      const bodyStart = pos + cteMatch[0].length;
      let i = bodyStart;
      let depth = 1;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "(") depth++;
        else if (sql[i] === ")") depth--;
        i++;
      }

      if (!ctx.seenCtes.has(cteName.toLowerCase())) {
        ctx.seenCtes.add(cteName.toLowerCase());
        const declared = (cteMatch[2] ?? "")
          .split(",")
          .map((col) => stripIdentifierQuotes(col.trim()))
          .filter((col) => col.length > 0);
        ctx.ctes.push({
          name: cteName,
          columns:
            declared.length > 0
              ? declared
              : inferColumnsFromSelectBody(sql.slice(bodyStart, Math.max(bodyStart, i - 1))),
          from: pos,
          to: pos + cteName.length,
        });
      }

      const separator = /^\s*,\s*/.exec(sql.slice(i));
      if (!separator) {
        break;
      }
      pos = i + separator[0].length;
    }

    withMatch = withPattern.exec(sql);
  }
}

function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * Best-effort inference of a CTE's output columns from its body's select list
 * (used by the regex fallback): `AS` aliases and simple identifiers only.
 */
function inferColumnsFromSelectBody(body: string): string[] {
  const selectMatch = /^\s*SELECT\s+(?:DISTINCT\s+)?([\s\S]*?)\s+FROM\s/i.exec(body);
  if (!selectMatch || !selectMatch[1]) {
    return [];
  }
  const columns: string[] = [];
  for (const item of splitTopLevelCommas(selectMatch[1])) {
    const trimmed = item.trim();
    const asMatch = new RegExp(String.raw`\s+AS\s+(${IDENT})$`, "i").exec(trimmed);
    if (asMatch?.[1]) {
      columns.push(stripIdentifierQuotes(asMatch[1]));
      continue;
    }
    if (/^(?:[\w$]+\.)*[\w$]+$/.test(trimmed)) {
      const segments = trimmed.split(".");
      const last = segments[segments.length - 1];
      if (last && last !== "*") {
        columns.push(last);
      }
    }
  }
  return columns;
}

/**
 * Builds the alias map from collected tables. Earlier (outer) entries win, so
 * a top-level alias shadows a same-named alias in a subquery.
 */
function finalizeContext(ctx: MutableContext): QueryContext {
  const aliases = new Map<string, string>();
  for (const table of ctx.tables) {
    if (table.alias) {
      const key = table.alias.toLowerCase();
      if (!aliases.has(key)) {
        aliases.set(key, table.path.join("."));
      }
    }
  }
  return {
    tables: ctx.tables,
    ctes: ctx.ctes,
    aliases,
    selectAliases: ctx.selectAliases,
  };
}

/**
 * Analyzes a single SQL statement, extracting referenced tables, aliases,
 * CTEs, and select-list aliases. Prefers the parsed AST and falls back to a
 * regex scan when the statement doesn't parse (e.g. mid-edit).
 */
export async function analyzeQueryContext(
  sql: string,
  parser: SqlParser,
  opts: { state: EditorState },
): Promise<QueryContext> {
  if (!sql.trim()) {
    return emptyContext();
  }

  let ast: unknown = null;
  try {
    const result = await parser.parse(sql, opts);
    if (result.success && result.ast != null) {
      ast = result.ast;
    }
  } catch (error) {
    debug("query-context parse failed", error);
  }

  if (ast == null) {
    return buildContextByRegex(sql);
  }

  try {
    const ctx: MutableContext = {
      tables: [],
      ctes: [],
      selectAliases: [],
      seenTables: new Set(),
      seenCtes: new Set(),
    };
    const asts = Array.isArray(ast) ? ast : [ast];
    for (const node of asts) {
      if (isRecord(node)) {
        collectSelectAliases(node, ctx);
      }
    }
    walkAst(ast, ctx, new Set());
    for (const cte of ctx.ctes) {
      const span = findCteSpan(sql, cte.name);
      cte.from = span.from;
      cte.to = span.to;
    }
    return finalizeContext(ctx);
  } catch (error) {
    debug("query-context AST walk failed", error);
    return buildContextByRegex(sql);
  }
}

/**
 * Caching wrapper around {@link analyzeQueryContext}, keyed on statement text.
 * Share one instance between hover/completion sources to avoid re-parsing the
 * same statement.
 */
export class QueryContextAnalyzer {
  private parser: SqlParser;
  private cache = new Map<string, QueryContext>();
  private readonly MAX_CACHE_SIZE = 20;

  constructor(parser: SqlParser = new NodeSqlParser()) {
    this.parser = parser;
  }

  async getContext(sql: string, opts: { state: EditorState }): Promise<QueryContext> {
    const cached = this.cache.get(sql);
    if (cached) {
      return cached;
    }

    const context = await analyzeQueryContext(sql, this.parser, opts);
    this.cache.set(sql, context);

    if (this.cache.size > this.MAX_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    return context;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
