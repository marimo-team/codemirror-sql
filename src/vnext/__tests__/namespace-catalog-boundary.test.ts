import { describe, expect, it, vi } from "vitest";
import {
  captureSqlNamespaceCatalogProvider,
  createSqlNamespaceCatalogSearchRequest,
  decodeSqlNamespaceCatalogSearchResponse,
  MAX_NAMESPACE_RESULTS,
  resolveSqlNamespaceCatalogProvider,
} from "../namespace-catalog-boundary.js";

const epoch = Object.freeze({ generation: 1, token: "one" });

function request(expectedEpoch = epoch) {
  const result = createSqlNamespaceCatalogSearchRequest({
    dialectId: "duckdb",
    expectedEpoch,
    limit: 10,
    prefix: { quoted: false, value: "ma" },
    qualifier: [{ quoted: false, value: "memory" }],
    scope: "connection",
    searchPaths: [[{ quoted: false, value: "main" }]],
  });
  if (result.status !== "accepted") throw new Error("request");
  return result.value;
}

function captured(search: unknown = vi.fn()) {
  const result = captureSqlNamespaceCatalogProvider({
    id: "namespaces",
    search,
  });
  if (result.status !== "accepted") throw new Error("provider");
  return result.value;
}

function container(
  id: string,
  role: "catalog" | "dataset" | "project" | "schema",
  value: string,
) {
  return {
    canonicalPath: [{
      quoted: false,
      role,
      value,
    }],
    containerEntityId: id,
    detail: `${role} detail`,
    insertText: value,
    matchQuality: "exact",
  };
}

describe("namespace catalog boundary", () => {
  it("captures provider methods without exposing a receiver", () => {
    const receivers: unknown[] = [];
    const search = function (this: unknown) {
      receivers.push(this);
    };
    const handle = captured(search);
    const context = resolveSqlNamespaceCatalogProvider(handle);
    expect(context?.id).toBe("namespaces");
    context?.search(request(), new AbortController().signal);
    expect(receivers).toEqual([undefined]);
    expect(Reflect.apply(
      resolveSqlNamespaceCatalogProvider,
      undefined,
      [{}],
    )).toBeNull();
    expect(Object.isFrozen(handle)).toBe(true);
  });

  it("rejects hostile or invalid providers", () => {
    const accessor = {};
    Object.defineProperty(accessor, "id", { get: vi.fn() });
    expect(captureSqlNamespaceCatalogProvider(accessor).status)
      .toBe("malformed");
    expect(captureSqlNamespaceCatalogProvider(null).status)
      .toBe("malformed");
    expect(captureSqlNamespaceCatalogProvider({
      id: "",
      search() {},
    }).status).toBe("malformed");
    expect(captureSqlNamespaceCatalogProvider({
      id: "x",
      search: 1,
    }).status).toBe("malformed");
    expect(captureSqlNamespaceCatalogProvider({
      extra: true,
      id: "x",
      search() {},
    }).status).toBe("malformed");
    expect(captureSqlNamespaceCatalogProvider(
      new Proxy({}, { ownKeys: () => { throw new Error("trap"); } }),
    ).status).toBe("malformed");
  });

  it("normalizes and freezes one bounded query-site search", () => {
    const value = request();
    expect(value).toEqual({
      dialectId: "duckdb",
      expectedEpoch: epoch,
      limit: 10,
      prefix: { quoted: false, value: "ma" },
      qualifier: [{ quoted: false, value: "memory" }],
      scope: "connection",
      searchPaths: [[{ quoted: false, value: "main" }]],
    });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.prefix)).toBe(true);
    expect(Object.isFrozen(value.qualifier)).toBe(true);
    expect(Object.isFrozen(value.searchPaths[0])).toBe(true);
    expect(createSqlNamespaceCatalogSearchRequest({
      ...value,
      expectedEpoch: null,
    }).status).toBe("accepted");
  });

  it("rejects malformed, sparse, accessor, and oversized requests", () => {
    const valid = request();
    const sparse: unknown[] = [];
    sparse.length = 1;
    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    const cases: unknown[] = [
      null,
      { ...valid, extra: true },
      { ...valid, dialectId: "" },
      { ...valid, scope: "" },
      { ...valid, expectedEpoch: undefined },
      { ...valid, expectedEpoch: { generation: -1, token: "x" } },
      { ...valid, expectedEpoch: { generation: 1.5, token: "x" } },
      { ...valid, expectedEpoch: { generation: 1, token: "" } },
      { ...valid, limit: 0 },
      { ...valid, limit: MAX_NAMESPACE_RESULTS + 1 },
      { ...valid, limit: 1.5 },
      { ...valid, prefix: { quoted: "no", value: "x" } },
      { ...valid, prefix: { quoted: false, value: "x", extra: 1 } },
      { ...valid, qualifier: [{ quoted: false, value: "" }] },
      { ...valid, searchPaths: [[{ quoted: false, value: "" }]] },
      { ...valid, qualifier: sparse },
      { ...valid, searchPaths: sparse },
      { ...valid, qualifier: revoked.proxy },
      { ...valid, qualifier: [{ quoted: false, value: "x".repeat(257) }] },
      { ...valid, searchPaths: Array.from({ length: 33 }, () => []) },
    ];
    const accessor = { ...valid };
    Object.defineProperty(accessor, "prefix", { get: vi.fn() });
    cases.push(accessor);
    cases.push({
      ...valid,
      qualifier: new Proxy([], {
        getOwnPropertyDescriptor: (_target, key) => {
          if (key === "length") throw new Error("length trap");
          return undefined;
        },
      }),
    });
    cases.push({
      ...valid,
      qualifier: new Proxy([{ quoted: false, value: "x" }], {
        getOwnPropertyDescriptor: (target, key) => {
          if (key === "0") throw new Error("element trap");
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      }),
    });
    for (const value of cases) {
      expect(createSqlNamespaceCatalogSearchRequest(value).status)
        .toBe("malformed");
    }
    expect(createSqlNamespaceCatalogSearchRequest({
      ...valid,
      prefix: { quoted: false, value: "" },
      qualifier: [],
    }).status).toBe("accepted");
  });

  it("decodes, deduplicates, orders, and freezes all container roles", () => {
    const provider = captured();
    const decoded = decodeSqlNamespaceCatalogSearchResponse(
      provider,
      request(),
      {
        containers: [
          container("schema", "schema", "main"),
          { ...container("schema", "schema", "main") },
          container("project", "project", "alpha"),
          container("dataset", "dataset", "events"),
          container("catalog", "catalog", "memory"),
        ],
        coverage: "partial",
        epoch,
        status: "ready",
      },
    );
    expect(decoded.status).toBe("accepted");
    if (decoded.status !== "accepted" ||
      decoded.value.status !== "ready") {
      throw new Error("Expected a ready namespace response");
    }
    expect(decoded.value.containers.map((value) =>
      value.canonicalPath[0]?.role
    )).toEqual(["catalog", "dataset", "project", "schema"]);
    expect(decoded.value.containers[0]?.provenance).toEqual({
      containerEntityId: "catalog",
      epoch,
      providerId: "namespaces",
      scope: "connection",
    });
    expect(Object.isFrozen(decoded.value)).toBe(true);
    expect(Object.isFrozen(decoded.value.containers)).toBe(true);
    expect(Object.isFrozen(
      decoded.value.containers[0]?.canonicalPath,
    )).toBe(true);
  });

  it("decodes loading and normalized failures", () => {
    const provider = captured();
    expect(decodeSqlNamespaceCatalogSearchResponse(
      provider,
      request(),
      { epoch, status: "loading" },
    )).toMatchObject({
      status: "accepted",
      value: { status: "loading" },
    });
    expect(decodeSqlNamespaceCatalogSearchResponse(
      provider,
      request(),
      {
        code: "rate-limited",
        epoch,
        retry: "next-request",
        status: "failed",
      },
    )).toMatchObject({
      status: "accepted",
      value: {
        code: "rate-limited",
        retry: "next-request",
        status: "failed",
      },
    });
  });

  it("orders tied identities and accepts quoted paths without detail", () => {
    const provider = captured();
    const base = {
      canonicalPath: [{
        quoted: true,
        role: "schema",
        value: "Main",
      }],
      insertText: "\"Main\"",
      matchQuality: "exact",
    };
    const decoded = decodeSqlNamespaceCatalogSearchResponse(
      provider,
      request(),
      {
        containers: [
          { ...base, containerEntityId: "z" },
          { ...base, containerEntityId: "a" },
        ],
        coverage: "complete",
        epoch,
        status: "ready",
      },
    );
    expect(decoded).toMatchObject({
      status: "accepted",
      value: {
        containers: [
          { containerEntityId: "a" },
          { containerEntityId: "z" },
        ],
      },
    });
  });

  it("orders raw identifier values by UTF-16 code units", () => {
    const decoded = decodeSqlNamespaceCatalogSearchResponse(
      captured(),
      request(),
      {
        containers: [
          container("hash", "schema", "#"),
          container("quote", "schema", "\""),
          container("slash", "schema", "\\"),
          container("control", "schema", "\u0000"),
        ],
        coverage: "complete",
        epoch,
        status: "ready",
      },
    );
    expect(decoded).toMatchObject({
      status: "accepted",
      value: {
        containers: [
          { containerEntityId: "control" },
          { containerEntityId: "quote" },
          { containerEntityId: "hash" },
          { containerEntityId: "slash" },
        ],
      },
    });
  });

  it("compares canonical paths structurally when they contain NUL", () => {
    const provider = captured();
    const base = {
      containerEntityId: "same",
      insertText: "value",
      matchQuality: "exact",
    };
    const decoded = decodeSqlNamespaceCatalogSearchResponse(
      provider,
      request(),
      {
        containers: [
          {
            ...base,
            canonicalPath: [{
              quoted: false,
              role: "schema",
              value: "a\u0000catalog:u:b",
            }],
          },
          {
            ...base,
            canonicalPath: [
              { quoted: false, role: "schema", value: "a" },
              { quoted: false, role: "catalog", value: "b" },
            ],
          },
        ],
        coverage: "complete",
        epoch,
        status: "ready",
      },
    );
    expect(decoded).toEqual({
      reason: "duplicate-entity-id",
      status: "malformed",
    });
  });

  it("rejects malformed, conflicting, stale, and oversized responses", () => {
    const provider = captured();
    const valid = {
      containers: [container("one", "schema", "main")],
      coverage: "complete",
      epoch,
      status: "ready",
    };
    const conflicting = {
      ...valid,
      containers: [
        container("same", "schema", "main"),
        container("same", "schema", "other"),
      ],
    };
    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    const malformedContainers = [
      { ...container("x", "schema", "x"), canonicalPath: [] },
      { ...container("x", "schema", "x"), canonicalPath: [{
        quoted: false,
        role: "schema",
        value: "",
      }] },
      { ...container("x", "schema", "x"), canonicalPath: [{
        quoted: false,
        role: "table",
        value: "x",
      }] },
      { ...container("x", "schema", "x"), containerEntityId: "" },
      { ...container("x", "schema", "x"), insertText: "" },
      { ...container("x", "schema", "x"), matchQuality: "bad" },
      { ...container("x", "schema", "x"), detail: 1 },
    ];
    const cases: unknown[] = [
      null,
      { ...valid, extra: true },
      { ...valid, epoch: { generation: 2, token: "two" } },
      { ...valid, coverage: "unknown" },
      { ...valid, containers: Array.from(
        { length: 11 },
        (_, index) => container(String(index), "schema", String(index)),
      ) },
      conflicting,
      { ...valid, containers: [null] },
      { ...valid, containers: revoked.proxy },
      { epoch, extra: true, status: "loading" },
      { code: "bad", epoch, retry: "never", status: "failed" },
      { code: "unknown", epoch, retry: "bad", status: "failed" },
      { code: "unknown", epoch, retry: "never", status: "failed", x: 1 },
      ...malformedContainers.map((value) => ({
        ...valid,
        containers: [value],
      })),
    ];
    for (const value of cases) {
      expect(decodeSqlNamespaceCatalogSearchResponse(
        provider,
        request(),
        value,
      ).status).toBe("malformed");
    }
    expect(Reflect.apply(
      decodeSqlNamespaceCatalogSearchResponse,
      undefined,
      [{}, request(), valid],
    )).toMatchObject({ status: "malformed" });
  });
});
