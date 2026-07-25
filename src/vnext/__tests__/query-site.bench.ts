import { bench, describe } from "vitest";
import {
  analyzeSqlCteLayout,
  MAX_CTE_DECLARATIONS,
} from "../cte-layout.js";
import {
  recognizeSqlRelationQuerySite,
} from "../query-site.js";
import { DUCKDB_SQL_RELATION_DIALECT } from "../relation-dialect.js";
import {
  recognizeSqlRelationQuerySiteWithCteLayout,
} from "../relation-query-site.js";
import { createIdentitySqlSource } from "../source.js";
import {
  buildSqlStatementIndex,
  findSqlStatementSlot,
} from "../statement-index.js";

const dialect = DUCKDB_SQL_RELATION_DIALECT.querySite;
const TEN_KIBIBYTES = 10 * 1_024;
const queryPrefix = "SELECT ";
const querySuffix = " FROM schema_prefix";
const projectedListLength =
  TEN_KIBIBYTES - queryPrefix.length - querySuffix.length;
const projectedList = `${"x,".repeat(
  Math.floor((projectedListLength - 1) / 2),
)}x`;
const tenKilobyteQuery = `${queryPrefix}${projectedList}${" ".repeat(
  projectedListLength - projectedList.length,
)}${querySuffix}`;
if (tenKilobyteQuery.length !== TEN_KIBIBYTES) {
  throw new Error("Query benchmark fixture must be exactly 10 KiB");
}
const source = createIdentitySqlSource(tenKilobyteQuery);
const index = buildSqlStatementIndex(
  source.analysisText,
  dialect.lexicalProfile,
);
const position = tenKilobyteQuery.length;
const slot = findSqlStatementSlot(index, position, "left");
const aliasHeavyQuery = `SELECT * FROM ${Array.from(
  { length: 1_000 },
  (_, aliasIndex) => `table_name alias_${aliasIndex}`,
).join(", ")}, `;
const aliasHeavySource = createIdentitySqlSource(aliasHeavyQuery);
const aliasHeavyIndex = buildSqlStatementIndex(
  aliasHeavySource.analysisText,
  dialect.lexicalProfile,
);
const aliasHeavyPosition = aliasHeavyQuery.length;
const aliasHeavySlot = findSqlStatementSlot(
  aliasHeavyIndex,
  aliasHeavyPosition,
  "left",
);
const usingHeavyQuery = `SELECT * FROM first_table JOIN second_table USING(${Array.from(
  { length: 1_000 },
  (_, columnIndex) => `column_${columnIndex}`,
).join(", ")}) JOIN target`;
const usingHeavySource = createIdentitySqlSource(usingHeavyQuery);
const usingHeavyIndex = buildSqlStatementIndex(
  usingHeavySource.analysisText,
  dialect.lexicalProfile,
);
const usingHeavyPosition = usingHeavyQuery.length;
const usingHeavySlot = findSqlStatementSlot(
  usingHeavyIndex,
  usingHeavyPosition,
  "left",
);
const cteQueryPrefix =
  "WITH cte_name AS (SELECT 1) SELECT ";
const cteQuerySuffix = " FROM schema_prefix";
const cteProjectedListLength =
  TEN_KIBIBYTES -
  cteQueryPrefix.length -
  cteQuerySuffix.length;
const cteProjectedList = `${"x,".repeat(
  Math.floor((cteProjectedListLength - 1) / 2),
)}x`;
const tenKilobyteCteQuery =
  `${cteQueryPrefix}${cteProjectedList}` +
  `${" ".repeat(
    cteProjectedListLength - cteProjectedList.length,
  )}${cteQuerySuffix}`;
if (tenKilobyteCteQuery.length !== TEN_KIBIBYTES) {
  throw new Error("CTE query benchmark fixture must be exactly 10 KiB");
}
const cteSource = createIdentitySqlSource(tenKilobyteCteQuery);
const cteIndex = buildSqlStatementIndex(
  cteSource.analysisText,
  dialect.lexicalProfile,
);
const ctePosition = tenKilobyteCteQuery.length;
const cteSlot = findSqlStatementSlot(
  cteIndex,
  ctePosition,
  "left",
);
if (cteSlot.boundaryQuality === "opaque") {
  throw new Error("CTE query benchmark requires an exact statement");
}
const maximumCteQuery =
  `WITH ${Array.from(
    { length: MAX_CTE_DECLARATIONS },
    (_, index) => `cte_${index} AS (SELECT ${index})`,
  ).join(", ")} SELECT * FROM target`;
const maximumCteSource =
  createIdentitySqlSource(maximumCteQuery);
const maximumCteIndex = buildSqlStatementIndex(
  maximumCteSource.analysisText,
  dialect.lexicalProfile,
);
const maximumCtePosition = maximumCteQuery.length;
const maximumCteSlot = findSqlStatementSlot(
  maximumCteIndex,
  maximumCtePosition,
  "left",
);
if (maximumCteSlot.boundaryQuality === "opaque") {
  throw new Error("Maximum CTE benchmark requires an exact statement");
}
const ctePreflightLayout = analyzeSqlCteLayout(
  cteSource,
  cteIndex,
  cteSlot,
  DUCKDB_SQL_RELATION_DIALECT.cteLayout,
);
const ctePreflightResult =
  recognizeSqlRelationQuerySiteWithCteLayout(
    cteSource,
    cteSlot,
    ctePosition,
    DUCKDB_SQL_RELATION_DIALECT,
    ctePreflightLayout,
  );
if (
  ctePreflightLayout.status !== "ready" ||
  ctePreflightResult.status !== "ready" ||
  ctePreflightResult.anchor !== "from"
) {
  throw new Error("CTE query benchmark must exercise a ready FROM site");
}
const maximumCtePreflightLayout = analyzeSqlCteLayout(
  maximumCteSource,
  maximumCteIndex,
  maximumCteSlot,
  DUCKDB_SQL_RELATION_DIALECT.cteLayout,
);
const maximumCtePreflightResult =
  recognizeSqlRelationQuerySiteWithCteLayout(
    maximumCteSource,
    maximumCteSlot,
    maximumCtePosition,
    DUCKDB_SQL_RELATION_DIALECT,
    maximumCtePreflightLayout,
  );
if (
  maximumCtePreflightLayout.status !== "ready" ||
  maximumCtePreflightLayout.declarations.length !==
    MAX_CTE_DECLARATIONS ||
  maximumCtePreflightLayout.mainQueryEntrypoints.length !== 1 ||
  maximumCtePreflightResult.status !== "ready" ||
  maximumCtePreflightResult.prefix.value !== "target"
) {
  throw new Error("Maximum CTE benchmark must exercise all declarations");
}

describe("query-site recognizer", () => {
  bench("10 KiB active statement", () => {
    recognizeSqlRelationQuerySite(source, slot, position, dialect);
  });

  bench("1,000 classified aliases", () => {
    recognizeSqlRelationQuerySite(
      aliasHeavySource,
      aliasHeavySlot,
      aliasHeavyPosition,
      dialect,
    );
  });

  bench("1,000 authenticated USING columns", () => {
    recognizeSqlRelationQuerySite(
      usingHeavySource,
      usingHeavySlot,
      usingHeavyPosition,
      dialect,
    );
  });

  bench("10 KiB WITH main-query double scan", () => {
    const layout = analyzeSqlCteLayout(
      cteSource,
      cteIndex,
      cteSlot,
      DUCKDB_SQL_RELATION_DIALECT.cteLayout,
    );
    recognizeSqlRelationQuerySiteWithCteLayout(
      cteSource,
      cteSlot,
      ctePosition,
      DUCKDB_SQL_RELATION_DIALECT,
      layout,
    );
  });

  bench("256 CTE main-query double scan", () => {
    const layout = analyzeSqlCteLayout(
      maximumCteSource,
      maximumCteIndex,
      maximumCteSlot,
      DUCKDB_SQL_RELATION_DIALECT.cteLayout,
    );
    recognizeSqlRelationQuerySiteWithCteLayout(
      maximumCteSource,
      maximumCteSlot,
      maximumCtePosition,
      DUCKDB_SQL_RELATION_DIALECT,
      layout,
    );
  });
});
