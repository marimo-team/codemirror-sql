import { scanSql, stripSqlComments } from "./scanner.js";
import type { EditorState } from "@codemirror/state";
import type { SqlParseError, SqlParserLike } from "./types.js";

export interface SqlStatement {
  /** Start position of the statement in the document */
  from: number;
  /** End position of the statement in the document */
  to: number;
  /** First line number of the statement (1-based) */
  lineFrom: number;
  /** Last line number of the statement (1-based) */
  lineTo: number;
  /** SQL prepared for display, with comments removed. */
  content: string;
  /** Type of SQL statement */
  type: "select" | "insert" | "update" | "delete" | "create" | "drop" | "alter" | "use" | "other";
  /** Whether this statement is syntactically valid */
  isValid: boolean;
  /** Parse errors relative to the original statement text at `from`. */
  errors: SqlParseError[];
}

/**
 * Analyzes SQL documents to extract statement boundaries and information
 * for use with gutter markers and other SQL-aware features.
 */
export class SqlStructureAnalyzer {
  private parser: SqlParserLike;
  private cache = new WeakMap<EditorState, Promise<SqlStatement[]>>();

  constructor(parser: SqlParserLike) {
    this.parser = parser;
  }

  async analyzeDocument(state: EditorState): Promise<SqlStatement[]> {
    const cache = this.cache;
    let statements = cache.get(state);
    if (!statements) {
      statements = this.extractStatements(state.doc.toString(), state);
      cache.set(state, statements);
      void statements.catch(() => cache.delete(state));
    }
    return statements;
  }

  async getStatementAtPosition(state: EditorState, position: number): Promise<SqlStatement | null> {
    const statements = await this.analyzeDocument(state);
    return statements.find((stmt) => position >= stmt.from && position <= stmt.to) || null;
  }

  async getStatementsInRange(
    state: EditorState,
    from: number,
    to: number,
  ): Promise<SqlStatement[]> {
    const statements = await this.analyzeDocument(state);
    return statements.filter(
      (stmt) => stmt.from <= to && stmt.to >= from,
    );
  }

  private async extractStatements(content: string, state: EditorState): Promise<SqlStatement[]> {
    const statements: SqlStatement[] = [];

    const parts = this.splitByStatementSeparators(content);
    let currentPosition = 0;

    for (const part of parts) {
      const trimmedPart = part.trim();
      if (trimmedPart.length === 0) {
        currentPosition += part.length;
        continue;
      }

      const from = currentPosition + part.indexOf(trimmedPart);
      const to = from + trimmedPart.length;

      const fromLine = state.doc.lineAt(from);
      const toLine = state.doc.lineAt(to);

      const strippedContent = this.stripComments(trimmedPart);

      if (strippedContent.trim().length === 0 || strippedContent.trim() === ";") {
        currentPosition += part.length;
        continue;
      }

      // Parse the original content (comments included) so error positions
      // reported by the parser line up with the document
      const parseResult = await this.parser.parse(trimmedPart, { state });
      const type = this.determineStatementType(strippedContent);

      const cleanContent = strippedContent.endsWith(";")
        ? strippedContent.slice(0, -1).trim()
        : strippedContent.trim();

      statements.push({
        from,
        to,
        lineFrom: fromLine.number,
        lineTo: toLine.number,
        content: cleanContent,
        type,
        isValid: parseResult.success,
        errors: parseResult.errors ?? [],
      });

      currentPosition += part.length;
    }

    return statements;
  }

  private splitByStatementSeparators(content: string): string[] {
    const parts: string[] = [];
    let from = 0;
    // Brackets remain array/subscript syntax here, matching the original statement splitter.
    for (const token of scanSql(content, { bracketIdentifiers: false })) {
      if (token.kind === "symbol" && token.text === ";") {
        parts.push(content.slice(from, token.to));
        from = token.to;
      }
    }
    if (from < content.length) parts.push(content.slice(from));
    return parts;
  }

  private determineStatementType(sql: string): SqlStatement["type"] {
    const trimmed = sql.trim().toLowerCase();

    if (trimmed.startsWith("select")) return "select";
    if (trimmed.startsWith("insert")) return "insert";
    if (trimmed.startsWith("update")) return "update";
    if (trimmed.startsWith("delete")) return "delete";
    if (trimmed.startsWith("create")) return "create";
    if (trimmed.startsWith("drop")) return "drop";
    if (trimmed.startsWith("alter")) return "alter";
    if (trimmed.startsWith("use")) return "use";

    return "other";
  }

  private stripComments(sql: string): string {
    return stripSqlComments(sql, { bracketIdentifiers: false });
  }

  clearCache(): void {
    this.cache = new WeakMap();
  }
}
