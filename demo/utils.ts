import { MySQL, PostgreSQL, type SQLDialect, SQLite } from "@codemirror/lang-sql";
import { DuckDBDialect } from "../src/dialects/duckdb/duckdb";
import type { SupportedDialects } from "../src/sql/parser";

export function guessSqlDialect(dialect: SupportedDialects): SQLDialect {
  // Other supported dialects: Cassandra, MSSQL, MariaSQL, MySQL, PLSQL, PostgreSQL
  switch (dialect) {
    case "PostgreSQL":
      return PostgreSQL;
    case "DuckDB":
      return DuckDBDialect;
    case "MySQL":
      return MySQL;
    case "Sqlite":
      return SQLite;
    default:
      return PostgreSQL;
  }
}
