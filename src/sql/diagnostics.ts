import { type Diagnostic, linter } from "@codemirror/lint";
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { type SqlParseError, SqlParser } from "./parser.js";

const DEFAULT_DELAY = 750;

/**
 * Configuration options for the SQL linter
 */
export interface SqlLinterConfig {
  /** Delay in milliseconds before running validation (default: 750) */
  delay?: number;
  /** Custom SQL parser instance to use for validation */
  parser?: SqlParser;
}

/**
 * Converts a SQL parse error to a CodeMirror diagnostic
 */
function convertToCodeMirrorDiagnostic(error: SqlParseError, doc: Text): Diagnostic {
  const lineStart = doc.line(error.line).from;
  const from = lineStart + Math.max(0, error.column - 1);
  const to = from + 1;

  return {
    from,
    to,
    severity: error.severity,
    message: error.message,
    source: "sql-parser",
  };
}

/**
 * Creates a SQL linter extension that validates SQL syntax and reports errors
 *
 * @param config Configuration options for the linter
 * @returns A CodeMirror linter extension
 *
 * @example
 * ```ts
 * import { sqlLinter } from '@marimo-team/codemirror-sql';
 *
 * const linter = sqlLinter({
 *   delay: 500, // 500ms delay before validation
 *   parser: new SqlParser() // custom parser instance
 * });
 * ```
 */
export function sqlLinter(config: SqlLinterConfig = {}) {
  const parser = config.parser || new SqlParser();

  return linter(
    (view: EditorView): Diagnostic[] => {
      const doc = view.state.doc;
      const sql = doc.toString();

      if (!sql.trim()) {
        return [];
      }

      const errors = parser.validateSql(sql);

      return errors.map((error) => convertToCodeMirrorDiagnostic(error, doc));
    },
    {
      delay: config.delay || DEFAULT_DELAY,
    },
  );
}
