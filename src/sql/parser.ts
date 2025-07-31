import { Parser } from "node-sql-parser";

/**
 * Represents a SQL parsing error with location information
 */
export interface SqlParseError {
  /** Error message describing the issue */
  message: string;
  /** Line number where the error occurred (1-indexed) */
  line: number;
  /** Column number where the error occurred (1-indexed) */
  column: number;
  /** Severity level of the error */
  severity: "error" | "warning";
}

/**
 * Result of parsing a SQL statement
 */
export interface SqlParseResult {
  /** Whether parsing was successful */
  success: boolean;
  /** Array of parsing errors, if any */
  errors: SqlParseError[];
  /** The parsed AST if successful */
  ast?: unknown;
}

/**
 * A SQL parser wrapper around node-sql-parser with enhanced error handling
 * and validation capabilities for CodeMirror integration.
 */
export class SqlParser {
  private parser: Parser;

  constructor() {
    this.parser = new Parser();
  }

  parse(sql: string): SqlParseResult {
    try {
      const ast = this.parser.astify(sql);

      return {
        success: true,
        errors: [],
        ast,
      };
    } catch (error: unknown) {
      const parseError = this.extractErrorInfo(error, sql);
      return {
        success: false,
        errors: [parseError],
      };
    }
  }

  private extractErrorInfo(error: unknown, _sql: string): SqlParseError {
    let line = 1;
    let column = 1;
    const message = (error as Error)?.message || "SQL parsing error";

    const errorObj = error as {
      location?: { start?: { line: number; column: number } };
      hash?: { line: number; loc?: { first_column: number } };
    };
    if (errorObj?.location) {
      line = errorObj.location.start?.line || 1;
      column = errorObj.location.start?.column || 1;
    } else if (errorObj?.hash) {
      line = errorObj.hash.line || 1;
      column = errorObj.hash.loc?.first_column || 1;
    } else {
      const lineMatch = message.match(/line (\d+)/i);
      const columnMatch = message.match(/column (\d+)/i);

      if (lineMatch) {
        line = parseInt(lineMatch[1]!, 10);
      }
      if (columnMatch) {
        column = parseInt(columnMatch[1]!, 10);
      }
    }

    return {
      message: this.cleanErrorMessage(message),
      line: Math.max(1, line),
      column: Math.max(1, column),
      severity: "error" as const,
    };
  }

  private cleanErrorMessage(message: string): string {
    return message
      .replace(/^Error: /, "")
      .replace(/Expected .* but .* found\./i, (match) =>
        match.replace(/but .* found/, "found unexpected token"),
      )
      .trim();
  }

  validateSql(sql: string): SqlParseError[] {
    const result = this.parse(sql);
    return result.errors;
  }
}
