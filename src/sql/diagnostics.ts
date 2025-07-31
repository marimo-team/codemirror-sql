import { type Diagnostic, linter } from "@codemirror/lint";
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { type SqlParseError, SqlParser } from "./parser.js";

const DEFAULT_DELAY = 750;

export interface SqlLinterConfig {
  delay?: number;
  parser?: SqlParser;
}

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
