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
    expect(resolveSqlColumnCatalogProvider(null)).toBeNull();
    expect(resolveSqlColumnCatalogProvider(1)).toBeNull();
  });

  it("contains hostile own-key and descriptor traps", () => {
    const ownKeys = new Proxy(
      { id: "catalog", loadColumns: () => undefined },
      {
        ownKeys() {
          throw new Error("private ownKeys trap");
        },
      },
    );
    const descriptor = new Proxy(
      { id: "catalog", loadColumns: () => undefined },
      {
        getOwnPropertyDescriptor() {
          throw new Error("private descriptor trap");
        },
      },
    );
    expect(captureSqlColumnCatalogProvider(ownKeys).status).toBe("malformed");
    expect(captureSqlColumnCatalogProvider(descriptor).status).toBe(
      "malformed",
    );
  });
});

describe("column catalog batch request boundary", () => {
  it("normalizes paths, search paths, and deterministic request order", () => {
    const result = createSqlColumnCatalogBatchRequest({
      dialectId: "duckdb",
      expectedEpoch: epoch,
      relations: [
        { path, requestKey: "z" },
        { path, requestKey: "a" },
      ],
      scope: "scope",
      searchPaths: [[{ quoted: true, value: "Main" }]],
    });
    expect(result).toMatchObject({
      status: "accepted",
      value: {
        relations: [
          { requestKey: "a" },
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

  it("rejects malformed epochs, path components, search paths, and array traps", () => {
    const base = {
      dialectId: "duckdb",
      expectedEpoch: epoch,
      relations: [{ path, requestKey: "users" }],
      scope: "scope",
      searchPaths: [],
    };
    const badEpochs = [
      { generation: -1, token: "x" },
      { generation: 1.5, token: "x" },
      { generation: 1, token: "" },
      { generation: "1", token: "x" },
    ];
    for (const expectedEpoch of badEpochs) {
      expect(
        createSqlColumnCatalogBatchRequest({ ...base, expectedEpoch }).status,
      ).toBe("malformed");
    }

    const sparsePath: unknown[] = [];
    sparsePath.length = 1;
    const sparseSearchPaths: unknown[] = [];
    sparseSearchPaths.length = 1;
    const malformedPaths = [
      sparsePath,
      [null],
      [{ quoted: "false", value: "users" }],
      [{ quoted: false, value: "" }],
    ];
    for (const malformedPath of malformedPaths) {
      expect(
        createSqlColumnCatalogBatchRequest({
          ...base,
          relations: [{ path: malformedPath, requestKey: "users" }],
        }).status,
      ).toBe("malformed");
    }
    expect(
      createSqlColumnCatalogBatchRequest({
        ...base,
        searchPaths: sparseSearchPaths,
      }).status,
    ).toBe("malformed");
    expect(
      createSqlColumnCatalogBatchRequest({
        ...base,
        searchPaths: [["not-a-component"]],
      }).status,
    ).toBe("malformed");
    expect(
      createSqlColumnCatalogBatchRequest({
        ...base,
        relations: [null],
      }).status,
    ).toBe("malformed");

    const trappedLength = new Proxy(
      [{ path, requestKey: "users" }],
      {
        getOwnPropertyDescriptor(target, key) {
          if (key === "length") {
            throw new Error("private length trap");
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    const trappedElement = new Proxy(
      [{ path, requestKey: "users" }],
      {
        getOwnPropertyDescriptor(target, key) {
          if (key === "0") {
            throw new Error("private element trap");
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    expect(
      createSqlColumnCatalogBatchRequest({
        ...base,
        relations: trappedLength,
      }).status,
    ).toBe("malformed");
    expect(
      createSqlColumnCatalogBatchRequest({
        ...base,
        relations: trappedElement,
      }).status,
    ).toBe("malformed");
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

  it("rejects revoked response arrays without throwing", () => {
    const captured = provider(() => undefined);
    for (const response of [
      (() => {
        const revoked = Proxy.revocable([], {});
        revoked.revoke();
        return { epoch, relations: revoked.proxy };
      })(),
      (() => {
        const revoked = Proxy.revocable([], {});
        revoked.revoke();
        return {
          epoch,
          relations: [
            {
              ...readyResponse().relations[0],
              columns: revoked.proxy,
            },
            readyResponse().relations[1],
          ],
        };
      })(),
    ]) {
      expect(() =>
        decodeSqlColumnCatalogBatchResponse(
          captured,
          request(),
          response,
        )
      ).not.toThrow();
      expect(decodeSqlColumnCatalogBatchResponse(
        captured,
        request(),
        response,
      )).toEqual({
        reason: "invalid-shape",
        status: "malformed",
      });
    }
  });

  it("rejects cross-variant relation fields", () => {
    const captured = provider(() => undefined);
    const invalid = [
      {
        code: "unknown",
        requestKey: "users",
        retry: "never",
        status: "loading",
      },
      {
        code: "unknown",
        ...readyResponse().relations[0],
        retry: "never",
      },
      {
        code: "unknown",
        columns: [],
        coverage: "complete",
        relationEntityId: "relation-users",
        requestKey: "users",
        retry: "never",
        status: "failed",
      },
    ];
    for (const relation of invalid) {
      expect(decodeSqlColumnCatalogBatchResponse(
        captured,
        request(),
        {
          epoch,
          relations: [relation, readyResponse().relations[1]],
        },
      ).status).toBe("malformed");
    }
  });

  it("rejects NUL-delimited conflicting column identities", () => {
    const result = decodeSqlColumnCatalogBatchResponse(
      provider(() => undefined),
      request(),
      {
        epoch,
        relations: [
          {
            columns: [
              {
                columnEntityId: "same",
                identifier: { quoted: false, value: "x\u0000y" },
                insertText: "z",
                ordinal: 0,
              },
              {
                columnEntityId: "same",
                identifier: { quoted: false, value: "x" },
                insertText: "y\u0000z",
                ordinal: 0,
              },
            ],
            coverage: "complete",
            relationEntityId: "relation-users",
            requestKey: "users",
            status: "ready",
          },
          readyResponse().relations[1],
        ],
      },
    );
    expect(result).toEqual({
      reason: "duplicate-column-entity-id",
      status: "malformed",
    });
  });

  it("rejects malformed relation and column state combinations", () => {
    const captured = provider(() => undefined);
    const request_ = request();
    const validUsers = readyResponse().relations[0];
    const validEvents = readyResponse().relations[1];
    const invalidUsers = [
      null,
      { requestKey: "", status: "loading" },
      {
        columns: [],
        coverage: "complete",
        relationEntityId: "",
        requestKey: "users",
        status: "ready",
      },
      { code: "mystery", requestKey: "users", retry: "never", status: "failed" },
      {
        code: "unavailable",
        requestKey: "users",
        retry: "mystery",
        status: "failed",
      },
      { requestKey: "users", status: "mystery" },
      {
        columns: [null],
        coverage: "complete",
        relationEntityId: "relation-users",
        requestKey: "users",
        status: "ready",
      },
      {
        columns: [{
          columnEntityId: "",
          identifier: { quoted: false, value: "id" },
          insertText: "id",
          ordinal: 0,
        }],
        coverage: "complete",
        relationEntityId: "relation-users",
        requestKey: "users",
        status: "ready",
      },
      {
        columns: [{
          columnEntityId: "id",
          identifier: null,
          insertText: "id",
          ordinal: 0,
        }],
        coverage: "complete",
        relationEntityId: "relation-users",
        requestKey: "users",
        status: "ready",
      },
      {
        columns: [{
          columnEntityId: "id",
          identifier: { quoted: false, value: "id" },
          insertText: "id",
          ordinal: -1,
        }],
        coverage: "complete",
        relationEntityId: "relation-users",
        requestKey: "users",
        status: "ready",
      },
    ];
    for (const users of invalidUsers) {
      expect(
        decodeSqlColumnCatalogBatchResponse(captured, request_, {
          epoch,
          relations: [users, validEvents],
        }).status,
      ).toBe("malformed");
    }

    const sparseColumns: unknown[] = [];
    sparseColumns.length = 1;
    const sparseRelations: unknown[] = [];
    sparseRelations.length = 2;
    expect(
      decodeSqlColumnCatalogBatchResponse(captured, request_, {
        epoch,
        relations: [
          { ...validUsers, columns: sparseColumns },
          validEvents,
        ],
      }).status,
    ).toBe("malformed");
    expect(
      decodeSqlColumnCatalogBatchResponse(captured, request_, {
        epoch,
        relations: sparseRelations,
      }).status,
    ).toBe("malformed");
  });

  it("rejects an unexpected relation without conflating it with response size", () => {
    const result = decodeSqlColumnCatalogBatchResponse(
      provider(() => undefined),
      request(),
      {
        epoch,
        relations: [
          readyResponse().relations[0],
          { requestKey: "other", status: "loading" },
        ],
      },
    );
    expect(result).toEqual({
      reason: "unexpected-relation",
      status: "malformed",
    });
  });

  it("sorts stable ties and enforces the aggregate batch column cap", () => {
    const tied = {
      epoch,
      relations: [
        {
          columns: [
            {
              columnEntityId: "b",
              identifier: { quoted: true, value: "same" },
              insertText: "same",
              ordinal: 0,
            },
            {
              columnEntityId: "a",
              identifier: { quoted: true, value: "same" },
              insertText: "same",
              ordinal: 0,
            },
          ],
          coverage: "complete",
          relationEntityId: "relation-users",
          requestKey: "users",
          status: "ready",
        },
        readyResponse().relations[1],
      ],
    };
    const sorted = decodeSqlColumnCatalogBatchResponse(
      provider(() => undefined),
      request(),
      tied,
    );
    expect(sorted).toMatchObject({
      status: "accepted",
      value: {
        relations: [
          { requestKey: "events" },
          {
            columns: [
              { columnEntityId: "a" },
              { columnEntityId: "b" },
            ],
          },
        ],
      },
    });

    const references = Array.from({ length: 17 }, (_, index) => ({
      path,
      requestKey: `r${index}`,
    }));
    const created = createSqlColumnCatalogBatchRequest({
      dialectId: "duckdb",
      expectedEpoch: epoch,
      relations: references,
      scope: "scope",
      searchPaths: [],
    });
    if (created.status !== "accepted") {
      throw new Error("Expected aggregate-limit request");
    }
    const relations = references.map((reference, relationIndex) => ({
      columns: Array.from({ length: MAX_COLUMNS_PER_RELATION }, (_, ordinal) => ({
        columnEntityId: `c${relationIndex}-${ordinal}`,
        identifier: { quoted: false, value: `c${ordinal}` },
        insertText: `c${ordinal}`,
        ordinal,
      })),
      coverage: "complete",
      relationEntityId: `relation-${relationIndex}`,
      requestKey: reference.requestKey,
      status: "ready",
    }));
    expect(
      decodeSqlColumnCatalogBatchResponse(
        provider(() => undefined),
        created.value,
        { epoch, relations },
      ),
    ).toEqual({ reason: "resource-limit", status: "malformed" });
  });
});
