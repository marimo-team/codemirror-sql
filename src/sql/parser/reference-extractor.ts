import type { AST } from "node-sql-parser";
import type { LocationInfo, SqlReference } from "./types.js";
import {
  isColumnRef,
  isJoinClause,
  isNode,
  isNodeOfType,
  isSelectStmt,
  isTableRef,
} from "./types.js";
import { extractColumnName, extractCteNames } from "./utils.js";

export class ReferenceExtractor {
  private tableAliases = new Map<string, string>();
  private cteNames = new Set<string>();

  extractReferences(ast: AST | AST[]): SqlReference[] {
    const references: SqlReference[] = [];
    const astArray = Array.isArray(ast) ? ast : [ast];

    // Extract CTE names and references in a single pass
    for (const statement of astArray) {
      this.extractCteNamesFromNode(statement);
      this.extractFromNode(statement, references);
    }

    return references;
  }

  getCteNames(): Set<string> {
    return new Set(this.cteNames);
  }

  private extractCteNamesFromNode(node: unknown): void {
    if (!isNode(node)) return;

    try {
      // Extract CTE names from WITH clauses
      const cteNames = extractCteNames(node);
      for (const cteName of cteNames) {
        this.cteNames.add(cteName);
      }

      // Recursively process child nodes
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          for (const child of value) {
            this.extractCteNamesFromNode(child);
          }
        } else if (isNode(value)) {
          this.extractCteNamesFromNode(value);
        }
      }
    } catch (error) {
      console.warn("Error extracting CTE names from AST node:", error);
    }
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

          if (fromItem.as && typeof fromItem.as === "string") {
            this.tableAliases.set(fromItem.as, fromItem.table as string);
          }
        }

        // Handle JOIN clauses
        if (isJoinClause(fromItem)) {
          this.extractFromJoin(fromItem, references);
        }

        // Handle ON conditions in JOINs
        if (isNode(fromItem) && "on" in fromItem && fromItem.on) {
          this.extractColumnRef(fromItem.on, references, "join", fromItem.loc as LocationInfo);
        }
      }
    }

    // Extract column references from different clauses
    this.extractColumnRefs(node.columns, references, "select");
    this.extractColumnRef(node.where, references, "where", node.loc as LocationInfo);
    this.extractColumnRefs(node.orderby, references, "order_by");

    // Fix: Check if groupby has columns property
    if (node.groupby && isNode(node.groupby) && "columns" in node.groupby) {
      this.extractColumnRefs(node.groupby.columns, references, "group_by");
    }

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
          // Skip wildcard columns - they should not be validated
          if (columnName === "*") {
            return;
          }

          const actualTableName =
            expr.table && this.tableAliases.has(expr.table as string)
              ? this.tableAliases.get(expr.table as string)
              : expr.table;

          references.push({
            type: "column",
            name: columnName,
            tableName: actualTableName as string,
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
          const unaryExpr = expr as Record<string, unknown>;
          this.extractColumnRef(unaryExpr.expr, references, context, location);
        } else if (isNodeOfType(expr, "case")) {
          // Fix: Properly type check for case expression
          const caseExpr = expr as Record<string, unknown>;
          if (Array.isArray(caseExpr.args)) {
            for (const caseArg of caseExpr.args) {
              if (isNode(caseArg) && caseArg.type === "when" && caseArg.cond) {
                this.extractColumnRef(caseArg.cond, references, context, location);
              }
              if (isNode(caseArg) && caseArg.type === "else" && caseArg.result) {
                this.extractColumnRef(caseArg.result, references, context, location);
              }
            }
          }
        }
      }
    } catch (error) {
      console.warn("Error extracting column reference:", error);
    }
  }
}
