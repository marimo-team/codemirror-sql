import { describe, expect, it, vi } from "vitest";
import {
  captureSqlColumnCatalogProvider,
  createSqlColumnCatalogBatchRequest,
  decodeSqlColumnCatalogBatchResponse,
  MAX_COLUMN_BATCH_RELATIONS,
  MAX_COLUMN_ENTITY_ID_LENGTH,
  MAX_COLUMNS_PER_RELATION,
  resolveSqlColumnCatalogProvider,
} from "../column-catalog-boundary.js";

const epoch = Object.freeze({ generation: 7, token: "epoch-7" });
const path = Object.freeze([
  Object.freeze({ quoted: false, value: "users" }),
]);

function request() {
  const result = createSqlColumnCatalogBatchRequest({
    dialectId: "duckdb",
    expectedEpoch: epoch,
    relations: [
      { path, requestKey: "users" },
      {
        path: [{ quoted: false, value: "events" }],
        relationEntityId: "relation-events",
        requestKey: "events",
      },
    ],
    scope: "connection-1",
    searchPaths: [[{ quoted: false, value: "main" }]],
  });
  if (result.status !== "accepted") {
    throw new Error("Expected valid request");
  }
  return result.value;
}

function provider(loadColumns: (...arguments_: unknown[]) => unknown) {
  const captured = captureSqlColumnCatalogProvider({
    id: "catalog",
    loadColumns,
  });
  if (captured.status !== "accepted") {
    throw new Error("Expected valid provider");
  }
  return captured.value;
}

function readyResponse() {
  return {
    epoch,
    relations: [
      {
        columns: [
          {
            columnEntityId: "column-name",
            dataType: "VARCHAR",
            identifier: { quoted: false, value: "name" },
            insertText: "name",
            ordinal: 1,
          },
          {
            columnEntityId: "column-id",
            detail: "primary key",
            identifier: { quoted: false, value: "id" },
            insertText: "id",
            ordinal: 0,
          },
        ],
        coverage: "complete",
        relationEntityId: "relation-users",
        requestKey: "users",
        status: "ready",
      },
      {
        code: "unavailable",
        requestKey: "events",
        retry: "next-request",
        status: "failed",
      },
    ],
  };
}

describe("column catalog provider boundary", () => {
  it("captures methods without retaining provider receivers", () => {
    const calls: unknown[][] = [];
    const captured = provider(function (
      this: unknown,
      ...arguments_: unknown[]
    ) {
      calls.push([this, ...arguments_]);
      return null;
    });
    const resolved = resolveSqlColumnCatalogProvider(captured);
    const signal = new AbortController().signal;
    resolved?.loadColumns(request(), signal);

    expect(resolved?.id).toBe("catalog");
    expect(calls).toEqual([[undefined, request(), signal]]);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(resolveSqlColumnCatalogProvider({})).toBeNull();
  });

  it("rejects inherited, accessor, and oversized provider data", () => {
    let calls = 0;
    const accessor = Object.defineProperty(
      { id: "catalog" },
      "loadColumns",
      {
        get: () => {
          calls += 1;
          return () => undefined;
        },
      },
    );
    expect(captureSqlColumnCatalogProvider(accessor)).toMatchObject({
      reason: "invalid-shape",
      status: "malformed",
    });
    expect(calls).toBe(0);
    expect(captureSqlColumnCatalogProvider(
      Object.create({ id: "catalog", loadColumns: () => undefined }),
    ).status).toBe("malformed");
    expect(captureSqlColumnCatalogProvider({
      id: "x".repeat(257),
      loadColumns: () => undefined,
    }).status).toBe("malformed");
    expect(captureSqlColumnCatalogProvider(null).status).toBe("malformed");
  });
});

describe("column catalog batch request boundary", () => {
  it("normalizes paths, search paths, and deterministic request order", () => {
    const result = createSqlColumnCatalogBatchRequest({
      dialectId: "duckdb",
      expectedEpoch: epoch,
      relations: [
        { path, requestKey: "z" },
        { path, relationEntityId: "stable-a", requestKey: "a" },
      ],
      scope: "scope",
      searchPaths: [[{ quoted: true, value: "Main" }]],
    });
    expect(result).toMatchObject({
      status: "accepted",
      value: {
        relations: [
          { relationEntityId: "stable-a", requestKey: "a" },
          { requestKey: "z" },
        ],
      },
    });
    if (result.status === "accepted") {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.relations)).toBe(true);
      expect(Object.isFrozen(result.value.relations[0]?.path)).toBe(true);
      expect(Object.isFrozen(result.value.searchPaths)).toBe(true);
    }
  });

  it("rejects malformed, duplicate, sparse, and resource-heavy requests", () => {
    const base = {
      dialectId: "duckdb",
      expectedEpoch: epoch,
      scope: "scope",
      searchPaths: [],
    };
    for (const relations of [
      [],
      [{ path: [], requestKey: "empty-path" }],
      [{ path, requestKey: "" }],
      [
        { path, requestKey: "same" },
        { path, requestKey: "same" },
      ],
      Array.from(
        { length: MAX_COLUMN_BATCH_RELATIONS + 1 },
        (_, index) => ({ path, requestKey: `r${index}` }),
      ),
    ]) {
      expect(createSqlColumnCatalogBatchRequest({
        ...base,
        relations,
      }).status).toBe("malformed");
    }
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(createSqlColumnCatalogBatchRequest({
      ...base,
      relations: sparse,
    }).status).toBe("malformed");
    expect(createSqlColumnCatalogBatchRequest({
      ...base,
      relations: [{
        path,
        relationEntityId: "x".repeat(MAX_COLUMN_ENTITY_ID_LENGTH + 1),
        requestKey: "long",
      }],
    }).status).toBe("malformed");
    expect(createSqlColumnCatalogBatchRequest(
      Object.create(base),
    ).status).toBe("malformed");
  });

  it("does not invoke request accessors or hostile array iterators", () => {
    let getterCalls = 0;
    const input = Object.defineProperty(
      {
        dialectId: "duckdb",
        epoch,
        relations: [{ path, requestKey: "users" }],
        searchPaths: [],
      },
      "scope",
      {
        get: () => {
          getterCalls += 1;
          return "scope";
        },
      },
    );
    expect(createSqlColumnCatalogBatchRequest(input).status).toBe(
      "malformed",
    );
    expect(getterCalls).toBe(0);

    const relations = [{ path, requestKey: "users" }];
    Object.defineProperty(relations, Symbol.iterator, {
      value: () => {
        throw new Error("iterator must not run");
      },
    });
    expect(createSqlColumnCatalogBatchRequest({
      dialectId: "duckdb",
      expectedEpoch: epoch,
      relations,
      scope: "scope",
      searchPaths: [],
    }).status).toBe("accepted");
  });
});

describe("column catalog response boundary", () => {
  it("decodes all coverage states with stable frozen provenance", () => {
    const captured = provider(() => undefined);
    const result = decodeSqlColumnCatalogBatchResponse(
      captured,
      request(),
      readyResponse(),
    );
    expect(result).toMatchObject({
      status: "accepted",
      value: {
        relations: [
          {
            code: "unavailable",
            requestKey: "events",
            status: "failed",
          },
          {
            columns: [
              { columnEntityId: "column-id", ordinal: 0 },
              { columnEntityId: "column-name", ordinal: 1 },
            ],
            coverage: "complete",
            relationEntityId: "relation-users",
            requestKey: "users",
            status: "ready",
          },
        ],
      },
    });
    if (result.status === "accepted") {
      const users = result.value.relations[1];
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.relations)).toBe(true);
      if (users?.status === "ready") {
        expect(users.columns[0]?.provenance).toEqual({
          columnEntityId: "column-id",
          epoch,
          providerId: "catalog",
          relationEntityId: "relation-users",
          scope: "connection-1",
        });
        expect(Object.isFrozen(users.columns[0]?.provenance)).toBe(true);
      }
    }
  });

  it("accepts loading, partial, and identical duplicate columns", () => {
    const captured = provider(() => undefined);
    const request_ = request();
    const column = {
      columnEntityId: "same",
      identifier: { quoted: false, value: "id" },
      insertText: "id",
      ordinal: 0,
    };
    const result = decodeSqlColumnCatalogBatchResponse(
      captured,
      request_,
      {
        epoch,
        relations: [
          {
            columns: [column, { ...column }],
            coverage: "partial",
            relationEntityId: "relation-users",
            requestKey: "users",
            status: "ready",
          },
          { requestKey: "events", status: "loading" },
        ],
      },
    );
    expect(result).toMatchObject({
      status: "accepted",
      value: {
        relations: [
          { requestKey: "events", status: "loading" },
          {
            columns: [{ columnEntityId: "same" }],
            coverage: "partial",
            requestKey: "users",
          },
        ],
      },
    });
  });

  it.each([
    {
      name: "wrong epoch",
      value: { ...readyResponse(), epoch: { generation: 8, token: "x" } },
    },
    {
      name: "missing relation",
      value: { epoch, relations: [readyResponse().relations[0]] },
    },
    {
      name: "unexpected relation",
      value: {
        epoch,
        relations: [
          ...readyResponse().relations,
          { requestKey: "other", status: "loading" },
        ],
      },
    },
    {
      name: "duplicate request key",
      value: {
        epoch,
        relations: [
          readyResponse().relations[0],
          readyResponse().relations[0],
        ],
      },
    },
    {
      name: "conflicting known entity",
      value: {
        epoch,
        relations: [
          readyResponse().relations[0],
          {
            columns: [],
            coverage: "complete",
            relationEntityId: "wrong-events-id",
            requestKey: "events",
            status: "ready",
          },
        ],
      },
    },
    {
      name: "conflicting duplicate column",
      value: {
        epoch,
        relations: [
          {
            ...readyResponse().relations[0],
            columns: [
              {
                columnEntityId: "x",
                identifier: { quoted: false, value: "a" },
                insertText: "a",
                ordinal: 0,
              },
              {
                columnEntityId: "x",
                identifier: { quoted: false, value: "b" },
                insertText: "b",
                ordinal: 0,
              },
            ],
          },
          readyResponse().relations[1],
        ],
      },
    },
    {
      name: "too many columns",
      value: {
        epoch,
        relations: [
          {
            ...readyResponse().relations[0],
            columns: Array.from(
              { length: MAX_COLUMNS_PER_RELATION + 1 },
              (_, ordinal) => ({
                columnEntityId: `c${ordinal}`,
                identifier: {
                  quoted: false,
                  value: `c${ordinal}`,
                },
                insertText: `c${ordinal}`,
                ordinal,
              }),
            ),
          },
          readyResponse().relations[1],
        ],
      },
    },
  ])("rejects $name", ({ value }) => {
    expect(decodeSqlColumnCatalogBatchResponse(
      provider(() => undefined),
      request(),
      value,
    ).status).toBe("malformed");
  });

  it("contains response accessors, iterators, and invalid provider handles", () => {
    let getterCalls = 0;
    const response = Object.defineProperty(
      { epoch },
      "relations",
      {
        get: () => {
          getterCalls += 1;
          return [];
        },
      },
    );
    expect(decodeSqlColumnCatalogBatchResponse(
      provider(() => undefined),
      request(),
      response,
    ).status).toBe("malformed");
    expect(getterCalls).toBe(0);

    const value = readyResponse();
    Object.defineProperty(value.relations, Symbol.iterator, {
      value: vi.fn(() => {
        throw new Error("iterator must not run");
      }),
    });
    expect(decodeSqlColumnCatalogBatchResponse(
      provider(() => undefined),
      request(),
      value,
    ).status).toBe("accepted");
    const invalid = Reflect.apply(
      decodeSqlColumnCatalogBatchResponse,
      undefined,
      [{}, request(), value],
    );
    expect(invalid.status).toBe("malformed");
  });
});
