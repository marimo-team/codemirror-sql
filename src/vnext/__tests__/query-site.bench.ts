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

describe("query-site recognizer", () => {
  bench("10 KiB active statement", () => {
    recognizeSqlRelationQuerySite(source, slot, position, dialect);
  });
});
