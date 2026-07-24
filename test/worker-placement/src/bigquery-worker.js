import { installParserWorker } from "./parser-worker.js";

installParserWorker(
  async () => await import("node-sql-parser/build/bigquery.js"),
);
