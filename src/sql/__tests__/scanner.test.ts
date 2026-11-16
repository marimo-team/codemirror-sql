import { EditorState } from "@codemirror/state";
import { expect, it } from "vitest";
import { scanSql, maskLiteralsAndComments, stripSqlComments } from "../scanner.js";
import { SqlStructureAnalyzer } from "../structure-analyzer.js";

it.each([
  "SELECT 'a; b'", 'SELECT "a; b"', "SELECT `a; b`",
  "SELECT 'it''s; fine'", 'SELECT "a"";b"',
  "SELECT [[1], [2]]", "SELECT ARRAY[ARRAY[1], ARRAY[2]]", "SELECT [']', ';']",
  "SELECT ['--', '/*'] /* comment */", "SELECT values[1][2] FROM users",
  "SELECT $$a; b$$", "SELECT $body$a; b$body$", "SELECT 1 /* source: gs://logs/* */",
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

it("distinguishes dollar signs inside words from adjacent dollar-quoted literals", () => {
  expect(scanSql("name$tag$ $$one$$$$two$$").map(({ kind, text }) => ({ kind, text }))).toEqual([
    { kind: "word", text: "name$tag$" },
    { kind: "literal", text: "$$one$$" },
    { kind: "literal", text: "$$two$$" },
  ]);
});

it("scans long sequences of dollar-quoted literals separated by whitespace", () => {
  const tokens = scanSql("$$$$ ".repeat(128000));
  expect(tokens).toHaveLength(128000);
  expect(tokens.every((token, i) => token.kind === "literal" && token.from === i * 5 && token.to === i * 5 + 4)).toBe(true);
});

it.each([" ", "\t", "\n", "\r", "\u00a0", "\u2003"])(
  "preserves existing whitespace around stripped comments: %j", (space) => {
    expect(stripSqlComments(`a/*comment*/${space}b`)).toBe(`a${space}b`);
    expect(stripSqlComments(`a${space}/*comment*/b`)).toBe(`a${space}b`);
  },
);

it("supports bracket-quoted identifiers in identifier mode", () => {
  const sql = "[a; b]";
  expect(scanSql(sql, { bracketIdentifiers: true })).toEqual([
    { kind: "identifier", from: 0, to: sql.length, text: sql },
  ]);
});

it.each(["ARRAY[[1,2],[3,4]]", "[[1,2],[3,4]]", "m[k[1]]"])(
  "continues masking literals and comments after nested brackets: %s", (expression) => {
    const sql = `SELECT ${expression}, 'from users u' FROM t -- join x y`;
    const masked = maskLiteralsAndComments(sql);
    expect(masked).toHaveLength(sql.length);
    expect(masked).not.toMatch(/from users u|join x y/);
    expect(masked.indexOf("FROM t")).toBe(sql.indexOf("FROM t"));
  },
);

it("ends block comments at the first closing delimiter", () => {
  const sql = "/* source: gs://bucket/logs/* */ SELECT 1";
  expect(stripSqlComments(sql)).toBe(" SELECT 1");
  expect(maskLiteralsAndComments(sql).trim()).toBe("SELECT 1");
});

it.each(["'unterminated", '"unterminated', "[unterminated", "/* unterminated", "$tag$unterminated"])(
  "handles an unfinished token: %s", (sql) => {
    expect(scanSql(sql)).toEqual([{ kind: sql.startsWith("/*") ? "comment" : sql.startsWith("'") || sql.startsWith("$") ? "literal" : "identifier", from: 0, to: sql.length, text: sql }]);
  },
);
