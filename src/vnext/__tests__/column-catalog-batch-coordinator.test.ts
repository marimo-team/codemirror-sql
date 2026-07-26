import { describe, expect, it, vi } from "vitest";
import {
  createSqlColumnCatalogBatchCoordinator,
} from "../column-catalog-batch-coordinator.js";
import type {
  SqlColumnCatalogBatchRequest,
} from "../column-catalog-types.js";
import type { SqlCatalogEpoch } from "../relation-completion-types.js";

const epoch: SqlCatalogEpoch =
  Object.freeze({ generation: 1, token: "one" });
const nextEpoch: SqlCatalogEpoch =
  Object.freeze({ generation: 2, token: "two" });

function reference(requestKey: string, name = requestKey) {
  return Object.freeze({
    path: Object.freeze([
      Object.freeze({ quoted: false, value: name }),
    ]),
    requestKey,
  });
}

function ready(
  request: SqlColumnCatalogBatchRequest,
  suffix = "",
) {
  return {
    epoch: request.expectedEpoch ?? epoch,
    relations: request.relations.map((relation) => ({
      columns: [{
        columnEntityId: `column-${relation.requestKey}${suffix}`,
        identifier: {
          quoted: false,
          value: `value_${relation.requestKey}${suffix}`,
        },
        insertText: `value_${relation.requestKey}${suffix}`,
        ordinal: 0,
      }],
      coverage: "complete",
      relationEntityId: `relation-${relation.requestKey}`,
      requestKey: relation.requestKey,
      status: "ready",
    })),
  };
}

function setup(
  loadColumns: (
    request: SqlColumnCatalogBatchRequest,
    signal: AbortSignal,
  ) => unknown,
  maxCacheEntries = 32,
) {
  const result = createSqlColumnCatalogBatchCoordinator({
    maxCacheEntries,
    provider: { id: "catalog", loadColumns },
  });
  if (result.status !== "created") {
    throw new Error("Expected coordinator");
  }
  const prepared = result.coordinator.prepareOwner({
    dialectId: "duckdb",
    scope: "scope",
  });
  if (prepared.status !== "prepared") {
    throw new Error("Expected owner");
  }
  return {
    coordinator: result.coordinator,
    owner: prepared.owner,
  };
}

function input(
  relations = [reference("users"), reference("events")],
  epoch_: SqlCatalogEpoch | null = epoch,
) {
  return {
    expectedEpoch: epoch_,
    relations,
    searchPaths: [[{ quoted: false, value: "main" }]],
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

describe("column catalog batch coordinator", () => {
  it("loads every missing relation in one deterministic batch", async () => {
    const requests: SqlColumnCatalogBatchRequest[] = [];
    const { coordinator, owner } = setup((request) => {
      requests.push(request);
      return ready(request);
    });
    const outcome = await owner.request(input([
      reference("users"),
      reference("events"),
      reference("accounts"),
    ])).result;

    expect(requests).toHaveLength(1);
    expect(requests[0]?.relations.map((relation) =>
      relation.requestKey
    )).toEqual(["accounts", "events", "users"]);
    expect(outcome).toMatchObject({
      providerId: "catalog",
      relations: [
        { requestKey: "accounts", status: "ready" },
        { requestKey: "events", status: "ready" },
        { requestKey: "users", status: "ready" },
      ],
      status: "usable",
    });
    expect(Object.isFrozen(outcome)).toBe(true);
    if (outcome.status === "usable") {
      expect(Object.isFrozen(outcome.relations)).toBe(true);
    }
    coordinator.dispose();
  });

  it("caches ready relations by authority identity and remaps request keys", async () => {
    const requests: SqlColumnCatalogBatchRequest[] = [];
    const { owner } = setup((request) => {
      requests.push(request);
      return ready(request);
    });
    await owner.request(input([reference("first", "users")])).result;
    const cached = await owner.request(input([
      reference("renamed", "users"),
    ])).result;
    await owner.request(input(
      [reference("new-epoch", "users")],
      nextEpoch,
    )).result;

    expect(requests).toHaveLength(2);
    expect(cached).toMatchObject({
      relations: [{
        relationEntityId: "relation-first",
        requestKey: "renamed",
      }],
      status: "usable",
    });
  });

  it("separates quoted relation and search-path cache identities", async () => {
    let calls = 0;
    const { owner } = setup((request) => {
      calls += 1;
      return ready(request);
    });
    const quoted = {
      expectedEpoch: epoch,
      relations: [{
        path: [{ quoted: true, value: "users" }],
        requestKey: "quoted",
      }],
      searchPaths: [[{ quoted: true, value: "main" }]],
    };

    await expect(owner.request(quoted).result).resolves.toMatchObject({
      status: "usable",
    });
    await expect(owner.request(quoted).result).resolves.toMatchObject({
      status: "usable",
    });
    expect(calls).toBe(1);
  });

  it("supports cold null epochs and reuses the observed response epoch", async () => {
    const expected: Array<SqlCatalogEpoch | null> = [];
    const { owner } = setup((request) => {
      expected.push(request.expectedEpoch);
      return {
        ...ready(request),
        epoch,
      };
    });
    await owner.request(input([reference("users")], null)).result;
    const cached = await owner.request(
      input([reference("renamed", "users")], null),
    ).result;

    expect(expected).toEqual([null]);
    expect(cached).toMatchObject({
      relations: [{ requestKey: "renamed" }],
      status: "usable",
    });
  });

  it("combines cached and loaded relations without changing order", async () => {
    const requests: SqlColumnCatalogBatchRequest[] = [];
    const { owner } = setup((request) => {
      requests.push(request);
      return ready(request);
    });
    await owner.request(input([reference("users")])).result;
    const mixed = await owner.request(input([
      reference("users"),
      reference("events"),
    ])).result;

    expect(requests).toHaveLength(2);
    expect(requests[1]?.relations.map((relation) =>
      relation.requestKey
    )).toEqual(["events"]);
    expect(mixed).toMatchObject({
      relations: [
        { requestKey: "events" },
        { requestKey: "users" },
      ],
      status: "usable",
    });
  });

  it("caches only complete ready coverage", async () => {
    let calls = 0;
    const { owner } = setup((request) => {
      calls += 1;
      return {
        epoch: request.expectedEpoch ?? epoch,
        relations: request.relations.map((relation, index) =>
          index === 0
            ? { requestKey: relation.requestKey, status: "loading" }
            : index === 1
            ? {
                columns: [],
                coverage: "partial",
                relationEntityId: `relation-${relation.requestKey}`,
                requestKey: relation.requestKey,
                status: "ready",
              }
            : {
                code: "unavailable",
                requestKey: relation.requestKey,
                retry: "next-request",
                status: "failed",
              }
        ),
      };
    });
    const uncached = [
      reference("loading"),
      reference("partial"),
      reference("failed"),
    ];
    const first = await owner.request(input(uncached)).result;
    const second = await owner.request(input(uncached)).result;

    expect(first).toMatchObject({
      relations: [
        { requestKey: "failed", status: "loading" },
        { requestKey: "loading", status: "ready" },
        { requestKey: "partial", status: "failed" },
      ],
      status: "usable",
    });
    expect(second.status).toBe("usable");
    expect(calls).toBe(2);
  });

  it("aborts and settles cancelled work exactly once", async () => {
    const work = deferred<unknown>();
    const signals: AbortSignal[] = [];
    const { owner } = setup((_request, signal_) => {
      signals.push(signal_);
      return work.promise;
    });
    const ticket = owner.request(input());
    ticket.cancel();
    ticket.cancel();

    await expect(ticket.result).resolves.toEqual({ status: "cancelled" });
    expect(signals[0]?.aborted).toBe(true);
    work.resolve({});
    await Promise.resolve();
    await expect(ticket.result).resolves.toEqual({ status: "cancelled" });
  });

  it("ignores a provider rejection after its consumer is cancelled", async () => {
    const work = deferred<unknown>();
    const { owner } = setup(() => work.promise);
    const ticket = owner.request(input());

    ticket.cancel();
    work.reject(new Error("late rejection"));
    await expect(ticket.result).resolves.toEqual({ status: "cancelled" });
    await Promise.resolve();
  });

  it("supersedes prior owner work but isolates other owners", async () => {
    const pending: Array<ReturnType<typeof deferred<unknown>>> = [];
    const { coordinator, owner } = setup(() => {
      const work = deferred<unknown>();
      pending.push(work);
      return work.promise;
    });
    const otherResult = coordinator.prepareOwner({
      dialectId: "duckdb",
      scope: "scope",
    });
    if (otherResult.status !== "prepared") {
      throw new Error("Expected second owner");
    }
    const first = owner.request(input());
    const other = otherResult.owner.request(input());
    const second = owner.request(input([reference("next")]));

    await expect(first.result).resolves.toEqual({
      status: "superseded",
    });
    let otherSettled = false;
    void other.result.then(() => {
      otherSettled = true;
    });
    await Promise.resolve();
    expect(otherSettled).toBe(false);
    second.cancel();
    other.cancel();
  });

  it("preserves the newest request across reentrant abort handlers", async () => {
    const signals: AbortSignal[] = [];
    let owner: ReturnType<typeof setup>["owner"] | null = null;
    const reentrant: {
      ticket:
        | ReturnType<ReturnType<typeof setup>["owner"]["request"]>
        | null;
    } = { ticket: null };
    const configured = setup((_request, signal) => {
      signals.push(signal);
      if (signals.length === 1) {
        signal.addEventListener("abort", () => {
          reentrant.ticket =
            owner?.request(input([reference("reentrant")])) ?? null;
        }, { once: true });
      }
      return new Promise(() => undefined);
    });
    owner = configured.owner;
    const first = owner.request(input([reference("first")]));
    const interrupted = owner.request(input([reference("interrupted")]));

    await expect(first.result).resolves.toEqual({
      status: "superseded",
    });
    await expect(interrupted.result).resolves.toEqual({
      status: "superseded",
    });
    expect(signals).toHaveLength(2);
    expect(signals.map((signal) => signal.aborted)).toEqual([
      true,
      false,
    ]);

    const newest = owner.request(input([reference("newest")]));
    expect(signals.map((signal) => signal.aborted)).toEqual([
      true,
      true,
      false,
    ]);
    await expect(reentrant.ticket?.result).resolves.toEqual({
      status: "superseded",
    });
    newest.cancel();
  });

  it.each(["owner", "coordinator"] as const)(
    "does not resurrect work after reentrant %s disposal",
    async (target) => {
      const signals: AbortSignal[] = [];
      let dispose = (): void => {};
      const configured = setup((_request, signal) => {
        signals.push(signal);
        if (signals.length === 1) {
          signal.addEventListener("abort", () => dispose(), {
            once: true,
          });
        }
        return new Promise(() => undefined);
      });
      dispose = target === "owner"
        ? configured.owner.dispose
        : configured.coordinator.dispose;
      const first = configured.owner.request(
        input([reference("first")]),
      );
      const interrupted = configured.owner.request(
        input([reference("interrupted")]),
      );

      await expect(first.result).resolves.toEqual({
        reason: "disposed",
        status: "unavailable",
      });
      await expect(interrupted.result).resolves.toEqual({
        reason: "disposed",
        status: "unavailable",
      });
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
    },
  );

  it("disposes owners and coordinator with prompt aborts", async () => {
    const signals: AbortSignal[] = [];
    const { coordinator, owner } = setup((_request, signal) => {
      signals.push(signal);
      return new Promise(() => undefined);
    });
    const ownerTicket = owner.request(input());
    owner.dispose();
    owner.dispose();
    await expect(ownerTicket.result).resolves.toEqual({
      reason: "disposed",
      status: "unavailable",
    });
    expect(signals[0]?.aborted).toBe(true);
    await expect(owner.request(input()).result).resolves.toMatchObject({
      reason: "disposed",
    });

    const next = coordinator.prepareOwner({
      dialectId: "duckdb",
      scope: "scope",
    });
    if (next.status !== "prepared") throw new Error("Expected owner");
    const coordinatorTicket = next.owner.request(input());
    coordinator.dispose();
    coordinator.dispose();
    await expect(coordinatorTicket.result).resolves.toEqual({
      reason: "disposed",
      status: "unavailable",
    });
    expect(coordinator.prepareOwner({
      dialectId: "duckdb",
      scope: "scope",
    })).toEqual({ reason: "disposed", status: "unavailable" });
  });

  it.each([
    {
      expected: "provider-failed",
      load: () => {
        throw new Error("sync");
      },
    },
    {
      expected: "provider-failed",
      load: () => Promise.reject(new Error("async")),
    },
    {
      expected: "malformed-response",
      load: () => ({ epoch, relations: [] }),
    },
  ])("contains provider failure as $expected", async ({ expected, load }) => {
    const { owner } = setup(load);
    await expect(owner.request(input()).result).resolves.toEqual({
      reason: expected,
      status: "unavailable",
    });
  });

  it("settles a revoked-array provider response as malformed", async () => {
    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    const { owner } = setup(() => ({
      epoch,
      relations: revoked.proxy,
    }));
    await expect(owner.request(input()).result).resolves.toEqual({
      reason: "malformed-response",
      status: "unavailable",
    });
  });

  it("contains an unexpected decoder exception", async () => {
    const integerCheck = vi.spyOn(Number, "isSafeInteger");
    const { owner } = setup((request) => {
      integerCheck.mockImplementationOnce(() => {
        throw new Error("decoder");
      });
      return ready(request);
    });
    await expect(owner.request(input()).result).resolves.toEqual({
      reason: "malformed-response",
      status: "unavailable",
    });
    integerCheck.mockRestore();
  });

  it("bounds cache entries with deterministic LRU eviction", async () => {
    const calls = new Map<string, number>();
    const { owner } = setup((request) => {
      const key = request.relations[0]?.path[0]?.value ?? "";
      calls.set(key, (calls.get(key) ?? 0) + 1);
      return ready(request);
    }, 2);
    await owner.request(input([reference("a")])).result;
    await owner.request(input([reference("b")])).result;
    await owner.request(input([reference("a")])).result;
    await owner.request(input([reference("c")])).result;
    await owner.request(input([reference("b")])).result;

    expect(calls).toEqual(new Map([
      ["a", 1],
      ["b", 2],
      ["c", 1],
    ]));
  });

  it("rejects invalid providers, options, owners, and requests", async () => {
    expect(createSqlColumnCatalogBatchCoordinator(null)).toEqual({
      reason: "invalid-provider",
      status: "unavailable",
    });
    expect(createSqlColumnCatalogBatchCoordinator({
      provider: {},
    })).toEqual({
      reason: "invalid-provider",
      status: "unavailable",
    });
    expect(createSqlColumnCatalogBatchCoordinator({
      maxCacheEntries: 0,
      provider: { id: "catalog", loadColumns: vi.fn() },
    })).toEqual({
      reason: "invalid-options",
      status: "unavailable",
    });
    const created = createSqlColumnCatalogBatchCoordinator({
      provider: { id: "catalog", loadColumns: vi.fn() },
    });
    if (created.status !== "created") throw new Error("Expected coordinator");
    expect(created.coordinator.prepareOwner({
      dialectId: "",
      scope: "scope",
    })).toMatchObject({ status: "unavailable" });
    const prepared = created.coordinator.prepareOwner({
      dialectId: "duckdb",
      scope: "scope",
    });
    if (prepared.status !== "prepared") throw new Error("Expected owner");
    const invalidTicket = prepared.owner.request({
      expectedEpoch: epoch,
      relations: [],
      searchPaths: [],
    });
    invalidTicket.cancel();
    await expect(invalidTicket.result).resolves.toEqual({
      reason: "invalid-request",
      status: "unavailable",
    });
  });

  it("contains hostile and missing request properties", async () => {
    const { owner } = setup(vi.fn());
    const hostile = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error("hostile descriptor");
      },
    });

    const hostileTicket = Reflect.apply(
      owner.request,
      undefined,
      [hostile],
    );
    await expect(hostileTicket.result).resolves.toEqual({
      reason: "invalid-request",
      status: "unavailable",
    });
    const missingTicket = Reflect.apply(
      owner.request,
      undefined,
      [{
        expectedEpoch: epoch,
        relations: [reference("users")],
      }],
    );
    await expect(missingTicket.result).resolves.toEqual({
      reason: "invalid-request",
      status: "unavailable",
    });
  });
});
