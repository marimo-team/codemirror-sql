import { describe, expect, it, vi } from "vitest";
import {
  captureSqlRelationCatalogProvider,
  type CapturedSqlRelationCatalogProvider,
  type SqlCatalogBoundaryResult,
} from "../relation-catalog-boundary.js";
import {
  createSqlCatalogSearchWorkCoordinator,
  MAX_CATALOG_ACTIVE_SEARCH_WORK,
  MAX_CATALOG_QUEUED_SEARCH_WORK,
  type SqlCatalogSearchDeadlineScheduler,
  type SqlCatalogSearchWorkCoordinator,
  type SqlCatalogSearchWorkInput,
  type SqlCatalogSearchWorkOptions,
  type SqlCatalogSearchWorkOwner,
  type SqlCatalogSearchWorkOutcome,
  type SqlCatalogSearchWorkTicket,
} from "../relation-catalog-search-work.js";
import {
  DUCKDB_SQL_RELATION_DIALECT,
  POSTGRESQL_SQL_RELATION_DIALECT,
  type SqlRelationDialectRuntime,
} from "../relation-dialect.js";
import type { SqlCatalogSearchRequest } from "../relation-completion-types.js";
import type { SqlIdentifierComponent } from "../types.js";

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: Value) => void;
}

interface ProviderCall {
  readonly request: SqlCatalogSearchRequest;
  readonly settlement: Deferred<unknown>;
  readonly signal: AbortSignal;
}

interface ProviderHarness {
  readonly calls: ProviderCall[];
  readonly captured: CapturedSqlRelationCatalogProvider;
}

interface ScheduledDeadline {
  active: boolean;
  readonly callback: (this: void) => void;
  readonly deadline: number;
}

class ManualDeadlineScheduler
  implements SqlCatalogSearchDeadlineScheduler
{
  nowValue = 0;
  readonly tasks = new Map<number, ScheduledDeadline>();
  private nextHandle = 1;

  readonly clearTimeout = (handle: unknown): void => {
    if (typeof handle !== "number") return;
    const task = this.tasks.get(handle);
    if (task) task.active = false;
  };

  readonly now = (): number => this.nowValue;

  readonly setTimeout = (
    callback: (this: void) => void,
    delayMs: number,
  ): unknown => {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.tasks.set(handle, {
      active: true,
      callback,
      deadline: this.nowValue + delayMs,
    });
    return handle;
  };

  advanceBy(deltaMs: number): void {
    this.nowValue += deltaMs;
    this.flushDue();
  }

  flushDue(): void {
    for (;;) {
      const due = [...this.tasks.entries()]
        .filter(
          ([, task]) =>
            task.active && task.deadline <= this.nowValue,
        )
        .sort(
          ([leftHandle, left], [rightHandle, right]) =>
            left.deadline - right.deadline ||
            leftHandle - rightHandle,
        )[0];
      if (!due) return;
      const [handle, task] = due;
      task.active = false;
      this.tasks.delete(handle);
      Reflect.apply(task.callback, undefined, []);
    }
  }

  get pendingCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.active) count += 1;
    }
    return count;
  }
}

function accepted<Value>(
  result: SqlCatalogBoundaryResult<Value>,
): Value {
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") {
    throw new Error(`Expected accepted, received ${result.reason}`);
  }
  return result.value;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

function epoch(
  generation = 1,
  token = `snapshot-${generation}`,
): {
  readonly generation: number;
  readonly token: string;
} {
  return { generation, token };
}

function component(
  value: string,
  quoted = false,
): SqlIdentifierComponent {
  return { quoted, value };
}

function pathComponent(
  role: "relation" | "schema",
  value: string,
) {
  return { quoted: false, role, value };
}

function readyResponse(generation = 1) {
  return {
    coverage: { kind: "complete" },
    epoch: epoch(generation),
    relations: [
      {
        canonicalPath: [
          pathComponent("schema", "public"),
          pathComponent("relation", `users-${generation}`),
        ],
        completionPathStart: 0,
        entityId: `relation-${generation}`,
        matchQuality: "exact",
        relationKind: "table",
      },
    ],
    status: "ready",
  };
}

function input(
  prefix = "us",
  overrides: Partial<SqlCatalogSearchWorkInput> = {},
): SqlCatalogSearchWorkInput {
  return {
    continuationToken: null,
    limit: 20,
    prefix: component(prefix),
    qualifier: [component("public")],
    searchPaths: [[component("public")]],
    ...overrides,
  };
}

function providerHarness(): ProviderHarness {
  const calls: ProviderCall[] = [];
  const captured = accepted(
    captureSqlRelationCatalogProvider({
      id: "catalog",
      search(
        request: SqlCatalogSearchRequest,
        signal: AbortSignal,
      ) {
        const settlement = deferred<unknown>();
        calls.push({ request, settlement, signal });
        return settlement.promise;
      },
    }),
  );
  return { calls, captured };
}

function coordinator(
  captured: CapturedSqlRelationCatalogProvider,
  options: SqlCatalogSearchWorkOptions = {},
): SqlCatalogSearchWorkCoordinator {
  const created = createSqlCatalogSearchWorkCoordinator(
    captured,
    options,
  );
  expect(created.status).toBe("created");
  if (created.status !== "created") {
    throw new Error(
      `Expected coordinator, received ${created.reason}`,
    );
  }
  return created.coordinator;
}

function owner(
  service: SqlCatalogSearchWorkCoordinator,
  scope = "connection:primary",
  dialect: SqlRelationDialectRuntime =
    POSTGRESQL_SQL_RELATION_DIALECT,
): SqlCatalogSearchWorkOwner {
  const prepared = service.prepareOwner(
    scope,
    dialect,
    {
      prepareCatalogChange: () => () => {},
    },
  );
  expect(prepared.status).toBe("prepared");
  if (prepared.status !== "prepared") {
    throw new Error(`Expected owner, received ${prepared.reason}`);
  }
  expect(prepared.owner.activate()).toEqual({ status: "active" });
  return prepared.owner;
}

async function settled(
  ticket: Promise<SqlCatalogSearchWorkOutcome>,
): Promise<SqlCatalogSearchWorkOutcome> {
  await Promise.resolve();
  return ticket;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("catalog search coordinator construction", () => {
  it("rejects unauthenticated providers and malformed scheduler options", () => {
    expect(
      Reflect.apply(
        createSqlCatalogSearchWorkCoordinator,
        undefined,
        [
          {
            id: "catalog",
            search: () => readyResponse(),
          },
        ],
      ),
    ).toEqual({
      reason: "invalid-provider",
      status: "unavailable",
    });

    const provider = providerHarness();
    for (const options of [
      { executionDeadlineMs: 9 },
      { executionDeadlineMs: 5_001 },
      { queueDeadlineMs: 9 },
      { queueDeadlineMs: 2_001 },
      {
        deadlineScheduler: {
          clearTimeout() {},
          now: 1,
          setTimeout() {
            return 1;
          },
        },
      },
    ]) {
      expect(
        Reflect.apply(
          createSqlCatalogSearchWorkCoordinator,
          undefined,
          [provider.captured, options],
        ),
      ).toEqual({
        reason: "invalid-options",
        status: "unavailable",
      });
    }
  });

  it("freezes public handles, tickets, outcomes, and decoded responses", async () => {
    const provider = providerHarness();
    const service = coordinator(provider.captured);
    const session = owner(service);
    const ticket = session.request(input());
    expect(Object.isFrozen(service)).toBe(true);
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(ticket)).toBe(true);

    provider.calls[0]?.settlement.resolve(readyResponse());
    const outcome = await ticket.result;
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(outcome.status).toBe("usable");
    if (outcome.status === "usable") {
      expect(Object.isFrozen(outcome.response)).toBe(true);
    }
  });

  it("does not expire default-scheduled work synchronously", async () => {
    let calls = 0;
    const captured = accepted(
      captureSqlRelationCatalogProvider({
        id: "catalog",
        search() {
          calls += 1;
          return readyResponse();
        },
      }),
    );
    const service = coordinator(captured);
    const ticket = owner(service).request(input());

    expect(calls).toBe(1);
    await expect(ticket.result).resolves.toMatchObject({
      status: "usable",
    });
  });

  it("rejects structurally copied dialect runtimes without invoking them", () => {
    const provider = providerHarness();
    const service = coordinator(provider.captured);
    const result = service.prepareOwner(
      "scope",
      { ...POSTGRESQL_SQL_RELATION_DIALECT },
      { prepareCatalogChange: () => () => {} },
    );
    expect(result).toEqual({
      reason: "invalid-dialect",
      status: "unavailable",
    });
  });

  it("returns closed tickets for inactive, malformed, and disposed owners", async () => {
    const provider = providerHarness();
    const service = coordinator(provider.captured);
    const prepared = service.prepareOwner(
      "scope",
      POSTGRESQL_SQL_RELATION_DIALECT,
      { prepareCatalogChange: () => () => {} },
    );
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") {
      throw new Error("Expected prepared owner");
    }

    await expect(
      prepared.owner.request(input()).result,
    ).resolves.toEqual({
      reason: "inactive",
      status: "unavailable",
    });
    expect(prepared.owner.activate()).toEqual({
      status: "active",
    });
    await expect(
      prepared.owner.request(input("bad", { limit: 0 })).result,
    ).resolves.toEqual({
      reason: "invalid-request",
      status: "unavailable",
    });
    prepared.owner.dispose();
    await expect(
      prepared.owner.request(input()).result,
    ).resolves.toEqual({
      reason: "disposed",
      status: "unavailable",
    });
    expect(provider.calls).toHaveLength(0);
  });
});

describe("catalog search structural sharing and admission", () => {
  it("shares exactly equal copied requests while preserving structural distinctions", async () => {
    const provider = providerHarness();
    const service = coordinator(provider.captured);
    const first = owner(service);
    const second = owner(service);
    const sharedInput = input();
    const firstTicket = first.request(sharedInput);
    const secondTicket = second.request({
      ...sharedInput,
      prefix: { ...sharedInput.prefix },
      qualifier: sharedInput.qualifier.map((part) => ({
        ...part,
      })),
      searchPaths: sharedInput.searchPaths.map((path) =>
        path.map((part) => ({ ...part })),
      ),
    });

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.request).not.toBe(sharedInput);
    expect(Object.isFrozen(provider.calls[0]?.request)).toBe(true);

    const distinct = [
      input("us", { continuationToken: "page-2" }),
      input("us", { limit: 19 }),
      input("US"),
      input("us", { prefix: component("us", true) }),
      input("us", { qualifier: [component("other")] }),
      input("us", { searchPaths: [[component("other")]] }),
    ];
    for (const candidate of distinct) {
      owner(service).request(candidate);
    }
    owner(
      service,
      "connection:primary",
      DUCKDB_SQL_RELATION_DIALECT,
    ).request(input());
    expect(provider.calls).toHaveLength(2 + distinct.length);
    expect(provider.calls.at(-1)?.request.dialectId).toBe(
      "duckdb",
    );

    provider.calls[0]?.settlement.resolve(readyResponse());
    await expect(firstTicket.result).resolves.toMatchObject({
      status: "usable",
    });
    await expect(secondTicket.result).resolves.toMatchObject({
      status: "usable",
    });
    service.dispose();
  });

  it("admits a same-key join at full queue capacity but rejects a new key", async () => {
    const scheduler = new ManualDeadlineScheduler();
    const provider = providerHarness();
    const service = coordinator(provider.captured, {
      deadlineScheduler: scheduler,
    });
    const tickets = Array.from(
      {
        length:
          MAX_CATALOG_ACTIVE_SEARCH_WORK +
          MAX_CATALOG_QUEUED_SEARCH_WORK,
      },
      (_, index) =>
        owner(service).request(input(`key-${index}`)),
    );
    expect(provider.calls).toHaveLength(
      MAX_CATALOG_ACTIVE_SEARCH_WORK,
    );

    const queuedIndex = MAX_CATALOG_ACTIVE_SEARCH_WORK;
    const joined = owner(service).request(
      input(`key-${queuedIndex}`),
    );
    const rejected = owner(service).request(input("overflow"));
    await expect(rejected.result).resolves.toEqual({
      reason: "overloaded",
      status: "unavailable",
    });

    provider.calls[0]?.settlement.resolve(readyResponse());
    await Promise.resolve();
    await Promise.resolve();
    expect(provider.calls.at(-1)?.request.prefix.value).toBe(
      `key-${queuedIndex}`,
    );
    provider.calls.at(-1)?.settlement.resolve(readyResponse());
    await expect(tickets[queuedIndex]?.result).resolves.toMatchObject(
      { status: "usable" },
    );
    await expect(joined.result).resolves.toMatchObject({
      status: "usable",
    });
    service.dispose();
  });

  it("promotes queued work FIFO without recursively invoking providers", async () => {
    let depth = 0;
    let maximumDepth = 0;
    const order: string[] = [];
    let service!: SqlCatalogSearchWorkCoordinator;
    const reentrantTickets: SqlCatalogSearchWorkTicket[] = [];
    const captured = accepted(
      captureSqlRelationCatalogProvider({
        id: "catalog",
        search(request: SqlCatalogSearchRequest) {
          depth += 1;
          maximumDepth = Math.max(maximumDepth, depth);
          order.push(request.prefix.value);
          if (
            request.prefix.value ===
              `key-${MAX_CATALOG_ACTIVE_SEARCH_WORK}` &&
            reentrantTickets.length === 0
          ) {
            reentrantTickets.push(
              owner(service).request(
                input("key-reentrant"),
              ),
            );
          }
          depth -= 1;
          return Promise.resolve(readyResponse());
        },
      }),
    );
    service = coordinator(captured);
    const tickets = Array.from(
      { length: MAX_CATALOG_ACTIVE_SEARCH_WORK + 3 },
      (_, index) => owner(service).request(input(`key-${index}`)),
    );
    await Promise.all(tickets.map((ticket) => ticket.result));
    const reentrantTicket = reentrantTickets[0];
    if (!reentrantTicket) {
      throw new Error("Expected reentrant queued ticket");
    }
    await reentrantTicket.result;

    expect(order).toEqual(
      [
        ...Array.from(
          { length: MAX_CATALOG_ACTIVE_SEARCH_WORK + 3 },
          (_, index) => `key-${index}`,
        ),
        "key-reentrant",
      ],
    );
    expect(maximumDepth).toBe(1);
  });
});

describe("catalog search ownership and active-slot lifecycle", () => {
  it("keeps cancellation idempotent before and after settlement", async () => {
    const provider = providerHarness();
    const service = coordinator(provider.captured);
    const cancelled = owner(service).request(input("cancelled"));
    cancelled.cancel();
    cancelled.cancel();
    await expect(cancelled.result).resolves.toEqual({
      status: "cancelled",
    });

    const completed = owner(service).request(input("completed"));
    provider.calls.at(-1)?.settlement.resolve(readyResponse());
    await expect(completed.result).resolves.toMatchObject({
      status: "usable",
    });
    completed.cancel();
    completed.cancel();
    service.dispose();
  });

  it("transfers same-key latest-wins ownership before detaching the old consumer", async () => {
    const provider = providerHarness();
    const service = coordinator(provider.captured);
    const session = owner(service);
    const first = session.request(input("same"));
    const signal = provider.calls[0]?.signal;
    const replacement = session.request(input("same"));

    await expect(first.result).resolves.toEqual({
      status: "superseded",
    });
    expect(provider.calls).toHaveLength(1);
    expect(signal?.aborted).toBe(false);

    provider.calls[0]?.settlement.resolve(readyResponse());
    await expect(replacement.result).resolves.toMatchObject({
      status: "usable",
    });
  });

  it("aborts only after the last shared owner leaves and retains the active slot until settlement", async () => {
    const provider = providerHarness();
    const service = coordinator(provider.captured);
    const firstOwner = owner(service);
    const secondOwner = owner(service);
    const first = firstOwner.request(input("shared"));
    const second = secondOwner.request(input("shared"));
    const filling = Array.from(
      { length: MAX_CATALOG_ACTIVE_SEARCH_WORK - 1 },
      (_, index) => owner(service).request(input(`active-${index}`)),
    );
    const queued = owner(service).request(input("queued"));
    const sharedCall = provider.calls[0];

    first.cancel();
    await expect(first.result).resolves.toEqual({
      status: "cancelled",
    });
    expect(sharedCall?.signal.aborted).toBe(false);

    second.cancel();
    await expect(second.result).resolves.toEqual({
      status: "cancelled",
    });
    expect(sharedCall?.signal.aborted).toBe(true);
    expect(provider.calls).toHaveLength(
      MAX_CATALOG_ACTIVE_SEARCH_WORK,
    );

    sharedCall?.settlement.resolve(readyResponse());
    await Promise.resolve();
    await Promise.resolve();
    expect(provider.calls).toHaveLength(
      MAX_CATALOG_ACTIVE_SEARCH_WORK + 1,
    );
    expect(provider.calls.at(-1)?.request.prefix.value).toBe(
      "queued",
    );

    for (const call of provider.calls.slice(1)) {
      call.settlement.resolve(readyResponse());
    }
    await Promise.all([
      ...filling.map((ticket) => settled(ticket.result)),
      settled(queued.result),
    ]);
  });

  it("supersedes a different key and aborts the abandoned work exactly once", async () => {
    const provider = providerHarness();
    const service = coordinator(provider.captured);
    const session = owner(service);
    const first = session.request(input("first"));
    let aborts = 0;
    provider.calls[0]?.signal.addEventListener("abort", () => {
      aborts += 1;
    });
    const replacement = session.request(input("replacement"));

    await expect(first.result).resolves.toEqual({
      status: "superseded",
    });
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]?.signal.aborted).toBe(true);
    expect(aborts).toBe(1);

    provider.calls[0]?.settlement.reject(
      new Error("late abandoned rejection"),
    );
    provider.calls[1]?.settlement.resolve(readyResponse());
    await expect(replacement.result).resolves.toMatchObject({
      status: "usable",
    });
    await flushMicrotasks();
    expect(aborts).toBe(1);
  });

  it("keeps one deterministic current owner when an abandoned abort reenters with a third key", async () => {
    const scheduler = new ManualDeadlineScheduler();
    const provider = providerHarness();
    const service = coordinator(provider.captured, {
      deadlineScheduler: scheduler,
    });
    const session = owner(service);
    const abandoned = session.request(input("abandoned"));
    const reentrantTickets: SqlCatalogSearchWorkTicket[] = [];
    provider.calls[0]?.signal.addEventListener("abort", () => {
      reentrantTickets.push(
        session.request(input("reentrant")),
      );
    });

    const displaced = session.request(input("displaced"));
    await expect(abandoned.result).resolves.toEqual({
      status: "superseded",
    });
    await expect(displaced.result).resolves.toEqual({
      status: "superseded",
    });
    expect(
      provider.calls.map((call) => call.request.prefix.value),
    ).toEqual(["abandoned", "reentrant"]);
    expect(provider.calls[0]?.signal.aborted).toBe(true);

    const reentrantTicket = reentrantTickets[0];
    if (!reentrantTicket) {
      throw new Error("Expected abort-listener reentrant request");
    }
    provider.calls[0]?.settlement.reject(
      new Error("late abandoned rejection"),
    );
    provider.calls[1]?.settlement.resolve(readyResponse());
    await expect(reentrantTicket.result).resolves.toMatchObject({
      status: "usable",
    });
    displaced.cancel();
    abandoned.cancel();
    await flushMicrotasks();
    expect(provider.calls).toHaveLength(2);
    expect(scheduler.pendingCount).toBe(0);
  });
});

describe("catalog search absolute deadlines", () => {
  it("does not retain or invoke work when a deadline expires while it is armed", async () => {
    const cases = [
      {
        expectedReason: "execution-timeout",
        nowValues: [0, 0, 0, 0, 20],
      },
    ] as const;
    for (const testCase of cases) {
      let index = 0;
      let providerCalls = 0;
      const activeHandles = new Set<number>();
      let nextHandle = 0;
      const scheduler: SqlCatalogSearchDeadlineScheduler = {
        clearTimeout(handle) {
          if (typeof handle === "number") {
            activeHandles.delete(handle);
          }
        },
        now() {
          const value = testCase.nowValues[index];
          index += 1;
          return (
            value ??
            testCase.nowValues.at(-1) ??
            Number.NaN
          );
        },
        setTimeout() {
          nextHandle += 1;
          activeHandles.add(nextHandle);
          return nextHandle;
        },
      };
      const captured = accepted(
        captureSqlRelationCatalogProvider({
          id: "catalog",
          search() {
            providerCalls += 1;
            return readyResponse();
          },
        }),
      );
      const service = coordinator(captured, {
        deadlineScheduler: scheduler,
        executionDeadlineMs: 20,
        queueDeadlineMs: 10,
        synchronousBudgetMs: 5,
      });
      const ticket = owner(service).request(input());

      await expect(ticket.result).resolves.toEqual({
        reason: testCase.expectedReason,
        status: "unavailable",
      });
      expect(providerCalls).toBe(1);
      expect(activeHandles.size).toBe(0);
      service.dispose();
    }
  });

  it("fails closed when adding a duration would overflow the clock", async () => {
    let providerCalls = 0;
    let timerCalls = 0;
    const captured = accepted(
      captureSqlRelationCatalogProvider({
        id: "catalog",
        search() {
          providerCalls += 1;
          return readyResponse();
        },
      }),
    );
    const service = coordinator(captured, {
      deadlineScheduler: {
        clearTimeout() {},
        now: () => Number.MAX_VALUE,
        setTimeout() {
          timerCalls += 1;
          return 1;
        },
      },
    });
    const ticket = owner(service).request(input());

    await expect(ticket.result).resolves.toEqual({
      reason: "execution-timeout",
      status: "unavailable",
    });
    expect(providerCalls).toBe(0);
    expect(timerCalls).toBe(0);
    service.dispose();
  });

  it("does not let a late joiner extend the first enqueue deadline", async () => {
    const scheduler = new ManualDeadlineScheduler();
    const provider = providerHarness();
    const service = coordinator(provider.captured, {
      deadlineScheduler: scheduler,
      executionDeadlineMs: 20,
      queueDeadlineMs: 10,
      synchronousBudgetMs: 5,
    });
    Array.from(
      { length: MAX_CATALOG_ACTIVE_SEARCH_WORK },
      (_, index) => owner(service).request(input(`active-${index}`)),
    );
    const first = owner(service).request(input("queued"));
    scheduler.advanceBy(9);
    const joined = owner(service).request(input("queued"));
    scheduler.advanceBy(1);

    await expect(first.result).resolves.toEqual({
      reason: "queue-timeout",
      status: "unavailable",
    });
    await expect(joined.result).resolves.toEqual({
      reason: "queue-timeout",
      status: "unavailable",
    });
    expect(provider.calls).toHaveLength(
      MAX_CATALOG_ACTIVE_SEARCH_WORK,
    );
    service.dispose();
  });

  it("checks the absolute queue deadline during promotion when the timer is delayed", async () => {
    const scheduler = new ManualDeadlineScheduler();
    const provider = providerHarness();
    const service = coordinator(provider.captured, {
      deadlineScheduler: scheduler,
      executionDeadlineMs: 20,
      queueDeadlineMs: 10,
      synchronousBudgetMs: 5,
    });
    Array.from(
      { length: MAX_CATALOG_ACTIVE_SEARCH_WORK },
      (_, index) => owner(service).request(input(`active-${index}`)),
    );
    const queued = owner(service).request(input("queued"));

    scheduler.nowValue = 10;
    provider.calls[0]?.settlement.resolve(readyResponse());
    await flushMicrotasks();

    await expect(queued.result).resolves.toEqual({
      reason: "queue-timeout",
      status: "unavailable",
    });
    expect(provider.calls).toHaveLength(
      MAX_CATALOG_ACTIVE_SEARCH_WORK,
    );
    service.dispose();
  });

  it("does not let a late joiner or delayed timer publish at the execution deadline", async () => {
    const scheduler = new ManualDeadlineScheduler();
    const provider = providerHarness();
    const service = coordinator(provider.captured, {
      deadlineScheduler: scheduler,
      executionDeadlineMs: 20,
      queueDeadlineMs: 10,
      synchronousBudgetMs: 5,
    });
    const first = owner(service).request(input("active"));
    scheduler.nowValue = 19;
    const joined = owner(service).request(input("active"));
    scheduler.nowValue = 20;
    provider.calls[0]?.settlement.resolve(readyResponse());
    await flushMicrotasks();

    await expect(first.result).resolves.toEqual({
      reason: "execution-timeout",
      status: "unavailable",
    });
    await expect(joined.result).resolves.toEqual({
      reason: "execution-timeout",
      status: "unavailable",
    });
    expect(provider.calls[0]?.signal.aborted).toBe(true);
    expect(scheduler.pendingCount).toBe(0);
  });

  it("discards a synchronous provider return that exceeds the observation budget", async () => {
    const scheduler = new ManualDeadlineScheduler();
    let signal: AbortSignal | undefined;
    const captured = accepted(
      captureSqlRelationCatalogProvider({
        id: "catalog",
        search(
          _request: SqlCatalogSearchRequest,
          nextSignal: AbortSignal,
        ) {
          signal = nextSignal;
          scheduler.nowValue += 6;
          return readyResponse();
        },
      }),
    );
    const service = coordinator(captured, {
      deadlineScheduler: scheduler,
      executionDeadlineMs: 20,
      queueDeadlineMs: 10,
      synchronousBudgetMs: 5,
    });
    const ticket = owner(service).request(input());

    await expect(ticket.result).resolves.toEqual({
      reason: "execution-timeout",
      status: "unavailable",
    });
    expect(signal?.aborted).toBe(true);
    expect(scheduler.pendingCount).toBe(0);
  });

  it("does not let synchronously repeated early timer callbacks violate the absolute deadline", async () => {
    let timerCallback: (() => void) | undefined;
    let providerCalls = 0;
    let synchronousFirings = 0;
    const delays: number[] = [];
    const scheduler: SqlCatalogSearchDeadlineScheduler = {
      clearTimeout() {},
      now: () => 0,
      setTimeout(callback, delayMs) {
        delays.push(delayMs);
        timerCallback = callback;
        if (
          delayMs === 20 &&
          synchronousFirings < 1
        ) {
          synchronousFirings += 1;
          callback();
          callback();
        }
        return 1;
      },
    };
    const captured = accepted(
      captureSqlRelationCatalogProvider({
        id: "catalog",
        search() {
          providerCalls += 1;
          return readyResponse();
        },
      }),
    );
    const service = coordinator(captured, {
      deadlineScheduler: scheduler,
      executionDeadlineMs: 20,
      queueDeadlineMs: 10,
      synchronousBudgetMs: 5,
    });
    const ticket = owner(service).request(input());

    expect({
      delays,
      providerCalls,
      synchronousFirings,
    }).toEqual({
      delays: [20, 20],
      providerCalls: 1,
      synchronousFirings: 1,
    });
    await expect(ticket.result).resolves.toMatchObject({
      status: "usable",
    });
    expect(() => timerCallback?.()).not.toThrow();
  });
});

describe("catalog provider failures and hostile settlement", () => {
  it("maps synchronous throws, rejections, and malformed responses to closed outcomes", async () => {
    const values: readonly {
      readonly expected: SqlCatalogSearchWorkOutcome;
      readonly search: () => unknown;
    }[] = [
      {
        expected: {
          reason: "provider-failed",
          status: "unavailable",
        },
        search: () => {
          throw new Error("synchronous provider failure");
        },
      },
      {
        expected: {
          reason: "provider-failed",
          status: "unavailable",
        },
        search: () =>
          Promise.reject(new Error("asynchronous provider failure")),
      },
      {
        expected: {
          reason: "malformed-response",
          status: "unavailable",
        },
        search: () => ({ status: "ready" }),
      },
    ];

    for (const { expected, search } of values) {
      const captured = accepted(
        captureSqlRelationCatalogProvider({
          id: "catalog",
          search,
        }),
      );
      const service = coordinator(captured);
      await expect(
        owner(service).request(input()).result,
      ).resolves.toEqual(expected);
      service.dispose();
    }
  });

  it("settles once when a hostile thenable resolves and rejects repeatedly", async () => {
    let calls = 0;
    const thenable: Record<string, unknown> = {};
    Object.defineProperty(thenable, ["th", "en"].join(""), {
      value(
        resolve: (value: unknown) => void,
        reject: (reason: unknown) => void,
      ) {
        calls += 1;
        resolve(readyResponse());
        reject(new Error("late rejection"));
        resolve({ status: "invalid" });
      },
    });
    const captured = accepted(
      captureSqlRelationCatalogProvider({
        id: "catalog",
        search() {
          return thenable;
        },
      }),
    );
    const service = coordinator(captured, {
      deadlineScheduler: new ManualDeadlineScheduler(),
    });
    const ticket = owner(service).request(input());

    await expect(ticket.result).resolves.toMatchObject({
      status: "usable",
    });
    expect(calls).toBe(1);
  });

  it("drains a rejected native promise without reading poisoned own then or catch properties", async () => {
    let thenReads = 0;
    let catchReads = 0;
    const thenProperty = ["th", "en"].join("");
    const captured = accepted(
      captureSqlRelationCatalogProvider({
        id: "catalog",
        search() {
          const poisoned = Promise.reject(
            new Error("poisoned provider rejection"),
          );
          Object.defineProperty(poisoned, thenProperty, {
            get() {
              thenReads += 1;
              throw new Error("poisoned own then");
            },
          });
          Object.defineProperty(poisoned, "catch", {
            get() {
              catchReads += 1;
              throw new Error("poisoned own catch");
            },
          });
          return poisoned;
        },
      }),
    );
    const service = coordinator(captured, {
      deadlineScheduler: new ManualDeadlineScheduler(),
    });

    await expect(
      owner(service).request(input()).result,
    ).resolves.toEqual({
      reason: "provider-failed",
      status: "unavailable",
    });
    expect(thenReads).toBe(0);
    expect(catchReads).toBe(0);
  });

  it("handles a throwing then getter that reenters with a replacement", async () => {
    let service!: SqlCatalogSearchWorkCoordinator;
    let session!: SqlCatalogSearchWorkOwner;
    const reentrantTickets: SqlCatalogSearchWorkTicket[] = [];
    let thenReads = 0;
    let calls = 0;
    const thenable: Record<string, unknown> = {};
    Object.defineProperty(thenable, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        reentrantTickets.push(
          session.request(input("replacement")),
        );
        throw new Error("hostile provider then getter");
      },
    });
    const captured = accepted(
      captureSqlRelationCatalogProvider({
        id: "catalog",
        search() {
          calls += 1;
          return calls === 1 ? thenable : readyResponse();
        },
      }),
    );
    service = coordinator(captured, {
      deadlineScheduler: new ManualDeadlineScheduler(),
    });
    session = owner(service);
    const first = session.request(input("hostile"));

    await expect(first.result).resolves.toEqual({
      status: "superseded",
    });
    const replacement = reentrantTickets[0];
    if (!replacement) {
      throw new Error("Expected then-getter replacement");
    }
    await expect(replacement.result).resolves.toMatchObject({
      status: "usable",
    });
    expect(thenReads).toBe(1);
    expect(calls).toBe(2);
  });

  it("invokes the captured provider receiver-free with immutable input and a work-owned signal", async () => {
    let observedThisIsUndefined = false;
    let requestFrozen = false;
    let observedSignal: AbortSignal | undefined;
    const captured = accepted(
      captureSqlRelationCatalogProvider({
        id: "catalog",
        search: function (
          this: void,
          request: SqlCatalogSearchRequest,
          signal: AbortSignal,
        ) {
          observedThisIsUndefined = this === undefined;
          requestFrozen = Object.isFrozen(request);
          observedSignal = signal;
          return readyResponse();
        },
      }),
    );
    const service = coordinator(captured);
    const ticket = owner(service).request(input());

    await expect(ticket.result).resolves.toMatchObject({
      status: "usable",
    });
    expect(observedThisIsUndefined).toBe(true);
    expect(requestFrozen).toBe(true);
    expect(observedSignal).toBeInstanceOf(AbortSignal);
  });
});

describe("catalog search epoch authority and isolation", () => {
  it("keeps shared response authority when the first owner is disposed", async () => {
    const provider = providerHarness();
    const service = coordinator(provider.captured);
    const firstOwner = owner(service);
    const remainingOwner = owner(service);
    const first = firstOwner.request(input("shared"));
    const remaining = remainingOwner.request(input("shared"));

    firstOwner.dispose();
    await expect(first.result).resolves.toEqual({
      status: "cancelled",
    });
    expect(provider.calls[0]?.signal.aborted).toBe(false);

    provider.calls[0]?.settlement.resolve(readyResponse());
    await expect(remaining.result).resolves.toMatchObject({
      status: "usable",
    });
  });

  it("rekeys same-scope unobserved work after a baseline without crossing scope boundaries", async () => {
    const provider = providerHarness();
    const service = coordinator(provider.captured);
    const baseline = owner(service, "scope-a").request(
      input("baseline"),
    );
    const pendingInScope = owner(service, "scope-a").request(
      input("pending"),
    );
    const pendingInOtherScope = owner(service, "scope-b").request(
      input("pending"),
    );

    expect(provider.calls).toHaveLength(3);
    expect(
      provider.calls.map((call) => call.request.expectedEpoch),
    ).toEqual([null, null, null]);

    provider.calls[0]?.settlement.resolve(readyResponse(7));
    await expect(baseline.result).resolves.toMatchObject({
      observation: "baseline",
      status: "usable",
    });

    const joinedInScope = owner(service, "scope-a").request(
      input("pending"),
    );
    const joinedInOtherScope = owner(service, "scope-b").request(
      input("pending"),
    );
    expect(provider.calls).toHaveLength(3);

    provider.calls[1]?.settlement.resolve(readyResponse(7));
    const [originalScopeResult, joinedScopeResult] =
      await Promise.all([
        pendingInScope.result,
        joinedInScope.result,
      ]);
    expect(originalScopeResult).toMatchObject({
      observation: "equal",
      status: "usable",
    });
    expect(joinedScopeResult).toBe(originalScopeResult);

    provider.calls[2]?.settlement.resolve(readyResponse(11));
    const [originalOtherResult, joinedOtherResult] =
      await Promise.all([
        pendingInOtherScope.result,
        joinedInOtherScope.result,
      ]);
    expect(originalOtherResult).toMatchObject({
      observation: "baseline",
      status: "usable",
    });
    expect(joinedOtherResult).toBe(originalOtherResult);
  });

  it("retires same-scope work before abort and revision dispatch while isolating another scope", async () => {
    const listeners = new Map<
      string,
      (event: unknown) => void
    >();
    const calls: ProviderCall[] = [];
    const events: string[] = [];
    const captured = accepted(
      captureSqlRelationCatalogProvider({
        id: "catalog",
        search(
          request: SqlCatalogSearchRequest,
          signal: AbortSignal,
        ) {
          const settlement = deferred<unknown>();
          signal.addEventListener("abort", () => {
            events.push(`abort-${request.scope}`);
          });
          calls.push({ request, settlement, signal });
          return settlement.promise;
        },
        subscribe(
          scope: string,
          listener: (event: unknown) => void,
        ) {
          listeners.set(scope, listener);
          return () => undefined;
        },
      }),
    );
    const service = coordinator(captured);
    const prepareOwner = (scope: string) => {
      const prepared = service.prepareOwner(
        scope,
        POSTGRESQL_SQL_RELATION_DIALECT,
        {
          prepareCatalogChange: () => {
            events.push(`prepare-${scope}`);
            return () => {
              events.push(`dispatch-${scope}`);
            };
          },
        },
      );
      if (prepared.status !== "prepared") {
        throw new Error("Expected prepared owner");
      }
      expect(prepared.owner.activate()).toEqual({
        status: "active",
      });
      return prepared.owner;
    };
    const firstScope = prepareOwner("scope-a").request(input("a"));
    const otherScope = prepareOwner("scope-b").request(input("b"));

    listeners.get("scope-a")?.({ epoch: epoch(1) });
    await expect(firstScope.result).resolves.toEqual({
      status: "superseded",
    });
    expect(events).toEqual([
      "prepare-scope-a",
      "abort-scope-a",
      "dispatch-scope-a",
    ]);
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(calls[1]?.signal.aborted).toBe(false);

    calls[1]?.settlement.resolve(readyResponse());
    await expect(otherScope.result).resolves.toMatchObject({
      status: "usable",
    });
  });

  it("supersedes reentrant work when its retiring membership makes the next capture fail", async () => {
    const listener: {
      current: ((event: unknown) => void) | null;
    } = { current: null };
    const calls: ProviderCall[] = [];
    const captured = accepted(
      captureSqlRelationCatalogProvider({
        id: "catalog",
        search(
          request: SqlCatalogSearchRequest,
          signal: AbortSignal,
        ) {
          const settlement = deferred<unknown>();
          calls.push({ request, settlement, signal });
          return settlement.promise;
        },
        subscribe(
          _scope: string,
          onInvalidation: (event: unknown) => void,
        ) {
          listener.current = onInvalidation;
          return () => undefined;
        },
      }),
    );
    const service = coordinator(captured);
    let session: SqlCatalogSearchWorkOwner | null = null;
    const reentrant: {
      current: SqlCatalogSearchWorkTicket | null;
    } = { current: null };
    const prepared = service.prepareOwner(
      "scope",
      POSTGRESQL_SQL_RELATION_DIALECT,
      {
        prepareCatalogChange: () => {
          reentrant.current =
            session?.request(input("reentrant")) ?? null;
          return null;
        },
      },
    );
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") {
      throw new Error("Expected prepared owner");
    }
    session = prepared.owner;
    expect(session.activate()).toEqual({ status: "active" });
    const initial = session.request(input("initial"));

    listener.current?.({ epoch: epoch(1) });
    await expect(initial.result).resolves.toEqual({
      status: "superseded",
    });
    expect(reentrant.current).not.toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(calls[1]?.signal.aborted).toBe(false);

    const afterRetirement = session.request(input("after"));
    await expect(afterRetirement.result).resolves.toEqual({
      reason: "disposed",
      status: "unavailable",
    });
    if (!reentrant.current) {
      throw new Error("Expected reentrant request");
    }
    await expect(reentrant.current.result).resolves.toEqual({
      status: "superseded",
    });
    expect(calls[1]?.signal.aborted).toBe(true);
  });

  it("makes a higher response self-supersede and retire other same-scope work only", async () => {
    const provider = providerHarness();
    const service = coordinator(provider.captured);
    const baselineOwner = owner(service, "scope-a");
    const baseline = baselineOwner.request(input("baseline"));
    provider.calls[0]?.settlement.resolve(readyResponse(1));
    await expect(baseline.result).resolves.toMatchObject({
      status: "usable",
    });

    const producing = owner(service, "scope-a").request(
      input("producing"),
    );
    const sameScope = owner(service, "scope-a").request(
      input("same-scope"),
    );
    const otherScope = owner(service, "scope-b").request(
      input("other-scope"),
    );
    const producingCall = provider.calls.find(
      (call) => call.request.prefix.value === "producing",
    );
    const sameScopeCall = provider.calls.find(
      (call) => call.request.prefix.value === "same-scope",
    );
    const otherScopeCall = provider.calls.find(
      (call) => call.request.prefix.value === "other-scope",
    );

    producingCall?.settlement.resolve(readyResponse(2));
    await expect(producing.result).resolves.toEqual({
      status: "superseded",
    });
    await expect(sameScope.result).resolves.toEqual({
      status: "superseded",
    });
    expect(producingCall?.signal.aborted).toBe(false);
    expect(sameScopeCall?.signal.aborted).toBe(true);
    expect(otherScopeCall?.signal.aborted).toBe(false);

    otherScopeCall?.settlement.resolve(readyResponse());
    await expect(otherScope.result).resolves.toMatchObject({
      status: "usable",
    });
  });

  it("fails closed for stale, token-conflicting, and malformed response epochs", async () => {
    const provider = providerHarness();
    const service = coordinator(provider.captured);
    const session = owner(service);
    const baseline = session.request(input("baseline"));
    provider.calls[0]?.settlement.resolve(readyResponse(2));
    await expect(baseline.result).resolves.toMatchObject({
      status: "usable",
    });

    const stale = session.request(input("stale"));
    provider.calls[1]?.settlement.resolve(readyResponse(1));
    await expect(stale.result).resolves.toEqual({
      status: "superseded",
    });

    const conflicting = session.request(input("conflicting"));
    provider.calls[2]?.settlement.resolve({
      ...readyResponse(2),
      epoch: epoch(2, "conflicting-token"),
    });
    await expect(conflicting.result).resolves.toEqual({
      status: "superseded",
    });

    const malformed = session.request(input("malformed"));
    provider.calls[3]?.settlement.resolve({
      ...readyResponse(3),
      epoch: { generation: -1, token: "invalid" },
    });
    await expect(malformed.result).resolves.toEqual({
      reason: "malformed-response",
      status: "unavailable",
    });
  });
});

describe("catalog search disposal and late settlement", () => {
  it("settles active and queued owners before abort and drains late rejection", async () => {
    const scheduler = new ManualDeadlineScheduler();
    const provider = providerHarness();
    const service = coordinator(provider.captured, {
      deadlineScheduler: scheduler,
      executionDeadlineMs: 20,
      queueDeadlineMs: 10,
      synchronousBudgetMs: 5,
    });
    const tickets = Array.from(
      { length: MAX_CATALOG_ACTIVE_SEARCH_WORK + 1 },
      (_, index) => owner(service).request(input(`key-${index}`)),
    );
    const events: string[] = [];
    let reentrantStatus: string | undefined;
    provider.calls[0]?.signal.addEventListener("abort", () => {
      events.push("abort");
      reentrantStatus = service.prepareOwner(
        "reentrant",
        POSTGRESQL_SQL_RELATION_DIALECT,
        {
          prepareCatalogChange: () => () => {},
        },
      ).status;
      void tickets[0]?.result.then(() => {
        events.push("settled-before-abort");
      });
    });

    service.dispose();
    await expect(tickets.at(-1)?.result).resolves.toEqual({
      reason: "disposed",
      status: "unavailable",
    });
    await Promise.all(
      tickets.map((ticket) =>
        expect(ticket.result).resolves.toEqual({
          reason: "disposed",
          status: "unavailable",
        }),
      ),
    );
    expect(provider.calls).toHaveLength(
      MAX_CATALOG_ACTIVE_SEARCH_WORK,
    );
    expect(
      provider.calls.every((call) => call.signal.aborted),
    ).toBe(true);
    expect(reentrantStatus).toBe("unavailable");
    expect(scheduler.pendingCount).toBe(0);

    for (const call of provider.calls) {
      call.settlement.reject(new Error("late rejection"));
    }
    await flushMicrotasks();
    expect(events).toContain("abort");
  });

  it("propagates epoch cleanup quarantine across scopes into search disposal", async () => {
    for (const cleanupFailure of [
      "non-undefined",
      "throw",
    ] as const) {
      const calls: ProviderCall[] = [];
      const captured = accepted(
        captureSqlRelationCatalogProvider({
          id: `catalog-${cleanupFailure}`,
          search(
            request: SqlCatalogSearchRequest,
            signal: AbortSignal,
          ) {
            const settlement = deferred<unknown>();
            calls.push({ request, settlement, signal });
            return settlement.promise;
          },
          subscribe(scope: string) {
            if (scope !== "scope-a") {
              return () => undefined;
            }
            if (cleanupFailure === "throw") {
              return () => {
                throw new Error("cleanup failed");
              };
            }
            return () => 1;
          },
        }),
      );
      const service = coordinator(captured);
      const scopeA = owner(service, "scope-a");
      const scopeB = owner(service, "scope-b");
      const active = scopeB.request(input("scope-b-active"));
      expect(calls).toHaveLength(1);

      scopeA.dispose();
      await expect(active.result).resolves.toEqual({
        reason: "disposed",
        status: "unavailable",
      });
      expect(calls[0]?.signal.aborted).toBe(true);
      await expect(
        scopeB.request(input("after-quarantine")).result,
      ).resolves.toEqual({
        reason: "disposed",
        status: "unavailable",
      });
      expect(calls).toHaveLength(1);
      calls[0]?.settlement.reject(
        new Error("late quarantined rejection"),
      );
      await flushMicrotasks();
    }
  });
});

describe("catalog search defensive lifecycle coverage", () => {
  it("returns disposed when the request clock disposes its coordinator", async () => {
    let disposeOnNow = false;
    let service: SqlCatalogSearchWorkCoordinator | undefined;
    const provider = providerHarness();
    service = coordinator(provider.captured, {
      deadlineScheduler: {
        clearTimeout() {},
        now() {
          if (disposeOnNow) service?.dispose();
          return 0;
        },
        setTimeout() {
          return 1;
        },
      },
    });
    const session = owner(service);
    disposeOnNow = true;

    await expect(session.request(input()).result).resolves.toEqual({
      reason: "disposed",
      status: "unavailable",
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("contains disposal while installing a queued deadline", async () => {
    let service: SqlCatalogSearchWorkCoordinator | undefined;
    const provider = providerHarness();
    service = coordinator(provider.captured, {
      deadlineScheduler: {
        clearTimeout() {},
        now: () => 0,
        setTimeout(_callback, delayMs) {
          if (delayMs === 100) service?.dispose();
          return 1;
        },
      },
      executionDeadlineMs: 20,
      queueDeadlineMs: 100,
    });
    const tickets = Array.from(
      { length: MAX_CATALOG_ACTIVE_SEARCH_WORK + 1 },
      (_, index) =>
        owner(service).request(input(`work-${index}`)),
    );

    await Promise.all(
      tickets.map((ticket) =>
        expect(ticket.result).resolves.toEqual({
          reason: "disposed",
          status: "unavailable",
        }),
      ),
    );
    expect(provider.calls).toHaveLength(
      MAX_CATALOG_ACTIVE_SEARCH_WORK,
    );
  });

  it("rejects throwing, non-finite, negative, and malformed scheduler configuration", () => {
    const provider = providerHarness();
    const validMethods = {
      clearTimeout() {},
      now: () => 0,
      setTimeout() {
        return 1;
      },
    };
    const candidates: unknown[] = [
      {
        get queueDeadlineMs() {
          throw new Error("hostile options");
        },
      },
      {
        deadlineScheduler: {
          ...validMethods,
          now() {
            throw new Error("hostile clock");
          },
        },
      },
      {
        deadlineScheduler: {
          ...validMethods,
          now: () => Number.NaN,
        },
      },
      {
        deadlineScheduler: {
          ...validMethods,
          now: () => -1,
        },
      },
      {
        deadlineScheduler: {
          ...validMethods,
          now: () => "now",
        },
      },
      {
        synchronousBudgetMs: 0,
      },
      {
        synchronousBudgetMs: 51,
      },
      {
        deadlineScheduler: {
          clearTimeout: 1,
          now: () => 0,
          setTimeout() {
            return 1;
          },
        },
      },
      {
        deadlineScheduler: {
          clearTimeout() {},
          now: () => 0,
          setTimeout: 1,
        },
      },
    ];

    for (const candidate of candidates) {
      expect(
        Reflect.apply(
          createSqlCatalogSearchWorkCoordinator,
          undefined,
          [provider.captured, candidate],
        ),
      ).toEqual({
        reason: "invalid-options",
        status: "unavailable",
      });
    }
  });

  it("fails closed when a live monotonic clock throws, becomes non-finite, or moves backward", async () => {
    const provider = providerHarness();
    const laterValues: Array<() => number> = [
      () => {
        throw new Error("clock failed");
      },
      () => Number.NaN,
      () => -1,
    ];

    for (const later of laterValues) {
      let reads = 0;
      const service = coordinator(provider.captured, {
        deadlineScheduler: {
          clearTimeout() {},
          now() {
            reads += 1;
            return reads === 1 ? 0 : later();
          },
          setTimeout() {
            return 1;
          },
        },
      });
      await expect(
        owner(service).request(input(`clock-${reads}`)).result,
      ).resolves.toEqual({
        reason: "execution-timeout",
        status: "unavailable",
      });
      service.dispose();
    }
    expect(provider.calls).toHaveLength(0);
  });

  it("contains throwing timer installation and cleanup", async () => {
    const provider = providerHarness();
    const installationFailure = coordinator(
      provider.captured,
      {
        deadlineScheduler: {
          clearTimeout() {},
          now: () => 0,
          setTimeout() {
            throw new Error("timer install failed");
          },
        },
      },
    );
    await expect(
      owner(installationFailure).request(
        input("install-failure"),
      ).result,
    ).resolves.toEqual({
      reason: "execution-timeout",
      status: "unavailable",
    });

    const cleanupProvider = accepted(
      captureSqlRelationCatalogProvider({
        id: "cleanup",
        search() {
          return readyResponse();
        },
      }),
    );
    const cleanupFailure = coordinator(cleanupProvider, {
      deadlineScheduler: {
        clearTimeout() {
          throw new Error("timer cleanup failed");
        },
        now: () => 0,
        setTimeout() {
          return 1;
        },
      },
    });
    await expect(
      owner(cleanupFailure).request(input("cleanup-failure"))
        .result,
    ).resolves.toMatchObject({ status: "usable" });
    expect(() => cleanupFailure.dispose()).not.toThrow();
  });

  it("bounds a scheduler that fires every deadline synchronously without advancing time", async () => {
    let timerCalls = 0;
    let providerCalls = 0;
    const captured = accepted(
      captureSqlRelationCatalogProvider({
        id: "catalog",
        search() {
          providerCalls += 1;
          return readyResponse();
        },
      }),
    );
    const service = coordinator(captured, {
      deadlineScheduler: {
        clearTimeout() {},
        now: () => 0,
        setTimeout(callback) {
          timerCalls += 1;
          callback();
          return timerCalls;
        },
      },
    });
    const ticket = owner(service).request(input());

    await expect(ticket.result).resolves.toEqual({
      reason: "execution-timeout",
      status: "unavailable",
    });
    expect(timerCalls).toBe(257);
    expect(providerCalls).toBe(0);
  });

  it("rearms an early asynchronous deadline and ignores its obsolete generation", async () => {
    const callbacks: Array<() => void> = [];
    const scheduler: SqlCatalogSearchDeadlineScheduler = {
      clearTimeout() {},
      now: () => 0,
      setTimeout(callback) {
        callbacks.push(callback);
        if (callbacks.length === 1) callback();
        return callbacks.length;
      },
    };
    const provider = providerHarness();
    const service = coordinator(provider.captured, {
      deadlineScheduler: scheduler,
    });
    const ticket = owner(service).request(input());

    expect(callbacks.length).toBeGreaterThanOrEqual(2);
    expect(() => callbacks[0]?.()).not.toThrow();
    expect(() => callbacks[1]?.()).not.toThrow();
    ticket.cancel();
    await expect(ticket.result).resolves.toEqual({
      status: "cancelled",
    });
    provider.calls[0]?.settlement.reject(
      new Error("late rejection"),
    );
    await flushMicrotasks();
  });

  it("expires safely when execution scheduling fires synchronously before provider invocation", async () => {
    let providerCalls = 0;
    let timerCalls = 0;
    let nowValue = 0;
    const captured = accepted(
      captureSqlRelationCatalogProvider({
        id: "catalog",
        search() {
          providerCalls += 1;
          return readyResponse();
        },
      }),
    );
    const service = coordinator(captured, {
      deadlineScheduler: {
        clearTimeout() {},
        now: () => nowValue,
        setTimeout(callback, delayMs) {
          timerCalls += 1;
          if (delayMs === 250) {
            nowValue = 250;
            callback();
          }
          return timerCalls;
        },
      },
    });
    const ticket = owner(service).request(input());

    await expect(ticket.result).resolves.toEqual({
      reason: "execution-timeout",
      status: "unavailable",
    });
    expect(providerCalls).toBe(0);
    expect(timerCalls).toBe(1);
  });

  it("stays inert when clearing the execution timer reentrantly disposes the coordinator", async () => {
    let service: SqlCatalogSearchWorkCoordinator | undefined;
    let providerCalls = 0;
    let clearCalls = 0;
    const captured = accepted(
      captureSqlRelationCatalogProvider({
        id: "catalog",
        search() {
          providerCalls += 1;
          return readyResponse();
        },
      }),
    );
    service = coordinator(captured, {
      deadlineScheduler: {
        clearTimeout() {
          clearCalls += 1;
          if (clearCalls === 1) service?.dispose();
        },
        now: () => 0,
        setTimeout() {
          return clearCalls + 1;
        },
      },
    });
    const ticket = owner(service).request(input());

    await expect(ticket.result).resolves.toMatchObject({
      status: "usable",
    });
    expect(providerCalls).toBe(1);
    expect(clearCalls).toBeGreaterThan(0);
  });

  it("validates scope and dialect runtime without leaking malformed UTF-16 into memberships", () => {
    const service = coordinator(providerHarness().captured);
    const invalidTexts: unknown[] = [
      null,
      "",
      "a".repeat(513),
      "nul\u0000value",
      "\ud800",
      "\ud800x",
      "\udc00",
    ];
    const target = { prepareCatalogChange: () => () => {} };

    for (const scope of invalidTexts) {
      expect(
        Reflect.apply(service.prepareOwner, undefined, [
          scope,
          POSTGRESQL_SQL_RELATION_DIALECT,
          target,
        ]),
      ).toEqual({
        reason: "invalid-scope",
        status: "unavailable",
      });
    }
    for (const dialect of invalidTexts) {
      expect(
        Reflect.apply(service.prepareOwner, undefined, [
          "scope",
          dialect,
          target,
        ]),
      ).toEqual({
        reason: "invalid-dialect",
        status: "unavailable",
      });
    }
    const validAstral = service.prepareOwner(
      "scope-\ud83d\ude80",
      POSTGRESQL_SQL_RELATION_DIALECT,
      target,
    );
    expect(validAstral.status).toBe("prepared");
    if (validAstral.status === "prepared") {
      validAstral.owner.dispose();
      validAstral.owner.dispose();
    }
    service.dispose();
    service.dispose();
  });

  it("maps hostile and capacity-rejected revision targets to closed owner failures", () => {
    const service = coordinator(providerHarness().captured);
    const throwingTarget = Object.defineProperty(
      {},
      "prepareCatalogChange",
      {
        get() {
          throw new Error("hostile target");
        },
      },
    );
    expect(
      Reflect.apply(service.prepareOwner, undefined, [
        "scope",
        POSTGRESQL_SQL_RELATION_DIALECT,
        throwingTarget,
      ]),
    ).toEqual({
      reason: "invalid-target",
      status: "unavailable",
    });

    const owners = Array.from({ length: 1_024 }, (_, index) =>
      service.prepareOwner(
        `bounded-scope-${index}`,
        POSTGRESQL_SQL_RELATION_DIALECT,
        { prepareCatalogChange: () => () => {} },
      ),
    );
    expect(owners.every((result) => result.status === "prepared"))
      .toBe(true);
    expect(
      service.prepareOwner(
        "bounded-scope-overflow",
        POSTGRESQL_SQL_RELATION_DIALECT,
        { prepareCatalogChange: () => () => {} },
      ),
    ).toEqual({
      reason: "membership-capacity",
      status: "unavailable",
    });
    service.dispose();
  });

  it("maps a throwing request getter to invalid-request after superseding current work", async () => {
    const provider = providerHarness();
    const service = coordinator(provider.captured);
    const session = owner(service);
    const previous = session.request(input("previous"));
    const hostile = Object.defineProperty(
      {},
      "continuationToken",
      {
        enumerable: true,
        get() {
          throw new Error("hostile request");
        },
      },
    );

    const rejected = Reflect.apply(
      session.request,
      undefined,
      [hostile],
    );
    await expect(rejected.result).resolves.toEqual({
      reason: "invalid-request",
      status: "unavailable",
    });
    await expect(previous.result).resolves.toEqual({
      status: "superseded",
    });
    expect(provider.calls[0]?.signal.aborted).toBe(true);
  });

  it("lets a request getter reenter with a newer request without the older frame overwriting it", async () => {
    const provider = providerHarness();
    const service = coordinator(provider.captured);
    const session = owner(service);
    let nested: SqlCatalogSearchWorkTicket | undefined;
    const outerInput = {
      get continuationToken() {
        nested ??= session.request(input("nested"));
        return null;
      },
      limit: 20,
      prefix: component("outer"),
      qualifier: [component("public")],
      searchPaths: [[component("public")]],
    };

    const outer = session.request(outerInput);
    await expect(outer.result).resolves.toEqual({
      status: "superseded",
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.request.prefix.value).toBe("nested");
    provider.calls[0]?.settlement.resolve(readyResponse());
    await expect(nested?.result).resolves.toMatchObject({
      status: "usable",
    });
  });

  it("fails closed when request decoding reentrantly disposes the coordinator", async () => {
    const provider = providerHarness();
    const service = coordinator(provider.captured);
    const session = owner(service);
    const hostile = Object.defineProperty(
      input("disposing-request"),
      "continuationToken",
      {
        enumerable: true,
        get() {
          service.dispose();
          return null;
        },
      },
    );

    await expect(
      session.request(hostile).result,
    ).resolves.toEqual({
      reason: "disposed",
      status: "unavailable",
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("revalidates active response work after the clock reenters with a replacement", async () => {
    const provider = providerHarness();
    let onNow: (() => void) | undefined;
    let reading = false;
    const service = coordinator(provider.captured, {
      deadlineScheduler: {
        clearTimeout() {},
        now() {
          if (!reading && onNow) {
            reading = true;
            const callback = onNow;
            onNow = undefined;
            callback();
            reading = false;
          }
          return 0;
        },
        setTimeout() {
          return 1;
        },
      },
    });
    const session = owner(service);
    const stale = session.request(input("clock-stale"));
    let replacement: SqlCatalogSearchWorkTicket | undefined;
    onNow = () => {
      replacement = session.request(input("clock-current"));
    };

    provider.calls[0]?.settlement.resolve(readyResponse());
    await expect(stale.result).resolves.toEqual({
      status: "superseded",
    });
    expect(provider.calls).toHaveLength(2);
    provider.calls[1]?.settlement.resolve(readyResponse());
    await expect(replacement?.result).resolves.toMatchObject({
      status: "usable",
    });
  });

  it("stops provider-result handling when the clock reentrantly disposes the service", async () => {
    const provider = providerHarness();
    let onNow: (() => void) | undefined;
    let reading = false;
    const service = coordinator(provider.captured, {
      deadlineScheduler: {
        clearTimeout() {},
        now() {
          if (!reading && onNow) {
            reading = true;
            const callback = onNow;
            onNow = undefined;
            callback();
            reading = false;
          }
          return 0;
        },
        setTimeout() {
          return 1;
        },
      },
    });
    const ticket = owner(service).request(input("clock-dispose"));
    onNow = () => service.dispose();

    provider.calls[0]?.settlement.resolve(readyResponse());
    await expect(ticket.result).resolves.toEqual({
      reason: "disposed",
      status: "unavailable",
    });
    await flushMicrotasks();
  });

  it("revalidates queued promotion after the clock reenters with newer work", async () => {
    const provider = providerHarness();
    let onNow: (() => void) | undefined;
    let reading = false;
    let skippedNowCallbacks = 0;
    const service = coordinator(provider.captured, {
      deadlineScheduler: {
        clearTimeout() {},
        now() {
          if (!reading && onNow) {
            if (skippedNowCallbacks > 0) {
              skippedNowCallbacks -= 1;
              return 0;
            }
            reading = true;
            const callback = onNow;
            onNow = undefined;
            callback();
            reading = false;
          }
          return 0;
        },
        setTimeout() {
          return 1;
        },
      },
    });
    const active = Array.from(
      { length: MAX_CATALOG_ACTIVE_SEARCH_WORK },
      (_, index) =>
        owner(service).request(input(`active-${index}`)),
    );
    const queuedOwner = owner(service);
    const staleQueued = queuedOwner.request(
      input("queued-stale"),
    );
    let replacement: SqlCatalogSearchWorkTicket | undefined;
    onNow = () => {
      replacement = queuedOwner.request(
        input("queued-current"),
      );
    };
    skippedNowCallbacks = 1;

    provider.calls[0]?.settlement.reject(
      new Error("release active slot"),
    );
    await expect(staleQueued.result).resolves.toEqual({
      status: "superseded",
    });
    await flushMicrotasks();
    expect(
      provider.calls.some(
        (call) =>
          call.request.prefix.value === "queued-current",
      ),
    ).toBe(true);
    const replacementCall = provider.calls.find(
      (call) =>
        call.request.prefix.value === "queued-current",
    );
    replacementCall?.settlement.resolve(readyResponse());
    await expect(replacement?.result).resolves.toMatchObject({
      status: "usable",
    });
    for (const ticket of active.slice(1)) ticket.cancel();
    service.dispose();
  });

  it("does not let a clock-reentrant request overwrite the newer request", async () => {
    const provider = providerHarness();
    let onNow: (() => void) | undefined;
    let reading = false;
    const service = coordinator(provider.captured, {
      deadlineScheduler: {
        clearTimeout() {},
        now() {
          if (!reading && onNow) {
            reading = true;
            const callback = onNow;
            onNow = undefined;
            callback();
            reading = false;
          }
          return 0;
        },
        setTimeout() {
          return 1;
        },
      },
    });
    const session = owner(service);
    let current: SqlCatalogSearchWorkTicket | undefined;
    onNow = () => {
      current = session.request(input("clock-newer"));
    };

    const obsolete = session.request(input("clock-older"));
    await expect(obsolete.result).resolves.toEqual({
      status: "superseded",
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.request.prefix.value).toBe(
      "clock-newer",
    );
    provider.calls[0]?.settlement.resolve(readyResponse());
    await expect(current?.result).resolves.toMatchObject({
      status: "usable",
    });
  });

  it("ignores stale queue and execution callbacks after successful settlement", async () => {
    const callbacks: Array<() => void> = [];
    const captured = accepted(
      captureSqlRelationCatalogProvider({
        id: "catalog",
        search() {
          return readyResponse();
        },
      }),
    );
    const service = coordinator(captured, {
      deadlineScheduler: {
        clearTimeout() {},
        now: () => 0,
        setTimeout(callback) {
          callbacks.push(callback);
          return callbacks.length;
        },
      },
    });
    const ticket = owner(service).request(input("stale-timers"));
    await expect(ticket.result).resolves.toMatchObject({
      status: "usable",
    });

    expect(callbacks).toHaveLength(1);
    expect(() => {
      callbacks[0]?.();
      callbacks[0]?.();
    }).not.toThrow();
  });

  it("fails closed when the execution deadline cannot advance a large monotonic clock", async () => {
    const base = 2 ** 57;
    let reads = 0;
    let providerCalls = 0;
    const captured = accepted(
      captureSqlRelationCatalogProvider({
        id: "catalog",
        search() {
          providerCalls += 1;
          return readyResponse();
        },
      }),
    );
    const service = coordinator(captured, {
      deadlineScheduler: {
        clearTimeout() {},
        now() {
          reads += 1;
          return reads < 4 ? base : base + 1_952;
        },
        setTimeout() {
          return 1;
        },
      },
      executionDeadlineMs: 10,
      queueDeadlineMs: 2_000,
    });
    const ticket = owner(service).request(input("large-clock"));

    await expect(ticket.result).resolves.toEqual({
      reason: "execution-timeout",
      status: "unavailable",
    });
    expect(providerCalls).toBe(0);
  });

  it("fails closed when a promoted queued search cannot allocate an execution deadline", async () => {
    const scheduler = new ManualDeadlineScheduler();
    const provider = providerHarness();
    const service = coordinator(provider.captured, {
      deadlineScheduler: scheduler,
      executionDeadlineMs: 10,
      queueDeadlineMs: 2_000,
    });
    Array.from(
      { length: MAX_CATALOG_ACTIVE_SEARCH_WORK },
      (_, index) => owner(service).request(input(`active-${index}`)),
    );
    scheduler.nowValue = 2 ** 57 - 1_024;
    const queued = owner(service).request(input("large-promoted"));
    scheduler.nowValue = 2 ** 57;
    provider.calls[0]?.settlement.reject(
      new Error("release active slot"),
    );

    await expect(queued.result).resolves.toEqual({
      reason: "execution-timeout",
      status: "unavailable",
    });
    expect(
      provider.calls.some(
        (call) =>
          call.request.prefix.value === "large-promoted",
      ),
    ).toBe(false);
    service.dispose();
  });

  it("clears a queued deadline when execution expiry fires synchronously during promotion", async () => {
    let nowValue = 0;
    let fireExecution = false;
    const callbacks = new Map<number, () => void>();
    let nextHandle = 0;
    const provider = providerHarness();
    const service = coordinator(provider.captured, {
      deadlineScheduler: {
        clearTimeout(handle) {
          if (typeof handle === "number") {
            callbacks.delete(handle);
          }
        },
        now: () => nowValue,
        setTimeout(callback, delayMs) {
          nextHandle += 1;
          callbacks.set(nextHandle, callback);
          if (fireExecution && delayMs === 20) {
            nowValue += 20;
            callback();
          }
          return nextHandle;
        },
      },
      executionDeadlineMs: 20,
      queueDeadlineMs: 100,
    });
    Array.from(
      { length: MAX_CATALOG_ACTIVE_SEARCH_WORK },
      (_, index) => owner(service).request(input(`active-${index}`)),
    );
    const queued = owner(service).request(
      input("synchronous-promotion-expiry"),
    );
    fireExecution = true;
    provider.calls[0]?.settlement.reject(
      new Error("release active slot"),
    );

    await expect(queued.result).resolves.toEqual({
      reason: "execution-timeout",
      status: "unavailable",
    });
    expect(
      provider.calls.some(
        (call) =>
          call.request.prefix.value ===
          "synchronous-promotion-expiry",
      ),
    ).toBe(false);
    service.dispose();
  });

  it("contains disposal reentrancy while a promoted search clears its queue deadline", async () => {
    const scheduler = new ManualDeadlineScheduler();
    const provider = providerHarness();
    const service = coordinator(provider.captured, {
      deadlineScheduler: {
        clearTimeout(handle) {
          scheduler.clearTimeout(handle);
          if (skipClears > 0) {
            skipClears -= 1;
          } else {
            service.dispose();
          }
        },
        now: scheduler.now,
        setTimeout: scheduler.setTimeout,
      },
      executionDeadlineMs: 20,
      queueDeadlineMs: 100,
    });
    let skipClears = Number.MAX_SAFE_INTEGER;
    Array.from(
      { length: MAX_CATALOG_ACTIVE_SEARCH_WORK },
      (_, index) => owner(service).request(input(`active-${index}`)),
    );
    const queued = owner(service).request(
      input("dispose-during-promotion"),
    );
    skipClears = 1;
    provider.calls[0]?.settlement.reject(
      new Error("release active slot"),
    );

    await expect(queued.result).resolves.toEqual({
      reason: "disposed",
      status: "unavailable",
    });
    expect(
      provider.calls.some(
        (call) =>
          call.request.prefix.value ===
          "dispose-during-promotion",
      ),
    ).toBe(false);
  });

  it("cancels reentrantly during response decoding and ignores the now-obsolete result", async () => {
    const provider = providerHarness();
    const service = coordinator(provider.captured);
    const session = owner(service);
    const ticket = session.request(input("decode-cancel"));
    const response = new Proxy(readyResponse(), {
      ownKeys(target) {
        ticket.cancel();
        return Reflect.ownKeys(target);
      },
    });

    provider.calls[0]?.settlement.resolve(response);
    await expect(ticket.result).resolves.toEqual({
      status: "cancelled",
    });
    await flushMicrotasks();
    expect(provider.calls[0]?.signal.aborted).toBe(false);
  });

  it("keeps a response that reenters with a replacement from publishing stale epoch evidence", async () => {
    const provider = providerHarness();
    const service = coordinator(provider.captured);
    const session = owner(service);
    const stale = session.request(input("stale"));
    let replacement: SqlCatalogSearchWorkTicket | undefined;
    const response = new Proxy(readyResponse(), {
      ownKeys(target) {
        replacement ??= session.request(input("replacement"));
        return Reflect.ownKeys(target);
      },
    });

    provider.calls[0]?.settlement.resolve(response);
    await expect(stale.result).resolves.toEqual({
      status: "superseded",
    });
    expect(replacement).toBeDefined();
    expect(provider.calls).toHaveLength(2);
    provider.calls[1]?.settlement.resolve(readyResponse());
    await expect(replacement?.result).resolves.toMatchObject({
      observation: "baseline",
      status: "usable",
    });
  });

  it("does not conflate paths with different component counts", async () => {
    const provider = providerHarness();
    const service = coordinator(provider.captured);
    const tickets = [
      owner(service).request(
        input("path-length", {
          qualifier: [component("public")],
        }),
      ),
      owner(service).request(
        input("path-length", {
          qualifier: [
            component("catalog"),
            component("public"),
          ],
        }),
      ),
      owner(service).request(
        input("path-length", {
          searchPaths: [[component("public")]],
        }),
      ),
      owner(service).request(
        input("path-length", {
          searchPaths: [
            [
              component("catalog"),
              component("public"),
            ],
          ],
        }),
      ),
    ];

    expect(provider.calls).toHaveLength(3);
    service.dispose();
    await Promise.all(
      tickets.map((ticket) =>
        expect(ticket.result).resolves.toEqual({
          reason: "disposed",
          status: "unavailable",
        }),
      ),
    );
  });

  it("applies the absolute execution deadline when response decoding advances the clock", async () => {
    const scheduler = new ManualDeadlineScheduler();
    const provider = providerHarness();
    const service = coordinator(provider.captured, {
      deadlineScheduler: scheduler,
      executionDeadlineMs: 20,
      queueDeadlineMs: 10,
      synchronousBudgetMs: 5,
    });
    const ticket = owner(service).request(input("decode-timeout"));
    const response = new Proxy(readyResponse(), {
      ownKeys(target) {
        scheduler.nowValue = 20;
        return Reflect.ownKeys(target);
      },
    });

    provider.calls[0]?.settlement.resolve(response);
    await expect(ticket.result).resolves.toEqual({
      reason: "execution-timeout",
      status: "unavailable",
    });
    expect(provider.calls[0]?.signal.aborted).toBe(true);
  });

  it("does not publish a decoded response that disposes the coordinator through a getter", async () => {
    const provider = providerHarness();
    const service = coordinator(provider.captured);
    const ticket = owner(service).request(input("decode-dispose"));
    const response = new Proxy(readyResponse(), {
      ownKeys(target) {
        service.dispose();
        return Reflect.ownKeys(target);
      },
    });

    provider.calls[0]?.settlement.resolve(response);
    await expect(ticket.result).resolves.toEqual({
      reason: "disposed",
      status: "unavailable",
    });
    await flushMicrotasks();
  });

  it("drains provider results returned after synchronous service disposal", async () => {
    for (const kind of ["pending", "rejected"] as const) {
      let service:
        | SqlCatalogSearchWorkCoordinator
        | undefined;
      const pending = deferred<unknown>();
      const captured = accepted(
        captureSqlRelationCatalogProvider({
          id: `dispose-${kind}`,
          search() {
            service?.dispose();
            if (kind === "rejected") {
              return Promise.reject(
                new Error("rejected after disposal"),
              );
            }
            return pending.promise;
          },
        }),
      );
      service = coordinator(captured);
      const ticket = owner(service).request(input(kind));

      await expect(ticket.result).resolves.toEqual({
        reason: "disposed",
        status: "unavailable",
      });
      if (kind === "pending") {
        pending.reject(new Error("late pending rejection"));
      }
      await flushMicrotasks();
    }
  });

  it("accepts an epoch transition with no search work and keeps disposal idempotent", () => {
    let invalidation: ((event: unknown) => void) | undefined;
    const captured = accepted(
      captureSqlRelationCatalogProvider({
        id: "catalog",
        search() {
          return readyResponse();
        },
        subscribe(
          _scope: string,
          listener: (event: unknown) => void,
        ) {
          invalidation = listener;
          return () => undefined;
        },
      }),
    );
    const service = coordinator(captured);
    const session = owner(service, "idle-scope");

    expect(() => invalidation?.({ epoch: epoch() })).not.toThrow();
    const immediate = service.prepareOwner(
      "inactive",
      POSTGRESQL_SQL_RELATION_DIALECT,
      { prepareCatalogChange: () => () => {} },
    );
    expect(immediate.status).toBe("prepared");
    if (immediate.status === "prepared") {
      const ticket = immediate.owner.request(input());
      expect(() => {
        ticket.cancel();
        ticket.cancel();
      }).not.toThrow();
    }
    session.dispose();
    session.dispose();
    service.dispose();
    service.dispose();
    expect(
      service.prepareOwner(
        "late",
        POSTGRESQL_SQL_RELATION_DIALECT,
        { prepareCatalogChange: () => () => {} },
      ),
    ).toEqual({
      reason: "disposed",
      status: "unavailable",
    });
  });
});

describe("catalog search epoch dependency failures", () => {
  it("maps every closed epoch decision and rotates retired captures", async () => {
    type Decision =
      | "disposed"
      | "malformed"
      | "overloaded"
      | "retired-exhausted"
      | "retired-then-usable"
      | "superseded";
    let decision: Decision = "disposed";
    let captureFailure = false;
    let captureHook: (() => void) | undefined;
    let capturedExpectedEpoch: ReturnType<typeof epoch> | null =
      null;
    let disposeCandidate: (() => void) | undefined;
    let factoryFailure = false;
    let membershipFailure = false;
    let searchCalls = 0;
    let submissions = 0;
    vi.resetModules();
    vi.doMock(
      "../relation-catalog-epoch-coordinator.js",
      async (importOriginal) => {
        const actual =
          await importOriginal<
            typeof import("../relation-catalog-epoch-coordinator.js")
          >();
        return {
          ...actual,
          createSqlCatalogEpochCoordinator() {
            if (factoryFailure) {
              return {
                reason: "invalid-provider",
                status: "unavailable",
              };
            }
            return {
              coordinator: {
                dispose() {},
                prepareScopeMembership() {
                  if (membershipFailure) {
                    return {
                      reason: "disposed",
                      status: "unavailable",
                    };
                  }
                  return {
                    membership: {
                      activate() {
                        return { status: "active" };
                      },
                      captureEpoch() {
                        const hook = captureHook;
                        captureHook = undefined;
                        hook?.();
                        if (captureFailure) {
                          return {
                            reason: "disposed",
                            status: "unavailable",
                          };
                        }
                        return {
                          capture: {
                            expectedEpoch: capturedExpectedEpoch,
                          },
                          status: "captured",
                        };
                      },
                      dispose() {},
                    },
                    status: "prepared",
                  };
                },
                providerId: "catalog",
                submitResponseEpoch(
                  _capture: unknown,
                  responseEpoch: ReturnType<typeof epoch>,
                  onDecision: (value: unknown) => void,
                ) {
                  submissions += 1;
                  if (
                    (decision === "retired-then-usable" ||
                      decision === "retired-exhausted") &&
                    submissions === 1
                  ) {
                    disposeCandidate?.();
                    return {
                      decision: {
                        reason: "retired",
                        status: "discarded",
                      },
                      status: "settled",
                    };
                  }
                  if (decision === "superseded") {
                    onDecision({
                      epoch: responseEpoch,
                      status: "superseded",
                    });
                  } else if (
                    decision === "retired-then-usable"
                  ) {
                    onDecision({
                      epoch: responseEpoch,
                      observation: "baseline",
                      status: "usable",
                    });
                  } else {
                    onDecision({
                      reason: decision,
                      status: "discarded",
                    });
                  }
                  return { status: "submitted" };
                },
              },
              status: "created",
            };
          },
        };
      },
    );
    const isolated = await import(
      "../relation-catalog-search-work.js"
    );
    const isolatedBoundary = await import(
      "../relation-catalog-boundary.js"
    );
    const isolatedDialect = await import(
      "../relation-dialect.js"
    );
    const captured = accepted(
      isolatedBoundary.captureSqlRelationCatalogProvider({
        id: "catalog",
        search() {
          searchCalls += 1;
          return readyResponse();
        },
      }),
    );

    const expected = new Map<
      Exclude<Decision, "retired-then-usable">,
      SqlCatalogSearchWorkOutcome
    >([
      [
        "disposed",
        { reason: "disposed", status: "unavailable" },
      ],
      [
        "malformed",
        {
          reason: "malformed-response",
          status: "unavailable",
        },
      ],
      [
        "overloaded",
        { reason: "overloaded", status: "unavailable" },
      ],
      ["superseded", { status: "superseded" }],
    ]);
    for (const [nextDecision, outcome] of expected) {
      decision = nextDecision;
      submissions = 0;
      const created =
        isolated.createSqlCatalogSearchWorkCoordinator(captured);
      expect(created.status).toBe("created");
      if (created.status !== "created") continue;
      const session = owner(
        created.coordinator,
        "connection:primary",
        isolatedDialect.POSTGRESQL_SQL_RELATION_DIALECT,
      );
      await expect(
        session.request(input(nextDecision)).result,
      ).resolves.toEqual(outcome);
      created.coordinator.dispose();
    }

    decision = "retired-then-usable";
    submissions = 0;
    const created =
      isolated.createSqlCatalogSearchWorkCoordinator(captured);
    expect(created.status).toBe("created");
    if (created.status === "created") {
      const first = owner(
        created.coordinator,
        "connection:primary",
        isolatedDialect.POSTGRESQL_SQL_RELATION_DIALECT,
      );
      const second = owner(
        created.coordinator,
        "connection:primary",
        isolatedDialect.POSTGRESQL_SQL_RELATION_DIALECT,
      );
      const firstTicket = first.request(input("rotation"));
      const secondTicket = second.request(input("rotation"));
      await expect(firstTicket.result).resolves.toMatchObject({
        status: "usable",
      });
      await expect(secondTicket.result).resolves.toMatchObject({
        status: "usable",
      });
      expect(submissions).toBe(2);
      created.coordinator.dispose();
    }

    decision = "retired-exhausted";
    submissions = 0;
    const exhausted =
      isolated.createSqlCatalogSearchWorkCoordinator(captured);
    expect(exhausted.status).toBe("created");
    if (exhausted.status === "created") {
      const first = owner(
        exhausted.coordinator,
        "connection:primary",
        isolatedDialect.POSTGRESQL_SQL_RELATION_DIALECT,
      );
      const second = owner(
        exhausted.coordinator,
        "connection:primary",
        isolatedDialect.POSTGRESQL_SQL_RELATION_DIALECT,
      );
      const firstTicket = first.request(input("exhausted"));
      const secondTicket = second.request(input("exhausted"));
      disposeCandidate = () => second.dispose();
      await expect(secondTicket.result).resolves.toEqual({
        status: "cancelled",
      });
      await expect(firstTicket.result).resolves.toEqual({
        status: "superseded",
      });
      expect(submissions).toBe(1);
      exhausted.coordinator.dispose();
    }

    decision = "disposed";
    capturedExpectedEpoch = null;
    searchCalls = 0;
    const epochMismatch =
      isolated.createSqlCatalogSearchWorkCoordinator(captured);
    expect(epochMismatch.status).toBe("created");
    if (epochMismatch.status === "created") {
      const first = owner(
        epochMismatch.coordinator,
        "connection:primary",
        isolatedDialect.POSTGRESQL_SQL_RELATION_DIALECT,
      ).request(input("epoch-key"));
      capturedExpectedEpoch = epoch(7);
      const second = owner(
        epochMismatch.coordinator,
        "connection:primary",
        isolatedDialect.POSTGRESQL_SQL_RELATION_DIALECT,
      ).request(input("epoch-key"));
      expect(searchCalls).toBe(2);
      epochMismatch.coordinator.dispose();
      await expect(first.result).resolves.toEqual({
        reason: "disposed",
        status: "unavailable",
      });
      await expect(second.result).resolves.toEqual({
        reason: "disposed",
        status: "unavailable",
      });
    }
    capturedExpectedEpoch = null;

    decision = "retired-then-usable";
    captureFailure = true;
    const captureRejected =
      isolated.createSqlCatalogSearchWorkCoordinator(captured);
    expect(captureRejected.status).toBe("created");
    if (captureRejected.status === "created") {
      const session = owner(
        captureRejected.coordinator,
        "connection:primary",
        isolatedDialect.POSTGRESQL_SQL_RELATION_DIALECT,
      );
      await expect(
        session.request(input("capture-disposed")).result,
      ).resolves.toEqual({
        reason: "disposed",
        status: "unavailable",
      });
      captureRejected.coordinator.dispose();
    }
    captureFailure = false;

    const captureReentrant =
      isolated.createSqlCatalogSearchWorkCoordinator(captured);
    expect(captureReentrant.status).toBe("created");
    if (captureReentrant.status === "created") {
      const session = owner(
        captureReentrant.coordinator,
        "connection:primary",
        isolatedDialect.POSTGRESQL_SQL_RELATION_DIALECT,
      );
      let current: SqlCatalogSearchWorkTicket | undefined;
      captureHook = () => {
        current = session.request(input("capture-current"));
      };
      const obsolete = session.request(input("capture-obsolete"));
      await expect(obsolete.result).resolves.toEqual({
        status: "superseded",
      });
      await expect(current?.result).resolves.toMatchObject({
        status: "usable",
      });
      captureReentrant.coordinator.dispose();
    }

    const captureDisposal =
      isolated.createSqlCatalogSearchWorkCoordinator(captured);
    expect(captureDisposal.status).toBe("created");
    if (captureDisposal.status === "created") {
      const session = owner(
        captureDisposal.coordinator,
        "connection:primary",
        isolatedDialect.POSTGRESQL_SQL_RELATION_DIALECT,
      );
      captureHook = () => {
        captureDisposal.coordinator.dispose();
      };
      await expect(
        session.request(input("capture-disposal")).result,
      ).resolves.toEqual({
        reason: "disposed",
        status: "unavailable",
      });
    }

    membershipFailure = true;
    const membershipRejected =
      isolated.createSqlCatalogSearchWorkCoordinator(captured);
    expect(membershipRejected.status).toBe("created");
    if (membershipRejected.status === "created") {
      expect(
        membershipRejected.coordinator.prepareOwner(
          "scope",
          isolatedDialect.POSTGRESQL_SQL_RELATION_DIALECT,
          { prepareCatalogChange: () => () => {} },
        ),
      ).toEqual({
        reason: "disposed",
        status: "unavailable",
      });
      membershipRejected.coordinator.dispose();
    }
    membershipFailure = false;

    factoryFailure = true;
    expect(
      isolated.createSqlCatalogSearchWorkCoordinator(captured),
    ).toEqual({
      reason: "invalid-provider",
      status: "unavailable",
    });
    vi.doUnmock("../relation-catalog-epoch-coordinator.js");
    vi.resetModules();
  });
});
