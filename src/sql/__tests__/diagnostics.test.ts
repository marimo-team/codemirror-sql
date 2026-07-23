import { EditorState, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { exportedForTesting, type SqlLinterConfig, sqlLinter } from "../diagnostics.js";
import { NodeSqlParser } from "../parser.js";
import type { SqlParser } from "../types.js";

const { createLintSource } = exportedForTesting;

const createMockView = (content: string) => {
  return {
    state: EditorState.create({ doc: content }),
  } as EditorView;
};

const lint = (content: string, config: SqlLinterConfig = {}) => {
  return createLintSource(config)(createMockView(content));
};

describe("sqlLinter", () => {
  it("should create a linter extension", () => {
    const linter = sqlLinter();
    expect(linter).toBeDefined();
  });

  it("should accept configuration with custom delay", () => {
    const linter = sqlLinter({ delay: 1000 });
    expect(linter).toBeDefined();
  });

  it("should use custom parser if provided", () => {
    const mockParser = {
      validateSql: vi.fn(() => []),
      parseSql: vi.fn(() => ({ statements: [] })),
    } as unknown as SqlParser;

    const linter = sqlLinter({ parser: mockParser });
    expect(linter).toBeDefined();
  });

  it("should use default delay when no delay provided", () => {
    const linter = sqlLinter();
    expect(linter).toBeDefined();
  });

  it("should use custom delay when provided", () => {
    const linter = sqlLinter({ delay: 500 });
    expect(linter).toBeDefined();
  });

  it("should use default parser when no parser provided", () => {
    const linter = sqlLinter();
    expect(linter).toBeDefined();
  });
});

describe("lint source", () => {
  it("should return no diagnostics for an empty document", async () => {
    expect(await lint("")).toEqual([]);
  });

  it("should return no diagnostics for a whitespace-only document", async () => {
    expect(await lint("   \n\n  \t ")).toEqual([]);
  });

  it("should return no diagnostics for valid statements", async () => {
    const diagnostics = await lint(
      "SELECT * FROM users;\nINSERT INTO users (name) VALUES ('John');",
    );
    expect(diagnostics).toEqual([]);
  });

  it("should report one diagnostic per broken statement", async () => {
    const doc = "SELCT * FROM users;\nSELECT * FORM users;\nDELETE FROMM users;";
    const diagnostics = await lint(doc);

    expect(diagnostics).toHaveLength(3);

    const text = Text.of(doc.split("\n"));
    expect(text.lineAt(diagnostics[0].from).number).toBe(1);
    expect(text.lineAt(diagnostics[1].from).number).toBe(2);
    expect(text.lineAt(diagnostics[2].from).number).toBe(3);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.severity).toBe("error");
      expect(diagnostic.source).toBe("sql-parser");
    }
  });

  it("should position diagnostics in a broken statement that follows a valid one", async () => {
    const doc = "SELECT * FROM users;\nSELCT * FROM orders;";
    const diagnostics = await lint(doc);

    expect(diagnostics).toHaveLength(1);
    const secondStatementStart = doc.indexOf("SELCT");
    expect(diagnostics[0].from).toBeGreaterThanOrEqual(secondStatementStart);
    expect(diagnostics[0].to).toBeLessThanOrEqual(doc.length);
  });

  it("should not split statements on semicolons inside string literals", async () => {
    const doc = "SELECT 'a; b' FROM users;\nSELCT * FROM orders;";
    const diagnostics = await lint(doc);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].from).toBeGreaterThanOrEqual(doc.indexOf("SELCT"));
  });

  it("should not split statements on semicolons inside comments", async () => {
    const doc = "SELECT 1 -- trailing; comment\n;\nSELCT * FROM orders;";
    const diagnostics = await lint(doc);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].from).toBeGreaterThanOrEqual(doc.indexOf("SELCT"));
  });

  it("should widen the diagnostic span to cover the offending token", async () => {
    // node-sql-parser reports this error at the "users" token
    const doc = "SELECT 1 FROMM users;";
    const diagnostics = await lint(doc);

    expect(diagnostics).toHaveLength(1);
    const { from, to } = diagnostics[0];
    // The span should cover the whole token, not a single character
    expect(doc.slice(from, to)).toBe("users");
  });

  it("should fall back to a one-character span when the error is not at a token", async () => {
    // node-sql-parser reports this error at the ";" character
    const doc = "SELECT * FROM users WHERE;";
    const diagnostics = await lint(doc);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].to).toBe(diagnostics[0].from + 1);
  });

  it("should handle statements separated on the same line", async () => {
    const doc = "SELECT 1; SELCT 2;";
    const diagnostics = await lint(doc);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].from).toBeGreaterThanOrEqual(doc.indexOf("SELCT"));
  });

  it("should report a single diagnostic when perStatement is disabled", async () => {
    const doc = "SELCT * FROM users;\nSELCT * FROM orders;";
    const diagnostics = await lint(doc, { perStatement: false });

    expect(diagnostics).toHaveLength(1);
    const text = Text.of(doc.split("\n"));
    expect(text.lineAt(diagnostics[0].from).number).toBe(1);
  });

  it("should keep diagnostics within statement bounds", async () => {
    const doc = "SELECT * FROM users;\nSELECT FROM WHERE;\nSELECT 2;";
    const diagnostics = await lint(doc);

    expect(diagnostics.length).toBeGreaterThanOrEqual(1);
    const stmtFrom = doc.indexOf("SELECT FROM");
    const stmtTo = doc.indexOf("SELECT 2");
    for (const diagnostic of diagnostics) {
      expect(diagnostic.from).toBeGreaterThanOrEqual(stmtFrom);
      expect(diagnostic.to).toBeLessThanOrEqual(stmtTo);
      expect(diagnostic.to).toBeGreaterThanOrEqual(diagnostic.from);
    }
  });

  it("should position diagnostics correctly when a line comment precedes the statement", async () => {
    const doc = [
      "-- Valid queries (no errors):",
      "SELECT id, name, email",
      "FROM users",
      "WHERE active == true",
      "ORDER BY created_at DESC;",
    ].join("\n");
    const diagnostics = await lint(doc);

    expect(diagnostics).toHaveLength(1);
    const text = Text.of(doc.split("\n"));
    // The error is at the "==" operator on line 4, not shifted up by the comment
    expect(text.lineAt(diagnostics[0].from).number).toBe(4);
    expect(diagnostics[0].from).toBe(doc.indexOf("==") + 1);
  });

  it("should position diagnostics correctly when a multi-line comment precedes the statement", async () => {
    const doc = [
      "/* header",
      "comment */",
      "SELECT id",
      "FROM users",
      "WHERE active == true;",
    ].join("\n");
    const diagnostics = await lint(doc);

    expect(diagnostics).toHaveLength(1);
    const text = Text.of(doc.split("\n"));
    expect(text.lineAt(diagnostics[0].from).number).toBe(5);
    expect(diagnostics[0].from).toBe(doc.indexOf("==") + 1);
  });

  it("should position diagnostics correctly when a comment appears inside the statement", async () => {
    const doc = [
      "SELECT id",
      "-- pick the table",
      "FROM users",
      "WHERE active == true;",
    ].join("\n");
    const diagnostics = await lint(doc);

    expect(diagnostics).toHaveLength(1);
    const text = Text.of(doc.split("\n"));
    expect(text.lineAt(diagnostics[0].from).number).toBe(4);
    expect(diagnostics[0].from).toBe(doc.indexOf("==") + 1);
  });

  it("should not report diagnostics for valid statements with comments", async () => {
    const doc = [
      "-- fetch users",
      "SELECT id /* inline */, name",
      "FROM users;",
      "/* another",
      "   comment */",
      "SELECT 2;",
    ].join("\n");
    expect(await lint(doc)).toEqual([]);
  });

  it("should reuse errors from a provided structure analyzer without re-validating", async () => {
    const parser = new NodeSqlParser();
    const validateSpy = vi.spyOn(parser, "validateSql");

    const diagnostics = await lint("SELCT 1;\nSELCT 2;", { parser });

    expect(diagnostics).toHaveLength(2);
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it("should clamp the diagnostic span to the document end when the error column runs past it", async () => {
    // A parser whose reported column points beyond the end of the document
    // exercises the `from >= doc.length` branch in tokenEndAt, which clamps
    // the span end to `doc.length`.
    const doc = "SELECT 1";
    const parser = {
      validateSql: vi.fn(async () => [
        { message: "unexpected end of input", line: 1, column: 999, severity: "error" as const },
      ]),
      parse: vi.fn(async () => ({ success: false, errors: [] })),
      extractTableReferences: vi.fn(async () => []),
      extractColumnReferences: vi.fn(async () => []),
    } as unknown as SqlParser;

    const diagnostics = await lint(doc, { parser, perStatement: false });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].from).toBe(doc.length);
    expect(diagnostics[0].to).toBe(doc.length);
  });

  it("should preserve warning severity from the parser", async () => {
    const parser = {
      validateSql: vi.fn(async () => [
        { message: "deprecated syntax", line: 1, column: 1, severity: "warning" as const },
      ]),
      parse: vi.fn(async () => ({ success: false, errors: [] })),
      extractTableReferences: vi.fn(async () => []),
      extractColumnReferences: vi.fn(async () => []),
    } as unknown as SqlParser;

    const diagnostics = await lint("SELECT 1", { parser, perStatement: false });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe("warning");
    expect(diagnostics[0].message).toBe("deprecated syntax");
  });

  it("should emit multiple diagnostics from a single statement when the parser returns several", async () => {
    const parser = {
      validateSql: vi.fn(async () => [
        { message: "first", line: 1, column: 1, severity: "error" as const },
        { message: "second", line: 1, column: 8, severity: "error" as const },
      ]),
      parse: vi.fn(async () => ({ success: false, errors: [] })),
      extractTableReferences: vi.fn(async () => []),
      extractColumnReferences: vi.fn(async () => []),
    } as unknown as SqlParser;

    const diagnostics = await lint("SELECT badcol", { parser, perStatement: false });

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((d) => d.message)).toEqual(["first", "second"]);
  });

  it("clamps a statement-relative error column that overshoots to the statement end", async () => {
    // perStatement path: an error with a large column is clamped within the
    // statement bounds by convertStatementErrorToDiagnostic.
    const doc = "SELECT 1;";
    const parser = {
      validateSql: vi.fn(async () => []),
      // The structure analyzer derives per-statement errors from parse().
      parse: vi.fn(async () => ({
        success: false,
        errors: [{ message: "boom", line: 1, column: 999, severity: "error" as const }],
      })),
      extractTableReferences: vi.fn(async () => []),
      extractColumnReferences: vi.fn(async () => []),
    } as unknown as SqlParser;

    const diagnostics = await lint(doc, { parser });

    expect(diagnostics.length).toBeGreaterThanOrEqual(1);
    for (const d of diagnostics) {
      expect(d.from).toBeLessThanOrEqual(doc.length);
      expect(d.to).toBeLessThanOrEqual(doc.length);
      expect(d.to).toBeGreaterThanOrEqual(d.from);
    }
  });
});
