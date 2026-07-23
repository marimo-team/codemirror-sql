import type { Completion, CompletionContext, CompletionSource } from "@codemirror/autocomplete";
import { findTableColumns, resolveSchema, toCompletion } from "./completion-utils.js";
import { NodeSqlParser } from "./parser.js";
import { type QueryContext, QueryContextAnalyzer } from "./query-context.js";
import type { SqlSchemaSource } from "./schema-facet.js";
import { SqlStructureAnalyzer } from "./structure-analyzer.js";
import type { SqlParser } from "./types.js";

/**
 * Configuration for the unqualified column completion source
 */
export interface ColumnCompletionConfig {
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

/** Slight boost so columns rank just above keyword completions */
const COLUMN_BOOST = 1;

/** Keywords after which a table name (not a column) is expected */
const TABLE_POSITION_PATTERN = /\b(?:from|join|into|update|table)\s+$/i;

/**
 * Creates a completion source that offers columns of the tables referenced in
 * the current statement's FROM/JOIN clauses for unqualified prefixes: with
 * `SELECT e FROM users`, typing `e` completes `email` even when multiple
 * tables exist in the schema. Tables that resolve to CTEs complete the CTE's
 * declared/inferred columns.
 *
 * @example
 * ```ts
 * import { unqualifiedColumnCompletionSource } from '@marimo-team/codemirror-sql';
 * import { StandardSQL } from '@codemirror/lang-sql';
 *
 * StandardSQL.language.data.of({
 *   autocomplete: unqualifiedColumnCompletionSource({ schema: { users: ['id', 'name'] } }),
 * })
 * ```
 */
export function unqualifiedColumnCompletionSource(
  config: ColumnCompletionConfig = {},
): CompletionSource {
  const parser = config.parser ?? new NodeSqlParser();
  const contextAnalyzer = config.contextAnalyzer ?? new QueryContextAnalyzer(parser);
  const structureAnalyzer = new SqlStructureAnalyzer(parser);

  return async (context: CompletionContext) => {
    const word = context.matchBefore(/[\w$]*/);
    if (!word) {
      return null;
    }
    if (word.from === word.to && !context.explicit) {
      return null;
    }
    // Qualified paths (`u.`, `db.table.`) belong to the alias and schema
    // completion sources
    if (context.state.sliceDoc(Math.max(0, word.from - 1), word.from) === ".") {
      return null;
    }
    // Don't offer columns where a table name is expected
    const before = context.state.sliceDoc(Math.max(0, word.from - 64), word.from);
    if (TABLE_POSITION_PATTERN.test(before)) {
      return null;
    }

    const statement = await structureAnalyzer.getStatementAtPosition(context.state, context.pos);
    const statementSql = statement
      ? context.state.sliceDoc(statement.from, statement.to)
      : context.state.doc.toString();
    const queryContext: QueryContext = await contextAnalyzer.getContext(statementSql, {
      state: context.state,
    });
    if (queryContext.tables.length === 0) {
      return null;
    }

    const schema = resolveSchema(config.schema, context);
    const options: Completion[] = [];
    const seenLabels = new Set<string>();
    const seenPaths = new Set<string>();

    for (const table of queryContext.tables) {
      const tablePath = table.path.join(".");
      const pathKey = tablePath.toLowerCase();
      if (seenPaths.has(pathKey)) {
        continue;
      }
      seenPaths.add(pathKey);

      // A table that names a CTE uses the CTE's declared/inferred columns
      const cte = queryContext.ctes.find((c) => c.name.toLowerCase() === table.name.toLowerCase());
      let columns: readonly (Completion | string)[] | null = null;
      if (cte) {
        columns = cte.columns.length > 0 ? cte.columns : null;
      } else if (schema != null) {
        columns = findTableColumns(schema, tablePath);
      }
      if (!columns) {
        continue;
      }

      const detail = `column of ${table.name}`;
      for (const column of columns) {
        const label = typeof column === "string" ? column : column.label;
        const labelKey = label.toLowerCase();
        if (seenLabels.has(labelKey)) {
          continue;
        }
        seenLabels.add(labelKey);
        options.push(toCompletion(column, detail, COLUMN_BOOST));
      }
    }

    if (options.length === 0) {
      return null;
    }

    return {
      from: word.from,
      options,
      validFor: /^[\w$]*$/,
    };
  };
}
