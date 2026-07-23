import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as dialects from "../dialects";
import * as exports from "../index";

describe("index.ts exports", () => {
  it("should not change unexpectedly", () => {
    const sortedExports = Object.keys(exports).sort();
    expect(sortedExports).toMatchInlineSnapshot(`
      [
        "DefaultSqlTooltipRenders",
        "NodeSqlParser",
        "QueryContextAnalyzer",
        "SqlStructureAnalyzer",
        "aliasColumnCompletionSource",
        "analyzeQueryContext",
        "cteCompletionSource",
        "defaultSqlHoverTheme",
        "resolveSqlSchema",
        "sqlExtension",
        "sqlHover",
        "sqlLinter",
        "sqlSchemaFacet",
        "sqlSemanticLinter",
        "sqlStructureGutter",
      ]
    `);
  });
});

describe("keywords", async () => {
  it("should have the correct structure, keywords.keywords should be an object", async () => {
    const dataDir = join(__dirname, "../data");
    const files = await readdir(dataDir);
    const keywordFiles = files.filter((file) => file.endsWith("-keywords.json"));

    for (const file of keywordFiles) {
      const keywords = await import(`../data/${file}`);
      expect(typeof keywords.keywords).toBe("object");
    }
  });
});

describe("dialects.ts exports", () => {
  it("should not change unexpectedly", () => {
    const sortedExports = Object.keys(dialects).sort();
    expect(sortedExports).toMatchInlineSnapshot(`
      [
        "BigQueryDialect",
        "DremioDialect",
        "DuckDBDialect",
      ]
    `);
  });

  it("should expose a Dremio dialect with Dremio SQL keywords", () => {
    expect(dialects.DremioDialect.spec.identifierQuotes).toBe('"');
    expect(dialects.DremioDialect.spec.keywords?.split(" ")).toContain("reflection");
    expect(dialects.DremioDialect.spec.keywords?.split(" ")).toContain("qualify");
    expect(dialects.DremioDialect.spec.types?.split(" ")).toContain("struct");
  });
});
