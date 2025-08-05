import type { SQLNamespace } from "@codemirror/lang-sql";
import type { EditorState, Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { type SqlLinterConfig, sqlLinter } from "./diagnostics.js";
import { type SqlHoverConfig, sqlHover, sqlHoverTheme } from "./hover.js";
import { NodeSqlParser } from "./parser.js";
import { type SqlGutterConfig, sqlStructureGutter } from "./structure-extension.js";

/**
 * Configuration options for the SQL extension
 */
export interface SqlExtensionConfig {
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

  /** Database schema for validation and hover tooltips */
  schema?: SQLNamespace | ((state: EditorState) => SQLNamespace);
}

/**
 * Creates a comprehensive SQL extension for CodeMirror that includes:
 * - SQL syntax validation and linting with schema-aware validation
 * - Visual gutter indicators for SQL statements
 * - Hover tooltips for keywords, tables, and columns with context awareness
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
 *       schema: {
 *         users: ['id', 'name', 'email'],
 *         orders: ['id', 'user_id', 'order_date', 'total']
 *       },
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
    linterConfig,
    gutterConfig,
    hoverConfig,
    schema,
  } = config;

  if (enableLinting) {
    extensions.push(
      sqlLinter({
        ...linterConfig,
        ...(schema && { parser: new NodeSqlParser({ schema }) }),
      }),
    );
  }

  if (enableGutterMarkers) {
    extensions.push(sqlStructureGutter(gutterConfig));
  }

  if (enableHover) {
    extensions.push(
      sqlHover({
        ...hoverConfig,
        schema:
          hoverConfig?.schema ??
          (typeof schema === "function" ? (view: EditorView) => schema(view.state) : schema),
      }),
      sqlHoverTheme(),
    );
  }

  return extensions;
}
