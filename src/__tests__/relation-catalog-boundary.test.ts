import { describe, expect, it } from "vitest";
import {
  captureSqlRelationCatalogProvider,
  compareSqlCatalogEpoch,
  createSqlCatalogSearchRequest,
  decodeSqlCatalogInvalidation,
  decodeSqlCatalogSearchResponse,
  isValidSqlCatalogScope,
  MAX_CATALOG_CONTINUATION_TOKEN_LENGTH,
  MAX_CATALOG_DETAIL_LENGTH,
  MAX_CATALOG_ENTITY_ID_LENGTH,
  MAX_CATALOG_EPOCH_TOKEN_LENGTH,
  MAX_CATALOG_IDENTIFIER_LENGTH,
  MAX_CATALOG_PROVIDER_ID_LENGTH,
  MAX_CATALOG_RELATIONS,
  MAX_CATALOG_REQUEST_TEXT_LENGTH,
  MAX_CATALOG_RESPONSE_TEXT_LENGTH,
  MAX_CATALOG_SCOPE_LENGTH,
  resolveSqlRelationCatalogProvider,
  type SqlCatalogBoundaryResult,
} from "../relation-catalog-boundary.js";
import {
  BIGQUERY_SQL_RELATION_DIALECT,
  DREMIO_SQL_RELATION_DIALECT,
  DUCKDB_SQL_RELATION_DIALECT,
  POSTGRESQL_SQL_RELATION_DIALECT,
  type SqlRelationDialectRuntime,
} from "../relation-dialect.js";

function accepted<Value>(
  result: SqlCatalogBoundaryResult<Value>,
): Value {
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") {
    throw new Error(`Expected accepted, received ${result.reason}`);
  }
  return result.value;
}

function epoch(
  generation = 1,
  token = "snapshot-1",
): {
  readonly generation: number;
  readonly token: string;
} {
  return { generation, token };
}

function component(
  value: string,
  quoted = false,
): {
  readonly quoted: boolean;
  readonly value: string;
} {
  return { quoted, value };
}

function pathComponent(
  role: "catalog" | "dataset" | "project" | "relation" | "schema",
  value: string,
  quoted = false,
): {
  readonly quoted: boolean;
  readonly role:
    | "catalog"
    | "dataset"
    | "project"
    | "relation"
    | "schema";
  readonly value: string;
} {
  return { quoted, role, value };
}

function relation(
  canonicalPath: readonly unknown[] = [
    pathComponent("schema", "public"),
    pathComponent("relation", "users"),
  ],
  entityId = "relation-1",
  completionPathStart = 0,
) {
  return {
    canonicalPath,
    completionPathStart,
    detail: "User accounts",
    entityId,
    matchQuality: "exact",
    relationKind: "table",
  };
}

function readyResponse(
  relations: readonly unknown[] = [relation()],
) {
  return {
    coverage: { kind: "complete" },
    epoch: epoch(),
    relations,
    status: "ready",
  };
}

function request(
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    continuationToken: null,
    dialectId: "postgresql",
    expectedEpoch: null,
    limit: 20,
    prefix: component("us"),
    qualifier: [component("public")],
    scope: "connection:primary",
    searchPaths: [[component("public")]],
    ...overrides,
  };
}

function requestWithAggregateText(
  textLength: number,
): ReturnType<typeof request> {
  const fixedTextLength = "s".length + "postgresql".length;
  let remaining = textLength - fixedTextLength;
  if (remaining < 1) {
    throw new Error("Aggregate request text fixture is too small");
  }
  const components: ReturnType<typeof component>[] = [];
  while (remaining > 0) {
    const length = Math.min(
      remaining,
      MAX_CATALOG_IDENTIFIER_LENGTH,
    );
    components.push(component("x".repeat(length), true));
    remaining -= length;
  }
  const searchPaths: ReturnType<typeof component>[][] = [];
  for (let index = 0; index < components.length; index += 4) {
    searchPaths.push(components.slice(index, index + 4));
  }
  return request({
    dialectId: "postgresql",
    prefix: component(""),
    qualifier: [],
    scope: "s",
    searchPaths,
  });
}

function paddedUniqueId(index: number, length: number): string {
  const prefix = `id-${index}-`;
  if (prefix.length > length) {
    throw new Error("Entity ID fixture length is too small");
  }
  return prefix + "x".repeat(length - prefix.length);
}

function responseAtAggregateTextLimit(
  extraTextLength = 0,
) {
  const relations = Array.from({ length: 50 }, (_, index) => ({
    canonicalPath: [
      pathComponent("schema", "s".repeat(256), true),
      pathComponent(
        "relation",
        "r".repeat(20 + (index === 0 ? extraTextLength : 0)),
        true,
      ),
    ],
    completionPathStart: 0,
    detail: "d".repeat(MAX_CATALOG_DETAIL_LENGTH),
    entityId: paddedUniqueId(index, index < 35 ? 11 : 10),
    matchQuality: "exact",
    relationKind: "table",
  }));
  return {
    coverage: { kind: "complete" },
    epoch: { generation: 1, token: "e" },
    relations,
    status: "ready",
  };
}

function expectMalformed(
  value: SqlCatalogBoundaryResult<unknown>,
  reason?:
    | "duplicate-entity-id"
    | "illegal-relation-path"
    | "invalid-shape"
    | "resource-limit",
): void {
  expect(value.status).toBe("malformed");
  if (reason !== undefined) {
    expect(value).toEqual({ reason, status: "malformed" });
  }
}

describe("relation catalog provider capture", () => {
  it("captures own callbacks once as this-free closures", () => {
    const calls: unknown[][] = [];
    const provider = {
      hostState: { connection: "caller-owned" },
      id: "catalog",
      search(this: unknown, ...args: unknown[]) {
        calls.push([this, ...args]);
        return Promise.resolve(readyResponse());
      },
      subscribe(this: unknown, ...args: unknown[]) {
        calls.push([this, ...args]);
        return { dispose() {} };
      },
    };
    const captured = accepted(
      captureSqlRelationCatalogProvider(provider),
    );
    provider.id = "changed";
    provider.search = function replacementSearch() {
      throw new Error("replacement search must not run");
    };
    provider.subscribe = function replacementSubscribe() {
      throw new Error("replacement subscription must not run");
    };
    const context = resolveSqlRelationCatalogProvider(captured);
    expect(context?.id).toBe("catalog");
    const signal = new AbortController().signal;
    const normalizedRequest = accepted(
      createSqlCatalogSearchRequest(request()),
    );
    context?.search(normalizedRequest, signal);
    const listener = () => {};
    context?.subscribe?.("scope", listener);
    expect(calls).toEqual([
      [undefined, normalizedRequest, signal],
      [undefined, "scope", listener],
    ]);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("supports static providers without subscriptions", () => {
    const captured = accepted(
      captureSqlRelationCatalogProvider({
        id: "static",
        search: async () => readyResponse(),
        subscribe: undefined,
      }),
    );
    expect(
      resolveSqlRelationCatalogProvider(captured)?.subscribe,
    ).toBeNull();
    expect(resolveSqlRelationCatalogProvider(null)).toBeNull();
  });

  it("ignores extra config while rejecting copied, inherited, accessor, and hostile providers", () => {
    const valid = {
      id: "catalog",
      search: async () => readyResponse(),
    };
    const captured = accepted(
      captureSqlRelationCatalogProvider(valid),
    );
    expect(resolveSqlRelationCatalogProvider({ ...captured })).toBeNull();

    const inherited = Object.create(valid);
    expectMalformed(captureSqlRelationCatalogProvider(inherited));
    expect(
      captureSqlRelationCatalogProvider({ ...valid, extra: true })
        .status,
    ).toBe("accepted");
    class PrototypeProvider {
      readonly id = "prototype";

      async search() {
        return readyResponse();
      }
    }
    expectMalformed(
      captureSqlRelationCatalogProvider(new PrototypeProvider()),
    );
    for (const candidate of [
      null,
      [],
      { id: "catalog", search: 1 },
      { ...valid, subscribe: null },
      new Date(),
    ]) {
      expectMalformed(captureSqlRelationCatalogProvider(candidate));
    }

    let getterInvoked = false;
    const accessor = {
      get id() {
        getterInvoked = true;
        return "catalog";
      },
      search: valid.search,
    };
    expectMalformed(captureSqlRelationCatalogProvider(accessor));
    expect(getterInvoked).toBe(false);

    const revoked = Proxy.revocable(valid, {});
    revoked.revoke();
    expectMalformed(
      captureSqlRelationCatalogProvider(revoked.proxy),
    );
    expectMalformed(
      captureSqlRelationCatalogProvider(
        new Proxy(valid, {
          getOwnPropertyDescriptor() {
            throw new Error("hostile");
          },
        }),
      ),
    );
  });

  it("enforces bounded well-formed provider IDs", () => {
    const search = async () => readyResponse();
    expect(
      captureSqlRelationCatalogProvider({
        id: "x".repeat(MAX_CATALOG_PROVIDER_ID_LENGTH),
        search,
      }).status,
    ).toBe("accepted");
    expectMalformed(
      captureSqlRelationCatalogProvider({
        id: "x".repeat(MAX_CATALOG_PROVIDER_ID_LENGTH + 1),
        search,
      }),
      "resource-limit",
    );
    for (const id of ["", "bad\0id", "\ud800", "\udc00"]) {
      expectMalformed(
        captureSqlRelationCatalogProvider({ id, search }),
        "invalid-shape",
      );
    }
    expect(
      captureSqlRelationCatalogProvider({
        id: "catalog-\ud83d\ude80",
        search,
      }).status,
    ).toBe("accepted");
  });
});

describe("catalog scope validation", () => {
  it("accepts only bounded, non-NUL, well-formed text", () => {
    expect(isValidSqlCatalogScope("connection:primary")).toBe(true);
    expect(
      isValidSqlCatalogScope(
        `\ud83d\ude80${"x".repeat(MAX_CATALOG_SCOPE_LENGTH - 2)}`,
      ),
    ).toBe(true);
    for (const candidate of [
      null,
      1,
      "",
      "bad\0scope",
      "\ud800",
      "\ud800x",
      "\udc00",
      "x".repeat(MAX_CATALOG_SCOPE_LENGTH + 1),
    ]) {
      expect(isValidSqlCatalogScope(candidate)).toBe(false);
    }
  });
});

describe("catalog search request snapshots", () => {
  it("copies and recursively freezes the exact provider request", () => {
    const raw = request();
    const normalized = accepted(
      createSqlCatalogSearchRequest(raw),
    );
    expect(normalized).toEqual(raw);
    expect(normalized).not.toBe(raw);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.searchPaths)).toBe(true);
    expect(Object.isFrozen(normalized.searchPaths[0])).toBe(true);
    expect(Object.isFrozen(normalized.searchPaths[0]?.[0])).toBe(true);
    expect(Object.isFrozen(normalized.qualifier)).toBe(true);
    expect(Object.isFrozen(normalized.prefix)).toBe(true);
  });

  it("copies shared request identities into independent frozen data", () => {
    const sharedComponent = {
      quoted: false,
      value: "public",
    };
    const sharedPath = [sharedComponent];
    const normalized = accepted(
      createSqlCatalogSearchRequest(
        request({
          qualifier: sharedPath,
          searchPaths: [sharedPath, sharedPath],
        }),
      ),
    );

    expect(normalized.qualifier).not.toBe(sharedPath);
    expect(normalized.searchPaths[0]).not.toBe(sharedPath);
    expect(normalized.searchPaths[1]).not.toBe(sharedPath);
    expect(normalized.qualifier[0]).not.toBe(sharedComponent);
    expect(normalized.searchPaths[0]?.[0]).not.toBe(
      sharedComponent,
    );
    expect(normalized.searchPaths[0]?.[0]).not.toBe(
      normalized.searchPaths[1]?.[0],
    );
    expect(Object.isFrozen(normalized.qualifier[0])).toBe(true);
    expect(Object.isFrozen(normalized.searchPaths[0]?.[0])).toBe(
      true,
    );

    sharedComponent.value = "mutated";
    sharedPath.push({ quoted: true, value: "later" });
    expect(normalized.qualifier).toEqual([
      { quoted: false, value: "public" },
    ]);
    expect(normalized.searchPaths).toEqual([
      [{ quoted: false, value: "public" }],
      [{ quoted: false, value: "public" }],
    ]);
  });

  it("accepts empty prefix, qualifier, and search-path list", () => {
    const normalized = accepted(
      createSqlCatalogSearchRequest(
        request({
          prefix: component(""),
          qualifier: [],
          searchPaths: [],
        }),
      ),
    );
    expect(normalized.prefix.value).toBe("");
    expect(normalized.qualifier).toEqual([]);
    expect(normalized.searchPaths).toEqual([]);
  });

  it("preserves quoted order, epochs, and continuation tokens", () => {
    const normalized = accepted(
      createSqlCatalogSearchRequest(
        request({
          continuationToken: "page-2",
          expectedEpoch: epoch(4, "four"),
          searchPaths: [
            [component("first", true), component("second")],
            [component("third")],
          ],
        }),
      ),
    );
    expect(normalized).toMatchObject({
      continuationToken: "page-2",
      expectedEpoch: { generation: 4, token: "four" },
      searchPaths: [
        [
          { quoted: true, value: "first" },
          { quoted: false, value: "second" },
        ],
        [{ quoted: false, value: "third" }],
      ],
    });
  });

  it("rejects missing, extra, inherited, and sparse data", () => {
    const { scope: _scope, ...missing } = request();
    expectMalformed(createSqlCatalogSearchRequest(missing));
    expectMalformed(
      createSqlCatalogSearchRequest({ ...request(), extra: true }),
    );
    expectMalformed(
      createSqlCatalogSearchRequest(
        Object.create(request()),
      ),
    );

    const sparse: unknown[] = [];
    sparse.length = 2;
    sparse[1] = component("public");
    expectMalformed(
      createSqlCatalogSearchRequest(
        request({ qualifier: sparse }),
      ),
    );
    const customArray = [component("public")];
    Object.defineProperty(customArray, "extra", {
      enumerable: true,
      value: true,
    });
    expectMalformed(
      createSqlCatalogSearchRequest(
        request({ qualifier: customArray }),
      ),
    );
    expectMalformed(
      createSqlCatalogSearchRequest(
        request({ qualifier: Object.setPrototypeOf([], null) }),
      ),
    );
    expectMalformed(
      createSqlCatalogSearchRequest(
        request({ qualifier: {} }),
      ),
    );
    expectMalformed(
      createSqlCatalogSearchRequest(
        request({ searchPaths: [[]] }),
      ),
    );

    const withSymbol = request();
    Object.defineProperty(withSymbol, Symbol("extra"), {
      enumerable: true,
      value: true,
    });
    expectMalformed(createSqlCatalogSearchRequest(withSymbol));

    const nonEnumerable = request();
    Object.defineProperty(nonEnumerable, "scope", {
      enumerable: false,
      value: "scope",
    });
    expectMalformed(createSqlCatalogSearchRequest(nonEnumerable));
  });

  it("does not invoke accessors or ordinary proxy get traps", () => {
    let getterInvoked = false;
    const accessor = {
      ...request(),
      get scope() {
        getterInvoked = true;
        return "scope";
      },
    };
    expectMalformed(createSqlCatalogSearchRequest(accessor));
    expect(getterInvoked).toBe(false);

    let getInvoked = false;
    const proxied = new Proxy(request(), {
      get() {
        getInvoked = true;
        throw new Error("hostile");
      },
    });
    expect(
      createSqlCatalogSearchRequest(proxied).status,
    ).toBe("accepted");
    expect(getInvoked).toBe(false);

    expectMalformed(
      createSqlCatalogSearchRequest(
        new Proxy(request(), {
          getOwnPropertyDescriptor() {
            throw new Error("hostile");
          },
        }),
      ),
    );
  });

  it("enforces numeric and string resource boundaries", () => {
    for (const limit of [
      0,
      MAX_CATALOG_RELATIONS + 1,
      1.5,
      Number.NaN,
    ]) {
      expectMalformed(
        createSqlCatalogSearchRequest(request({ limit })),
      );
    }
    expect(
      createSqlCatalogSearchRequest(
        request({
          continuationToken: "x".repeat(
            MAX_CATALOG_CONTINUATION_TOKEN_LENGTH,
          ),
          scope: "x".repeat(MAX_CATALOG_SCOPE_LENGTH),
        }),
      ).status,
    ).toBe("accepted");
    expectMalformed(
      createSqlCatalogSearchRequest(
        request({
          continuationToken: "x".repeat(
            MAX_CATALOG_CONTINUATION_TOKEN_LENGTH + 1,
          ),
        }),
      ),
      "resource-limit",
    );
    expectMalformed(
      createSqlCatalogSearchRequest(
        request({
          scope: "x".repeat(MAX_CATALOG_SCOPE_LENGTH + 1),
        }),
      ),
      "resource-limit",
    );
    expectMalformed(
      createSqlCatalogSearchRequest(
        request({ continuationToken: 1 }),
      ),
    );
    expectMalformed(
      createSqlCatalogSearchRequest(
        request({ expectedEpoch: { generation: -1, token: "bad" } }),
      ),
    );
    expectMalformed(
      createSqlCatalogSearchRequest(
        request({ prefix: { quoted: "no", value: "x" } }),
      ),
    );
  });

  it("enforces the aggregate request text boundary", () => {
    expect(
      createSqlCatalogSearchRequest(
        requestWithAggregateText(MAX_CATALOG_REQUEST_TEXT_LENGTH),
      ).status,
    ).toBe("accepted");
    expectMalformed(
      createSqlCatalogSearchRequest(
        requestWithAggregateText(
          MAX_CATALOG_REQUEST_TEXT_LENGTH + 1,
        ),
      ),
      "resource-limit",
    );
  });
});

describe("catalog response decoding", () => {
  it.each([
    [
      "PostgreSQL",
      POSTGRESQL_SQL_RELATION_DIALECT,
      [
        pathComponent("schema", "public"),
        pathComponent("relation", "users"),
      ],
      0,
      "public.users",
    ],
    [
      "DuckDB",
      DUCKDB_SQL_RELATION_DIALECT,
      [
        pathComponent("catalog", "memory"),
        pathComponent("schema", "main"),
        pathComponent("relation", "users"),
      ],
      1,
      "main.users",
    ],
    [
      "BigQuery",
      BIGQUERY_SQL_RELATION_DIALECT,
      [
        pathComponent("project", "my-project"),
        pathComponent("dataset", "analytics"),
        pathComponent("relation", "users"),
      ],
      1,
      "analytics.users",
    ],
    [
      "Dremio",
      DREMIO_SQL_RELATION_DIALECT,
      [
        pathComponent("catalog", "lake"),
        pathComponent("schema", "raw"),
        pathComponent("schema", "crm"),
        pathComponent("relation", "users"),
      ],
      2,
      "crm.users",
    ],
  ] as const)(
    "validates and pre-renders a %s canonical suffix",
    (
      _name,
      dialect,
      canonicalPath,
      completionPathStart,
      completionText,
    ) => {
      const decoded = accepted(
        decodeSqlCatalogSearchResponse(
          readyResponse([
            relation(
              canonicalPath,
              "relation-1",
              completionPathStart,
            ),
          ]),
          20,
          dialect,
        ),
      );
      if (decoded.status !== "ready") {
        throw new Error("Expected a ready catalog page");
      }
      expect(decoded.relations[0]).toMatchObject({
        completionPath: canonicalPath.slice(completionPathStart),
        completionText,
      });
      expect(Object.isFrozen(decoded)).toBe(true);
      expect(Object.isFrozen(decoded.relations)).toBe(true);
      expect(Object.isFrozen(decoded.relations[0])).toBe(true);
      expect(
        Object.isFrozen(decoded.relations[0]?.canonicalPath),
      ).toBe(true);
    },
  );

  it("renders quoted and reserved relation components with the dialect", () => {
    const decoded = accepted(
      decodeSqlCatalogSearchResponse(
        readyResponse([
          relation(
            [
              pathComponent("schema", "select"),
              pathComponent("relation", "has space", true),
            ],
            "quoted",
          ),
        ]),
        20,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    );
    if (decoded.status !== "ready") {
      throw new Error("Expected a ready catalog page");
    }
    expect(decoded.relations[0]?.completionText).toBe(
      '"select"."has space"',
    );
  });

  it("accepts relations without optional detail", () => {
    const { detail: _detail, ...withoutDetail } = relation();
    const decoded = accepted(
      decodeSqlCatalogSearchResponse(
        readyResponse([withoutDetail]),
        20,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    );
    if (decoded.status !== "ready") {
      throw new Error("Expected ready");
    }
    expect(decoded.relations[0]).not.toHaveProperty("detail");
  });

  it("copies shared response identities into independent frozen data", () => {
    const sharedSchema = {
      quoted: false,
      role: "schema" as const,
      value: "public",
    };
    const sharedRelation = {
      quoted: false,
      role: "relation" as const,
      value: "users",
    };
    const sharedPath = [sharedSchema, sharedRelation];
    const decoded = accepted(
      decodeSqlCatalogSearchResponse(
        readyResponse([
          relation(sharedPath, "one"),
          relation(sharedPath, "two"),
        ]),
        20,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    );
    if (decoded.status !== "ready") {
      throw new Error("Expected a ready catalog page");
    }

    expect(decoded.relations[0]?.canonicalPath).not.toBe(sharedPath);
    expect(decoded.relations[1]?.canonicalPath).not.toBe(sharedPath);
    expect(decoded.relations[0]?.canonicalPath).not.toBe(
      decoded.relations[1]?.canonicalPath,
    );
    expect(decoded.relations[0]?.canonicalPath[0]).not.toBe(
      sharedSchema,
    );
    expect(decoded.relations[0]?.canonicalPath[0]).not.toBe(
      decoded.relations[1]?.canonicalPath[0],
    );
    expect(
      Object.isFrozen(decoded.relations[0]?.canonicalPath[0]),
    ).toBe(true);

    sharedSchema.value = "mutated";
    sharedRelation.value = "changed";
    sharedPath.push({
      quoted: false,
      role: "relation",
      value: "later",
    });
    expect(decoded.relations[0]?.canonicalPath).toEqual([
      { quoted: false, role: "schema", value: "public" },
      { quoted: false, role: "relation", value: "users" },
    ]);
    expect(decoded.relations[1]?.completionText).toBe(
      "public.users",
    );
  });

  it("decodes all coverage and terminal response variants", () => {
    for (const coverage of [
      { kind: "complete" },
      { kind: "partial" },
      { continuationToken: "next", kind: "paginated" },
    ]) {
      const value = accepted(
        decodeSqlCatalogSearchResponse(
          { ...readyResponse([]), coverage },
          20,
          POSTGRESQL_SQL_RELATION_DIALECT,
        ),
      );
      expect(value).toMatchObject({ coverage, status: "ready" });
    }
    expect(
      accepted(
        decodeSqlCatalogSearchResponse(
          { epoch: epoch(), status: "loading" },
          20,
          POSTGRESQL_SQL_RELATION_DIALECT,
        ),
      ),
    ).toEqual({ epoch: epoch(), status: "loading" });
    for (const code of [
      "authentication",
      "authorization",
      "invalid-configuration",
      "rate-limited",
      "unavailable",
      "unknown",
    ]) {
      for (const retry of [
        "after-invalidation",
        "never",
        "next-request",
      ]) {
        expect(
          accepted(
            decodeSqlCatalogSearchResponse(
              { code, epoch: epoch(), retry, status: "failed" },
              20,
              POSTGRESQL_SQL_RELATION_DIALECT,
            ),
          ),
        ).toMatchObject({ code, retry, status: "failed" });
      }
    }
  });

  it("rejects dialect-illegal canonical paths", () => {
    expectMalformed(
      decodeSqlCatalogSearchResponse(
        readyResponse([
          relation([
            pathComponent("catalog", "wrong"),
            pathComponent("relation", "users"),
          ]),
        ]),
        20,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
      "illegal-relation-path",
    );
  });

  it("rejects malformed paths and completion offsets", () => {
    const malformedPaths = [
      [],
      [pathComponent("schema", "public")],
      [
        pathComponent("relation", "users"),
        pathComponent("relation", "again"),
      ],
      [
        { quoted: false, role: "unknown", value: "x" },
        pathComponent("relation", "users"),
      ],
    ];
    for (const canonicalPath of malformedPaths) {
      expectMalformed(
        decodeSqlCatalogSearchResponse(
          readyResponse([relation(canonicalPath)]),
          20,
          POSTGRESQL_SQL_RELATION_DIALECT,
        ),
      );
    }
    for (const completionPathStart of [-1, 2, 0.5]) {
      expectMalformed(
        decodeSqlCatalogSearchResponse(
          readyResponse([
            relation(undefined, "bad-offset", completionPathStart),
          ]),
          20,
          POSTGRESQL_SQL_RELATION_DIALECT,
        ),
      );
    }
    for (const canonicalPath of [
      [
        { quoted: "no", role: "schema", value: "public" },
        pathComponent("relation", "users"),
      ],
      [
        { quoted: false, role: "schema", value: 1 },
        pathComponent("relation", "users"),
      ],
      [
        { quoted: false, value: "public" },
        pathComponent("relation", "users"),
      ],
      [
        pathComponent("schema", ""),
        pathComponent("relation", "users"),
      ],
    ]) {
      expectMalformed(
        decodeSqlCatalogSearchResponse(
          readyResponse([relation(canonicalPath)]),
          20,
          POSTGRESQL_SQL_RELATION_DIALECT,
        ),
      );
    }
  });

  it("rejects duplicate IDs and the entire malformed page atomically", () => {
    expectMalformed(
      decodeSqlCatalogSearchResponse(
        readyResponse([
          relation(undefined, "duplicate"),
          relation(
            [pathComponent("relation", "other")],
            "duplicate",
          ),
        ]),
        20,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
      "duplicate-entity-id",
    );
    expectMalformed(
      decodeSqlCatalogSearchResponse(
        readyResponse([
          relation(),
          { ...relation(), completionPathStart: 99 },
        ]),
        20,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    );
  });

  it("rejects extra/missing/status-specific fields and closed values", () => {
    const malformedResponses = [
      { ...readyResponse(), extra: true },
      { ...readyResponse(), status: "unknown" },
      { epoch: epoch(), relations: [], status: "loading" },
      {
        code: "wrong",
        epoch: epoch(),
        retry: "never",
        status: "failed",
      },
      {
        code: "unknown",
        epoch: epoch(),
        extra: true,
        retry: "never",
        status: "failed",
      },
      {
        code: "unknown",
        epoch: epoch(),
        retry: "wrong",
        status: "failed",
      },
      { epoch: { generation: -1, token: "bad" }, status: "loading" },
      { epoch: epoch(), status: "failed" },
      {
        ...readyResponse(),
        coverage: { continuationToken: "", kind: "paginated" },
      },
      {
        ...readyResponse(),
        coverage: {
          continuationToken: 1,
          kind: "paginated",
        },
      },
      { ...readyResponse(), coverage: null },
      {
        ...readyResponse(),
        coverage: { continuationToken: "wrong", kind: "complete" },
      },
    ];
    for (const value of malformedResponses) {
      expectMalformed(
        decodeSqlCatalogSearchResponse(
          value,
          20,
          POSTGRESQL_SQL_RELATION_DIALECT,
        ),
      );
    }
  });

  it("rejects malformed relation fields and record shapes", () => {
    const malformedRelations = [
      null,
      [],
      { ...relation(), extra: true },
      { ...relation(), entityId: 1 },
      { ...relation(), matchQuality: "approximate" },
      { ...relation(), relationKind: "sequence" },
      { ...relation(), completionPathStart: "0" },
      new Date(),
    ];
    for (const candidate of malformedRelations) {
      expectMalformed(
        decodeSqlCatalogSearchResponse(
          readyResponse([candidate]),
          20,
          POSTGRESQL_SQL_RELATION_DIALECT,
        ),
      );
    }
  });

  it("accepts table-valued functions as relation-site entities", () => {
    const value = accepted(decodeSqlCatalogSearchResponse(
      readyResponse([{ ...relation(), relationKind: "table-function" }]),
      20,
      POSTGRESQL_SQL_RELATION_DIALECT,
    ));
    expect(value).toMatchObject({
      relations: [{ relationKind: "table-function" }],
      status: "ready",
    });
  });

  it("rejects present undefined detail and enforces relation bounds", () => {
    expectMalformed(
      decodeSqlCatalogSearchResponse(
        readyResponse([{ ...relation(), detail: undefined }]),
        20,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    );
    expect(
      decodeSqlCatalogSearchResponse(
        readyResponse([
          {
            ...relation(),
            detail: "x".repeat(MAX_CATALOG_DETAIL_LENGTH),
            entityId: "x".repeat(MAX_CATALOG_ENTITY_ID_LENGTH),
          },
        ]),
        20,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ).status,
    ).toBe("accepted");
    expectMalformed(
      decodeSqlCatalogSearchResponse(
        readyResponse([
          {
            ...relation(),
            detail: "x".repeat(MAX_CATALOG_DETAIL_LENGTH + 1),
          },
        ]),
        20,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
      "resource-limit",
    );
    expectMalformed(
      decodeSqlCatalogSearchResponse(
        readyResponse([
          {
            ...relation(),
            detail: "\0".repeat(1_000_000),
          },
        ]),
        20,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
      "resource-limit",
    );
    expectMalformed(
      decodeSqlCatalogSearchResponse(
        readyResponse([
          {
            ...relation(),
            entityId: "x".repeat(
              MAX_CATALOG_ENTITY_ID_LENGTH + 1,
            ),
          },
        ]),
        20,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
      "resource-limit",
    );
  });

  it("enforces the aggregate response text boundary", () => {
    expect(
      decodeSqlCatalogSearchResponse(
        responseAtAggregateTextLimit(),
        MAX_CATALOG_RELATIONS,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ).status,
    ).toBe("accepted");
    expectMalformed(
      decodeSqlCatalogSearchResponse(
        responseAtAggregateTextLimit(1),
        MAX_CATALOG_RELATIONS,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
      "resource-limit",
    );
    expect(MAX_CATALOG_RESPONSE_TEXT_LENGTH).toBe(
      1 + 50 * (256 + 20 + MAX_CATALOG_DETAIL_LENGTH) + 535,
    );
  });

  it("rejects over-limit pages instead of truncating", () => {
    expectMalformed(
      decodeSqlCatalogSearchResponse(
        readyResponse([
          relation(undefined, "one"),
          relation(undefined, "two"),
        ]),
        1,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    );
    const customRelations = [relation()];
    Object.defineProperty(customRelations, "extra", {
      enumerable: true,
      value: true,
    });
    expectMalformed(
      decodeSqlCatalogSearchResponse(
        readyResponse(customRelations),
        20,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    );
  });

  it("does not invoke accessors or ordinary get traps", () => {
    let invoked = false;
    const accessor = {
      ...readyResponse(),
      get status() {
        invoked = true;
        return "ready";
      },
    };
    expectMalformed(
      decodeSqlCatalogSearchResponse(
        accessor,
        20,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    );
    expect(invoked).toBe(false);

    const proxied = new Proxy(readyResponse(), {
      get() {
        invoked = true;
        throw new Error("hostile");
      },
    });
    expect(
      decodeSqlCatalogSearchResponse(
        proxied,
        20,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ).status,
    ).toBe("accepted");
    expect(invoked).toBe(false);
  });

  it("normalizes hostile proxies without leaking thrown values", () => {
    const throwing = new Proxy(readyResponse(), {
      getOwnPropertyDescriptor() {
        throw new Error("hostile");
      },
    });
    expectMalformed(
      decodeSqlCatalogSearchResponse(
        throwing,
        20,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    );
    expectMalformed(
      decodeSqlCatalogSearchResponse(
        [],
        20,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    );
    expectMalformed(
      decodeSqlCatalogSearchResponse(
        new Date(),
        20,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    );
    const revoked = Proxy.revocable(readyResponse(), {});
    revoked.revoke();
    expectMalformed(
      decodeSqlCatalogSearchResponse(
        revoked.proxy,
        20,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    );
  });

  it("rejects foreign dialect aggregates and invalid trusted limits", () => {
    const mixed: SqlRelationDialectRuntime = {
      ...POSTGRESQL_SQL_RELATION_DIALECT,
      completion: DUCKDB_SQL_RELATION_DIALECT.completion,
    };
    expectMalformed(
      decodeSqlCatalogSearchResponse(readyResponse(), 20, mixed),
    );
    for (const limit of [0, 101, 1.5]) {
      expectMalformed(
        decodeSqlCatalogSearchResponse(
          readyResponse(),
          limit,
          POSTGRESQL_SQL_RELATION_DIALECT,
        ),
      );
    }
  });

  it("enforces component and epoch token boundaries", () => {
    expect(
      decodeSqlCatalogSearchResponse(
        {
          ...readyResponse(),
          epoch: epoch(
            1,
            "x".repeat(MAX_CATALOG_EPOCH_TOKEN_LENGTH),
          ),
          relations: [
            relation([
              pathComponent(
                "relation",
                "x".repeat(MAX_CATALOG_IDENTIFIER_LENGTH),
              ),
            ]),
          ],
        },
        20,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ).status,
    ).toBe("accepted");
    expectMalformed(
      decodeSqlCatalogSearchResponse(
        {
          ...readyResponse(),
          epoch: epoch(
            1,
            "x".repeat(MAX_CATALOG_EPOCH_TOKEN_LENGTH + 1),
          ),
        },
        20,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
      "resource-limit",
    );
    expectMalformed(
      decodeSqlCatalogSearchResponse(
        readyResponse([
          relation([
            pathComponent(
              "relation",
              "x".repeat(MAX_CATALOG_IDENTIFIER_LENGTH + 1),
            ),
          ]),
        ]),
        20,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
      "resource-limit",
    );
  });
});

describe("catalog invalidation and epoch comparison", () => {
  it("decodes fresh frozen invalidations", () => {
    const raw = { epoch: epoch(2, "two") };
    const decoded = accepted(
      decodeSqlCatalogInvalidation(raw),
    );
    expect(decoded).toEqual(raw);
    expect(decoded).not.toBe(raw);
    expect(decoded.epoch).not.toBe(raw.epoch);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.epoch)).toBe(true);
  });

  it("rejects malformed invalidations without invoking accessors", () => {
    let invoked = false;
    const invalidation = {
      get epoch() {
        invoked = true;
        return epoch();
      },
    };
    expectMalformed(decodeSqlCatalogInvalidation(invalidation));
    expect(invoked).toBe(false);
    expectMalformed(
      decodeSqlCatalogInvalidation({
        epoch: epoch(),
        scope: "spoofed",
      }),
    );
    expectMalformed(
      decodeSqlCatalogInvalidation(
        new Proxy({ epoch: epoch() }, {
          ownKeys() {
            throw new Error("hostile");
          },
        }),
      ),
    );
    expectMalformed(decodeSqlCatalogInvalidation(null));
  });

  it("classifies baseline, equal, advance, stale, and conflicts", () => {
    expect(compareSqlCatalogEpoch(null, epoch(1, "one"))).toEqual({
      epoch: epoch(1, "one"),
      kind: "baseline",
    });
    expect(
      compareSqlCatalogEpoch(epoch(1, "one"), epoch(1, "one")),
    ).toEqual({
      epoch: epoch(1, "one"),
      kind: "equal",
    });
    expect(
      compareSqlCatalogEpoch(epoch(1, "one"), epoch(2, "two")),
    ).toEqual({
      epoch: epoch(2, "two"),
      kind: "advance",
      previous: epoch(1, "one"),
    });
    expect(
      compareSqlCatalogEpoch(epoch(2, "two"), epoch(1, "one")),
    ).toEqual({
      kind: "stale",
      observed: epoch(2, "two"),
      received: epoch(1, "one"),
    });
    expect(
      compareSqlCatalogEpoch(epoch(1, "one"), epoch(1, "other")),
    ).toEqual({
      kind: "token-conflict",
      observed: epoch(1, "one"),
      received: epoch(1, "other"),
    });
  });

  it("canonicalizes negative zero and rejects invalid epochs", () => {
    expect(compareSqlCatalogEpoch(null, epoch(-0, "zero"))).toEqual({
      epoch: epoch(0, "zero"),
      kind: "baseline",
    });
    for (const generation of [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(
        compareSqlCatalogEpoch(null, epoch(generation)),
      ).toEqual({ kind: "malformed" });
    }
    expect(
      compareSqlCatalogEpoch(
        { generation: 1, token: "" },
        epoch(),
      ),
    ).toEqual({ kind: "malformed" });
    expect(
      compareSqlCatalogEpoch(
        epoch(),
        new Proxy(epoch(), {
          ownKeys() {
            throw new Error("hostile");
          },
        }),
      ),
    ).toEqual({ kind: "malformed" });
  });
});
