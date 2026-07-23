import { type Diagnostic, linter } from "@codemirror/lint";
import type { Extension, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { NodeSqlParser } from "./parser.js";
import { type SqlStatement, SqlStructureAnalyzer } from "./structure-analyzer.js";
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
  /**
   * Lint each statement in the document separately so every broken statement
   * gets its own diagnostic, instead of stopping at the first parse error (default: true)
   */
  perStatement?: boolean;
  /**
   * Structure analyzer used to split the document into statements.
   * Pass a shared instance (e.g. the one used by the gutter) to reuse its cache.
   */
  structureAnalyzer?: SqlStructureAnalyzer;
}

/**
 * Extends an error span from `from` to cover the token at that position,
 * so the squiggle covers the offending word instead of a single character.
 */
function tokenEndAt(doc: Text, from: number): number {
  if (from >= doc.length) {
    return doc.length;
  }
  const line = doc.lineAt(from);
  const match = line.text.slice(from - line.from).match(/^[\w"'`.]+/);
  return match ? from + match[0].length : Math.min(from + 1, doc.length);
}

/**
 * Converts a SQL parse error (relative to the whole document) to a CodeMirror diagnostic
 */
function convertToCodeMirrorDiagnostic(error: SqlParseError, doc: Text): Diagnostic {
  const line = doc.line(Math.min(error.line, doc.lines));
  const from = Math.min(line.from + Math.max(0, error.column - 1), doc.length);

  return {
    from,
    to: tokenEndAt(doc, from),
    severity: error.severity,
    message: error.message,
    source: "sql-parser",
  };
}

/**
 * Converts a SQL parse error whose line/column are relative to a statement's
 * content into a CodeMirror diagnostic positioned in the document.
 *
 * Error line 1 corresponds to the statement's first line, with columns
 * relative to `stmt.from` (the statement content is trimmed, so its first
 * character is exactly at `stmt.from`).
 */
function convertStatementErrorToDiagnostic(
  error: SqlParseError,
  stmt: SqlStatement,
  doc: Text,
): Diagnostic {
  let from: number;
  if (error.line <= 1) {
    from = stmt.from + Math.max(0, error.column - 1);
  } else {
    const line = doc.line(Math.min(stmt.lineFrom + error.line - 1, doc.lines));
    from = line.from + Math.max(0, error.column - 1);
  }
  // Clamp within the statement's range in case the parser's reported
  // position drifts (e.g. comments are stripped before parsing)
  from = Math.max(stmt.from, Math.min(from, stmt.to));

  return {
    from,
    to: Math.max(from, Math.min(tokenEndAt(doc, from), stmt.to)),
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
  return linter(createLintSource(config), {
    delay: config.delay || DEFAULT_DELAY,
  });
}

function createLintSource(config: SqlLinterConfig = {}) {
  const parser = config.parser || new NodeSqlParser();
  const perStatement = config.perStatement !== false;
  const analyzer = config.structureAnalyzer || new SqlStructureAnalyzer(parser);

  return async (view: EditorView): Promise<Diagnostic[]> => {
    const doc = view.state.doc;
    const sql = doc.toString();

    if (!sql.trim()) {
      return [];
    }

    if (!perStatement) {
      const errors = await parser.validateSql(sql, { state: view.state });
      return errors.map((error) => convertToCodeMirrorDiagnostic(error, doc));
    }

    // Lint each statement independently so errors are reported for all
    // broken statements, not just the first one in the document
    const statements = await analyzer.analyzeDocument(view.state);
    return statements.flatMap((stmt) =>
      stmt.errors.map((error) => convertStatementErrorToDiagnostic(error, stmt, doc)),
    );
  };
}

export const exportedForTesting = { createLintSource };
