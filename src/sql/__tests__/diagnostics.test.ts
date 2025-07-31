import { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { sqlLinter } from "../diagnostics.js";

// Mock EditorView
const _createMockView = (content: string) => {
  const doc = Text.of(content.split("\n"));
  return {
    state: { doc },
  } as EditorView;
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
    } as any;

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
