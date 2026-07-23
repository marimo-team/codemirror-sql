import type { Completion, CompletionContext, CompletionSource } from "@codemirror/autocomplete";
import { findTableColumns, resolveSchema, toCompletion } from "./completion-utils.js";
import { NodeSqlParser } from "./parser.js";
import {
  type QueryContext,
  QueryContextAnalyzer,
  stripIdentifierQuotes,
} from "./query-context.js";
import type { SqlSchemaSource } from "./schema-facet.js";
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
    // Match `<alias>.<partial>` immediately before the cursor; the alias may
    // be a quoted identifier ("ut"., `ut`., [ut].)
    const match = context.matchBefore(/(?:[\w$]+|"[^"]+"|`[^`]+`|\[[^\]]+\])\.[\w$]*/);
    if (!match) {
      return null;
    }
    // Skip multi-segment paths like `db.table.` — only bare qualifiers can be
    // aliases
    if (context.state.sliceDoc(Math.max(0, match.from - 1), match.from) === ".") {
      return null;
    }

    // The partial after the dot contains no dots, so the last dot is the
    // qualifier separator even for quoted qualifiers like `"a.b".`
    const dotIndex = match.text.lastIndexOf(".");
    const qualifier = stripIdentifierQuotes(match.text.slice(0, dotIndex));

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
