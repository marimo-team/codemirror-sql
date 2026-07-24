// @vitest-environment node

import { beforeAll, bench, describe, expect } from "vitest";
import {
  getBigQueryNodeSqlStatementParser,
  getDuckDbCompatibilityNodeSqlStatementParser,
  getPostgresqlNodeSqlStatementParser,
} from "../node-sql-parser-adapter.js";
import {
  createSqlStatementParseRequest,
  runSqlStatementParser,
  type SqlStatementParser,
} from "../syntax.js";

function statementNear(targetLength: number): string {
  const prefix = "SELECT ";
  const suffix = " FROM benchmark_table";
  const columns: string[] = [];
  let columnLength = 0;
  for (let index = 0; ; index += 1) {
    const column = `column_${index}`;
    const separatorLength = columns.length === 0 ? 0 : 2;
    if (
      prefix.length +
        columnLength +
        separatorLength +
        column.length +
        suffix.length >
      targetLength
    ) {
      break;
    }
    columns.push(column);
    columnLength += separatorLength + column.length;
  }
  return `${prefix}${columns.join(", ")}${suffix}`;
}

const controller = new AbortController();
const statements = [
  ["1 KiB", statementNear(1024)],
  ["8 KiB", statementNear(8 * 1024)],
  ["16 KiB", statementNear(16 * 1024)],
] as const;

function requestFor(statement: string) {
  return createSqlStatementParseRequest(
    statement,
    controller.signal,
  );
}

const requests = statements.map(
  ([label, statement]) =>
    [label, requestFor(statement)] as const,
);

const postgresqlParser = getPostgresqlNodeSqlStatementParser();
const bigQueryParser = getBigQueryNodeSqlStatementParser();
const duckDbParser = getDuckDbCompatibilityNodeSqlStatementParser();

async function parse(
  parser: SqlStatementParser,
  request: ReturnType<typeof createSqlStatementParseRequest>,
) {
  return await runSqlStatementParser(parser, request);
}

beforeAll(async () => {
  const warmup = requestFor("SELECT 1");
  const warmups = await Promise.all([
    parse(postgresqlParser, warmup),
    parse(bigQueryParser, warmup),
    parse(duckDbParser, warmup),
  ]);
  for (const state of warmups) {
    expect(state.analysis).toMatchObject({
      mode: "compatibility",
      status: "parsed",
    });
  }
  for (const [, request] of requests) {
    const states = await Promise.all([
      parse(postgresqlParser, request),
      parse(bigQueryParser, request),
    ]);
    for (const state of states) {
      expect(state.analysis).toMatchObject({
        limitations: ["partial-artifact"],
        mode: "compatibility",
        status: "parsed",
      });
    }
  }
  const duckDbRequest = requests[1]?.[1];
  if (duckDbRequest === undefined) {
    throw new Error("DuckDB benchmark request is unavailable");
  }
  expect(
    (await parse(duckDbParser, duckDbRequest)).analysis,
  ).toMatchObject({
    limitations: ["dialect-compatibility", "partial-artifact"],
    mode: "compatibility",
    status: "parsed",
  });
});

describe("node-sql-parser adapter", () => {
  for (const [label, request] of requests) {
    bench(`PostgreSQL ${label}`, async () => {
      await parse(postgresqlParser, request);
    });

    bench(`BigQuery ${label}`, async () => {
      await parse(bigQueryParser, request);
    });
  }

  bench("DuckDB compatibility 8 KiB", async () => {
    const request = requests[1]?.[1];
    if (request === undefined) {
      throw new Error("DuckDB benchmark request is unavailable");
    }
    await parse(duckDbParser, request);
  });
});
