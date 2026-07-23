import type { Completion, CompletionContext, CompletionSource } from "@codemirror/autocomplete";
import type { SQLNamespace } from "@codemirror/lang-sql";
import {
  findNamespaceItemByEndMatch,
  isArrayNamespace,
  isSelfChildrenNamespace,
  type ResolvedNamespaceItem,
  traverseNamespacePath,
} from "./namespace-utils.js";
import { NodeSqlParser } from "./parser.js";
import { type QueryContext, QueryContextAnalyzer } from "./query-context.js";
import { type SqlSchemaSource, sqlSchemaFacet } from "./schema-facet.js";
import { SqlStructureAnalyzer } from "./structure-analyzer.js";
import type { SqlParser } from "./types.js";

/**
 * Configuration for the alias-aware column completion source
 */
export interface AliasCompletionConfig {
  /**
   * Database schema to complete columns from. Falls back to the shared
   * `sqlSchemaFacet` when not provided.
   */
  schema?: SqlSchemaSource;
  /** Custom SQL parser instance to use for query analysis */
  parser?: SqlParser;
  /**
   * Query-context analyzer to reuse (e.g. the one backing hover), so the
   * statement is only analyzed once per edit.
   */
  contextAnalyzer?: QueryContextAnalyzer;
}

function resolveSchema(
  explicit: SqlSchemaSource | undefined,
  context: CompletionContext,
): SQLNamespace | null {
  const source = explicit ?? context.state.facet(sqlSchemaFacet);
  if (source == null) {
    return null;
  }
  if (typeof source === "function") {
    // Function sources need a view; contexts created without one (e.g. tests)
    // simply get no schema
    return context.view ? source(context.view) : null;
  }
  return source;
}

/** Column list of a namespace node, when it is (or wraps) a column array */
function columnsOf(namespace: SQLNamespace | undefined): readonly (Completion | string)[] | null {
  if (namespace == null) {
    return null;
  }
  const resolved = isSelfChildrenNamespace(namespace) ? namespace.children : namespace;
  return isArrayNamespace(resolved) ? resolved : null;
}

/**
 * Resolves a (possibly qualified) table path to its column list,
 * case-insensitively. An under-qualified name also matches a table nested
 * deeper in the namespace (e.g. `users` matches `mydb.users`).
 */
function findTableColumns(
  schema: SQLNamespace,
  tablePath: string,
): readonly (Completion | string)[] | null {
  const exact = traverseNamespacePath(schema, tablePath, { caseSensitive: false });
  const exactColumns = columnsOf(exact?.namespace);
  if (exactColumns) {
    return exactColumns;
  }

  const segments = tablePath.split(".").map((segment) => segment.toLowerCase());
  const lastSegment = segments[segments.length - 1];
  if (!lastSegment) {
    return null;
  }

  const matches = findNamespaceItemByEndMatch(schema, lastSegment).filter(
    (item: ResolvedNamespaceItem) => {
      if (columnsOf(item.namespace) === null) {
        return false;
      }
      if (item.path.length < segments.length) {
        return false;
      }
      const suffix = item.path.slice(-segments.length).map((segment) => segment.toLowerCase());
      return segments.every((segment, i) => suffix[i] === segment);
    },
  );

  // Only trust the column list when the match is unambiguous
  return matches.length === 1 ? columnsOf(matches[0]?.namespace) : null;
}

function toCompletion(column: Completion | string, detail: string): Completion {
  if (typeof column === "string") {
    return { label: column, type: "property", detail };
  }
  return { type: "property", detail, ...column };
}

/**
 * Creates a completion source that offers a table's columns after an alias
 * qualifier: with `SELECT ... FROM users u`, typing `u.` completes the columns
 * of `users`. Aliases of CTEs complete the CTE's declared/inferred columns.
 *
 * @example
 * ```ts
 * import { aliasColumnCompletionSource } from '@marimo-team/codemirror-sql';
 * import { StandardSQL } from '@codemirror/lang-sql';
 *
 * StandardSQL.language.data.of({
 *   autocomplete: aliasColumnCompletionSource({ schema: { users: ['id', 'name'] } }),
 * })
 * ```
 */
export function aliasColumnCompletionSource(config: AliasCompletionConfig = {}): CompletionSource {
  const parser = config.parser ?? new NodeSqlParser();
  const contextAnalyzer = config.contextAnalyzer ?? new QueryContextAnalyzer(parser);
  const structureAnalyzer = new SqlStructureAnalyzer(parser);

  return async (context: CompletionContext) => {
    // Match `<alias>.<partial>` immediately before the cursor
    const match = context.matchBefore(/[\w$]+\.[\w$]*/);
    if (!match) {
      return null;
    }
    // Skip multi-segment paths like `db.table.` — only bare qualifiers can be
    // aliases
    if (context.state.sliceDoc(Math.max(0, match.from - 1), match.from) === ".") {
      return null;
    }

    const dotIndex = match.text.indexOf(".");
    const qualifier = match.text.slice(0, dotIndex);

    const statement = await structureAnalyzer.getStatementAtPosition(context.state, context.pos);
    const statementSql = statement
      ? context.state.sliceDoc(statement.from, statement.to)
      : context.state.doc.toString();
    const queryContext: QueryContext = await contextAnalyzer.getContext(statementSql, {
      state: context.state,
    });

    const target = queryContext.aliases.get(qualifier.toLowerCase());
    if (!target) {
      return null;
    }

    let columns: readonly (Completion | string)[] | null = null;

    // Alias of a CTE: use the CTE's declared/inferred output columns
    const cte = queryContext.ctes.find((c) => c.name.toLowerCase() === target.toLowerCase());
    if (cte && cte.columns.length > 0) {
      columns = cte.columns;
    } else if (!cte) {
      const schema = resolveSchema(config.schema, context);
      if (schema != null) {
        columns = findTableColumns(schema, target);
      }
    }

    if (!columns || columns.length === 0) {
      return null;
    }

    const detail = `column of ${target}`;
    return {
      from: match.from + dotIndex + 1,
      options: columns.map((column) => toCompletion(column, detail)),
      validFor: /^[\w$]*$/,
    };
  };
}
