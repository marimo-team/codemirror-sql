import type { SQLDialect } from "@codemirror/lang-sql";
import type { Extension } from "@codemirror/state";
import { aliasColumnCompletionSource } from "./alias-completion-source.js";
import { unqualifiedColumnCompletionSource } from "./column-completion-source.js";
import { createCteCompletionSource } from "./cte-completion-source.js";
import { NodeSqlParser } from "./parser.js";
import { QueryContextAnalyzer } from "./query-context.js";
import type { SqlSchemaSource } from "./schema-facet.js";
import type { SqlParser } from "./types.js";

/**
 * Configuration for {@link sqlCompletion}, the convenience helper that
 * registers every schema-aware SQL completion source at once.
 */
export interface SqlCompletionConfig {
  /**
   * The SQL dialect whose language the completion sources are registered on
   * (e.g. `PostgreSQL`, or a dialect from `./dialects`). This must match the
   * dialect passed to `sql({ dialect })` for the sources to activate.
   */
  dialect: SQLDialect;
  /**
   * Database schema to complete columns from. Falls back to the shared
   * `sqlSchemaFacet` when not provided. Not used by CTE completion, which
   * derives columns from the statement itself.
   */
  schema?: SqlSchemaSource;
  /**
   * Custom SQL parser shared by all completion sources. Defaults to a new
   * `NodeSqlParser`. Pass the same instance used by the linter/hover so
   * dialect-specific setups only configure the parser once.
   */
  parser?: SqlParser;
  /**
   * Query-context analyzer shared by all completion sources, so each edit is
   * analyzed once. Defaults to one built from `parser`.
   */
  contextAnalyzer?: QueryContextAnalyzer;

  /** Whether to enable CTE name/column completion (default: true) */
  enableCteCompletion?: boolean;
  /** Whether to enable alias-qualified column completion (default: true) */
  enableAliasCompletion?: boolean;
  /** Whether to enable unqualified column completion (default: true) */
  enableColumnCompletion?: boolean;
}

/**
 * Registers every schema-aware SQL completion source in one call, so you don't
 * have to wire up each `dialect.language.data.of({ autocomplete })` by hand:
 * - {@link createCteCompletionSource} — CTE names and their output columns
 * - {@link aliasColumnCompletionSource} — `u.` → columns of `users` in
 *   `SELECT ... FROM users u`
 * - {@link unqualifiedColumnCompletionSource} — `SELECT e` → `email` from the
 *   statement's FROM/JOIN tables
 *
 * A single parser and query-context analyzer are shared across the sources so
 * each edit is analyzed only once. This complements `sqlExtension`, which
 * covers linting, hover, gutter, and navigation but not completion.
 *
 * @example
 * ```ts
 * import { sql, PostgreSQL } from '@codemirror/lang-sql';
 * import { sqlCompletion } from '@marimo-team/codemirror-sql';
 *
 * const schema = { users: ['id', 'name', 'email'] };
 * const extensions = [
 *   sql({ dialect: PostgreSQL, schema }),
 *   sqlCompletion({ dialect: PostgreSQL, schema }),
 * ];
 * ```
 */
export function sqlCompletion(config: SqlCompletionConfig): Extension[] {
  const {
    dialect,
    schema,
    parser = new NodeSqlParser(),
    enableCteCompletion = true,
    enableAliasCompletion = true,
    enableColumnCompletion = true,
  } = config;
  const contextAnalyzer = config.contextAnalyzer ?? new QueryContextAnalyzer(parser);

  const extensions: Extension[] = [];

  if (enableCteCompletion) {
    extensions.push(
      dialect.language.data.of({
        autocomplete: createCteCompletionSource({ parser, contextAnalyzer }),
      }),
    );
  }

  if (enableAliasCompletion) {
    extensions.push(
      dialect.language.data.of({
        autocomplete: aliasColumnCompletionSource({ schema, parser, contextAnalyzer }),
      }),
    );
  }

  if (enableColumnCompletion) {
    extensions.push(
      dialect.language.data.of({
        autocomplete: unqualifiedColumnCompletionSource({ schema, parser, contextAnalyzer }),
      }),
    );
  }

  return extensions;
}
