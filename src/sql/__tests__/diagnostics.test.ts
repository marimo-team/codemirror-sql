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

  it("should reuse errors from a provided structure analyzer without re-validating", async () => {
    const parser = new NodeSqlParser();
    const validateSpy = vi.spyOn(parser, "validateSql");

    const diagnostics = await lint("SELCT 1;\nSELCT 2;", { parser });

    expect(diagnostics).toHaveLength(2);
    expect(validateSpy).not.toHaveBeenCalled();
  });
});
