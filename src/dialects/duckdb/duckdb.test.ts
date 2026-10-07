import { describe, expect, it } from "vitest";
import { DuckDBDialect } from "./duckdb.js";

function variablesAndErrors(sql: string) {
  const tokens: { type: string; text: string }[] = [];
  DuckDBDialect.language.parser.parse(sql).iterate({
    enter(node) {
      if (node.name === "SpecialVar" || node.type.isError) {
        tokens.push({ type: node.name, text: sql.slice(node.from, node.to) });
      }
    },
  });
  return tokens;
}

describe("DuckDB variable tokens", () => {
  it.each(["$threshold", "$lower_bound", "$1"])("recognizes %s without error tokens", (variable) => {
    expect(variablesAndErrors(`SELECT * FROM events WHERE amount > ${variable}`)).toEqual([
      { type: "SpecialVar", text: variable },
    ]);
  });

  it("preserves the existing parameter prefixes", () => {
    expect(variablesAndErrors("SELECT ?name, @name, ?")).toEqual([
      { type: "SpecialVar", text: "?name" },
      { type: "SpecialVar", text: "@name" },
      { type: "SpecialVar", text: "?" },
    ]);
  });

  it("ignores variable prefixes inside strings, quoted identifiers, and comments", () => {
    const sql = `SELECT 'cost $threshold', "price$usd"
      -- $line_comment
      /* $block_comment */
      FROM events WHERE amount > $threshold`;
    expect(variablesAndErrors(sql)).toEqual([{ type: "SpecialVar", text: "$threshold" }]);
  });
});
