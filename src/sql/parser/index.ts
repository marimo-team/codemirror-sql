import type { SQLNamespace } from "@codemirror/lang-sql";
import type { EditorState } from "@codemirror/state";
import type { AST } from "node-sql-parser";
import { lazy } from "../../utils.js";
import type { SqlParseError, SqlParser } from "../types.js";
import { ErrorHandler } from "./error-handler.js";
import { ReferenceExtractor } from "./reference-extractor.js";
import { SchemaValidator } from "./schema-validator.js";
import type {
  NodeSqlParseResult,
  NodeSqlParserOptions,
  QueryContext,
  SchemaValidationError,
  SqlReference,
} from "./types.js";

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
      // Extract references and CTE names in one pass
      const references = this.referenceExtractor.extractReferences(result.ast);
      const cteNames = this.referenceExtractor.getCteNames();
      const validationErrors = this.schemaValidator.validateReferences(
        references,
        resolvedSchema,
        cteNames,
      );

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

  getCteNames(): Set<string> {
    return this.referenceExtractor.getCteNames();
  }
}

// Export types for external use
export type { SqlReference, SchemaValidationError, QueryContext };
