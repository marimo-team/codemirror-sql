import { expect, test } from "vitest";
import {
  decodeNodeSqlParserWireMessage,
  encodeNodeSqlParserWireRequest,
  NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
  type NodeSqlParserWireGrammar,
  type NodeSqlParserWireMessage,
} from "../node-sql-parser-wire.js";

const MESSAGE_TIMEOUT_MS = 4_000;
let activeMessageWaits = 0;

function createParserWorker(): Worker {
  return new Worker(
    new URL(
      "../node-sql-parser-browser-worker.ts",
      import.meta.url,
    ),
    {
      name: "codemirror-sql-parser-endpoint-test",
      type: "module",
    },
  );
}

function waitForWireMessage(
  worker: Worker,
): Promise<NodeSqlParserWireMessage> {
  activeMessageWaits += 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      operation: () => void,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("message", onMessage);
      activeMessageWaits -= 1;
      operation();
    };
    const onError = (): void => {
      finish(() => {
        reject(new Error("Parser module worker failed"));
      });
    };
    const onMessage = (event: MessageEvent<unknown>): void => {
      const message = decodeNodeSqlParserWireMessage(event.data);
      finish(() => {
        if (message === null) {
          reject(
            new Error("Parser module worker returned malformed wire data"),
          );
        } else {
          resolve(message);
        }
      });
    };
    const timeout = setTimeout(() => {
      finish(() => {
        reject(new Error("Parser module worker message timed out"));
      });
    }, MESSAGE_TIMEOUT_MS);
    worker.addEventListener("error", onError);
    worker.addEventListener("message", onMessage);
  });
}

async function request(
  worker: Worker,
  grammar: NodeSqlParserWireGrammar,
  requestId: number,
  text: string,
): Promise<
  Exclude<
    NodeSqlParserWireMessage,
    { readonly kind: "ready" | "protocol-error" }
  >
> {
  const responsePromise = waitForWireMessage(worker);
  worker.postMessage(
    encodeNodeSqlParserWireRequest(
      grammar,
      requestId,
      text,
    ),
  );
  const response = await responsePromise;
  if (
    response.kind === "ready" ||
    response.kind === "protocol-error" ||
    response.requestId !== requestId
  ) {
    throw new Error("Parser module worker response did not correlate");
  }
  return response;
}

test(
  "runs both lazy grammar backends through the closed worker protocol",
  { timeout: 10_000 },
  async () => {
    const keys = ["NodeSQLParser", "global"] as const;
    const originalDescriptors = keys.map((key) => ({
      descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
      key,
    }));
    const nodeSqlParserSentinel = Object.freeze({
      owner: "browser-main-node-sql-parser",
    });
    const globalSentinel = Object.freeze({
      owner: "browser-main-global",
    });
    const nodeSqlParserDescriptor: PropertyDescriptor = {
      configurable: true,
      enumerable: true,
      value: nodeSqlParserSentinel,
      writable: false,
    };
    const globalDescriptor: PropertyDescriptor = {
      configurable: true,
      enumerable: false,
      value: globalSentinel,
      writable: true,
    };
    Object.defineProperty(
      globalThis,
      "NodeSQLParser",
      nodeSqlParserDescriptor,
    );
    Object.defineProperty(globalThis, "global", globalDescriptor);

    let worker: Worker | undefined;
    try {
      worker = createParserWorker();
      await expect(waitForWireMessage(worker)).resolves.toStrictEqual({
        kind: "ready",
        protocolVersion: NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
      });

      const privateSourceMarker = "__wire_private_source_marker__";
      const firstPostgresql = await request(
        worker,
        "postgresql",
        1,
        `SELECT 1 AS ${privateSourceMarker}`,
      );
      expect(firstPostgresql).toStrictEqual({
        kind: "parsed",
        protocolVersion: NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
        requestId: 1,
        statementKind: "query",
      });
      expect(JSON.stringify(firstPostgresql)).not.toContain(
        privateSourceMarker,
      );
      expect(JSON.stringify(firstPostgresql)).not.toMatch(
        /(?:\bast\b|\berror\b|\bmessage\b|\broot\b|\bstack\b)/i,
      );

      await expect(
        request(worker, "postgresql", 2, "SELECT 2 AS warm_value"),
      ).resolves.toStrictEqual({
        kind: "parsed",
        protocolVersion: NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
        requestId: 2,
        statementKind: "query",
      });

      await expect(
        request(
          worker,
          "bigquery",
          3,
          "SELECT `project.dataset.table`.id FROM `project.dataset.table`",
        ),
      ).resolves.toStrictEqual({
        kind: "parsed",
        protocolVersion: NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
        requestId: 3,
        statementKind: "query",
      });

      await expect(
        request(worker, "postgresql", 4, "SELECT FROM"),
      ).resolves.toStrictEqual({
        kind: "syntax-rejected",
        protocolVersion: NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
        requestId: 4,
      });

      await expect(
        request(
          worker,
          "postgresql",
          5,
          "SELECT 1; SELECT 2",
        ),
      ).resolves.toStrictEqual({
        kind: "unsupported",
        protocolVersion: NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
        reason: "multiple-statements",
        requestId: 5,
      });

      expect(
        Object.getOwnPropertyDescriptor(
          globalThis,
          "NodeSQLParser",
        ),
      ).toStrictEqual(nodeSqlParserDescriptor);
      expect(
        Object.getOwnPropertyDescriptor(globalThis, "global"),
      ).toStrictEqual(globalDescriptor);
      expect(activeMessageWaits).toBe(0);
    } finally {
      worker?.terminate();
      for (const { descriptor, key } of originalDescriptors) {
        if (descriptor === undefined) {
          Reflect.deleteProperty(globalThis, key);
        } else {
          Object.defineProperty(globalThis, key, descriptor);
        }
      }
    }
    expect(activeMessageWaits).toBe(0);
  },
);

test(
  "fails closed on an invalid request without reflecting its data",
  { timeout: 10_000 },
  async () => {
    const worker = createParserWorker();
    try {
      await expect(waitForWireMessage(worker)).resolves.toStrictEqual({
        kind: "ready",
        protocolVersion: NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
      });
      const privateMarker = "__invalid_request_private_marker__";
      const responsePromise = waitForWireMessage(worker);
      worker.postMessage({
        grammar: "postgresql",
        kind: "parse",
        privateMarker,
        protocolVersion:
          NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION + 1,
        requestId: 6,
        text: "SELECT 1",
      });
      const response = await responsePromise;

      expect(response).toStrictEqual({
        code: "invalid-request",
        kind: "protocol-error",
        protocolVersion: NODE_SQL_PARSER_WIRE_PROTOCOL_VERSION,
      });
      expect(JSON.stringify(response)).not.toContain(privateMarker);
      expect(Reflect.has(response, "requestId")).toBe(false);
      expect(activeMessageWaits).toBe(0);
    } finally {
      worker.terminate();
    }
    expect(activeMessageWaits).toBe(0);
  },
);
