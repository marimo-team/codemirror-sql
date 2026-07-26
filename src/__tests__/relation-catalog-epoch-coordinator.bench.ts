import { bench, describe } from "vitest";
import {
  captureSqlRelationCatalogProvider,
} from "../relation-catalog-boundary.js";
import {
  MAX_CATALOG_CALLBACKS_PER_RESET_WINDOW,
  createSqlCatalogEpochCoordinator,
} from "../relation-catalog-epoch-coordinator.js";
import type {
  SqlCatalogEpochCoordinator,
  SqlCatalogEpochTransitionTarget,
  SqlCatalogResponseEpochDecision,
  SqlCatalogResponseEpochSubmissionResult,
  SqlCatalogRevisionTarget,
  SqlCatalogScopeMembership,
} from "../relation-catalog-epoch-coordinator.js";

interface RevisionCounter {
  dispatched: number;
  prepared: number;
  readonly target: SqlCatalogRevisionTarget;
}

interface CoordinatorFixture {
  readonly coordinator: SqlCatalogEpochCoordinator;
  readonly counters: RevisionCounter[];
  readonly dispose: () => void;
  readonly emitInvalidation: (generation: number) => void;
  readonly memberships: SqlCatalogScopeMembership[];
  readonly subscriptionCounts: {
    disposed: number;
    installed: number;
  };
}

let providerSequence = 0;

function benchmarkFailure(message: string): never {
  throw new Error(
    `Catalog epoch coordinator benchmark preflight failed: ${message}`,
  );
}

function revisionCounter(): RevisionCounter {
  const counter: RevisionCounter = {
    dispatched: 0,
    prepared: 0,
    target: {
      prepareCatalogChange: (): (() => void) => {
        counter.prepared += 1;
        return (): void => {
          counter.dispatched += 1;
        };
      },
    },
  };
  return counter;
}

function requireMembership(
  coordinator: SqlCatalogEpochCoordinator,
  scope: string,
  counter: RevisionCounter,
): SqlCatalogScopeMembership {
  const prepared = coordinator.prepareScopeMembership(
    scope,
    counter.target,
  );
  if (prepared.status !== "prepared") {
    return benchmarkFailure("membership preparation was unavailable");
  }
  const activated = prepared.membership.activate();
  if (activated.status !== "active") {
    return benchmarkFailure("membership activation was unavailable");
  }
  return prepared.membership;
}

function requireMember(
  members: readonly SqlCatalogScopeMembership[],
  index: number,
): SqlCatalogScopeMembership {
  const member = members[index];
  if (!member) {
    return benchmarkFailure("membership index was unavailable");
  }
  return member;
}

function requireDecision(
  submit: (
    receive: (
      this: void,
      decision: SqlCatalogResponseEpochDecision,
    ) => void,
  ) => SqlCatalogResponseEpochSubmissionResult,
): SqlCatalogResponseEpochDecision {
  const decisions: SqlCatalogResponseEpochDecision[] = [];
  const submission = submit((decision): void => {
    decisions.push(decision);
  });
  if (submission.status !== "submitted") {
    return benchmarkFailure("epoch command was not submitted");
  }
  const decision = decisions[0];
  if (!decision || decisions.length !== 1) {
    return benchmarkFailure(
      "epoch command did not settle exactly once",
    );
  }
  return decision;
}

function createFixture(
  memberCount: number,
  prepareEpochTransition?: SqlCatalogEpochTransitionTarget,
): CoordinatorFixture {
  let invalidationListener:
    | ((this: void, event: unknown) => void)
    | null = null;
  const subscriptionCounts = {
    disposed: 0,
    installed: 0,
  };
  providerSequence += 1;
  const captured = captureSqlRelationCatalogProvider({
    id: `coordinator-benchmark-${providerSequence}`,
    search: (): Promise<never> =>
      new Promise<never>(() => {
        // The epoch coordinator never invokes catalog search.
      }),
    subscribe: (
      _scope: string,
      listener: (this: void, event: unknown) => void,
    ) => {
      subscriptionCounts.installed += 1;
      invalidationListener = listener;
      return (): void => {
        subscriptionCounts.disposed += 1;
      };
    },
  });
  if (captured.status !== "accepted") {
    return benchmarkFailure("provider capture was rejected");
  }
  const created = createSqlCatalogEpochCoordinator(
    captured.value,
    prepareEpochTransition,
  );
  if (created.status !== "created") {
    return benchmarkFailure("coordinator creation was unavailable");
  }
  const counters: RevisionCounter[] = [];
  const memberships: SqlCatalogScopeMembership[] = [];
  for (let index = 0; index < memberCount; index += 1) {
    const counter = revisionCounter();
    counters.push(counter);
    memberships.push(
      requireMembership(
        created.coordinator,
        "benchmark-scope",
        counter,
      ),
    );
  }
  return {
    coordinator: created.coordinator,
    counters,
    dispose: (): void => {
      created.coordinator.dispose();
    },
    emitInvalidation: (generation: number): void => {
      const listener = invalidationListener;
      if (!listener) {
        return benchmarkFailure(
          "provider subscription listener was unavailable",
        );
      }
      listener({
        epoch: {
          generation,
          token: "benchmark-epoch",
        },
      });
    },
    memberships,
    subscriptionCounts,
  };
}

function establishBaseline(
  fixture: CoordinatorFixture,
): SqlCatalogScopeMembership {
  const member = requireMember(fixture.memberships, 0);
  const captured = member.captureEpoch();
  if (captured.status !== "captured") {
    return benchmarkFailure("epoch capture was unavailable");
  }
  const decision = requireDecision((receive) =>
    fixture.coordinator.submitResponseEpoch(
      captured.capture,
      { generation: 0, token: "benchmark-epoch" },
      receive,
    ),
  );
  if (
    decision.status !== "usable" ||
    decision.observation !== "baseline"
  ) {
    return benchmarkFailure("baseline response was not usable");
  }
  return member;
}

function assertFanout(memberCount: number): void {
  const fixture = createFixture(memberCount);
  const member = establishBaseline(fixture);
  const captured = member.captureEpoch();
  if (captured.status !== "captured") {
    return benchmarkFailure("fanout capture was unavailable");
  }
  const decision = requireDecision((receive) =>
    fixture.coordinator.submitResponseEpoch(
      captured.capture,
      { generation: 1, token: "benchmark-epoch" },
      receive,
    ),
  );
  if (decision.status !== "superseded") {
    return benchmarkFailure(
      "higher response did not supersede its capture",
    );
  }
  for (const counter of fixture.counters) {
    if (counter.prepared !== 1 || counter.dispatched !== 1) {
      return benchmarkFailure(
        `higher response did not reach all ${memberCount} members`,
      );
    }
  }
  fixture.dispose();
}

function assertRejectedCallbacks(): void {
  const fixture = createFixture(1);
  fixture.emitInvalidation(2);
  fixture.emitInvalidation(2);
  fixture.emitInvalidation(1);
  if (
    fixture.counters[0]?.prepared !== 1 ||
    fixture.counters[0]?.dispatched !== 1
  ) {
    return benchmarkFailure(
      "duplicate or stale callback changed the revision",
    );
  }
  fixture.dispose();
}

function assertBoundedStorm(): void {
  const fixture = createFixture(1);
  for (
    let generation = 1;
    generation <= MAX_CATALOG_CALLBACKS_PER_RESET_WINDOW;
    generation += 1
  ) {
    fixture.emitInvalidation(generation);
  }
  const counter = fixture.counters[0];
  if (
    !counter ||
    counter.prepared !== MAX_CATALOG_CALLBACKS_PER_RESET_WINDOW ||
    counter.dispatched !== MAX_CATALOG_CALLBACKS_PER_RESET_WINDOW
  ) {
    return benchmarkFailure("bounded callback storm lost an event");
  }
  fixture.emitInvalidation(
    MAX_CATALOG_CALLBACKS_PER_RESET_WINDOW + 1,
  );
  fixture.emitInvalidation(
    MAX_CATALOG_CALLBACKS_PER_RESET_WINDOW + 2,
  );
  if (
    counter.prepared !== MAX_CATALOG_CALLBACKS_PER_RESET_WINDOW ||
    counter.dispatched !== MAX_CATALOG_CALLBACKS_PER_RESET_WINDOW ||
    fixture.subscriptionCounts.disposed !== 1
  ) {
    return benchmarkFailure(
      "callback overflow did not retire the subscription",
    );
  }
  fixture.dispose();
}

function assertAttachDetachReuse(): void {
  const fixture = createFixture(1);
  for (let index = 0; index < 256; index += 1) {
    const counter = revisionCounter();
    const membership = requireMembership(
      fixture.coordinator,
      "benchmark-scope",
      counter,
    );
    membership.dispose();
  }
  const finalMembership = requireMembership(
    fixture.coordinator,
    "benchmark-scope",
    revisionCounter(),
  );
  finalMembership.dispose();
  if (
    fixture.subscriptionCounts.installed !== 1 ||
    fixture.subscriptionCounts.disposed !== 0
  ) {
    return benchmarkFailure(
      "attach/detach churn changed the shared subscription",
    );
  }
  fixture.dispose();
  if (Number(fixture.subscriptionCounts.disposed) !== 1) {
    return benchmarkFailure(
      "shared subscription was not disposed exactly once",
    );
  }
}

for (const memberCount of [1, 10, 50, 256]) {
assertFanout(memberCount);
}
assertRejectedCallbacks();
assertBoundedStorm();
assertAttachDetachReuse();

const noopDecision = (
  _decision: SqlCatalogResponseEpochDecision,
): void => {};

describe("relation catalog epoch coordinator", () => {
  for (const memberCount of [1, 10, 50, 256]) {
    const lifecycleFixture = createFixture(memberCount);
    let lifecycleCursor = 0;
    bench(
      `join, activate, and dispose within a ${memberCount}-member scope`,
      () => {
        const previous = requireMember(
          lifecycleFixture.memberships,
          lifecycleCursor,
        );
        const nextCounter = revisionCounter();
        if (memberCount === 1) {
          const next = requireMembership(
            lifecycleFixture.coordinator,
            "benchmark-scope",
            nextCounter,
          );
          previous.dispose();
          lifecycleFixture.memberships[lifecycleCursor] = next;
        } else {
          previous.dispose();
          lifecycleFixture.memberships[lifecycleCursor] =
            requireMembership(
              lifecycleFixture.coordinator,
              "benchmark-scope",
              nextCounter,
            );
        }
        lifecycleCursor =
          (lifecycleCursor + 1) % memberCount;
      },
    );

    const fanoutFixture = createFixture(memberCount);
    const fanoutMember = establishBaseline(fanoutFixture);
    let generation = 0;
    bench(
      `accept higher response and fan out to ${memberCount} members`,
      () => {
        generation += 1;
        const nextCapture = fanoutMember.captureEpoch();
        if (nextCapture.status !== "captured") {
          benchmarkFailure(
            "fanout benchmark capture was unavailable",
          );
        }
        const submission =
          fanoutFixture.coordinator.submitResponseEpoch(
            nextCapture.capture,
            { generation, token: "benchmark-epoch" },
            noopDecision,
          );
        if (submission.status !== "submitted") {
          benchmarkFailure(
            "fanout benchmark response was not submitted",
          );
        }
      },
    );
  }

  bench("reject duplicate and stale provider callbacks", () => {
    const fixture = createFixture(1);
    fixture.emitInvalidation(2);
    fixture.emitInvalidation(2);
    fixture.emitInvalidation(1);
    fixture.dispose();
  });

  bench(
    "process a bounded 256-event provider callback storm for one member",
    () => {
      const fixture = createFixture(1);
      for (
        let generation = 1;
        generation <= MAX_CATALOG_CALLBACKS_PER_RESET_WINDOW;
        generation += 1
      ) {
        fixture.emitInvalidation(generation);
      }
      fixture.dispose();
    },
  );

  bench(
    "process a bounded 256-event storm with a null transition dispatch",
    () => {
      let transitions = 0;
      const fixture = createFixture(1, () => {
        transitions += 1;
        return null;
      });
      for (
        let generation = 1;
        generation <= MAX_CATALOG_CALLBACKS_PER_RESET_WINDOW;
        generation += 1
      ) {
        fixture.emitInvalidation(generation);
      }
      if (
        transitions !== MAX_CATALOG_CALLBACKS_PER_RESET_WINDOW
      ) {
        benchmarkFailure(
          "configured transition hook lost an accepted epoch",
        );
      }
      fixture.dispose();
    },
  );

  bench("fan out a bounded 256-event storm to 256 members", () => {
    const fixture = createFixture(256);
    for (
      let generation = 1;
      generation <= MAX_CATALOG_CALLBACKS_PER_RESET_WINDOW;
      generation += 1
    ) {
      fixture.emitInvalidation(generation);
    }
    fixture.dispose();
  });

  bench("attach and detach 10,000 members on one scope", () => {
    const fixture = createFixture(1);
    for (let index = 0; index < 10_000; index += 1) {
      const membership = requireMembership(
        fixture.coordinator,
        "benchmark-scope",
        revisionCounter(),
      );
      membership.dispose();
    }
    fixture.dispose();
  });
});
