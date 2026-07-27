import { describe, expect, it } from "vitest";
import {
  bigQueryDialect,
  createSqlLanguageService,
  duckdbDialect,
  postgresDialect,
  type SqlDialect,
} from "../index.js";
import { bigQuerySemanticCompletion } from "../../test/corpora/semantic-completion/bigquery.js";
import { duckDbSemanticCompletion } from "../../test/corpora/semantic-completion/duckdb.js";
import { postgresqlSemanticCompletion } from "../../test/corpora/semantic-completion/postgresql.js";
import type {
  SemanticCompletionCase,
  SemanticCompletionCategory,
} from "../../test/corpora/semantic-completion/types.js";

const categories: readonly SemanticCompletionCategory[] = [
  "valid",
  "invalid",
  "incomplete",
  "templated",
  "multi-statement",
];

const corpora: readonly {
  readonly cases: readonly SemanticCompletionCase[];
  readonly dialect: SqlDialect;
}[] = [
  { cases: postgresqlSemanticCompletion, dialect: postgresDialect() },
  { cases: bigQuerySemanticCompletion, dialect: bigQueryDialect() },
  { cases: duckDbSemanticCompletion, dialect: duckdbDialect() },
];

describe.each(corpora)("$dialect.id semantic completion corpus", ({
  cases,
  dialect,
}) => {
  it("owns every required corpus category", () => {
    expect(new Set(cases.map((item) => item.category))).toEqual(
      new Set(categories),
    );
  });

  it.each(cases)("$category: $sql", async (fixture) => {
    const position = fixture.sql.indexOf("|");
    expect(position).toBeGreaterThanOrEqual(0);
    expect(fixture.sql.indexOf("|", position + 1)).toBe(-1);
    const text =
      fixture.sql.slice(0, position) + fixture.sql.slice(position + 1);
    const templateFrom = fixture.template
      ? text.indexOf(fixture.template)
      : -1;
    const service = createSqlLanguageService({
      dialects: [dialect],
    });
    const session = service.openDocument({
      context: { dialect: dialect.id },
      embeddedRegions: templateFrom < 0 || !fixture.template
        ? []
        : [{
            from: templateFrom,
            language: "host",
            to: templateFrom + fixture.template.length,
          }],
      text,
    });

    const result = await session.complete({
      position,
      trigger: { kind: "invoked" },
    });
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.value.items.map((item) => item.label)).toEqual(
        fixture.expectedLabels,
      );
      expect(result.value.isIncomplete).toBe(fixture.expectedIncomplete);
    }
    service.dispose();
  });
});
