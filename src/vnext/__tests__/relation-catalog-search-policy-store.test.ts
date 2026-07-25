import { describe, expect, it } from "vitest";
import type {
  SqlValidatedCatalogRelation,
  SqlValidatedCatalogSearchResponse,
} from "../relation-catalog-boundary.js";
import {
  createSqlCatalogSearchPolicyStore,
  MAX_CATALOG_POLICY_STORE_ENTRIES,
  MAX_CATALOG_POLICY_STORE_RETAINED_BYTES,
} from "../relation-catalog-search-policy-store.js";
import {
  DUCKDB_SQL_RELATION_DIALECT,
  POSTGRESQL_SQL_RELATION_DIALECT,
} from "../relation-dialect.js";
import type {
  SqlCanonicalRelationPath,
  SqlCatalogEpoch,
  SqlCatalogReadyCoverage,
  SqlCatalogSearchRequest,
} from "../relation-completion-types.js";

function epoch(generation: number): SqlCatalogEpoch {
  return Object.freeze({
    generation,
    token: `epoch-${generation}`,
  });
}

function request(
  prefix: string,
  expectedEpoch: SqlCatalogEpoch | null,
  options: {
    readonly continuationToken?: string | null;
    readonly dialectId?: string;
    readonly limit?: number;
    readonly qualifier?: string;
    readonly quoted?: boolean;
    readonly searchPath?: string;
    readonly scope?: string;
  } = {},
): SqlCatalogSearchRequest {
  return Object.freeze({
    continuationToken: options.continuationToken ?? null,
    dialectId: options.dialectId ?? "postgresql",
    expectedEpoch,
    limit: options.limit ?? 20,
    prefix: Object.freeze({
      quoted: options.quoted ?? false,
      value: prefix,
    }),
    qualifier: Object.freeze([
        Object.freeze({
          quoted: false,
          value: options.qualifier ?? "public",
        }),
    ]),
    scope: options.scope ?? "scope-a",
    searchPaths: Object.freeze([
      Object.freeze([
        Object.freeze({
          quoted: false,
          value: options.searchPath ?? "public",
        }),
      ]),
    ]),
  });
}

function relation(
  entityId: string,
  detail?: string,
): SqlValidatedCatalogRelation {
  const path: SqlCanonicalRelationPath = Object.freeze([
    Object.freeze({
      quoted: false,
      role: "relation" as const,
      value: entityId,
    }),
  ]);
  const base = {
    canonicalPath: path,
    completionPath: path,
    completionPathStart: 0,
    completionText: entityId,
    entityId,
    matchQuality: "exact" as const,
    relationKind: "table" as const,
  };
  return Object.freeze(
    detail === undefined ? base : { ...base, detail },
  );
}

function ready(
  value: SqlCatalogEpoch,
  coverage: SqlCatalogReadyCoverage = { kind: "complete" },
  relations: readonly SqlValidatedCatalogRelation[] = [],
): Extract<
  SqlValidatedCatalogSearchResponse,
  { readonly status: "ready" }
> {
  return Object.freeze({
    coverage: Object.freeze(coverage),
    epoch: value,
    relations: Object.freeze(relations),
    status: "ready",
  });
}

function loading(
  value: SqlCatalogEpoch,
): Extract<
  SqlValidatedCatalogSearchResponse,
  { readonly status: "loading" }
> {
  return Object.freeze({ epoch: value, status: "loading" });
}

function failed(
  value: SqlCatalogEpoch,
  retry: "after-invalidation" | "never" | "next-request",
): Extract<
  SqlValidatedCatalogSearchResponse,
  { readonly status: "failed" }
> {
  return Object.freeze({
    code: "unavailable",
    epoch: value,
    retry,
    status: "failed",
  });
}

describe("relation catalog search policy store", () => {
  it("caches ready baseline pages only under their concrete exact epoch key", () => {
    const store = createSqlCatalogSearchPolicyStore();
    const firstEpoch = epoch(1);
    const baseline = request("u", null);
    const response = ready(
      firstEpoch,
      {
        continuationToken: "next",
        kind: "paginated",
      },
      [relation("users")],
    );

    expect(
      store.record(
        baseline,
        POSTGRESQL_SQL_RELATION_DIALECT,
        response,
      ),
    ).toMatchObject({ retained: "ready", status: "accepted" });
    expect(
      store.probe(
        baseline,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    ).toEqual({ loadingEpoch: null, status: "miss" });
    expect(
      store.probe(
        request("u", firstEpoch),
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    ).toEqual({ response, status: "ready" });
    expect(
      store.probe(
        request("u", firstEpoch, {
          continuationToken: "next",
        }),
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    ).toMatchObject({ status: "miss" });
    expect(
      store.probe(
        request("u", firstEpoch),
        DUCKDB_SQL_RELATION_DIALECT,
      ),
    ).toMatchObject({ status: "miss" });
  });

  it("retains partial and complete-empty results without upgrading coverage", () => {
    const store = createSqlCatalogSearchPolicyStore();
    const current = epoch(2);
    const partial = ready(current, { kind: "partial" }, [
      relation("partial"),
    ]);
    const empty = ready(current);

    store.record(
      request("p", current),
      POSTGRESQL_SQL_RELATION_DIALECT,
      partial,
    );
    store.record(
      request("e", current),
      POSTGRESQL_SQL_RELATION_DIALECT,
      empty,
    );

    expect(
      store.probe(
        request("p", current),
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    ).toEqual({ response: partial, status: "ready" });
    expect(
      store.probe(
        request("e", current),
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    ).toEqual({ response: empty, status: "ready" });
  });

  it("uses every structural key field and replaces an exact cached value", () => {
    const store = createSqlCatalogSearchPolicyStore();
    const current = epoch(2);
    const key = request("key", current);
    const replacement = ready(current, { kind: "partial" });
    store.record(
      key,
      POSTGRESQL_SQL_RELATION_DIALECT,
      ready(current),
    );
    store.record(
      key,
      POSTGRESQL_SQL_RELATION_DIALECT,
      replacement,
    );

    const variants = [
      request("key", current, { continuationToken: "page" }),
      request("key", current, { dialectId: "other" }),
      request("key", current, { limit: 19 }),
      request("key", current, { qualifier: "other" }),
      request("key", current, { quoted: true }),
      request("key", current, { searchPath: "other" }),
      request("key", current, { scope: "other" }),
      request("other", current),
      Object.freeze({
        ...key,
        qualifier: Object.freeze([]),
      }),
    ];
    for (const variant of variants) {
      expect(
        store.probe(
          variant,
          POSTGRESQL_SQL_RELATION_DIALECT,
        ),
      ).toMatchObject({ status: "miss" });
    }
    expect(
      store.probe(
        key,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    ).toEqual({ response: replacement, status: "ready" });
    const continued = request("continued", current, {
      continuationToken: "page-2",
    });
    store.record(
      continued,
      POSTGRESQL_SQL_RELATION_DIALECT,
      ready(current),
    );
    expect(
      store.probe(
        continued,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    ).toMatchObject({ status: "ready" });
    expect(store.metrics().entries).toBe(2);
  });

  it("permits loading probes but rejects same-epoch ready publication", () => {
    const store = createSqlCatalogSearchPolicyStore();
    const current = epoch(3);
    const key = request("load", current);

    expect(
      store.record(
        key,
        POSTGRESQL_SQL_RELATION_DIALECT,
        loading(current),
      ),
    ).toMatchObject({
      retained: "loading-barrier",
      status: "accepted",
    });
    expect(
      store.probe(key, POSTGRESQL_SQL_RELATION_DIALECT),
    ).toEqual({
      loadingEpoch: current,
      status: "miss",
    });
    expect(
      store.record(
        key,
        POSTGRESQL_SQL_RELATION_DIALECT,
        loading(current),
      ),
    ).toMatchObject({ retained: "loading-barrier" });
    expect(
      store.record(
        key,
        POSTGRESQL_SQL_RELATION_DIALECT,
        ready(current),
      ),
    ).toEqual({
      reason: "loading-transition",
      status: "conflict",
    });
    expect(
      store.record(
        key,
        POSTGRESQL_SQL_RELATION_DIALECT,
        ready(epoch(4)),
      ),
    ).toEqual({
      reason: "epoch-mismatch",
      status: "conflict",
    });
    expect(store.metrics()).toMatchObject({
      loadingBarriers: 1,
    });
    expect(
      store.record(
        key,
        POSTGRESQL_SQL_RELATION_DIALECT,
        failed(current, "next-request"),
      ),
    ).toMatchObject({ retained: "none" });
    expect(
      store.probe(key, POSTGRESQL_SQL_RELATION_DIALECT),
    ).toEqual({ loadingEpoch: current, status: "miss" });
  });

  it("implements all failure retry policies", () => {
    const current = epoch(4);
    const key = request("retry", current);

    const nextStore = createSqlCatalogSearchPolicyStore();
    expect(
      nextStore.record(
        key,
        POSTGRESQL_SQL_RELATION_DIALECT,
        failed(current, "next-request"),
      ),
    ).toMatchObject({ retained: "none" });
    expect(
      nextStore.probe(
        key,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    ).toMatchObject({ status: "miss" });

    const invalidationStore =
      createSqlCatalogSearchPolicyStore();
    invalidationStore.record(
      key,
      POSTGRESQL_SQL_RELATION_DIALECT,
      failed(current, "after-invalidation"),
    );
    expect(
      invalidationStore.probe(
        key,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    ).toMatchObject({
      retry: "after-invalidation",
      status: "failed",
    });
    expect(
      invalidationStore.record(
        key,
        POSTGRESQL_SQL_RELATION_DIALECT,
        ready(current),
      ),
    ).toEqual({
      reason: "retry-gated",
      status: "conflict",
    });
    expect(
      invalidationStore.record(
        key,
        POSTGRESQL_SQL_RELATION_DIALECT,
        loading(current),
      ),
    ).toEqual({
      reason: "retry-gated",
      status: "conflict",
    });
    invalidationStore.advanceScope("scope-a", epoch(5));
    expect(
      invalidationStore.probe(
        request("retry", epoch(5)),
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    ).toMatchObject({ status: "miss" });

    const neverStore = createSqlCatalogSearchPolicyStore();
    neverStore.record(
      key,
      POSTGRESQL_SQL_RELATION_DIALECT,
      failed(current, "never"),
    );
    neverStore.advanceScope("scope-a", epoch(5));
    expect(
      neverStore.probe(
        request("retry", epoch(5)),
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    ).toEqual({
      code: "unavailable",
      epoch: epoch(5),
      retry: "never",
      status: "failed",
    });
    expect(
      neverStore.probe(
        request("retry", null),
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    ).toEqual({ loadingEpoch: null, status: "miss" });
    expect(
      neverStore.record(
        request("retry", epoch(5)),
        POSTGRESQL_SQL_RELATION_DIALECT,
        loading(epoch(5)),
      ),
    ).toEqual({
      reason: "retry-gated",
      status: "conflict",
    });
  });

  it("invalidates only older epoch-scoped state in the selected scope", () => {
    const store = createSqlCatalogSearchPolicyStore();
    const oldEpoch = epoch(7);
    const newEpoch = epoch(8);
    const keepResponse = ready(newEpoch);

    store.record(
      request("old", oldEpoch),
      POSTGRESQL_SQL_RELATION_DIALECT,
      ready(oldEpoch),
    );
    store.record(
      request("keep", newEpoch),
      POSTGRESQL_SQL_RELATION_DIALECT,
      keepResponse,
    );
    store.record(
      request("other", oldEpoch, { scope: "scope-b" }),
      POSTGRESQL_SQL_RELATION_DIALECT,
      ready(oldEpoch),
    );
    store.advanceScope("scope-a", newEpoch);
    store.advanceScope("scope-missing", newEpoch);

    expect(
      store.probe(
        request("old", newEpoch),
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    ).toMatchObject({ status: "miss" });
    expect(
      store.probe(
        request("keep", newEpoch),
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    ).toEqual({ response: keepResponse, status: "ready" });
    expect(store.metrics()).toMatchObject({
      entries: 2,
      readyEntries: 2,
    });
  });

  it("evicts deterministically by recency at the shared entry ceiling", () => {
    const store = createSqlCatalogSearchPolicyStore();
    const current = epoch(9);
    for (
      let index = 0;
      index < MAX_CATALOG_POLICY_STORE_ENTRIES;
      index += 1
    ) {
      store.record(
        request(`key-${index}`, current),
        POSTGRESQL_SQL_RELATION_DIALECT,
        ready(current),
      );
    }
    store.probe(
      request("key-0", current),
      POSTGRESQL_SQL_RELATION_DIALECT,
    );
    store.record(
      request("newest", current),
      POSTGRESQL_SQL_RELATION_DIALECT,
      failed(current, "after-invalidation"),
    );

    expect(store.metrics()).toMatchObject({
      entries: MAX_CATALOG_POLICY_STORE_ENTRIES,
      failureGates: 1,
    });
    expect(
      store.probe(
        request("key-0", current),
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    ).toMatchObject({ status: "ready" });
    expect(
      store.probe(
        request("key-1", current),
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    ).toMatchObject({ status: "miss" });
  });

  it("never evicts correctness gates when bounded capacity is exhausted", () => {
    const store = createSqlCatalogSearchPolicyStore();
    const current = epoch(9);
    for (
      let index = 0;
      index < MAX_CATALOG_POLICY_STORE_ENTRIES;
      index += 1
    ) {
      expect(
        store.record(
          request(`gate-${index}`, current),
          POSTGRESQL_SQL_RELATION_DIALECT,
          loading(current),
        ),
      ).toMatchObject({
        retained: "loading-barrier",
        status: "accepted",
      });
    }

    expect(
      store.record(
        request("overflow", current),
        POSTGRESQL_SQL_RELATION_DIALECT,
        failed(current, "after-invalidation"),
      ),
    ).toEqual({
      reason: "capacity",
      status: "conflict",
    });
    expect(
      store.record(
        request("loading-overflow", current),
        POSTGRESQL_SQL_RELATION_DIALECT,
        loading(current),
      ),
    ).toEqual({
      reason: "capacity",
      status: "conflict",
    });
    expect(
      store.probe(
        request("gate-0", current),
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    ).toEqual({ status: "overloaded" });
    expect(store.metrics()).toMatchObject({
      entries: MAX_CATALOG_POLICY_STORE_ENTRIES,
      loadingBarriers: MAX_CATALOG_POLICY_STORE_ENTRIES,
    });
  });

  it("enforces the retained-byte ceiling without truncating responses", () => {
    const store = createSqlCatalogSearchPolicyStore();
    const current = epoch(10);
    const relations = Array.from(
      { length: 50 },
      (_, index) =>
        relation(`large-${index}`, "x".repeat(800)),
    );
    for (let index = 0; index < 80; index += 1) {
      store.record(
        request(`large-${index}`, current),
        POSTGRESQL_SQL_RELATION_DIALECT,
        ready(current, { kind: "partial" }, relations),
      );
    }

    expect(store.metrics().retainedBytes).toBeLessThanOrEqual(
      MAX_CATALOG_POLICY_STORE_RETAINED_BYTES,
    );
    expect(store.metrics().entries).toBeLessThan(80);
    expect(
      store.probe(
        request("large-0", current),
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    ).toMatchObject({ status: "miss" });
    expect(
      store.probe(
        request("large-79", current),
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    ).toMatchObject({ status: "ready" });
  });

  it("does not retain one response larger than the byte ceiling", () => {
    const store = createSqlCatalogSearchPolicyStore();
    const current = epoch(10);
    const oversized = ready(current, { kind: "partial" }, [
      relation(
        "oversized",
        "x".repeat(
          MAX_CATALOG_POLICY_STORE_RETAINED_BYTES,
        ),
      ),
    ]);

    expect(
      store.record(
        request("oversized", current),
        POSTGRESQL_SQL_RELATION_DIALECT,
        oversized,
      ),
    ).toMatchObject({
      retained: "none",
      response: oversized,
      status: "accepted",
    });
    expect(store.metrics().entries).toBe(0);
  });

  it("rejects an individually oversized correctness gate", () => {
    const store = createSqlCatalogSearchPolicyStore();
    const current = epoch(10);
    const oversizedKey = request(
      "x".repeat(
        MAX_CATALOG_POLICY_STORE_RETAINED_BYTES,
      ),
      current,
    );

    expect(
      store.record(
        oversizedKey,
        POSTGRESQL_SQL_RELATION_DIALECT,
        failed(current, "after-invalidation"),
      ),
    ).toEqual({
      reason: "capacity",
      status: "conflict",
    });
    expect(store.metrics()).toMatchObject({
      entries: 0,
      failureGates: 0,
    });
  });

  it("disposes retained state and leaves the frozen handle inert", () => {
    const store = createSqlCatalogSearchPolicyStore();
    const current = epoch(11);
    const key = request("disposed", current);
    store.record(
      key,
      POSTGRESQL_SQL_RELATION_DIALECT,
      ready(current),
    );

    expect(Object.isFrozen(store)).toBe(true);
    store.dispose();
    store.dispose();
    store.advanceScope("scope-a", epoch(12));

    expect(store.metrics()).toEqual({
      entries: 0,
      failureGates: 0,
      loadingBarriers: 0,
      readyEntries: 0,
      retainedBytes: 0,
    });
    expect(
      store.probe(key, POSTGRESQL_SQL_RELATION_DIALECT),
    ).toEqual({ status: "disposed" });
    expect(
      store.record(
        key,
        POSTGRESQL_SQL_RELATION_DIALECT,
        ready(current),
      ),
    ).toEqual({ status: "disposed" });
  });
});
