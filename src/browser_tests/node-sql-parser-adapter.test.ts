import { expect, test } from "vitest";
import {
  getBigQueryNodeSqlStatementParser,
  getPostgresqlNodeSqlStatementParser,
} from "../node-sql-parser-adapter.js";
import {
  createSqlStatementParseRequest,
  runSqlStatementParser,
  type SqlStatementParser,
} from "../syntax.js";

const parserGlobalKeys = ["NodeSQLParser", "global"] as const;

function snapshotGlobals() {
  return parserGlobalKeys.map((key) => ({
    descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
    key,
  }));
}

function restoreGlobals(
  snapshots: ReturnType<typeof snapshotGlobals>,
): void {
  for (const { descriptor, key } of snapshots) {
    if (descriptor === undefined) {
      Reflect.deleteProperty(globalThis, key);
    } else {
      Object.defineProperty(globalThis, key, descriptor);
    }
  }
}

async function expectWindowRealmBlocked(
  parser: SqlStatementParser,
): Promise<void> {
  const state = await runSqlStatementParser(
    parser,
    createSqlStatementParseRequest(
      "SELECT 1 AS value",
      new AbortController().signal,
    ),
  );
  expect(state).toMatchObject({
    analysis: {
      reason: "backend-failure",
      retryable: false,
      status: "failed",
    },
    state: "analyzed",
  });
}

test(
  "window-realm dialect requests fail without mutating globals",
  { timeout: 10_000 },
  async () => {
    const original = snapshotGlobals();
    try {
      const nodeSqlParserSentinel = Object.freeze({
        owner: "consumer",
      });
      const nodeSqlParserDescriptor: PropertyDescriptor = {
        configurable: true,
        enumerable: false,
        value: nodeSqlParserSentinel,
        writable: true,
      };
      const globalDescriptor: PropertyDescriptor = {
        configurable: true,
        enumerable: true,
        value: undefined,
        writable: true,
      };
      Object.defineProperty(
        globalThis,
        "NodeSQLParser",
        nodeSqlParserDescriptor,
      );
      Object.defineProperty(globalThis, "global", globalDescriptor);

      await Promise.all([
        expectWindowRealmBlocked(
          getPostgresqlNodeSqlStatementParser(),
        ),
        expectWindowRealmBlocked(
          getBigQueryNodeSqlStatementParser(),
        ),
      ]);
      expect(
        Object.getOwnPropertyDescriptor(
          globalThis,
          "NodeSQLParser",
        ),
      ).toStrictEqual(nodeSqlParserDescriptor);
      expect(
        Object.getOwnPropertyDescriptor(globalThis, "global"),
      ).toStrictEqual(globalDescriptor);
    } finally {
      restoreGlobals(original);
    }
  },
);
