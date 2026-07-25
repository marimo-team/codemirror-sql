import { bench, describe } from "vitest";
import {
  recognizeSqlRelationQuerySite,
} from "../query-site.js";
import { DUCKDB_SQL_RELATION_DIALECT } from "../relation-dialect.js";
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
});
