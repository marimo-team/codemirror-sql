import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { createSqlAnalysis } from "../analysis.js";
import { aliasColumnCompletionSource } from "../alias-completion-source.js";
import { exportedForTesting as syntax } from "../diagnostics.js";
import { exportedForTesting as hover } from "../hover.js";
import { NodeSqlParser, type SupportedDialects } from "../parser.js";
import { exportedForTesting as semantic } from "../semantic-diagnostics.js";
import type { SqlParserLike } from "../types.js";
import { createTestView } from "./test-utils.js";

it("shares in-flight parsing between syntax, semantics, hover, and completion", async () => {
  const parser = new NodeSqlParser();
  const parse = vi.spyOn(parser, "parse");
  const analysis = createSqlAnalysis({ parser });
  const schema = { users: ["id", "email"] };
  const doc = "SELECT u.id FROM users u";
  const view = createTestView({ doc });
  const pos = doc.indexOf("u.id") + 2;
  const [errors, findings, tooltip, completion] = await Promise.all([
    syntax.createLintSource(analysis)(view),
    semantic.createSemanticLintSource({ ...analysis, schema })(view),
    hover.createHoverSource({ ...analysis, schema })(view, pos, 0),
    aliasColumnCompletionSource({ ...analysis, schema })(new CompletionContext(view.state, pos, true, view)),
  ]);
  expect(errors).toEqual([]);
  expect(findings).toEqual([]);
  expect(tooltip).not.toBeNull();
  expect(completion?.options.map((option) => option.label)).toEqual(["id", "email"]);
  expect(parse).toHaveBeenCalledTimes(1);
});

it("retries rejected parses instead of caching a rejection", async () => {
  const parse = vi.fn<SqlParserLike["parse"]>()
    .mockRejectedValueOnce(new Error("temporary failure"))
    .mockResolvedValue({ success: true, errors: [] });
  const analysis = createSqlAnalysis({ parser: { parse } });
  const state = EditorState.create({ doc: "SELECT 1" });
  await expect(analysis.structureAnalyzer.analyzeDocument(state)).rejects.toThrow("temporary failure");
  await expect(analysis.structureAnalyzer.analyzeDocument(state)).resolves.toHaveLength(1);
  expect(parse).toHaveBeenCalledTimes(2);
});

it("invalidates parse, structure, and query caches when only the dialect changes", async () => {
  const setDialect = StateEffect.define<SupportedDialects>();
  const dialect = StateField.define<SupportedDialects>({
    create: () => "PostgreSQL",
    update: (value, transaction) => transaction.effects.find((effect) => effect.is(setDialect))?.value ?? value,
  });
  const parser = new NodeSqlParser({ getParserOptions: (state) => ({ database: state.field(dialect) }) });
  const parse = vi.spyOn(parser, "parse");
  const analysis = createSqlAnalysis({ parser });
  const sql = "SELECT id FROM users LIMIT 1, 2";
  const postgres = EditorState.create({ doc: sql, extensions: [dialect] });
  const mysql = postgres.update({ effects: setDialect.of("MySQL") }).state;
  const first = await analysis.structureAnalyzer.analyzeDocument(postgres);
  const firstContext = await analysis.contextAnalyzer.getContext(sql, { state: postgres });
  const second = await analysis.structureAnalyzer.analyzeDocument(mysql);
  const secondContext = await analysis.contextAnalyzer.getContext(sql, { state: mysql });
  expect(first[0]?.isValid).toBe(false);
  expect(second[0]?.isValid).toBe(true);
  expect(secondContext).not.toBe(firstContext);
  expect(parse).toHaveBeenCalledTimes(2);
});

describe("parser isolation", () => {
  it("maps concurrent placeholder errors exactly as separate parses do", async () => {
    const makeParser = () => new NodeSqlParser({
      getParserOptions: () => ({ database: "PostgreSQL", ignoreBrackets: true }),
    });
    const sqls = ["SELECT {id} FORM users", "SELECT id FORM users", "SELECT {one}, {two} FORM users"];
    const opts = { state: EditorState.create() };
    const expected = await Promise.all(sqls.map((sql) => makeParser().parse(sql, opts)));
    const parser = makeParser();
    const actual = await Promise.all(sqls.map((sql) => parser.parse(sql, opts)));
    expect(actual.map((result) => result.errors)).toEqual(expected.map((result) => result.errors));
    expect(actual.every((result) => !result.success)).toBe(true);
  });
});

it("ignores malformed nodes returned by a custom parser", async () => {
  const analysis = createSqlAnalysis({ parser: {
    parse: async () => ({ success: true, errors: [], ast: [null, false, {
      type: "select", from: [null, { table: "users" }], columns: [false, { expr: null }],
      with: [null, { name: "recent", columns: ["id", null] }],
    }] }),
  } });
  const view = createTestView({ doc: "SELECT id FROM users" });
  expect(await semantic.createSemanticLintSource({ ...analysis, schema: { users: ["id"] } })(view)).toEqual([]);
  const context = await analysis.contextAnalyzer.getContext(view.state.doc.toString(), { state: view.state });
  expect(context.tables.map((table) => table.name)).toEqual(["users"]);
  expect(context.ctes[0]?.columns).toEqual(["id"]);
});
