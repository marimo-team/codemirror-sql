import { describe, expect, it, vi } from "vitest";
import {
  createSqlNamespaceCatalogCoordinator,
  type SqlNamespaceCatalogSearchOutcome,
} from "../namespace-catalog-coordinator.js";
import {
  composeSqlNamespaceCompletion,
  prepareSqlNamespaceCatalogSearch,
} from "../namespace-completion.js";
import type {
  SqlNamespaceCatalogSearchRequest,
} from "../namespace-catalog-types.js";
import type { SqlCatalogEpoch } from "../relation-completion-types.js";

const epoch: SqlCatalogEpoch =
  Object.freeze({ generation: 1, token: "one" });
const nextEpoch: SqlCatalogEpoch =
  Object.freeze({ generation: 2, token: "two" });

function input(
  prefix = "ma",
  expectedEpoch: SqlCatalogEpoch | null = epoch,
) {
  return {
    expectedEpoch,
    limit: 10,
    prefix: { quoted: false, value: prefix },
    qualifier: [{ quoted: false, value: "memory" }],
    searchPaths: [[{ quoted: false, value: "main" }]],
  };
}

function response(
  request: SqlNamespaceCatalogSearchRequest,
  coverage: "complete" | "partial" = "complete",
) {
  return {
    containers: [{
      canonicalPath: [
        { quoted: false, role: "catalog", value: "memory" },
        { quoted: false, role: "schema", value: "main" },
      ],
      containerEntityId: `schema:${request.prefix.value}`,
      detail: "Schema",
      insertText: "main",
      matchQuality: "exact",
    }],
    coverage,
    epoch: request.expectedEpoch ?? epoch,
    status: "ready",
  };
}

function setup(
  search: (
    request: SqlNamespaceCatalogSearchRequest,
    signal: AbortSignal,
  ) => unknown,
  maxCacheEntries = 16,
) {
  const created = createSqlNamespaceCatalogCoordinator({
    maxCacheEntries,
    provider: { id: "namespaces", search },
  });
  if (created.status !== "created") throw new Error("coordinator");
  const prepared = created.coordinator.prepareOwner({
    dialectId: "duckdb",
    scope: "connection",
  });
  if (prepared.status !== "prepared") throw new Error("owner");
  return {
    coordinator: created.coordinator,
    owner: prepared.owner,
  };
}

function deferred<Value>() {
  let resolve: (value: Value) => void = (): void => {};
  let reject: (reason?: unknown) => void = (): void => {};
  const promise = new Promise<Value>((resolve_, reject_) => {
    resolve = resolve_;
    reject = reject_;
  });
  return { promise, reject, resolve };
}

describe("namespace catalog coordinator", () => {
  it("performs exactly one bounded search for one query site", async () => {
    const searches: SqlNamespaceCatalogSearchRequest[] = [];
    const { coordinator, owner } = setup((request) => {
      searches.push(request);
      return response(request);
    });
    const outcome = await owner.request(input()).result;
    expect(searches).toHaveLength(1);
    expect(searches[0]).toMatchObject({
      dialectId: "duckdb",
      limit: 10,
      prefix: { value: "ma" },
      qualifier: [{ value: "memory" }],
      scope: "connection",
    });
    expect(outcome).toMatchObject({
      providerId: "namespaces",
      response: { status: "ready" },
      scope: "connection",
      status: "usable",
    });
    expect(Object.isFrozen(outcome)).toBe(true);
    coordinator.dispose();
  });

  it("observes cold epochs and caches complete searches", async () => {
    const expected: Array<SqlCatalogEpoch | null> = [];
    const { owner } = setup((request) => {
      expected.push(request.expectedEpoch);
      return { ...response(request), epoch };
    });
    await owner.request(input("ma", null)).result;
    const cached = await owner.request(input("ma", null)).result;
    await owner.request(input("ma", nextEpoch)).result;
    expect(expected).toEqual([null, nextEpoch]);
    expect(cached.status).toBe("usable");
  });

  it("does not cache partial, loading, or failed results", async () => {
    let calls = 0;
    const { owner } = setup((request) => {
      calls += 1;
      if (calls <= 2) return response(request, "partial");
      if (calls <= 4) {
        return { epoch, status: "loading" };
      }
      return {
        code: "unavailable",
        epoch,
        retry: "next-request",
        status: "failed",
      };
    });
    await owner.request(input("partial")).result;
    await owner.request(input("partial")).result;
    await owner.request(input("loading")).result;
    await owner.request(input("loading")).result;
    await owner.request(input("failed")).result;
    await owner.request(input("failed")).result;
    expect(calls).toBe(6);
  });

  it("cancels and supersedes pending owner searches", async () => {
    const pending: Array<ReturnType<typeof deferred<unknown>>> = [];
    const signals: AbortSignal[] = [];
    const { owner } = setup((_request, signal) => {
      const work = deferred<unknown>();
      pending.push(work);
      signals.push(signal);
      return work.promise;
    });
    const first = owner.request(input("first"));
    const second = owner.request(input("second"));
    await expect(first.result).resolves.toEqual({
      status: "superseded",
    });
    expect(signals[0]?.aborted).toBe(true);
    second.cancel();
    second.cancel();
    await expect(second.result).resolves.toEqual({
      status: "cancelled",
    });
    expect(signals[1]?.aborted).toBe(true);
    pending[0]?.resolve({});
    pending[1]?.resolve({});
    await Promise.resolve();
  });

  it("isolates owners and settles disposal", async () => {
    const pending: Array<ReturnType<typeof deferred<unknown>>> = [];
    const { coordinator, owner } = setup(() => {
      const work = deferred<unknown>();
      pending.push(work);
      return work.promise;
    });
    const other = coordinator.prepareOwner({
      dialectId: "duckdb",
      scope: "connection",
    });
    if (other.status !== "prepared") throw new Error("second owner");
    const first = owner.request(input("first"));
    const second = other.owner.request(input("second"));
    owner.dispose();
    await expect(first.result).resolves.toEqual({
      reason: "disposed",
      status: "unavailable",
    });
    let secondSettled = false;
    void second.result.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    coordinator.dispose();
    await expect(second.result).resolves.toEqual({
      reason: "disposed",
      status: "unavailable",
    });
    expect(coordinator.prepareOwner({
      dialectId: "duckdb",
      scope: "connection",
    })).toMatchObject({
      reason: "disposed",
      status: "unavailable",
    });
    expect(owner.request(input())).toBeDefined();
  });

  it("contains provider failures and malformed settlements", async () => {
    const thrown = setup(() => {
      throw new Error("sync");
    });
    await expect(thrown.owner.request(input()).result).resolves
      .toMatchObject({
        reason: "provider-failed",
        status: "unavailable",
      });
    const rejected = setup(() => Promise.reject(new Error("async")));
    await expect(rejected.owner.request(input()).result).resolves
      .toMatchObject({
        reason: "provider-failed",
        status: "unavailable",
      });
    const malformed = setup(() => ({}));
    await expect(malformed.owner.request(input()).result).resolves
      .toMatchObject({
        reason: "malformed-response",
        status: "unavailable",
      });
  });

  it("bounds the LRU and re-fetches evicted searches", async () => {
    let calls = 0;
    const { owner } = setup((request) => {
      calls += 1;
      return response(request);
    }, 1);
    await owner.request(input("one")).result;
    await owner.request(input("two")).result;
    await owner.request(input("one")).result;
    expect(calls).toBe(3);
  });

  it("fails closed for hostile or invalid configuration and inputs", async () => {
    expect(createSqlNamespaceCatalogCoordinator(null)).toMatchObject({
      reason: "invalid-provider",
      status: "unavailable",
    });
    expect(createSqlNamespaceCatalogCoordinator({
      maxCacheEntries: 0,
      provider: { id: "x", search() {} },
    })).toMatchObject({
      reason: "invalid-options",
      status: "unavailable",
    });
    const created = createSqlNamespaceCatalogCoordinator({
      provider: { id: "x", search() {} },
    });
    if (created.status !== "created") throw new Error("created");
    expect(created.coordinator.prepareOwner({
      dialectId: "",
      scope: "",
    })).toMatchObject({
      reason: "invalid-options",
      status: "unavailable",
    });
    const prepared = created.coordinator.prepareOwner({
      dialectId: "duckdb",
      scope: "scope",
    });
    if (prepared.status !== "prepared") throw new Error("prepared");
    expect(await prepared.owner.request({
      ...input(),
      limit: 0,
    }).result).toMatchObject({
      reason: "invalid-request",
      status: "unavailable",
    });
    const hostile = {};
    Object.defineProperty(hostile, "expectedEpoch", { get: vi.fn() });
    const hostileTicket = Reflect.apply(
      prepared.owner.request,
      undefined,
      [hostile],
    );
    expect(await hostileTicket.result).toMatchObject({
      reason: "invalid-request",
      status: "unavailable",
    });
  });
});

describe("namespace completion composer", () => {
  const readyOutcome: Extract<
    SqlNamespaceCatalogSearchOutcome,
    { readonly status: "usable" }
  > = {
    providerId: "namespaces",
    response: {
      containers: [
        {
          canonicalPath: [
            { quoted: false, role: "catalog", value: "memory" },
            { quoted: false, role: "schema", value: "main" },
          ],
          containerEntityId: "main",
          detail: "Schema",
          insertText: "main",
          matchQuality: "exact",
          provenance: {
            containerEntityId: "main",
            epoch,
            providerId: "namespaces",
            scope: "connection",
          },
        },
        {
          canonicalPath: [
            { quoted: false, role: "project", value: "alpha" },
            { quoted: false, role: "dataset", value: "metrics" },
          ],
          containerEntityId: "metrics",
          insertText: "metrics",
          matchQuality: "equivalent",
          provenance: {
            containerEntityId: "metrics",
            epoch,
            providerId: "namespaces",
            scope: "connection",
          },
        },
      ],
      coverage: "complete",
      epoch,
      status: "ready",
    },
    scope: "connection",
    status: "usable",
  };

  function catalogResponse() {
    if (readyOutcome.response.status !== "ready") {
      throw new Error("ready response");
    }
    return readyOutcome.response;
  }

  it("prepares one immutable search from a query site", () => {
    const prepared = prepareSqlNamespaceCatalogSearch({
      prefix: { quoted: false, value: "ma" },
      qualifier: [{ quoted: false, value: "memory" }],
      replacementRange: { from: 7, to: 9 },
    }, null, [], 20);
    expect(prepared).toEqual({
      expectedEpoch: null,
      limit: 20,
      prefix: { quoted: false, value: "ma" },
      qualifier: [{ quoted: false, value: "memory" }],
      searchPaths: [],
    });
    expect(Object.isFrozen(prepared)).toBe(true);
  });

  it("filters prefixes, deduplicates, orders, and uses provider edits", () => {
    const catalog = catalogResponse();
    const main = catalog.containers[0];
    if (!main) throw new Error("main");
    const duplicated = {
      ...readyOutcome,
      response: {
        ...catalog,
        containers: [
          ...catalog.containers,
          main,
          {
            ...main,
            containerEntityId: "main-copy",
            provenance: {
              ...main.provenance,
              containerEntityId: "main-copy",
            },
          },
        ],
      },
    };
    const all = composeSqlNamespaceCompletion({
      matchPrefix: (): "match" => "match",
      outcome: duplicated,
      prefix: { quoted: false, value: "" },
      providerId: "namespaces",
      replacementRange: { from: 10, to: 12 },
    });
    expect(all?.value.items.map((value) => value.label))
      .toEqual(["main", "main", "metrics"]);
    const composition = composeSqlNamespaceCompletion({
      matchPrefix: (candidate, prefix) =>
        candidate.value.startsWith(prefix.value)
          ? "match"
          : "no-match",
      outcome: duplicated,
      prefix: { quoted: false, value: "ma" },
      providerId: "namespaces",
      replacementRange: { from: 10, to: 12 },
    });
    expect(composition).toMatchObject({
      source: { coverage: "complete", outcome: "ready" },
      value: {
        isIncomplete: false,
        items: [{
          edit: { from: 10, insert: "main", to: 12 },
          label: "main",
          role: "schema",
        }, {
          edit: { from: 10, insert: "main", to: 12 },
          label: "main",
          role: "schema",
        }],
      },
    });
    expect(Object.isFrozen(composition?.value.items)).toBe(true);
  });

  it("surfaces partial and uncertain prefix coverage", () => {
    const catalog = catalogResponse();
    const composition = composeSqlNamespaceCompletion({
      matchPrefix: () => {
        throw new Error("dialect");
      },
      outcome: {
        ...readyOutcome,
        response: { ...catalog, coverage: "partial" },
      },
      prefix: { quoted: false, value: "m" },
      providerId: "namespaces",
      replacementRange: { from: 0, to: 1 },
    });
    expect(composition?.value).toMatchObject({
      isIncomplete: true,
      issues: [
        "namespace-catalog-partial",
        "namespace-prefix-uncertain",
      ],
      items: [],
    });
  });

  it("maps loading, failed, unavailable, and cancellation", () => {
    const base = {
      matchPrefix: (): "match" => "match",
      prefix: { quoted: false, value: "" },
      providerId: "namespaces",
      replacementRange: { from: 0, to: 0 },
    };
    expect(composeSqlNamespaceCompletion({
      ...base,
      outcome: {
        providerId: "namespaces",
        response: { epoch, status: "loading" },
        scope: "connection",
        status: "usable",
      },
    })).toMatchObject({
      source: { outcome: "loading" },
      value: { issues: ["namespace-catalog-loading"] },
    });
    expect(composeSqlNamespaceCompletion({
      ...base,
      outcome: {
        providerId: "namespaces",
        response: {
          code: "unknown",
          epoch,
          retry: "never",
          status: "failed",
        },
        scope: "connection",
        status: "usable",
      },
    })).toMatchObject({
      source: { outcome: "failed" },
      value: { issues: ["namespace-catalog-failed"] },
    });
    expect(composeSqlNamespaceCompletion({
      ...base,
      outcome: {
        reason: "malformed-response",
        status: "unavailable",
      },
    })).toMatchObject({
      source: {
        outcome: "unavailable",
        reason: "malformed-response",
      },
      value: { issues: ["namespace-catalog-malformed"] },
    });
    expect(composeSqlNamespaceCompletion({
      ...base,
      outcome: {
        reason: "provider-failed",
        status: "unavailable",
      },
    })).toMatchObject({
      value: { issues: ["namespace-catalog-failed"] },
    });
    expect(composeSqlNamespaceCompletion({
      ...base,
      outcome: { status: "cancelled" },
    })).toBeNull();
    expect(composeSqlNamespaceCompletion({
      ...base,
      outcome: { status: "superseded" },
    })).toBeNull();
  });
});
