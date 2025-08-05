import { type Diagnostic, linter } from "@codemirror/lint";
import type { Extension, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { NodeSqlParser } from "./parser.js";
import type { SqlParseError, SqlParser } from "./types.js";

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
export function convertToCodeMirrorDiagnostic(error: SqlParseError, doc: Text): Diagnostic {
  const line = doc.line(error.line);
  const lineStart = line.from;

  // Calculate the start position of the error
  const from = lineStart + Math.max(0, error.column - 1);

  // For column errors, try to span the entire column name
  let to = from + 1; // Default to single character

  // If this is a column error, try to find the column name length
  if (error.message.includes("Column") && error.message.includes("does not exist")) {
    // Extract column name from error message
    const columnMatch = error.message.match(/Column '([^']+)' does not exist/);
    if (columnMatch?.[1]) {
      const columnName = columnMatch[1];
      // Find the column name in the line text starting from the error column
      const lineText = line.text;
      const startSearchPos = Math.max(0, error.column - 1);
      const columnIndex = lineText.indexOf(columnName, startSearchPos);
      if (columnIndex !== -1) {
        to = lineStart + columnIndex + columnName.length;
      } else {
        // If not found from the error column, try to find it anywhere in the line
        const globalIndex = lineText.indexOf(columnName);
        if (globalIndex !== -1) {
          to = lineStart + globalIndex + columnName.length;
        }
      }
    }
  }

  // Handle the case where the error is reported on a comment line but should be on the SQL line
  // This happens when the parser reports the wrong line number due to comments
  if (line.text.trim().startsWith("--")) {
    // Find the next non-comment line that contains SQL
    for (let i = error.line; i < doc.lines; i++) {
      const nextLine = doc.line(i + 1);
      const nextLineText = nextLine.text.trim();
      if (nextLineText && !nextLineText.startsWith("--")) {
        // Found a non-comment line, check if it contains the error
        if (error.message.includes("Column") && error.message.includes("does not exist")) {
          const columnMatch = error.message.match(/Column '([^']+)' does not exist/);
          if (columnMatch?.[1]) {
            const columnName = columnMatch[1];
            const columnIndex = nextLineText.indexOf(columnName);
            if (columnIndex !== -1) {
              return {
                from: nextLine.from + columnIndex,
                to: nextLine.from + columnIndex + columnName.length,
                severity: error.severity,
                message: error.message,
                source: "sql-parser",
              };
            }
          }
        }
        break;
      }
    }
  }

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
export function sqlLinter(config: SqlLinterConfig = {}): Extension {
  const parser = config.parser || new NodeSqlParser();

  return linter(
    async (view: EditorView): Promise<Diagnostic[]> => {
      const doc = view.state.doc;
      const sql = doc.toString();

      if (!sql.trim()) {
        return [];
      }

      const errors = await parser.validateSql(sql, { state: view.state });

      return errors.map((error) => convertToCodeMirrorDiagnostic(error, doc));
    },
    {
      delay: config.delay || DEFAULT_DELAY,
    },
  );
}
