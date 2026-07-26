import { EditorState } from "@codemirror/state";
import { expect, it } from "vitest";
import { NodeSqlParser } from "../parser.js";
import { findReferences } from "../references.js";

const parser = new NodeSqlParser({ getParserOptions: () => ({ database: "PostgreSQL" }) });
const navigationSql = `WITH recent_orders AS (
  SELECT customer_id, total_amount FROM orders
),
top_customers AS (
  SELECT customer_id, SUM(total_amount) AS total_spent
  FROM recent_orders
  GROUP BY customer_id
)
SELECT c.first_name, t.total_spent AS amount
FROM customers c
JOIN top_customers t ON t.customer_id = c.id
ORDER BY amount DESC;`;

it("resolves navigation in a compound CTE query", async () => {
  const state = EditorState.create({ doc: navigationSql });
  const result = await parser.parse(navigationSql, { state });
  expect(result.errors).toEqual([]);

  const expectations: Array<[string, string, number]> = [
    ["recent_orders AS", "cte", 2],
    ["top_customers AS", "cte", 2],
    ["amount DESC", "select-alias", 2],
    ["t.customer_id", "table-alias", 3],
  ];
  for (const [marker, kind, count] of expectations) {
    const refs = await findReferences(state, navigationSql.indexOf(marker), { parser });
    expect(refs?.kind, marker).toBe(kind);
    expect(refs?.references, marker).toHaveLength(count);
  }
});
