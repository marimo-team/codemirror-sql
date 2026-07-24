import { installParserWorker } from "./parser-worker.js";

installParserWorker({
  bigquery: async () =>
    await import("node-sql-parser/build/bigquery.js"),
  postgresql: async () =>
    await import("node-sql-parser/build/postgresql.js"),
});
