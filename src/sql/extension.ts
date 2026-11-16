import { createSqlAnalysis, type SqlAnalysis, type SqlAnalysisConfig } from "./analysis.js";
import type { Extension } from "@codemirror/state";
import { type SqlLinterConfig, sqlLinter } from "./diagnostics.js";
import { defaultSqlHoverTheme, type SqlHoverConfig, sqlHover } from "./hover.js";
import { type SqlNavigationConfig, sqlNavigation } from "./navigation-extension.js";
import { type SqlSchemaSource, sqlSchemaFacet } from "./schema-facet.js";
import { type SqlSemanticLinterConfig, sqlSemanticLinter } from "./semantic-diagnostics.js";
import { type SqlGutterConfig, sqlStructureGutter } from "./structure-extension.js";

/**
 * Configuration options for the SQL extension
 */
export interface SqlExtensionConfig extends SqlAnalysisConfig {
  /** Refresh linting and gutter analysis when parser configuration changes. */
  needsRefresh?: (update: import("@codemirror/view").ViewUpdate) => boolean;
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

  /**
   * Whether to enable navigation features — reference highlights and
   * Mod-click go-to-definition for CTEs and aliases (default: true).
   * Keybindings (F12/Mod-b/F2) are opt-in via `navigationConfig.keymap`.
   */
  enableNavigation?: boolean;
  /** Configuration for navigation features */
  navigationConfig?: SqlNavigationConfig;
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
    enableNavigation = true,
    linterConfig,
    semanticLinterConfig,
    gutterConfig,
    hoverConfig,
    navigationConfig,
  } = config;

  if (schema != null) {
    extensions.push(sqlSchemaFacet.of(schema));
  }

  const analysis = createSqlAnalysis(config);
  const forFeature = (feature: SqlAnalysisConfig = {}, fallback: SqlAnalysis = analysis) => {
    if (feature.parser && feature.parser !== fallback.parser) {
      return createSqlAnalysis(feature);
    }
    return createSqlAnalysis({
      parser: fallback.parser,
      structureAnalyzer: feature.structureAnalyzer ?? fallback.structureAnalyzer,
      contextAnalyzer: feature.contextAnalyzer ?? fallback.contextAnalyzer,
    });
  };
  const syntaxAnalysis = forFeature(linterConfig);
  const hasSharedAnalysis =
    config.parser != null || config.structureAnalyzer != null || config.contextAnalyzer != null;
  const inheritedAnalysis = hasSharedAnalysis ? analysis : syntaxAnalysis;

  if (enableLinting) {
    extensions.push(sqlLinter({
      ...linterConfig,
      ...syntaxAnalysis,
      needsRefresh: linterConfig?.needsRefresh ?? config.needsRefresh,
    }));
  }
  if (enableSemanticLinting) {
    extensions.push(sqlSemanticLinter({
      ...semanticLinterConfig,
      ...forFeature(semanticLinterConfig, inheritedAnalysis),
      needsRefresh: semanticLinterConfig?.needsRefresh ?? config.needsRefresh,
    }));
  }
  if (enableGutterMarkers) {
    extensions.push(sqlStructureGutter({
      ...gutterConfig,
      ...forFeature(gutterConfig),
      needsRefresh: gutterConfig?.needsRefresh ?? config.needsRefresh,
    }));
  }
  if (enableHover) {
    extensions.push(sqlHover({ ...hoverConfig, ...forFeature(hoverConfig) }));
    extensions.push(hoverConfig?.theme ?? defaultSqlHoverTheme());
  }
  if (enableNavigation) {
    extensions.push(...sqlNavigation({ ...navigationConfig, ...forFeature(navigationConfig, inheritedAnalysis) }));
  }

  return extensions;
}
