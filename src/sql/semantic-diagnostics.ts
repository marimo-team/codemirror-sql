import type { SQLNamespace } from "@codemirror/lang-sql";
import { type Diagnostic, linter } from "@codemirror/lint";
import type { Extension, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  findNamespaceItemByEndMatch,
  isArrayNamespace,
  isObjectNamespace,
  isSelfChildrenNamespace,
  traverseNamespacePath,
} from "./namespace-utils.js";
import { NodeSqlParser } from "./parser.js";
import { resolveSqlSchema, type SqlSchemaSource } from "./schema-facet.js";
import { type SqlStatement, SqlStructureAnalyzer } from "./structure-analyzer.js";
import type { SqlParser } from "./types.js";

const DEFAULT_DELAY = 750;

/** Severity for a semantic check; "off" disables the check entirely */
export type SemanticSeverity = "error" | "warning" | "off";

/**
 * Configuration options for the semantic (schema-aware) SQL linter
 */
export interface SqlSemanticLinterConfig {
  /**
   * Database schema to validate queries against. Falls back to the shared
   * `sqlSchemaFacet` when not provided. Without a schema (or with an empty
   * one) the linter is inert.
   *
   * Function sources are invoked on every lint pass and should be
   * cheap/memoized.
   */
  schema?: SqlSchemaSource;
  /** Custom SQL parser instance to use for analysis */
  parser?: SqlParser;
  /**
   * Structure analyzer used to split the document into statements.
   * Pass a shared instance (e.g. the one used by the gutter) to reuse its cache.
   */
  structureAnalyzer?: SqlStructureAnalyzer;
  /** Delay in milliseconds before running validation (default: 750) */
  delay?: number;
  /** Per-check severity overrides (default: "warning" for every check) */
  severity?: {
    /** A referenced table is not present in the schema */
    unknownTable?: SemanticSeverity;
    /** A column is not present in its resolved table */
    unknownColumn?: SemanticSeverity;
    /** An unqualified column exists in two or more referenced tables */
    ambiguousColumn?: SemanticSeverity;
  };
}

type FindingKind = "unknownTable" | "unknownColumn" | "ambiguousColumn";

interface SemanticFinding {
  kind: FindingKind;
  /** Identifier to highlight in the statement text */
  identifier: string;
  message: string;
}

/** Loosely-typed node-sql-parser AST node */
interface AstNode {
  [key: string]: unknown;
}

/** A table-like source in a query scope (FROM entry, DML target, CTE, subquery) */
interface TableSource {
  /** Full dotted path as written, e.g. "mydb.users" (empty for subqueries) */
  path: string;
  /** Unqualified table name */
  name: string;
  alias: string | null;
  /** References a CTE defined in the statement */
  isCte: boolean;
  /** Subquery/table-function source whose columns we cannot know */
  opaque: boolean;
}

/**
 * A single query scope (a SELECT, or the target/WHERE portion of a DML
 * statement). Column references are checked against the scope's sources.
 */
interface QueryScope {
  sources: TableSource[];
  columnRefs: AstNode[];
  /** Lowercased SELECT-list aliases, referable from GROUP BY/ORDER BY etc. */
  selectAliases: Set<string>;
  /**
   * Whether unqualified column refs may be checked. Disabled for scopes that
   * can see an outer scope (correlated subqueries), where an unqualified name
   * may legally resolve to an outer table.
   */
  checkUnqualified: boolean;
  /** A USING/NATURAL join makes shared columns unambiguous; skip that check */
  hasUsingJoin: boolean;
}

function isSelectNode(node: unknown): node is AstNode & { type: "select" } {
  return (
    typeof node === "object" &&
    node !== null &&
    !Array.isArray(node) &&
    (node as AstNode).type === "select"
  );
}

function asArray(value: unknown): AstNode[] {
  return Array.isArray(value) ? (value as AstNode[]) : [];
}

function newScope(checkUnqualified: boolean): QueryScope {
  return {
    sources: [],
    columnRefs: [],
    selectAliases: new Set(),
    checkUnqualified,
    hasUsingJoin: false,
  };
}

/**
 * Registers CTE names defined on a statement node and collects scopes from
 * their bodies. Names are registered before bodies are walked so a CTE
 * referencing another (or itself, when recursive) is never flagged.
 */
function registerCtes(node: AstNode, ctes: Set<string>, scopes: QueryScope[]): void {
  const withList = asArray(node.with);
  for (const cte of withList) {
    const name = cte.name as AstNode | string | undefined;
    const value = typeof name === "string" ? name : name?.value;
    if (typeof value === "string") {
      ctes.add(value.toLowerCase());
    }
  }
  for (const cte of withList) {
    const stmt = cte.stmt as AstNode | undefined;
    const body = stmt?.ast ?? stmt;
    if (isSelectNode(body)) {
      collectSelect(body, ctes, scopes, false);
    }
  }
}

/**
 * Adds a FROM/target entry to the scope. Entries are either named tables
 * (`{db, schema, table, as}`) or expression sources (subqueries, table
 * functions), which are treated as opaque.
 */
function addTableEntry(
  entry: AstNode,
  scope: QueryScope,
  ctes: Set<string>,
  scopes: QueryScope[],
): void {
  if (entry.using != null) {
    scope.hasUsingJoin = true;
  }
  if (typeof entry.join === "string" && entry.join.toLowerCase().includes("natural")) {
    scope.hasUsingJoin = true;
  }
  if (entry.on != null) {
    walkExpr(entry.on, scope, ctes, scopes);
  }

  const expr = entry.expr as AstNode | undefined;
  if (expr != null) {
    const sub = expr.ast ?? expr;
    if (isSelectNode(sub)) {
      collectSelect(sub, ctes, scopes, false);
    }
    scope.sources.push({
      path: "",
      name: "",
      alias: typeof entry.as === "string" ? entry.as : null,
      isCte: false,
      opaque: true,
    });
    return;
  }

  if (typeof entry.table === "string") {
    const qualifier = entry.db ?? entry.catalog;
    const parts = [qualifier, entry.schema, entry.table].filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    );
    scope.sources.push({
      path: parts.join("."),
      name: entry.table,
      alias: typeof entry.as === "string" ? entry.as : null,
      isCte: parts.length === 1 && ctes.has(entry.table.toLowerCase()),
      opaque: false,
    });
  }
}

/**
 * Generic walk collecting column refs into the current scope and opening a
 * new (correlated) scope for any nested SELECT.
 */
function walkExpr(value: unknown, scope: QueryScope, ctes: Set<string>, scopes: QueryScope[]): void {
  if (value == null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walkExpr(item, scope, ctes, scopes);
    }
    return;
  }
  const node = value as AstNode;
  if (node.type === "column_ref") {
    scope.columnRefs.push(node);
    return;
  }
  if (isSelectNode(node)) {
    collectSelect(node, ctes, scopes, true);
    return;
  }
  if (isSelectNode(node.ast)) {
    collectSelect(node.ast, ctes, scopes, true);
    return;
  }
  for (const [key, child] of Object.entries(node)) {
    if (key === "loc" || key === "tableList" || key === "columnList") {
      continue;
    }
    walkExpr(child, scope, ctes, scopes);
  }
}

function collectSelect(
  node: AstNode,
  inheritedCtes: Set<string>,
  scopes: QueryScope[],
  correlated: boolean,
): void {
  const ctes = new Set(inheritedCtes);
  registerCtes(node, ctes, scopes);

  const scope = newScope(!correlated);
  scopes.push(scope);

  for (const entry of asArray(node.from)) {
    addTableEntry(entry, scope, ctes, scopes);
  }

  for (const col of asArray(node.columns)) {
    if (typeof col.as === "string") {
      scope.selectAliases.add(col.as.toLowerCase());
    }
  }

  for (const [key, child] of Object.entries(node)) {
    // `with` and `from` were handled above; walking them again would create
    // duplicate scopes (and `on` clauses are walked by addTableEntry)
    if (key === "with" || key === "from" || key === "loc") {
      continue;
    }
    walkExpr(child, scope, ctes, scopes);
  }
}

/**
 * Collects query scopes from a single parsed statement. DDL targets (CREATE
 * TABLE x) define tables rather than read them, so they are never added as
 * sources; DML targets (INSERT/UPDATE/DELETE) must exist and are.
 */
function collectStatement(node: AstNode, scopes: QueryScope[]): void {
  const ctes = new Set<string>();

  switch (node.type) {
    case "select": {
      collectSelect(node, ctes, scopes, false);
      return;
    }
    case "update": {
      registerCtes(node, ctes, scopes);
      const scope = newScope(true);
      scopes.push(scope);
      for (const entry of asArray(node.table)) {
        addTableEntry(entry, scope, ctes, scopes);
      }
      for (const entry of asArray(node.from)) {
        addTableEntry(entry, scope, ctes, scopes);
      }
      // SET entries are `{column, table, value}` where `column` is a plain
      // string in some dialect grammars (no column_ref type), so the generic
      // walk would miss them
      for (const entry of asArray(node.set)) {
        if (entry.column != null) {
          scope.columnRefs.push({
            type: "column_ref",
            table: entry.table ?? null,
            column: entry.column,
          });
        }
        walkExpr(entry.value, scope, ctes, scopes);
      }
      for (const [key, child] of Object.entries(node)) {
        if (
          key === "with" ||
          key === "table" ||
          key === "from" ||
          key === "set" ||
          key === "loc"
        ) {
          continue;
        }
        walkExpr(child, scope, ctes, scopes);
      }
      return;
    }
    case "delete": {
      registerCtes(node, ctes, scopes);
      const scope = newScope(true);
      scopes.push(scope);
      // node.table duplicates node.from entries (with `addition: true`), so
      // only FROM is used as the source list
      for (const entry of asArray(node.from)) {
        addTableEntry(entry, scope, ctes, scopes);
      }
      for (const [key, child] of Object.entries(node)) {
        if (key === "with" || key === "table" || key === "from" || key === "loc") {
          continue;
        }
        walkExpr(child, scope, ctes, scopes);
      }
      return;
    }
    case "insert":
    case "replace": {
      registerCtes(node, ctes, scopes);
      // The insert target must exist, but its scope has no readable columns
      // context, so unqualified column checks stay off
      const scope = newScope(false);
      scopes.push(scope);
      for (const entry of asArray(node.table)) {
        addTableEntry(entry, scope, ctes, scopes);
      }
      for (const [key, child] of Object.entries(node)) {
        // `columns` holds the target column names as plain strings
        if (key === "with" || key === "table" || key === "columns" || key === "loc") {
          continue;
        }
        if (isSelectNode(child)) {
          // INSERT INTO t SELECT ... — the select is a top-level query
          collectSelect(child, ctes, scopes, false);
        } else {
          walkExpr(child, scope, ctes, scopes);
        }
      }
      return;
    }
    case "create":
    case "alter":
    case "drop": {
      const scope = newScope(false);
      scopes.push(scope);
      for (const [key, child] of Object.entries(node)) {
        if (key === "table" || key === "loc") {
          continue;
        }
        if (isSelectNode(child)) {
          // CREATE TABLE/VIEW ... AS SELECT — top-level query, not correlated
          collectSelect(child, ctes, scopes, false);
        } else {
          walkExpr(child, scope, ctes, scopes);
        }
      }
      return;
    }
    default: {
      const scope = newScope(false);
      scopes.push(scope);
      for (const [key, child] of Object.entries(node)) {
        if (key === "loc") {
          continue;
        }
        walkExpr(child, scope, ctes, scopes);
      }
    }
  }
}

/**
 * Extracts the column name from a column_ref node. Depending on the dialect
 * grammar the column is either a plain string or `{expr: {value}}`.
 */
function getColumnName(ref: AstNode): string | null {
  const column = ref.column;
  if (typeof column === "string") {
    return column;
  }
  if (typeof column === "object" && column !== null) {
    const expr = (column as AstNode).expr as AstNode | undefined;
    const value = expr?.value ?? (column as AstNode).value;
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}

function getColumnQualifier(ref: AstNode): string | null {
  if (typeof ref.table !== "string" || ref.table.length === 0) {
    return null;
  }
  if (typeof ref.db === "string" && ref.db.length > 0) {
    return `${ref.db}.${ref.table}`;
  }
  return ref.table;
}

/** Extracts column names when the namespace node is a column array */
function columnsOf(namespace: SQLNamespace | undefined): string[] | null {
  if (namespace == null) {
    return null;
  }
  const resolved = isSelfChildrenNamespace(namespace) ? namespace.children : namespace;
  if (isArrayNamespace(resolved)) {
    return resolved.map((col) => (typeof col === "string" ? col : col.label));
  }
  return null;
}

interface ResolvedTable {
  exists: boolean;
  /** Column names when the table resolves to a column array; null otherwise */
  columns: string[] | null;
}

/**
 * Resolves a (possibly qualified) table path against the schema,
 * case-insensitively. An unqualified or partially-qualified name also matches
 * a table nested deeper in the namespace (e.g. `users` matches `mydb.users`)
 * so that under-qualified references are never flagged.
 */
function resolveTable(schema: SQLNamespace, path: string): ResolvedTable {
  const exact = traverseNamespacePath(schema, path, { caseSensitive: false });
  if (exact) {
    return { exists: true, columns: columnsOf(exact.namespace) };
  }

  const segments = path.split(".").map((segment) => segment.toLowerCase());
  const lastSegment = segments[segments.length - 1];
  if (!lastSegment) {
    return { exists: false, columns: null };
  }

  const matches = findNamespaceItemByEndMatch(schema, lastSegment).filter((item) => {
    if (columnsOf(item.namespace) === null) {
      return false; // only table-like matches (nodes holding a column array)
    }
    if (item.path.length < segments.length) {
      return false;
    }
    const suffix = item.path.slice(-segments.length).map((segment) => segment.toLowerCase());
    return segments.every((segment, i) => suffix[i] === segment);
  });

  if (matches.length === 0) {
    return { exists: false, columns: null };
  }
  // Only trust the column list when the match is unambiguous
  return {
    exists: true,
    columns: matches.length === 1 ? columnsOf(matches[0]?.namespace) : null,
  };
}

function includesIgnoreCase(haystack: string[], needle: string): boolean {
  const lower = needle.toLowerCase();
  return haystack.some((item) => item.toLowerCase() === lower);
}

/**
 * Runs the semantic checks for one parsed statement and returns findings,
 * deduplicated by kind + identifier.
 */
function analyzeStatementAst(ast: AstNode, schema: SQLNamespace): SemanticFinding[] {
  const scopes: QueryScope[] = [];
  collectStatement(ast, scopes);

  const findings = new Map<string, SemanticFinding>();
  const addFinding = (finding: SemanticFinding) => {
    const key = `${finding.kind}::${finding.identifier.toLowerCase()}`;
    if (!findings.has(key)) {
      findings.set(key, finding);
    }
  };

  for (const scope of scopes) {
    const resolved = scope.sources.map((source) => {
      if (source.opaque || source.isCte) {
        return { source, exists: true, columns: null };
      }
      const table = resolveTable(schema, source.path);
      return { source, exists: table.exists, columns: table.columns };
    });

    for (const { source, exists } of resolved) {
      if (!source.opaque && !source.isCte && !exists) {
        addFinding({
          kind: "unknownTable",
          identifier: source.name,
          message: `Unknown table '${source.path}'`,
        });
      }
    }

    for (const ref of scope.columnRefs) {
      const name = getColumnName(ref);
      if (!name || name === "*") {
        continue;
      }

      const qualifier = getColumnQualifier(ref);
      if (qualifier) {
        const lowerQualifier = qualifier.toLowerCase();
        const match =
          resolved.find((entry) => entry.source.alias?.toLowerCase() === lowerQualifier) ??
          resolved.find(
            (entry) =>
              entry.source.name.toLowerCase() === lowerQualifier ||
              entry.source.path.toLowerCase() === lowerQualifier,
          );
        // An unresolved qualifier may be an outer-scope alias; skip it
        if (match?.columns && !includesIgnoreCase(match.columns, name)) {
          addFinding({
            kind: "unknownColumn",
            identifier: name,
            message: `Column '${name}' not found in table '${match.source.path || qualifier}'`,
          });
        }
        continue;
      }

      if (!scope.checkUnqualified || scope.selectAliases.has(name.toLowerCase())) {
        continue;
      }

      const containing = resolved.filter(
        (entry) => entry.columns !== null && includesIgnoreCase(entry.columns, name),
      );
      if (containing.length >= 2 && !scope.hasUsingJoin) {
        addFinding({
          kind: "ambiguousColumn",
          identifier: name,
          message: `Column '${name}' is ambiguous; it exists in ${containing
            .map((entry) => entry.source.name)
            .join(", ")}`,
        });
        continue;
      }
      // Only flag unknown columns when the scope reads exactly one table
      // whose columns are fully known — anything else is not confidently
      // resolvable and false positives are worse than under-reporting
      const only = resolved.length === 1 ? resolved[0] : undefined;
      if (only && only.columns !== null && containing.length === 0) {
        addFinding({
          kind: "unknownColumn",
          identifier: name,
          message: `Column '${name}' not found in table '${only.source.path}'`,
        });
      }
    }
  }

  return [...findings.values()];
}

/**
 * Finds an identifier occurrence (word-bounded, case-insensitive) in text.
 * Used to position diagnostics, since node-sql-parser's name lists and AST
 * nodes for tables/columns carry no location information.
 */
function findIdentifier(text: string, name: string): number {
  const lowerText = text.toLowerCase();
  const needle = name.toLowerCase();
  let index = lowerText.indexOf(needle);
  while (index !== -1) {
    const before = index > 0 ? (lowerText[index - 1] ?? "") : "";
    const after = lowerText[index + needle.length] ?? "";
    if (!/[\w$]/.test(before) && !/[\w$]/.test(after)) {
      return index;
    }
    index = lowerText.indexOf(needle, index + 1);
  }
  return -1;
}

function findingToDiagnostic(
  finding: SemanticFinding,
  stmt: SqlStatement,
  doc: Text,
  severity: "error" | "warning",
): Diagnostic {
  const statementText = doc.sliceString(stmt.from, stmt.to);
  const offset = findIdentifier(statementText, finding.identifier);
  const from = offset === -1 ? stmt.from : stmt.from + offset;
  const to =
    offset === -1
      ? Math.min(stmt.from + (statementText.match(/^[\w"'`.]+/)?.[0].length ?? 1), stmt.to)
      : Math.min(from + finding.identifier.length, stmt.to);

  return {
    from,
    to,
    severity,
    message: finding.message,
    source: "sql-schema",
  };
}

/** True when the schema has nothing to validate against */
function isEmptySchema(schema: SQLNamespace): boolean {
  if (isArrayNamespace(schema)) {
    return schema.length === 0;
  }
  if (isObjectNamespace(schema)) {
    return Object.keys(schema).length === 0;
  }
  return false;
}

function createSemanticLintSource(config: SqlSemanticLinterConfig = {}) {
  const parser = config.parser || new NodeSqlParser();
  const analyzer = config.structureAnalyzer || new SqlStructureAnalyzer(parser);
  const severities = {
    unknownTable: config.severity?.unknownTable ?? "warning",
    unknownColumn: config.severity?.unknownColumn ?? "warning",
    ambiguousColumn: config.severity?.ambiguousColumn ?? "warning",
  } as const;

  return async (view: EditorView): Promise<Diagnostic[]> => {
    const schema = resolveSqlSchema(config.schema, view);
    // No schema (or an empty placeholder while it loads) → stay inert rather
    // than flagging every table as unknown
    if (schema == null || isEmptySchema(schema)) {
      return [];
    }

    const doc = view.state.doc;
    if (!doc.toString().trim()) {
      return [];
    }

    const diagnostics: Diagnostic[] = [];
    const statements = await analyzer.analyzeDocument(view.state);
    for (const stmt of statements) {
      // Never stack semantic noise on top of syntax errors
      if (!stmt.isValid) {
        continue;
      }
      const result = await parser.parse(stmt.content, { state: view.state });
      if (!result.success || result.ast == null) {
        continue;
      }
      const asts = Array.isArray(result.ast) ? result.ast : [result.ast];
      for (const ast of asts) {
        for (const finding of analyzeStatementAst(ast as AstNode, schema)) {
          const severity = severities[finding.kind];
          if (severity === "off") {
            continue;
          }
          diagnostics.push(findingToDiagnostic(finding, stmt, doc, severity));
        }
      }
    }
    return diagnostics;
  };
}

/**
 * Creates a schema-aware SQL linter extension that validates queries against
 * a database schema, reporting unknown tables, unknown columns, and ambiguous
 * column references.
 *
 * Checks only run on statements that parse cleanly, and skip anything that is
 * not confidently resolvable (CTEs, subquery outputs, aliases from outer
 * scopes, expressions), preferring under-reporting over false positives.
 *
 * @param config Configuration options for the semantic linter
 * @returns A CodeMirror linter extension
 *
 * @example
 * ```ts
 * import { sqlSemanticLinter } from '@marimo-team/codemirror-sql';
 *
 * const linter = sqlSemanticLinter({
 *   schema: { users: ['id', 'name'], posts: ['id', 'user_id'] },
 *   severity: { unknownTable: 'error' },
 * });
 * ```
 */
export function sqlSemanticLinter(config: SqlSemanticLinterConfig = {}): Extension {
  return linter(createSemanticLintSource(config), {
    delay: config.delay || DEFAULT_DELAY,
  });
}

export const exportedForTesting = { createSemanticLintSource };
