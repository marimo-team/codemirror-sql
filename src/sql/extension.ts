import type { Extension } from "@codemirror/state";
import { type SqlLinterConfig, sqlLinter } from "./diagnostics.js";
import { type SqlHoverConfig, sqlHover, sqlHoverTheme } from "./hover.js";
import { SqlParser } from "./parser.js";
import { type SqlGutterConfig, sqlStructureGutter } from "./structure-extension.js";

/**
 * Configuration options for the SQL extension
 */
export interface SqlExtensionConfig {
  /**
   * The SQL parser used for linting and gutter markers.
   * If not provided, a default PostgreSQL parser is created.
   * The parser instance is shared across the extension.
   */
  sqlParser?: SqlParser;

  /** Whether to enable SQL linting (default: true) */
  enableLinting?: boolean;
  /** Configuration for the SQL linter */
  linterConfig?: SqlLinterConfig;

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
    enableLinting = true,
    enableGutterMarkers = true,
    enableHover = true,
    sqlParser,
    linterConfig,
    gutterConfig,
    hoverConfig,
  } = config;

  if (enableLinting || enableGutterMarkers) {
    const parser = sqlParser ?? new SqlParser({ dialect: "PostgresQL" });

    if (enableLinting) {
      extensions.push(sqlLinter(parser, linterConfig));
    }

    if (enableGutterMarkers) {
      extensions.push(sqlStructureGutter(parser, gutterConfig));
    }
  }

  if (enableHover) {
    extensions.push(sqlHover(hoverConfig));
    extensions.push(sqlHoverTheme());
  }

  return extensions;
}
