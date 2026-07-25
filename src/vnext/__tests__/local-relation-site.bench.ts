import { bench, describe } from "vitest";
import { MAX_CTE_DECLARATIONS } from "../cte-layout.js";
import {
  analyzeSqlLocalRelationSite,
  prepareSqlLocalRelationStatement,
  type SqlLocalRelationStatement,
} from "../local-relation-site.js";
import { DUCKDB_SQL_RELATION_DIALECT } from "../relation-dialect.js";
import { createIdentitySqlSource } from "../source.js";
import {
  buildSqlStatementIndex,
  findSqlStatementSlot,
} from "../statement-index.js";

interface Fixture {
  readonly index: ReturnType<typeof buildSqlStatementIndex>;
  readonly position: number;
  readonly slot: ReturnType<typeof findSqlStatementSlot>;
  readonly source: ReturnType<typeof createIdentitySqlSource>;
  readonly statement: SqlLocalRelationStatement;
}

function fixture(text: string): Fixture {
  const source = createIdentitySqlSource(text);
  const index = buildSqlStatementIndex(
    source.analysisText,
    DUCKDB_SQL_RELATION_DIALECT.querySite.lexicalProfile,
  );
  const position = text.length;
  const slot = findSqlStatementSlot(index, position, "left");
  const preparation = prepareSqlLocalRelationStatement(
    source,
    index,
    slot,
    DUCKDB_SQL_RELATION_DIALECT,
  );
  if (preparation.status === "unavailable") {
    throw new Error("Local relation benchmark must prepare");
  }
  return {
    index,
    position,
    slot,
    source,
    statement: preparation.statement,
  };
}

function coldAnalyze(value: Fixture) {
  const preparation = prepareSqlLocalRelationStatement(
    value.source,
    value.index,
    value.slot,
    DUCKDB_SQL_RELATION_DIALECT,
  );
  if (preparation.status === "unavailable") {
    throw new Error("Cold local relation benchmark must prepare");
  }
  return analyzeSqlLocalRelationSite(
    preparation.statement,
    value.position,
  );
}

const tenKibibytes = 10 * 1_024;
const withPrefix = "WITH local_cte AS (SELECT 1) SELECT ";
const withSuffix = " FROM target";
const projectionLength =
  tenKibibytes - withPrefix.length - withSuffix.length;
const withText = `${withPrefix}${"x,".repeat(
  Math.floor((projectionLength - 1) / 2),
)}x${withSuffix}`;
const paddedWithText = `${withText.slice(
  0,
  -withSuffix.length,
)}${" ".repeat(tenKibibytes - withText.length)}${withSuffix}`;
if (paddedWithText.length !== tenKibibytes) {
  throw new Error("Local relation benchmark must be exactly 10 KiB");
}
const withFixture = fixture(paddedWithText);

const maximumCteText = `WITH ${Array.from(
  { length: MAX_CTE_DECLARATIONS },
  (_, index) => `c${index} AS (SELECT ${index})`,
).join(", ")} SELECT * FROM target`;
const maximumCteFixture = fixture(maximumCteText);

const withPreflight = analyzeSqlLocalRelationSite(
  withFixture.statement,
  withFixture.position,
);
const maximumCtePreflight = analyzeSqlLocalRelationSite(
  maximumCteFixture.statement,
  maximumCteFixture.position,
);
if (
  withPreflight.status !== "ready" ||
  withPreflight.local.kind !== "unqualified" ||
  withPreflight.local.cteVisibility.ctes.length !== 1
) {
  throw new Error("10 KiB benchmark must expose one visible CTE");
}
if (
  maximumCtePreflight.status !== "ready" ||
  maximumCtePreflight.local.kind !== "unqualified" ||
  maximumCtePreflight.local.cteVisibility.ctes.length !==
    MAX_CTE_DECLARATIONS
) {
  throw new Error("Maximum benchmark must expose every CTE");
}

describe("local relation site", () => {
  bench("cold 10 KiB WITH statement", () => {
    coldAnalyze(withFixture);
  });

  bench("warm 10 KiB WITH statement", () => {
    analyzeSqlLocalRelationSite(
      withFixture.statement,
      withFixture.position,
    );
  });

  bench("cold 256-CTE statement", () => {
    coldAnalyze(maximumCteFixture);
  });

  bench("warm 256-CTE statement", () => {
    analyzeSqlLocalRelationSite(
      maximumCteFixture.statement,
      maximumCteFixture.position,
    );
  });
});
