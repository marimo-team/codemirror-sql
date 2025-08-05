import { isNode } from "./types.js";

/**
 * Safely extracts column name from various AST node structures
 */
export function extractColumnName(column: unknown): string {
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
 * Extracts CTE names from a WITH clause
 */
export function extractCteNames(node: Record<string, unknown>): string[] {
  const cteNames: string[] = [];

  // Check if this node has a WITH clause
  if ("with" in node && Array.isArray(node.with)) {
    const withClauses = node.with;

    for (const clause of withClauses) {
      if (isNode(clause) && "name" in clause) {
        const nameObj = clause.name;
        if (isNode(nameObj) && "value" in nameObj && typeof nameObj.value === "string") {
          cteNames.push(nameObj.value);
        }
      }
    }
  }

  return cteNames;
}
