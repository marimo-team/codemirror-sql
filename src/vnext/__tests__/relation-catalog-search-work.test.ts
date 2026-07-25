import { describe, expect, it } from "vitest";
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
    "postgresql",
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
      "postgresql",
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
      "postgresql",
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
        expectedReason: "queue-timeout",
        nowValues: [0, 0, 10],
      },
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
      expect(providerCalls).toBe(0);
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
      delays: [10, 20, 20],
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
        "postgresql",
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
        "postgresql",
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
});
