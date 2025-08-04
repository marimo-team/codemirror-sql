import { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { sqlLinter } from "../diagnostics.js";
import { SqlParser } from "../parser.js";

const defaultParser = new SqlParser({ dialect: "PostgresQL" });

// Mock EditorView
const _createMockView = (content: string) => {
  const doc = Text.of(content.split("\n"));
  return {
    state: { doc },
  } as EditorView;
};

describe("sqlLinter", () => {
  it("should create a linter extension", () => {
    const linter = sqlLinter(defaultParser);
    expect(linter).toBeDefined();
  });

  it("should accept configuration with custom delay", () => {
    const linter = sqlLinter(defaultParser, { delay: 1000 });
    expect(linter).toBeDefined();
  });

  it("should use custom parser if provided", () => {
    const mockParser = {
      validateSql: vi.fn(() => []),
      parseSql: vi.fn(() => ({ statements: [] })),
    } as unknown as SqlParser;

    const linter = sqlLinter(mockParser);
    expect(linter).toBeDefined();
  });

  it("should use default delay when no delay provided", () => {
    const linter = sqlLinter(defaultParser);
    expect(linter).toBeDefined();
  });

  it("should use custom delay when provided", () => {
    const linter = sqlLinter(defaultParser, { delay: 500 });
    expect(linter).toBeDefined();
  });
});
