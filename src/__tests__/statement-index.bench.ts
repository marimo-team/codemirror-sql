import { bench, describe } from "vitest";
import {
  buildSqlStatementIndex,
  DUCKDB_SQL_LEXICAL_PROFILE,
  MAX_SQL_STATEMENT_SLOTS,
  updateSqlStatementIndex,
} from "../statement-index.js";

const padding = "x".repeat(1_000);
const oneMegabyteDocument = Array.from(
  { length: 1_000 },
  (_, index) => `SELECT ${index} AS value /* ${padding} */`,
).join(";\n");
const previousIndex = buildSqlStatementIndex(
  oneMegabyteDocument,
  DUCKDB_SQL_LEXICAL_PROFILE,
);
const middleFrom = oneMegabyteDocument.indexOf("500 AS value");
const localChanges = [
  {
    from: middleFrom,
    insert: "501",
    to: middleFrom + 3,
  },
] as const;
const localDocument =
  oneMegabyteDocument.slice(0, middleFrom) +
  "501" +
  oneMegabyteDocument.slice(middleFrom + 3);
const shiftedChanges = [{ from: 0, insert: "-- lead\n", to: 0 }] as const;
const shiftedDocument = `-- lead\n${oneMegabyteDocument}`;
const cappedDocument = ";".repeat(MAX_SQL_STATEMENT_SLOTS + 5);
const cappedIndex = buildSqlStatementIndex(
  cappedDocument,
  DUCKDB_SQL_LEXICAL_PROFILE,
);
const capRecoveryChanges = [{ from: 0, insert: "", to: 10 }] as const;
const recoveredDocument = cappedDocument.slice(10);

describe("statement index", () => {
  bench("full 1 MiB scan", () => {
    buildSqlStatementIndex(
      oneMegabyteDocument,
      DUCKDB_SQL_LEXICAL_PROFILE,
    );
  });

  bench("incremental 1 MiB middle edit", () => {
    updateSqlStatementIndex(
      previousIndex,
      localDocument,
      localChanges,
      DUCKDB_SQL_LEXICAL_PROFILE,
    );
  });

  bench("incremental 1 MiB prefix shift", () => {
    updateSqlStatementIndex(
      previousIndex,
      shiftedDocument,
      shiftedChanges,
      DUCKDB_SQL_LEXICAL_PROFILE,
    );
  });

  bench("incremental resource-cap recovery", () => {
    updateSqlStatementIndex(
      cappedIndex,
      recoveredDocument,
      capRecoveryChanges,
      DUCKDB_SQL_LEXICAL_PROFILE,
    );
  });
});
