import { readdirSync, readFileSync } from "node:fs";
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
        "SqlReferenceResolver",
        "SqlStructureAnalyzer",
        "aliasColumnCompletionSource",
        "analyzeQueryContext",
        "createCteCompletionSource",
        "cteCompletionSource",
        "defaultSqlHoverTheme",
        "findReferences",
        "gotoSqlDefinition",
        "renameSqlIdentifier",
        "resolveSqlSchema",
        "sqlCompletion",
        "sqlExtension",
        "sqlGotoDefinition",
        "sqlHighlightReferences",
        "sqlHover",
        "sqlLinter",
        "sqlNavigation",
        "sqlNavigationKeymap",
        "sqlSchemaFacet",
        "sqlSemanticLinter",
        "sqlStructureGutter",
        "unqualifiedColumnCompletionSource",
      ]
    `);
  });
});

describe("keywords", () => {
  it("should have the correct structure, keywords.keywords should be an object", () => {
    const dataDirectory = join(__dirname, "../data");
    const keywordFiles = readdirSync(dataDirectory).filter((file) =>
      file.endsWith("-keywords.json"),
    );

    expect(keywordFiles.length).toBeGreaterThan(0);
    for (const file of keywordFiles) {
      const data = JSON.parse(readFileSync(join(dataDirectory, file), "utf8"));
      expect(typeof data.keywords).toBe("object");
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
