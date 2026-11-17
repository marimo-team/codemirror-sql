import { EditorState } from "@codemirror/state";
import { forceLinting, forEachDiagnostic } from "@codemirror/lint";
import { describe, expect, it, vi } from "vitest";
import { createSqlAnalysis } from "../analysis.js";
import { readAst } from "../ast.js";
import { sqlExtension } from "../extension.js";
import { DefaultSqlTooltipRenders } from "../hover.js";
import { NodeSqlParser, type ParserOption } from "../parser.js";
import type { SqlParseResult } from "../types.js";
import { createTestView } from "./test-utils.js";

class SanitizingParser extends NodeSqlParser {
  override async sanitizeSql(sql: string, options?: ParserOption): Promise<string> {
    await Promise.resolve();
    return super.sanitizeSql(sql.replace("CUSTOM_SELECT", "SELECT"), options);
  }
}

describe("public sanitizer overrides", () => {
  it("awaits the override from both parse and validateSql and forwards parser options", async () => {
    const options: ParserOption = { database: "PostgreSQL", ignoreBrackets: true };
    const parser = new SanitizingParser({ getParserOptions: () => options });
    const sanitize = vi.spyOn(parser, "sanitizeSql");
    const sql = "CUSTOM_SELECT {value}";
    const state = EditorState.create({ doc: sql });
    expect((await parser.parse(sql, { state })).success).toBe(true);
    expect(await parser.validateSql(sql, { state })).toEqual([]);
    expect(sanitize).toHaveBeenCalledTimes(2);
    expect(sanitize).toHaveBeenCalledWith(sql, options);
  });

  it("keeps placeholder offsets isolated when an override delegates to super", async () => {
    const makeParser = () => new SanitizingParser({
      getParserOptions: () => ({ database: "PostgreSQL", ignoreBrackets: true }),
    });
    const opts = { state: EditorState.create() };
    const sqls = ["SELECT {one} FORM users", "SELECT id FORM users", "SELECT {one}, {two} FORM users"];
    const expected = await Promise.all(sqls.map((sql) => makeParser().parse(sql, opts)));
    const shared = makeParser();
    const actual = await Promise.all(sqls.map((sql) => shared.parse(sql, opts)));
    expect(actual.map((result) => result.errors)).toEqual(expected.map((result) => result.errors));
  });

  it("does not apply built-in offsets to a custom transformation", async () => {
    class CustomParser extends NodeSqlParser {
      override async sanitizeSql(sql: string): Promise<string> { return sql.replace("{id}", "id"); }
    }
    const parser = new CustomParser({
      getParserOptions: () => ({ database: "PostgreSQL", ignoreBrackets: true }),
    });
    const opts = { state: EditorState.create() };
    const actual = await parser.parse("SELECT {id} FORM users", opts);
    const expected = await new NodeSqlParser({
      getParserOptions: () => ({ database: "PostgreSQL" }),
    }).parse("SELECT id FORM users", opts);
    expect(actual.errors).toEqual(expected.errors);
    expect(actual.success).toBe(false);
  });

  it("preserves sanitizer rejection behavior", async () => {
    class FailingParser extends NodeSqlParser {
      override async sanitizeSql(): Promise<string> { throw new Error("custom sanitizer failed"); }
    }
    const parser = new FailingParser();
    await expect(parser.parse("SELECT 1", { state: EditorState.create() })).rejects.toThrow("custom sanitizer failed");
  });
});

it("preserves successful custom results with warnings and failure results with an AST", async () => {
  const warning = { message: "deprecated", line: 1, column: 1, severity: "warning" as const };
  const result: SqlParseResult = {
    success: true,
    errors: [warning],
    ast: { type: "select", from: [{ table: "custom_source", as: "u" }] },
  };
  const analysis = createSqlAnalysis({ parser: { parse: async () => result } });
  const state = EditorState.create({ doc: "SELECT u.id FROM users u" });
  expect(await analysis.parser.parse(state.doc.toString(), { state })).toBe(result);
  const context = await analysis.contextAnalyzer.getContext(state.doc.toString(), { state });
  expect(context.aliases.get("u")).toBe("custom_source");
  expect((await analysis.structureAnalyzer.analyzeDocument(state))[0]?.errors).toEqual([warning]);
  expect(readAst({ success: false, errors: [warning], ast: result.ast })).toEqual({ kind: "invalid" });
  expect(readAst({ success: true, errors: [] })).toEqual({ kind: "skipped" });
});

it("retains the optional payloads accepted by public namespace renderers", () => {
  expect(DefaultSqlTooltipRenders.namespace({
    type: "completion", path: ["users"], semanticType: "table",
  })).toContain("<strong>users</strong>");
  expect(DefaultSqlTooltipRenders.namespace({
    type: "namespace", completion: { label: "custom label" }, path: ["users"], semanticType: "table",
  })).toContain("<strong>custom label</strong>");
});

it("forwards custom extraction and validation methods through shared analysis", async () => {
  const source = new NodeSqlParser();
  const tableReferences = vi.spyOn(source, "extractTableReferences");
  const columnReferences = vi.spyOn(source, "extractColumnReferences");
  const validate = vi.spyOn(source, "validateSql");
  const { parser } = createSqlAnalysis({ parser: source });
  const sql = "SELECT id FROM users";
  const opts = { state: EditorState.create({ doc: sql }) };
  expect(await parser.extractTableReferences(sql, opts)).toEqual(["users"]);
  expect(await parser.extractColumnReferences(sql, opts)).toEqual(["id"]);
  expect(await parser.validateSql(sql, opts)).toEqual([]);
  expect(tableReferences).toHaveBeenCalledWith(sql, opts);
  expect(columnReferences).toHaveBeenCalledWith(sql, opts);
  expect(validate).toHaveBeenCalledWith(sql, opts);
});

it("keeps legacy gutter defaults independent from a syntax-only parser override", async () => {
  const custom = createSqlAnalysis({ parser: {
    parse: async () => ({ success: false, errors: [
      { message: "custom syntax error", line: 1, column: 1, severity: "error" },
    ] }),
  } });
  const view = createTestView({ doc: "SELECT 1", extensions: [sqlExtension({
    linterConfig: { parser: custom.parser, delay: 0 },
    enableSemanticLinting: false,
    enableHover: false,
    enableNavigation: false,
  })] });
  forceLinting(view);
  const messages = () => {
    const result: string[] = [];
    forEachDiagnostic(view.state, (diagnostic) => result.push(diagnostic.message));
    return result;
  };
  await vi.waitFor(() => expect(messages()).toEqual(["custom syntax error"]));
  await vi.waitFor(() => expect(view.dom.querySelector<HTMLElement>(".cm-sql-gutter-marker")?.style.background)
    .toBe("rgb(59, 130, 246)"));
});
