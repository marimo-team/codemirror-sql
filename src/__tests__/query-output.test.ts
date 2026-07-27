import { describe, expect, it } from "vitest";
import { inferSqlQueryOutput } from "../query-output.js";
import {
  BIGQUERY_SQL_RELATION_DIALECT,
  POSTGRESQL_SQL_RELATION_DIALECT,
} from "../relation-dialect.js";
import {
  createIdentitySqlSource,
  createMaskedSqlSource,
} from "../source.js";

function infer(
  text: string,
  dialect = POSTGRESQL_SQL_RELATION_DIALECT,
) {
  const source = createIdentitySqlSource(text);
  return inferSqlQueryOutput(
    source,
    { from: 0, to: text.length },
    dialect,
  );
}

describe("query output inference", () => {
  it("infers simple and explicitly aliased projection names", () => {
    expect(
      infer("SELECT users.id, upper(name) AS display_name FROM users"),
    ).toMatchObject({
      columns: [
        {
          identifier: { quoted: false, value: "id" },
          insertText: "id",
        },
        {
          identifier: { quoted: false, value: "display_name" },
          insertText: "display_name",
        },
      ],
      coverage: "complete",
      status: "ready",
    });
  });

  it("keeps known names while marking unprovable expressions partial", () => {
    expect(infer("SELECT id, upper(name), * FROM users")).toMatchObject({
      columns: [{
        identifier: { quoted: false, value: "id" },
      }],
      coverage: "partial",
      status: "ready",
    });
  });

  it.each([
    "SELECT DISTINCT id",
    "SELECT ALL id",
  ])("ignores a projection quantifier in %s", (text) => {
    expect(infer(text)).toMatchObject({
      columns: [{ identifier: { value: "id" } }],
      coverage: "complete",
    });
  });

  it.each([
    "SELECT , id",
    "SELECT (id)",
    "SELECT id.",
    "SELECT {opaque}",
  ])("keeps unsupported projection shape partial in %s", (text) => {
    expect(infer(text)).toMatchObject({
      coverage: "partial",
      status: "ready",
    });
  });

  it.each([
    "SELECT id /* unterminated",
    "SELECT id FROM users WHERE name = 'unterminated",
  ])("marks output inference partial for %s", (text) => {
    expect(infer(text)).toMatchObject({
      columns: [{ identifier: { value: "id" } }],
      coverage: "partial",
      status: "ready",
    });
  });

  it("uses the first set-operation arm for output names", () => {
    expect(
      infer(
        "SELECT id AS first_name FROM users " +
          "UNION ALL SELECT id AS later_name FROM archived",
      ),
    ).toMatchObject({
      columns: [{
        identifier: { quoted: false, value: "first_name" },
      }],
      coverage: "complete",
      status: "ready",
    });
  });

  it("uses a parenthesized first set-operation arm for output names", () => {
    expect(
      infer(
        "(SELECT id AS first_name FROM users) " +
          "UNION ALL SELECT id AS later_name FROM archived",
      ),
    ).toMatchObject({
      columns: [{
        identifier: { quoted: false, value: "first_name" },
      }],
      coverage: "complete",
      status: "ready",
    });
  });

  it("uses the first projection of a nested first set arm", () => {
    expect(
      infer(
        "(SELECT a AS first_name UNION SELECT b AS second_name) " +
          "UNION SELECT c AS later_name",
      ),
    ).toMatchObject({
      columns: [{
        identifier: { quoted: false, value: "first_name" },
      }],
      coverage: "complete",
      status: "ready",
    });
  });

  it("selects the outer projection after a nested WITH body", () => {
    expect(
      infer(
        "WITH inner_cte AS (SELECT hidden FROM source) " +
          "SELECT visible FROM inner_cte",
      ),
    ).toMatchObject({
      columns: [{
        identifier: { quoted: false, value: "visible" },
      }],
      coverage: "complete",
      status: "ready",
    });
  });

  it("preserves BigQuery quoted insertion spelling", () => {
    expect(
      infer("SELECT value AS `Display Name` FROM source", BIGQUERY_SQL_RELATION_DIALECT),
    ).toMatchObject({
      columns: [{
        identifier: { quoted: true, value: "Display Name" },
        insertText: "`Display Name`",
      }],
      coverage: "complete",
      status: "ready",
    });
  });

  it("keeps an aliased embedded projection explicitly partial", () => {
    const text = "SELECT {opaque} AS metric";
    const from = text.indexOf("{opaque}");
    const source = createMaskedSqlSource(text, [{
      from,
      language: "template",
      to: from + "{opaque}".length,
    }]);
    expect(inferSqlQueryOutput(
      source,
      { from: 0, to: text.length },
      POSTGRESQL_SQL_RELATION_DIALECT,
    )).toMatchObject({
      columns: [{ identifier: { value: "metric" } }],
      coverage: "partial",
      status: "ready",
    });
  });

  it("fails bounded and non-query ranges closed", () => {
    expect(infer("VALUES (1)")).toEqual({
      reason: "unsupported-query",
      status: "unavailable",
    });
    const text = `SELECT ${"x".repeat(65_537)}`;
    expect(infer(text)).toEqual({
      reason: "resource-limit",
      status: "unavailable",
    });
  });

  it("bounds output count and lexical work", () => {
    const wide = `SELECT ${Array.from(
      { length: 257 },
      (_, index) => `column_${index}`,
    ).join(", ")}`;
    expect(infer(wide)).toMatchObject({
      columns: { length: 256 },
      coverage: "partial",
      status: "ready",
    });
    const lexical = `SELECT ${"a+".repeat(9_000)}a`;
    expect(infer(lexical)).toEqual({
      reason: "resource-limit",
      status: "unavailable",
    });
  });

  it.each([
    { from: -1, to: 1 },
    { from: 1, to: 1 },
    { from: 0.5, to: 1 },
    { from: 0, to: 100 },
  ])("rejects invalid range $from..$to", (range) => {
    const source = createIdentitySqlSource("SELECT id");
    expect(
      inferSqlQueryOutput(
        source,
        range,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    ).toEqual({
      reason: "resource-limit",
      status: "unavailable",
    });
  });
});
