import { EditorState } from "@codemirror/state";
import { expect, it } from "vitest";
import { defaultSqlDoc } from "../../../demo/data.js";
import { NodeSqlParser } from "../parser.js";
import { findReferences } from "../references.js";

const parser = new NodeSqlParser({ getParserOptions: () => ({ database: "PostgreSQL" }) });

it("demo default doc: first statement parses and navigation resolves", async () => {
  const state = EditorState.create({ doc: defaultSqlDoc });
  const firstStmt = defaultSqlDoc.slice(0, defaultSqlDoc.indexOf(";") + 1);
  const result = await parser.parse(firstStmt, { state });
  expect(result.errors).toEqual([]);

  const expectations: Array<[string, string, number]> = [
    ["recent_orders AS", "cte", 2],
    ["top_customers AS", "cte", 2],
    ["amount DESC", "select-alias", 2],
    ["t.customer_id", "table-alias", 3],
  ];
  for (const [marker, kind, count] of expectations) {
    const refs = await findReferences(state, defaultSqlDoc.indexOf(marker), { parser });
    expect(refs?.kind, marker).toBe(kind);
    expect(refs?.references, marker).toHaveLength(count);
  }
});
