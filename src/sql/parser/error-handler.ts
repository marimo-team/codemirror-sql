import type { SqlParseError } from "../types.js";
import { isNode } from "./types.js";

export class ErrorHandler {
  extractErrorInfo(error: unknown): SqlParseError {
    const errorObj = error as Record<string, unknown>;
    const message = String(errorObj.message || errorObj.msg || error || "Unknown error");

    let line = 1;
    let column = 1;

    // Try to extract location from error object
    if (isNode(errorObj)) {
      if (errorObj.location && isNode(errorObj.location) && errorObj.location.start) {
        const start = errorObj.location.start as Record<string, unknown>;
        line = (start.line as number) || 1;
        column = (start.column as number) || 1;
      } else if (errorObj.hash && isNode(errorObj.hash)) {
        line = (errorObj.hash.line as number) || 1;
        column =
          errorObj.hash.loc && isNode(errorObj.hash.loc)
            ? (errorObj.hash.loc.first_column as number) || 1
            : 1;
      }
    }

    // Fallback to regex parsing
    if (line === 1 && column === 1) {
      const lineMatch = message.match(/line (\d+)/i);
      const columnMatch = message.match(/column (\d+)/i);

      if (lineMatch?.[1]) line = parseInt(lineMatch[1], 10);
      if (columnMatch?.[1]) column = parseInt(columnMatch[1], 10);
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
}
