import { bench, describe } from "vitest";
import {
  recognizeSqlRelationQuerySite,
  type SqlQuerySiteDialect,
} from "../query-site.js";
import { createIdentitySqlSource } from "../source.js";
import {
  buildSqlStatementIndex,
  DUCKDB_SQL_LEXICAL_PROFILE,
  findSqlStatementSlot,
} from "../statement-index.js";

const dialect: SqlQuerySiteDialect = {
  classifyRelationAlias: (rawAlias) => ({
    status: "identifier",
    value: rawAlias,
  }),
  decodeRelationPath: (rawPath, cursorOffset) => ({
    finalSegment: { from: 0, to: rawPath.length },
    prefix: {
      quoted: false,
      value: rawPath.slice(0, cursorOffset),
    },
    qualifier: [],
    quality: "exact",
    status: "decoded",
  }),
  lexicalProfile: DUCKDB_SQL_LEXICAL_PROFILE,
  maximumPathDepth: 16,
  supportsNaturalJoin: true,
};
const tenKilobyteQuery = `SELECT ${Array.from(
  { length: 1_100 },
  (_, index) => `value_${index}`,
).join(", ")} FROM schema_prefix`;
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
});
