import { bench, describe } from "vitest";
import {
  captureSqlRelationCatalogProvider,
} from "../relation-catalog-boundary.js";
import type {
  CapturedSqlRelationCatalogProvider,
  SqlCatalogBoundaryResult,
} from "../relation-catalog-boundary.js";
import {
  createSqlCatalogSearchWorkCoordinator,
  MAX_CATALOG_ACTIVE_SEARCH_WORK,
  MAX_CATALOG_EXECUTION_DEADLINE_MS,
  MAX_CATALOG_QUEUED_SEARCH_WORK,
  MAX_CATALOG_QUEUE_DEADLINE_MS,
} from "../relation-catalog-search-work.js";
import type {
  SqlCatalogSearchWorkCoordinator,
  SqlCatalogSearchWorkInput,
  SqlCatalogSearchWorkOutcome,
  SqlCatalogSearchWorkOwner,
  SqlCatalogSearchWorkTicket,
} from "../relation-catalog-search-work.js";
import {
  POSTGRESQL_SQL_RELATION_DIALECT,
} from "../relation-dialect.js";
import type {
  SqlCatalogSearchRequest,
} from "../relation-completion-types.js";

interface Deferred {
  readonly promise: Promise<unknown>;
  readonly resolve: (value: unknown) => void;
}

interface ProviderCall {
  readonly request: SqlCatalogSearchRequest;
  readonly settlement: Deferred;
  readonly signal: AbortSignal;
}

interface ProviderFixture {
  readonly calls: ProviderCall[];
  readonly captured: CapturedSqlRelationCatalogProvider;
  readonly emitInvalidation: (
    this: void,
    generation: number,
  ) => void;
}

let providerSequence = 0;

function benchmarkFailure(message: string): never {
  throw new Error(
    `Catalog search-work benchmark preflight failed: ${message}`,
  );
}

function accepted<Value>(
  result: SqlCatalogBoundaryResult<Value>,
): Value {
  if (result.status !== "accepted") {
    return benchmarkFailure(
      `provider capture was rejected: ${result.reason}`,
    );
  }
  return result.value;
}

function deferred(): Deferred {
  let resolve: ((value: unknown) => void) | null = null;
  const promise = new Promise<unknown>((onResolve) => {
    resolve = onResolve;
  });
  return {
    promise,
    resolve: (value: unknown): void => {
      if (!resolve) {
        return benchmarkFailure("deferred resolver was unavailable");
      }
      resolve(value);
    },
  };
}

function readyResponse(generation = 1): unknown {
  return {
    coverage: { kind: "complete" },
    epoch: {
      generation,
      token: `benchmark-epoch-${generation}`,
    },
    relations: [],
    status: "ready",
  };
}

function input(prefix: string): SqlCatalogSearchWorkInput {
  return {
    continuationToken: null,
    limit: 20,
    prefix: { quoted: false, value: prefix },
    qualifier: [{ quoted: false, value: "public" }],
    searchPaths: [[{ quoted: false, value: "public" }]],
  };
}

function providerFixture(subscribe: boolean): ProviderFixture {
  const calls: ProviderCall[] = [];
  let invalidation:
    | ((this: void, event: unknown) => void)
    | null = null;
  providerSequence += 1;
  const provider = subscribe
    ? {
        id: `search-work-benchmark-${providerSequence}`,
        search(
          request: SqlCatalogSearchRequest,
          signal: AbortSignal,
        ): Promise<unknown> {
          const settlement = deferred();
          calls.push({ request, settlement, signal });
          return settlement.promise;
        },
        subscribe(
          _scope: string,
          listener: (this: void, event: unknown) => void,
        ): (this: void) => undefined {
          invalidation = listener;
          return (): undefined => undefined;
        },
      }
    : {
        id: `search-work-benchmark-${providerSequence}`,
        search(
          request: SqlCatalogSearchRequest,
          signal: AbortSignal,
        ): Promise<unknown> {
          const settlement = deferred();
          calls.push({ request, settlement, signal });
          return settlement.promise;
        },
      };
  return {
    calls,
    captured: accepted(
      captureSqlRelationCatalogProvider(provider),
    ),
    emitInvalidation: (generation: number): void => {
      const listener = invalidation;
      if (!listener) {
        return benchmarkFailure(
          "invalidation listener was unavailable",
        );
      }
      listener({
        epoch: {
          generation,
          token: `benchmark-epoch-${generation}`,
        },
      });
    },
  };
}

function coordinator(
  fixture: ProviderFixture,
): SqlCatalogSearchWorkCoordinator {
  const created = createSqlCatalogSearchWorkCoordinator(
    fixture.captured,
    {
      executionDeadlineMs: MAX_CATALOG_EXECUTION_DEADLINE_MS,
      queueDeadlineMs: MAX_CATALOG_QUEUE_DEADLINE_MS,
    },
  );
  if (created.status !== "created") {
    return benchmarkFailure(
      `coordinator creation was unavailable: ${created.reason}`,
    );
  }
  return created.coordinator;
}

function owner(
  service: SqlCatalogSearchWorkCoordinator,
): SqlCatalogSearchWorkOwner {
  const prepared = service.prepareOwner(
    "benchmark-scope",
    "postgresql",
    POSTGRESQL_SQL_RELATION_DIALECT,
    {
      prepareCatalogChange: () => () => undefined,
    },
  );
  if (prepared.status !== "prepared") {
    return benchmarkFailure(
      `owner preparation was unavailable: ${prepared.reason}`,
    );
  }
  const activated = prepared.owner.activate();
  if (activated.status !== "active") {
    return benchmarkFailure(
      `owner activation was unavailable: ${activated.reason}`,
    );
  }
  return prepared.owner;
}

function requireCall(
  fixture: ProviderFixture,
  index: number,
): ProviderCall {
  const call = fixture.calls[index];
  if (!call) {
    return benchmarkFailure(
      `provider call ${index} was unavailable`,
    );
  }
  return call;
}

async function requireUsable(
  ticket: SqlCatalogSearchWorkTicket,
): Promise<void> {
  const outcome = await ticket.result;
  if (outcome.status !== "usable") {
    benchmarkFailure(
      `expected usable work, received ${outcome.status}`,
    );
  }
}

async function requireStatus(
  ticket: SqlCatalogSearchWorkTicket,
  status: SqlCatalogSearchWorkOutcome["status"],
): Promise<void> {
  const outcome = await ticket.result;
  if (outcome.status !== status) {
    benchmarkFailure(
      `expected ${status} work, received ${outcome.status}`,
    );
  }
}

async function flushProviderCalls(
  fixture: ProviderFixture,
  expected: number,
): Promise<void> {
  for (let index = 0; index < expected; index += 1) {
    for (
      let attempts = 0;
      !fixture.calls[index] && attempts < 4;
      attempts += 1
    ) {
      await Promise.resolve();
    }
    requireCall(fixture, index).settlement.resolve(
      readyResponse(),
    );
    await Promise.resolve();
  }
}

async function benchmarkSameKeyJoins(
  ownerCount: number,
): Promise<void> {
  const fixture = providerFixture(false);
  const service = coordinator(fixture);
  const tickets = Array.from(
    { length: ownerCount },
    () => owner(service).request(input("shared")),
  );
  if (fixture.calls.length !== 1) {
    benchmarkFailure(
      `${ownerCount} same-key owners created ${fixture.calls.length} calls`,
    );
  }
  requireCall(fixture, 0).settlement.resolve(readyResponse());
  await Promise.all(tickets.map(requireUsable));
  service.dispose();
}

async function benchmarkQueuePump(): Promise<void> {
  const fixture = providerFixture(false);
  const service = coordinator(fixture);
  const workCount =
    MAX_CATALOG_ACTIVE_SEARCH_WORK +
    MAX_CATALOG_QUEUED_SEARCH_WORK;
  const tickets = Array.from(
    { length: workCount },
    (_, index) =>
      owner(service).request(input(`queue-${index}`)),
  );
  if (
    fixture.calls.length !== MAX_CATALOG_ACTIVE_SEARCH_WORK
  ) {
    benchmarkFailure("active search capacity was not filled");
  }
  await flushProviderCalls(fixture, workCount);
  await Promise.all(tickets.map(requireUsable));
  if (fixture.calls.length !== workCount) {
    benchmarkFailure("queued search work was not fully pumped");
  }
  service.dispose();
}

async function benchmarkWorstCaseExactKeyScan(): Promise<void> {
  const fixture = providerFixture(false);
  const service = coordinator(fixture);
  const workCount =
    MAX_CATALOG_ACTIVE_SEARCH_WORK +
    MAX_CATALOG_QUEUED_SEARCH_WORK;
  const tickets = Array.from(
    { length: workCount },
    (_, index) =>
      owner(service).request(input(`scan-${index}`)),
  );
  const joined = owner(service).request(
    input(`scan-${workCount - 1}`),
  );
  if (
    fixture.calls.length !== MAX_CATALOG_ACTIVE_SEARCH_WORK
  ) {
    benchmarkFailure("worst-case exact key did not join queued work");
  }
  for (const ticket of tickets) ticket.cancel();
  joined.cancel();
  await Promise.all([
    ...tickets.map((ticket) =>
      requireStatus(ticket, "cancelled"),
    ),
    requireStatus(joined, "cancelled"),
  ]);
  for (const call of fixture.calls) {
    call.settlement.resolve(readyResponse());
  }
  await Promise.resolve();
  await Promise.resolve();
  service.dispose();
}

async function benchmarkScopeRetirement(): Promise<void> {
  const fixture = providerFixture(true);
  const service = coordinator(fixture);
  const workCount =
    MAX_CATALOG_ACTIVE_SEARCH_WORK +
    MAX_CATALOG_QUEUED_SEARCH_WORK;
  const tickets = Array.from(
    { length: workCount },
    (_, index) =>
      owner(service).request(input(`epoch-${index}`)),
  );
  fixture.emitInvalidation(1);
  await Promise.all(
    tickets.map((ticket) =>
      requireStatus(ticket, "superseded"),
    ),
  );
  for (const call of fixture.calls) {
    if (!call.signal.aborted) {
      benchmarkFailure(
        "scope retirement left active provider work un-aborted",
      );
    }
    call.settlement.resolve(readyResponse());
  }
  await Promise.resolve();
  await Promise.resolve();
  service.dispose();
}

async function benchmarkAcquireCancel10k(): Promise<void> {
  const fixture = providerFixture(false);
  const service = coordinator(fixture);
  const session = owner(service);
  for (let index = 0; index < 10_000; index += 1) {
    session.request(input(`cancel-${index}`)).cancel();
  }
  if (
    fixture.calls.length !== MAX_CATALOG_ACTIVE_SEARCH_WORK
  ) {
    benchmarkFailure(
      "cancelled active work did not retain its slot until settlement",
    );
  }
  for (const call of fixture.calls) {
    if (!call.signal.aborted) {
      benchmarkFailure("cancelled active work was not aborted");
    }
    call.settlement.resolve(readyResponse());
  }
  await Promise.resolve();
  await Promise.resolve();
  service.dispose();
}

describe("relation catalog search work", () => {
  for (const ownerCount of [1, 10, 50]) {
    bench(`${ownerCount} same-key owner joins`, async () => {
      await benchmarkSameKeyJoins(ownerCount);
    });
  }

  bench("pump 8 active and 64 queued searches", async () => {
    await benchmarkQueuePump();
  });

  bench("scan the worst-case exact key at capacity", async () => {
    await benchmarkWorstCaseExactKeyScan();
  });

  bench("retire a full scope on an epoch change", async () => {
    await benchmarkScopeRetirement();
  });

  bench("acquire and cancel 10,000 requests", async () => {
    await benchmarkAcquireCancel10k();
  });
});
