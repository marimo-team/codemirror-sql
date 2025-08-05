import type { SQLNamespace } from "@codemirror/lang-sql";
import type { SchemaValidationError, SqlReference } from "./types.js";
import { isNode } from "./types.js";

export class SchemaValidator {
  validateReferences(
    references: SqlReference[],
    schema: SQLNamespace,
    cteNames: Set<string> = new Set(),
  ): SchemaValidationError[] {
    const errors: SchemaValidationError[] = [];
    const primaryTable = references.find((ref) => ref.type === "table")?.name;

    for (const ref of references) {
      if (ref.type === "table" && !this.tableExists(schema, ref.name) && !cteNames.has(ref.name)) {
        errors.push({
          message: `Table '${ref.name}' does not exist`,
          line: ref.line,
          column: ref.column,
          severity: "error",
          type: "missing_table",
        });
      } else if (ref.type === "column") {
        this.validateColumnRef(ref, primaryTable, schema, errors, cteNames);
      }
    }

    return errors;
  }

  private validateColumnRef(
    ref: SqlReference,
    primaryTable: string | undefined,
    schema: SQLNamespace,
    errors: SchemaValidationError[],
    cteNames: Set<string> = new Set(),
  ): void {
    // Skip validation for wildcard columns
    if (ref.name === "*") {
      return;
    }

    if (ref.tableName) {
      // Qualified column reference
      if (!this.tableExists(schema, ref.tableName) && !cteNames.has(ref.tableName)) {
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

  columnExists(schema: SQLNamespace, tableName: string, columnName: string): boolean {
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
