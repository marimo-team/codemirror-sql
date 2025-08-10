import type { EditorState } from "@codemirror/state";
import type { AST, Option, Parser } from "node-sql-parser";
import { debug } from "../debug.js";
import { lazy } from "../utils.js";
import type { SqlParseError, SqlParseResult, SqlParser } from "./types.js";

interface ParserOption extends Option {
  database: SupportedDialects;
}

interface NodeSqlParserOptions {
  getParserOptions?: (state: EditorState) => ParserOption;
}

interface NodeSqlParserResult extends SqlParseResult {
  ast?: AST | AST[];
}

/**
 * A SQL parser wrapper around node-sql-parser with enhanced error handling
 * and validation capabilities for CodeMirror integration.
 *
 * @example Custom dialect
 * ```ts
 * import { NodeSqlParser } from "@marimo-team/codemirror-sql";
 *
 * const myParser = new NodeSqlParser({
 *   getParserOptions: (state) => ({
 *     dialect: getDialect(state),
 *     parseOptions: {
 *       includeLocations: true,
 *     },
 *   }),
 * });
 * ```
 */
export class NodeSqlParser implements SqlParser {
  private opts: NodeSqlParserOptions;
  private parser: Parser | null = null;

  constructor(opts: NodeSqlParserOptions = {}) {
    this.opts = opts;
  }

  /**
   * Lazy import of the node-sql-parser package and create a new Parser instance.
   */
  private getParser = lazy(async () => {
    if (this.parser) {
      return this.parser;
    }
    const module = await import("node-sql-parser");
    // Support for ESM and CJS
    const { Parser } = module.default || module;
    this.parser = new Parser();
    return this.parser;
  });

  async parse(sql: string, opts: { state: EditorState }): Promise<NodeSqlParserResult> {
    try {
      const parserOptions = this.opts.getParserOptions?.(opts.state);
      const parser = await this.getParser();

      // Check if this is DuckDB dialect and apply custom processing
      if (parserOptions?.database === "DuckDB") {
        return this.parseWithDuckDBSupport(sql, parserOptions);
      }

      const ast = parser.astify(sql, parserOptions);

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

  /**
   * Parse SQL with DuckDB-specific syntax support
   */
  private async parseWithDuckDBSupport(
    sql: string,
    parserOptions: Option,
  ): Promise<NodeSqlParserResult> {
    const parser = await this.getParser();

    // If the query starts with "from", it's DuckDB-specific syntax
    // Just return success without parsing to avoid errors
    if (sql.trim().toLowerCase().startsWith("from")) {
      debug("From syntax is not supported");
      return {
        success: true,
        errors: [],
      };
    }

    // Otherwise, try standard parsing with PostgreSQL dialect
    try {
      const postgresOptions = { ...parserOptions, database: "PostgreSQL" };
      const ast = parser.astify(sql, postgresOptions);
      return {
        success: true,
        errors: [],
        ast,
      };
    } catch (error) {
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

      if (lineMatch?.[1]) {
        line = parseInt(lineMatch[1], 10);
      }
      if (columnMatch?.[1]) {
        column = parseInt(columnMatch[1], 10);
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

  async validateSql(sql: string, opts: { state: EditorState }): Promise<SqlParseError[]> {
    const result = await this.parse(sql, opts);
    return result.errors;
  }

  /**
   * Extracts table references from a SQL query using node-sql-parser
   * @param sql The SQL query to analyze
   * @returns Array of table names referenced in the query
   */
  async extractTableReferences(sql: string): Promise<string[]> {
    try {
      const parser = await this.getParser();
      const tableList = parser.tableList(sql);
      // Clean up table names - node-sql-parser returns format like "select::null::users"
      return tableList.map((table: string) => {
        const parts = table.split("::");
        return parts[parts.length - 1] || table;
      });
    } catch {
      return [];
    }
  }

  /**
   * Extracts column references from a SQL query using node-sql-parser
   * @param sql The SQL query to analyze
   * @returns Array of column names referenced in the query
   */
  async extractColumnReferences(sql: string): Promise<string[]> {
    try {
      const parser = await this.getParser();
      const columnList = parser.columnList(sql);

      // Clean up column names - node-sql-parser returns format like "select::null::users"
      const cleanColumnList = columnList.map((column: string) => {
        const parts = column.split("::");
        return parts[parts.length - 1] || column;
      });
      return cleanColumnList;
    } catch {
      return [];
    }
  }
}

/**
 * https://github.com/taozhi8833998/node-sql-parser?tab=readme-ov-file#supported-database-sql-syntax
 * While DuckDB is not supported in the library, we perform some special handling for it and treat it as PostgreSQL.
 */
export type SupportedDialects =
  | "Athena"
  | "BigQuery"
  | "DB2"
  | "Hive"
  | "MariaDB"
  | "MySQL"
  | "PostgreSQL"
  | "DuckDB"
  | "Redshift"
  | "Sqlite"
  | "TransactSQL"
  | "FlinkSQL"
  | "Snowflake"
  | "Noql";
