import { installNodeSqlParserBrowserWorkerEndpoint } from "./node-sql-parser-browser-worker-endpoint.js";

installNodeSqlParserBrowserWorkerEndpoint(globalThis, {
  bigquery: async () =>
    await import("node-sql-parser/build/bigquery.js"),
  postgresql: async () =>
    await import("node-sql-parser/build/postgresql.js"),
});
