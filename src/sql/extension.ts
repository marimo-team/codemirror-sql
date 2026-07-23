import type { Extension } from "@codemirror/state";
import { type SqlLinterConfig, sqlLinter } from "./diagnostics.js";
import { defaultSqlHoverTheme, type SqlHoverConfig, sqlHover } from "./hover.js";
import { type SqlSchemaSource, sqlSchemaFacet } from "./schema-facet.js";
import { type SqlSemanticLinterConfig, sqlSemanticLinter } from "./semantic-diagnostics.js";
import { type SqlGutterConfig, sqlStructureGutter } from "./structure-extension.js";

/**
 * Configuration options for the SQL extension
 */
export interface SqlExtensionConfig {
  /**
   * Database schema shared by all schema-aware features (hover tooltips and
   * semantic linting), registered via `sqlSchemaFacet`. Per-feature `schema`
   * options in `hoverConfig`/`semanticLinterConfig` take precedence.
   *
   * Function sources are called on every lint/hover pass and should be
   * cheap/memoized.
   */
  schema?: SqlSchemaSource;

  /** Whether to enable SQL linting (default: true) */
  enableLinting?: boolean;
  /** Configuration for the SQL linter */
  linterConfig?: SqlLinterConfig;

  /**
   * Whether to enable schema-aware semantic linting — unknown tables, unknown
   * columns, ambiguous columns (default: true). Inert unless a schema is
   * provided (via `schema` or `semanticLinterConfig.schema`).
   */
  enableSemanticLinting?: boolean;
  /** Configuration for the semantic linter */
  semanticLinterConfig?: SqlSemanticLinterConfig;

  /** Whether to enable gutter markers for SQL statements (default: true) */
  enableGutterMarkers?: boolean;
  /** Configuration for the SQL gutter markers */
  gutterConfig?: SqlGutterConfig;

  /** Whether to enable hover tooltips (default: true) */
  enableHover?: boolean;
  /** Configuration for hover tooltips */
  hoverConfig?: SqlHoverConfig;
}

/**
 * Creates a comprehensive SQL extension for CodeMirror that includes:
 * - SQL syntax validation and linting
 * - Schema-aware semantic linting (unknown tables/columns, ambiguous columns)
 * - Visual gutter indicators for SQL statements
 * - Hover tooltips for keywords, tables, and columns
 *
 * @param config Configuration options for the extension
 * @returns An array of CodeMirror extensions
 *
 * @example
 * ```ts
 * import { sqlExtension } from '@marimo-team/codemirror-sql';
 *
 * const editor = new EditorView({
 *   extensions: [
 *     sqlExtension({
 *       schema: { users: ['id', 'name'] },
 *       linterConfig: { delay: 500 },
 *       gutterConfig: { backgroundColor: '#3b82f6' },
 *       hoverConfig: { hoverTime: 300 }
 *     })
 *   ]
 * });
 * ```
 */
export function sqlExtension(config: SqlExtensionConfig = {}): Extension[] {
  const extensions: Extension[] = [];
  const {
    schema,
    enableLinting = true,
    enableSemanticLinting = true,
    enableGutterMarkers = true,
    enableHover = true,
    linterConfig,
    semanticLinterConfig,
    gutterConfig,
    hoverConfig,
  } = config;

  if (schema != null) {
    extensions.push(sqlSchemaFacet.of(schema));
  }

  if (enableLinting) {
    extensions.push(sqlLinter(linterConfig));
  }

  if (enableSemanticLinting) {
    // Reuse the syntax linter's parser/analyzer so dialect-specific setups
    // don't have to configure them twice (and semantic checks don't disagree
    // with the syntax linter about what parses)
    extensions.push(
      sqlSemanticLinter({
        ...semanticLinterConfig,
        parser: semanticLinterConfig?.parser ?? linterConfig?.parser,
        structureAnalyzer:
          semanticLinterConfig?.structureAnalyzer ?? linterConfig?.structureAnalyzer,
      }),
    );
  }

  if (enableGutterMarkers) {
    extensions.push(sqlStructureGutter(gutterConfig));
  }

  if (enableHover) {
    extensions.push(sqlHover(hoverConfig));
    extensions.push(hoverConfig?.theme ?? defaultSqlHoverTheme());
  }

  return extensions;
}
