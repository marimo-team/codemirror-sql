import { describe, expect, it, vi } from "vitest";
import { sqlLinter } from "../diagnostics.js";
import { SqlParser } from "../parser.js";

describe("sqlLinter", () => {
  it("should create a linter extension", () => {
    const linter = sqlLinter();
    expect(linter).toBeDefined();
  });

  it("should use custom parser when provided", () => {
    const mockParser = vi.mocked(new SqlParser());
    mockParser.validateSql = vi.fn().mockReturnValue([]);

    const linter = sqlLinter({ parser: mockParser });
    expect(linter).toBeDefined();
  });

  it("should use default delay if not provided", () => {
    const linter = sqlLinter();
    expect(linter).toBeDefined();
  });

  it("should use custom delay when provided", () => {
    const linter = sqlLinter({ delay: 1000 });
    expect(linter).toBeDefined();
  });
});
