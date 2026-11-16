import { EditorState } from "@codemirror/state";
import { expect, it } from "vitest";
import { scanSql, maskLiteralsAndComments, stripSqlComments } from "../scanner.js";
import { SqlStructureAnalyzer } from "../structure-analyzer.js";

it.each([
  "SELECT 'a; b'", 'SELECT "a; b"', "SELECT `a; b`",
  "SELECT 'it''s; fine'", 'SELECT "a"";b"',
  "SELECT [[1], [2]]", "SELECT ARRAY[ARRAY[1], ARRAY[2]]", "SELECT [']', ';']",
  "SELECT ['--', '/*'] /* comment */", "SELECT values[1][2] FROM users",
  "SELECT $$a; b$$", "SELECT $body$a; b$body$", "SELECT 1 /* outer /* ; */ ; */",
  "SELECT 1 -- ;\n",
])("keeps semicolons inside tokens in one statement: %s", async (sql) => {
  const state = EditorState.create({ doc: `${sql}; SELECT 2;` });
  const analyzer = new SqlStructureAnalyzer({ parse: async () => ({ success: true, errors: [] }) });
  const statements = await analyzer.analyzeDocument(state);
  expect(statements).toHaveLength(2);
  expect(state.sliceDoc(statements[0]?.from, statements[0]?.to)).toBe(`${sql};`);
  expect(statements[1]?.content).toBe("SELECT 2");
});

it("preserves offsets and line breaks while masking strings and comments", () => {
  const sql = "SELECT 'one\ntwo' /* three\nfour */ FROM \"a.b\" -- five\n";
  const masked = maskLiteralsAndComments(sql);
  expect(masked.length).toBe(sql.length);
  expect(masked.indexOf("FROM")).toBe(sql.indexOf("FROM"));
  expect(masked.split("\n")).toHaveLength(sql.split("\n").length);
  expect(masked).toContain('"a.b"');
  expect(masked).not.toMatch(/one|two|three|four|five/);
});

it("does not concatenate identifiers when removing comments", () => {
  expect(stripSqlComments("SELECT/* hint */id FROM users")).toBe("SELECT id FROM users");
  expect(stripSqlComments("SELECT/* a *//* b */id FROM users")).toBe("SELECT id FROM users");
  expect(stripSqlComments("a/* x */".repeat(1000))).toBe(Array(1000).fill("a").join(" "));
});

it.each(["[a; b]", "[a]];b]"])("supports bracket-quoted identifiers in identifier mode: %s", (sql) => {
  expect(scanSql(sql, { bracketIdentifiers: true })).toEqual([
    { kind: "identifier", from: 0, to: sql.length, text: sql },
  ]);
});

it.each(["'unterminated", '"unterminated', "[unterminated", "/* unterminated", "$tag$unterminated"])(
  "handles an unfinished token: %s", (sql) => {
    expect(scanSql(sql)).toEqual([{ kind: sql.startsWith("/*") ? "comment" : sql.startsWith("'") || sql.startsWith("$") ? "literal" : "identifier", from: 0, to: sql.length, text: sql }]);
  },
);
