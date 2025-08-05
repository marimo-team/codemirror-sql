import type { SQLNamespace } from "@codemirror/lang-sql";
import type { EditorState } from "@codemirror/state";
import type { AST, Option } from "node-sql-parser";
import { lazy } from "../utils.js";
import type { SqlParseError, SqlParseResult, SqlParser } from "./types.js";

// ============================================================================
// TYPES AND INTERFACES
// ============================================================================

interface LocationInfo {
  start?: { line: number; column: number };
  end?: { line: number; column: number };
}

interface SqlReference {
  type: "table" | "column";
  name: string;
  tableName?: string;
  tableAlias?: string;
  line: number;
  column: number;
  context: "select" | "from" | "where" | "join" | "order_by" | "group_by" | "having";
}

interface SchemaValidationError {
  message: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  type: "missing_table" | "missing_column" | "invalid_reference";
}

interface QueryContext {
  tables: string[];
  columns: string[];
  aliases: Map<string, string>;
  primaryTable?: string;
}

interface NodeSqlParseResult extends SqlParseResult {
  ast?: AST | AST[];
}

interface NodeSqlParserOptions {
  getParserOptions?: (state: EditorState) => Option;
  schema?: SQLNamespace | ((state: EditorState) => SQLNamespace);
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Safely extracts column name from various AST node structures
 */
function extractColumnName(column: unknown): string {
  if (typeof column === "string") return column;
  if (!column || typeof column !== "object") return "[unknown]";

  const obj = column as Record<string, unknown>;

  // Handle nested structures
  if ("expr" in obj) return extractColumnName(obj.expr);
  if ("column" in obj) return extractColumnName(obj.column);
  if ("name" in obj && typeof obj.name === "string") return obj.name;
  if ("value" in obj && typeof obj.value === "string") return obj.value;

  return "[unknown]";
}

/**
 * Type guards for AST nodes
 */
const isNode = (node: unknown): node is Record<string, unknown> =>
  typeof node === "object" && node !== null;

const isNodeOfType = (node: unknown, type: string): node is Record<string, unknown> =>
  isNode(node) && "type" in node && node.type === type;

const isColumnRef = (node: unknown): node is Record<string, unknown> =>
  isNodeOfType(node, "column_ref") && "column" in node;

const isTableRef = (node: unknown): node is Record<string, unknown> =>
  isNode(node) && "table" in node && typeof node.table === "string";

const isSelectStmt = (node: unknown): node is Record<string, unknown> =>
  isNodeOfType(node, "select");

const isJoinClause = (node: unknown): node is Record<string, unknown> => isNodeOfType(node, "join");

// ============================================================================
// REFERENCE EXTRACTOR
// ============================================================================

class ReferenceExtractor {
  private tableAliases = new Map<string, string>();

  extractReferences(ast: AST | AST[]): SqlReference[] {
    const references: SqlReference[] = [];
    const astArray = Array.isArray(ast) ? ast : [ast];

    for (const statement of astArray) {
      this.extractFromNode(statement, references);
    }

    return references;
  }

  private extractFromNode(node: unknown, references: SqlReference[]): void {
    if (!isNode(node)) return;

    try {
      if (isSelectStmt(node)) {
        this.extractFromSelect(node, references);
      } else if (isJoinClause(node)) {
        this.extractFromJoin(node, references);
      }

      // Recursively process child nodes
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          for (const child of value) {
            this.extractFromNode(child, references);
          }
        } else if (isNode(value)) {
          this.extractFromNode(value, references);
        }
      }
    } catch (error) {
      console.warn("Error extracting references from AST node:", error);
    }
  }

  private extractFromSelect(node: Record<string, unknown>, references: SqlReference[]): void {
    this.tableAliases.clear();

    // Extract FROM clause references
    if (Array.isArray(node.from)) {
      for (const fromItem of node.from) {
        if (isTableRef(fromItem)) {
          references.push({
            type: "table",
            name: fromItem.table as string,
            line: (fromItem.loc as LocationInfo)?.start?.line || 1,
            column: (fromItem.loc as LocationInfo)?.start?.column || 1,
            context: "from",
          });

          if (fromItem.as) {
            this.tableAliases.set(fromItem.as as string, fromItem.table as string);
          }
        }

        // Handle JOIN conditions
        if (isNode(fromItem) && "on" in fromItem) {
          this.extractColumnRef(fromItem.on, references, "join", fromItem.loc as LocationInfo);
        }
      }
    }

    // Extract column references from different clauses
    this.extractColumnRefs(node.columns, references, "select");
    this.extractColumnRef(node.where, references, "where", node.loc as LocationInfo);
    this.extractColumnRefs(node.orderby, references, "order_by");
    this.extractColumnRefs(node.groupby?.columns, references, "group_by");
    this.extractColumnRefs(node.having, references, "having");
  }

  private extractFromJoin(node: Record<string, unknown>, references: SqlReference[]): void {
    if (Array.isArray(node.join)) {
      for (const joinItem of node.join) {
        if (isTableRef(joinItem)) {
          references.push({
            type: "table",
            name: joinItem.table as string,
            line: (joinItem.loc as LocationInfo)?.start?.line || 1,
            column: (joinItem.loc as LocationInfo)?.start?.column || 1,
            context: "join",
          });
        }
      }
    }
  }

  private extractColumnRefs(
    items: unknown,
    references: SqlReference[],
    context: SqlReference["context"],
    location?: LocationInfo,
  ): void {
    if (!Array.isArray(items)) return;

    for (const item of items) {
      if (isNode(item)) {
        const expr = "expr" in item ? item.expr : item;
        this.extractColumnRef(expr, references, context, location || (item.loc as LocationInfo));
      }
    }
  }

  private extractColumnRef(
    expr: unknown,
    references: SqlReference[],
    context: SqlReference["context"],
    location?: LocationInfo,
  ): void {
    if (!expr) return;

    try {
      if (isColumnRef(expr)) {
        const columnName = extractColumnName(expr.column);
        if (columnName !== "[unknown]") {
          const actualTableName =
            expr.table && this.tableAliases.has(expr.table as string)
              ? this.tableAliases.get(expr.table as string)
              : expr.table;

          references.push({
            type: "column",
            name: columnName,
            tableName: actualTableName || undefined,
            tableAlias: (expr.table as string) || undefined,
            line: location?.start?.line || (expr.loc as LocationInfo)?.start?.line || 1,
            column: location?.start?.column || (expr.loc as LocationInfo)?.start?.column || 1,
            context,
          });
        }
      }

      // Handle compound expressions
      if (isNode(expr)) {
        if (isNodeOfType(expr, "function") && Array.isArray(expr.args)) {
          for (const arg of expr.args) {
            this.extractColumnRef(arg, references, context, location);
          }
        } else if (isNodeOfType(expr, "binary_expr")) {
          this.extractColumnRef(expr.left, references, context, location);
          this.extractColumnRef(expr.right, references, context, location);
        } else if (isNodeOfType(expr, "unary_expr")) {
          this.extractColumnRef(expr.expr, references, context, location);
        } else if (isNodeOfType(expr, "case") && Array.isArray(expr.args)) {
          for (const caseArg of expr.args) {
            if (caseArg.type === "when" && caseArg.cond) {
              this.extractColumnRef(caseArg.cond, references, context, location);
            }
            if (caseArg.type === "else" && caseArg.result) {
              this.extractColumnRef(caseArg.result, references, context, location);
            }
          }
        }
      }
    } catch (error) {
      console.warn("Error extracting column reference:", error);
    }
  }
}

// ============================================================================
// SCHEMA VALIDATOR
// ============================================================================

class SchemaValidator {
  validateReferences(references: SqlReference[], schema: SQLNamespace): SchemaValidationError[] {
    const errors: SchemaValidationError[] = [];
    const primaryTable = references.find((ref) => ref.type === "table")?.name;

    for (const ref of references) {
      if (ref.type === "table" && !this.tableExists(schema, ref.name)) {
        errors.push({
          message: `Table '${ref.name}' does not exist`,
          line: ref.line,
          column: ref.column,
          severity: "error",
          type: "missing_table",
        });
      } else if (ref.type === "column") {
        this.validateColumnRef(ref, primaryTable, schema, errors);
      }
    }

    return errors;
  }

  private validateColumnRef(
    ref: SqlReference,
    primaryTable: string | undefined,
    schema: SQLNamespace,
    errors: SchemaValidationError[],
  ): void {
    if (ref.tableName) {
      // Qualified column reference
      if (!this.tableExists(schema, ref.tableName)) {
        errors.push({
          message: `Table '${ref.tableAlias || ref.tableName}' does not exist`,
          line: ref.line,
          column: ref.column,
          severity: "error",
          type: "missing_table",
        });
      } else if (!this.columnExists(schema, ref.tableName, ref.name)) {
        errors.push({
          message: `Column '${ref.name}' does not exist in table '${ref.tableAlias || ref.tableName}'`,
          line: ref.line,
          column: ref.column,
          severity: "error",
          type: "missing_column",
        });
      }
    } else if (primaryTable && !this.columnExists(schema, primaryTable, ref.name)) {
      // Unqualified column reference
      errors.push({
        message: `Column '${ref.name}' does not exist in table '${primaryTable}'`,
        line: ref.line,
        column: ref.column,
        severity: "error",
        type: "missing_column",
      });
    }
  }

  private tableExists(schema: SQLNamespace, tableName: string): boolean {
    if (!isNode(schema) || Array.isArray(schema)) return false;

    // Direct property check
    if (tableName in schema) return true;

    // Recursive search
    for (const value of Object.values(schema)) {
      if (isNode(value) && !Array.isArray(value)) {
        if (this.tableExists(value, tableName)) return true;
      }
    }

    return false;
  }

  private columnExists(schema: SQLNamespace, tableName: string, columnName: string): boolean {
    const columns = this.getTableColumns(schema, tableName);
    if (!columns) return false;

    return columns.some((col) =>
      typeof col === "string" ? col === columnName : col.label === columnName,
    );
  }

  private getTableColumns(
    schema: SQLNamespace,
    tableName: string,
  ): readonly (string | { label: string })[] | null {
    if (!isNode(schema)) return null;

    // Direct property check
    if (tableName in schema) {
      const tableData = schema[tableName as keyof typeof schema];
      if (Array.isArray(tableData)) {
        return tableData as readonly (string | { label: string })[];
      }
    }

    // Recursive search
    for (const value of Object.values(schema)) {
      if (isNode(value)) {
        const result = this.getTableColumns(value, tableName);
        if (result) return result;
      }
    }

    return null;
  }

  findTablesWithColumn(schema: SQLNamespace, columnName: string): string[] {
    const tables: string[] = [];

    if (!isNode(schema)) return tables;

    for (const tableName of Object.keys(schema)) {
      const columns = this.getTableColumns(schema, tableName);
      if (
        columns?.some((col) =>
          typeof col === "string" ? col === columnName : col.label === columnName,
        )
      ) {
        tables.push(tableName);
      }
    }

    return tables;
  }
}

// ============================================================================
// ERROR HANDLER
// ============================================================================

class ErrorHandler {
  extractErrorInfo(error: unknown): SqlParseError {
    const message = (error as Error)?.message || "SQL parsing error";
    const errorObj = error as Record<string, unknown>;

    let line = 1;
    let column = 1;

    // Try to extract location from error object
    if (isNode(errorObj)) {
      if (errorObj.location && isNode(errorObj.location) && errorObj.location.start) {
        line = (errorObj.location.start as LocationInfo).line || 1;
        column = (errorObj.location.start as LocationInfo).column || 1;
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

// ============================================================================
// MAIN PARSER CLASS
// ============================================================================

export class NodeSqlParser implements SqlParser {
  private opts: NodeSqlParserOptions;
  private referenceExtractor = new ReferenceExtractor();
  private schemaValidator = new SchemaValidator();
  private errorHandler = new ErrorHandler();

  constructor(opts: NodeSqlParserOptions = {}) {
    this.opts = opts;
  }

  private getParser = lazy(async () => {
    const { Parser } = await import("node-sql-parser");
    return new Parser();
  });

  async parse(sql: string, opts: { state: EditorState }): Promise<NodeSqlParseResult> {
    try {
      const parserOptions = this.opts.getParserOptions?.(opts.state);
      const parser = await this.getParser();

      const enhancedOptions = {
        ...parserOptions,
        parseOptions: {
          ...parserOptions?.parseOptions,
          includeLocations: true,
        },
      };

      const ast = parser.astify(sql, enhancedOptions);

      return {
        success: true,
        errors: [],
        ast,
      };
    } catch (error: unknown) {
      const parseError = this.errorHandler.extractErrorInfo(error);
      return {
        success: false,
        errors: [parseError],
      };
    }
  }

  async validateSql(sql: string, opts: { state: EditorState }): Promise<SqlParseError[]> {
    const result = await this.parse(sql, opts);
    const errors: SqlParseError[] = [...result.errors];

    const schema = this.opts.schema;

    if (schema && result.success && result.ast) {
      const resolvedSchema = typeof schema === "function" ? schema(opts.state) : schema;
      const references = this.referenceExtractor.extractReferences(result.ast);
      const validationErrors = this.schemaValidator.validateReferences(references, resolvedSchema);

      errors.push(
        ...validationErrors.map((error) => ({
          message: error.message,
          line: error.line,
          column: error.column,
          severity: error.severity,
        })),
      );
    }

    return errors;
  }

  async extractReferences(ast: AST | AST[]): Promise<SqlReference[]> {
    return this.referenceExtractor.extractReferences(ast);
  }

  async extractContext(ast: AST | AST[]): Promise<QueryContext> {
    const references = await this.extractReferences(ast);
    const context: QueryContext = {
      tables: [],
      columns: [],
      aliases: new Map(),
    };

    for (const ref of references) {
      if (ref.type === "table") {
        if (!context.tables.includes(ref.name)) {
          context.tables.push(ref.name);
        }
      } else if (ref.type === "column") {
        if (!context.columns.includes(ref.name)) {
          context.columns.push(ref.name);
        }
        if (ref.tableAlias && ref.tableName) {
          context.aliases.set(ref.tableAlias, ref.tableName);
        }
      }
    }

    const fromTables = references
      .filter((ref) => ref.type === "table" && ref.context === "from")
      .map((ref) => ref.name);

    if (fromTables.length > 0) {
      context.primaryTable = fromTables[0];
    }

    return context;
  }

  validateReferences(references: SqlReference[], schema: SQLNamespace): SchemaValidationError[] {
    return this.schemaValidator.validateReferences(references, schema);
  }

  columnExists(schema: SQLNamespace, tableName: string, columnName: string): boolean {
    return this.schemaValidator.columnExists(schema, tableName, columnName);
  }

  findTablesWithColumn(schema: SQLNamespace, columnName: string): string[] {
    return this.schemaValidator.findTablesWithColumn(schema, columnName);
  }
}

// Export types for external use
export type { SqlReference, SchemaValidationError, QueryContext };
