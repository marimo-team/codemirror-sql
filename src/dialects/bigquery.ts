import { PostgreSQL, SQLDialect, type SQLDialectSpec } from "@codemirror/lang-sql";

/**
 * There is no custom BigQuery dialect at the moment,
 * but we want to provide a light wrapper around PostgreSQL
 */

const BigQuery: SQLDialectSpec = {
  ...PostgreSQL,
  caseInsensitiveIdentifiers: true, // Case-insensitive completes
  identifierQuotes: "`", // BigQuery uses backticks for identifiers
};

export const BigQueryDialect = SQLDialect.define(BigQuery);
