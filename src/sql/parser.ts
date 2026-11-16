import { scanSql } from "./scanner.js";
import { record } from "./ast.js";
import type { EditorState } from "@codemirror/state";
import type { AST, Option } from "node-sql-parser";
import { debug } from "../debug.js";
import { lazy } from "../utils.js";
import type { SqlParseError, SqlParseResult, SqlParser } from "./types.js";

export interface ParserOption extends Option {
  database: SupportedDialects;
  /**
   * If true, the parser will quote brackets in the SQL query which will satisfy the parser.
   * This is useful if you want to interpolate variables in f-strings.
   *
   * @example
   * ```sql
   * SELECT {id} -> SELECT '{id}'
   * ```
   *
   * @experimental This is an experimental feature and may break parsing.
   */
  ignoreBrackets?: boolean;
}

export interface NodeSqlParserOptions {
  getParserOptions?: (state: EditorState) => ParserOption;
}

export interface NodeSqlParserResult extends SqlParseResult {
  ast?: AST | AST[];
}

type NodeParseOutcome =
  | { success: true; errors: []; ast?: AST | AST[] }
  | { success: false; errors: SqlParseError[]; ast?: never };

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

  constructor(opts: NodeSqlParserOptions = {}) {
    this.opts = opts;
  }

  /**
   * Lazy import of the node-sql-parser package and create a new Parser instance.
   */
  private getParser = lazy(async () => {
    const module = await import("node-sql-parser");
    // Support for ESM and CJS
    const { Parser } = module.default || module;
    return new Parser();
  });

  async parse(sql: string, opts: { state: EditorState }): Promise<NodeSqlParserResult> {
    const parserOptions = this.opts.getParserOptions?.(opts.state);
    const sanitizedSql = await this.sanitizeSql(sql, parserOptions);
    const builtIn = parserOptions?.ignoreBrackets ? replaceBracketsWithQuotes(sql) : null;
    // A custom sanitizer may change offsets in ways the built-in mapping cannot describe.
    const offsetRecord = builtIn?.sql === sanitizedSql ? builtIn.offsetRecord : {};
    return this.parseSanitizedSql(sanitizedSql, parserOptions, offsetRecord);
  }

  private async parseSanitizedSql(
    sanitizedSql: string,
    parserOptions: ParserOption | undefined,
    offsetRecord: Record<number, number>,
  ): Promise<NodeParseOutcome> {
    try {
      const parser = await this.getParser();

      // Check if this is DuckDB dialect and apply custom processing
      if (parserOptions?.database === "DuckDB") {
        return this.parseWithDuckDBSupport(sanitizedSql, parserOptions, offsetRecord);
      }

      const ast = parser.astify(sanitizedSql, parserOptions);

      return {
        success: true,
        errors: [],
        ast,
      };
    } catch (error: unknown) {
      const parseError = this.extractErrorInfo(error, sanitizedSql, offsetRecord);
      return {
        success: false,
        errors: [parseError],
      };
    }
  }

  async sanitizeSql(sql: string, parserOptions?: ParserOption): Promise<string> {
    return parserOptions?.ignoreBrackets ? replaceBracketsWithQuotes(sql).sql : sql;
  }

  /**
   * Parse SQL with DuckDB syntax support
   * This is not robust, we catch main cases.
   */
  private async parseWithDuckDBSupport(
    sql: string,
    parserOptions: Option,
    offsetRecord: Record<number, number>,
  ): Promise<NodeParseOutcome> {
    const parser = await this.getParser();

    // Remove comments and normalize for pattern checking
    const sqlToCheck = removeCommentsFromStart(sql).trimStart().toLowerCase();

    // Handle unsupported DuckDB syntax patterns
    if (sqlToCheck.startsWith("from") || sqlToCheck.includes("macro")) {
      debug("Unsupported DuckDB syntax");
      return { success: true, errors: [] };
    }

    let modifiedSql = sql;
    // Postgres does not support `CREATE OR REPLACE` for tables
    if (sqlToCheck.includes("create or replace table")) {
      const offset = "create or replace table".length - "create table".length;
      const index = /create or replace table/i.exec(sql)?.index ?? 0;
      offsetRecord[index] = -offset;
      modifiedSql = sql.replace(/create or replace table/i, "create table");
    }

    // Try standard parsing with PostgreSQL dialect
    try {
      const postgresOptions = { ...parserOptions, database: "PostgreSQL" };
      const ast = parser.astify(modifiedSql, postgresOptions);
      return { success: true, errors: [], ast };
    } catch (error) {
      // Use the original sql since we manually apply the offset
      const parseError = this.extractErrorInfo(error, sql, offsetRecord);
      return { success: false, errors: [parseError] };
    }
  }

  /**
   * @param error - The error object
   * @param sql - The SQL string
   * @param offset - The offset to add to the column position. Default is 0.
   * @returns The parsed error information
   */
  private extractErrorInfo(error: unknown, sql: string, offsetRecord: Record<number, number>): SqlParseError {
    let line = 1;
    let column = 1;
    const errorObj = record(error);
    const message = typeof errorObj?.message === "string" ? errorObj.message : "SQL parsing error";
    const start = record(record(errorObj?.location)?.start);
    const hash = record(errorObj?.hash);
    const numberOrOne = (value: unknown): number =>
      typeof value === "number" && Number.isFinite(value) ? Math.max(1, value) : 1;
    if (start) {
      line = numberOrOne(start.line);
      column = numberOrOne(start.column);
    } else if (hash) {
      line = numberOrOne(hash.line);
      column = numberOrOne(record(hash.loc)?.first_column);
    } else {
      line = Number(message.match(/line (\d+)/i)?.[1] ?? 1);
      column = Number(message.match(/column (\d+)/i)?.[1] ?? 1);
    }

    /**
     * Map the error column back to the original (pre-replacement) SQL
     * SELECT {id} FRO users
     *             ^ error position should be here
     *
     * SELECT '{id}' FRO users
     *                   ^ parser reports this
     * So in this case, we subtract the offset from the column position.
     *
     * offsetRecord keys are absolute offsets into the pre-replacement SQL,
     * while the parser reports line-relative columns, so only replacements
     * on the error's own line (and before the error column) shift it.
     * Replacements never add or remove newlines, so line numbers match.
     */
    const replacements = Object.entries(offsetRecord)
      .map(([position, offset]) => ({ position: parseInt(position, 10), offset }))
      .sort((a, b) => a.position - b.position);
    let shift = 0;
    for (const { position, offset } of replacements) {
      const replacedPosition = position + shift;
      shift += offset;

      const beforeReplacement = sql.slice(0, replacedPosition);
      const replacementLine = (beforeReplacement.match(/\n/g)?.length ?? 0) + 1;
      const replacementColumn = replacedPosition - beforeReplacement.lastIndexOf("\n");

      if (line === replacementLine && column > replacementColumn) {
        column -= offset;
      }
    }

    // Ensure we don't exceed the sql length
    if (column > sql.length) {
      column = sql.length;
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
  async extractTableReferences(sql: string, opts?: { state: EditorState }): Promise<string[]> {
    const parserOptions = opts ? this.opts.getParserOptions?.(opts.state) : undefined;

    try {
      const parser = await this.getParser();
      const tableList = parser.tableList(sql, parserOptions);
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
  async extractColumnReferences(sql: string, opts?: { state: EditorState }): Promise<string[]> {
    const parserOptions = opts?.state ? this.opts.getParserOptions?.(opts.state) : undefined;

    try {
      const parser = await this.getParser();
      const columnList = parser.columnList(sql, parserOptions);

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

type CommentType = "--" | "/*";

function removeCommentsFromStart(sql: string, commentTypes: CommentType[] = ["/*", "--"]): string {
  let end = 0;
  for (const token of scanSql(sql)) {
    if (token.kind !== "comment" || !commentTypes.some((type) => token.text.startsWith(type))) break;
    end = token.to;
  }
  return end > 0 ? sql.slice(end).trimStart() : sql;
}

const QUOTE_LENGTH = "''".length;

/**
 * Replaces unquoted curly bracket expressions (e.g., {id}) with quoted strings (e.g., '{id}'),
 * ignoring brackets already inside single or double quotes.
 *
 * Returns the modified SQL and a record mapping the index of each replaced bracket to the
 * number of characters added (for offset tracking).
 *
 * @example
 *   replaceBracketsWithQuotes("SELECT {id}, '{name}' FROM users");
 *   // => {
 *   //   sql: "SELECT '{id}', '{name}' FROM users",
 *   //   offsetRecord: { 7: 2 }
 *   // }
 */
function replaceBracketsWithQuotes(sql: string): {
  sql: string;
  offsetRecord: Record<number, number>;
} {
  const offsetRecord: Record<number, number> = {};

  const protectedTokens = scanSql(sql, { backslashEscapes: true }).filter(
    (token) => token.kind === "comment" || token.kind === "literal" || token.kind === "identifier",
  );
  let replacedSql = "";
  let from = 0;
  let tokenIndex = 0;
  while (from < sql.length) {
    const token = protectedTokens[tokenIndex];
    if (token && from >= token.to) {
      tokenIndex++;
      continue;
    }
    if (token && from === token.from) {
      replacedSql += token.text;
      from = token.to;
      continue;
    }
    const end = sql[from] === "{" ? sql.indexOf("}", from + 1) : -1;
    if (end >= 0) {
      offsetRecord[from] = QUOTE_LENGTH;
      replacedSql += `'${sql.slice(from, end + 1)}'`;
      from = end + 1;
    } else if (sql[from] === "{") {
      replacedSql += sql.slice(from);
      break;
    } else {
      replacedSql += sql[from];
      from++;
    }
  }

  return { sql: replacedSql, offsetRecord };
}

export const exportedForTesting = { replaceBracketsWithQuotes, removeCommentsFromStart };

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
