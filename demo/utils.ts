import { MariaSQL, MySQL, PostgreSQL, type SQLDialect, SQLite } from "@codemirror/lang-sql";
import { DuckDBDialect } from "../src/dialects/duckdb/duckdb";
import type { SupportedDialects } from "../src/sql/parser";

const demoDialects = new Map<string, SupportedDialects>([
  ["PostgreSQL", "PostgreSQL"],
  ["MySQL", "MySQL"],
  ["SQLite", "Sqlite"],
  ["MariaDB", "MariaDB"],
  ["Snowflake", "Snowflake"],
  ["DuckDB", "DuckDB"],
]);

export function parseDemoDialect(value: string): SupportedDialects | undefined {
  return demoDialects.get(value);
}

export function guessSqlDialect(dialect: SupportedDialects): SQLDialect {
  switch (dialect) {
    case "PostgreSQL":
      return PostgreSQL;
    case "DuckDB":
      return DuckDBDialect;
    case "MySQL":
      return MySQL;
    case "MariaDB":
      return MariaSQL;
    case "Sqlite":
      return SQLite;
    default:
      return PostgreSQL;
  }
}
