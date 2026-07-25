import { MessageChannel } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import {
  captureSqlRelationCatalogProvider,
  MAX_CATALOG_SCOPE_LENGTH,
  type CapturedSqlRelationCatalogProvider,
} from "../relation-catalog-boundary.js";
import {
  createSqlCatalogEpochCoordinator,
  MAX_CATALOG_CALLBACKS_PER_RESET_WINDOW,
  MAX_CATALOG_CLEANUPS_PER_BARRIER,
  MAX_CATALOG_EPOCH_COMMANDS,
  MAX_CATALOG_LIVE_SCOPES,
  MAX_CATALOG_MEMBERSHIPS,
  MAX_CATALOG_MEMBERSHIPS_PER_SCOPE,
  type SqlCatalogEpochCapture,
  type SqlCatalogEpochCoordinator,
  type SqlCatalogResponseEpochDecision,
  type SqlCatalogResponseEpochSubmissionResult,
  type SqlCatalogRevisionTarget,
  type SqlCatalogScopeMembership,
} from "../relation-catalog-epoch-coordinator.js";

type RawInvalidationListener = (value: unknown) => void;
type RawSubscribe = (
  scope: string,
  listener: RawInvalidationListener,
) => unknown;

function epoch(generation: number, token = `epoch-${generation}`) {
  return { generation, token };
}

function invalidation(generation: number, token = `epoch-${generation}`) {
  return { epoch: epoch(generation, token) };
}

function capturedProvider(
  subscribe?: RawSubscribe,
  id = "catalog",
): CapturedSqlRelationCatalogProvider {
  const candidate =
    subscribe === undefined
      ? {
          id,
          search: async () => null,
        }
      : {
          id,
          search: async () => null,
          subscribe,
        };
  const result = captureSqlRelationCatalogProvider(candidate);
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") {
    throw new Error("Expected an accepted provider fixture");
  }
  return result.value;
}

function coordinator(
  subscribe?: RawSubscribe,
  id = "catalog",
): SqlCatalogEpochCoordinator {
  const result = createSqlCatalogEpochCoordinator(
    capturedProvider(subscribe, id),
  );
  expect(result.status).toBe("created");
  if (result.status !== "created") {
    throw new Error("Expected a coordinator fixture");
  }
  return result.coordinator;
}

function prepared(
  owner: SqlCatalogEpochCoordinator,
  scope: unknown,
  target: SqlCatalogRevisionTarget = {
    prepareCatalogChange: () => () => {},
  },
): SqlCatalogScopeMembership {
  const result = owner.prepareScopeMembership(scope, target);
  expect(result.status).toBe("prepared");
  if (result.status !== "prepared") {
    throw new Error("Expected a prepared membership fixture");
  }
  return result.membership;
}

function active(
  owner: SqlCatalogEpochCoordinator,
  scope: string,
  target?: SqlCatalogRevisionTarget,
): SqlCatalogScopeMembership {
  const membership = prepared(owner, scope, target);
  expect(membership.activate()).toEqual({ status: "active" });
  return membership;
}

function capture(
  membership: SqlCatalogScopeMembership,
): SqlCatalogEpochCapture {
  const result = membership.captureEpoch();
  expect(result.status).toBe("captured");
  if (result.status !== "captured") {
    throw new Error("Expected a capture fixture");
  }
  return result.capture;
}

function submit(
  owner: SqlCatalogEpochCoordinator,
  captured: unknown,
  value: unknown,
): {
  readonly decisions: readonly SqlCatalogResponseEpochDecision[];
  readonly result: SqlCatalogResponseEpochSubmissionResult;
} {
  const decisions: SqlCatalogResponseEpochDecision[] = [];
  const result = owner.submitResponseEpoch(
    captured,
    value,
    (decision) => decisions.push(decision),
  );
  return { decisions, result };
}

function listenerProvider(): {
  readonly listeners: RawInvalidationListener[];
  readonly scopes: string[];
  readonly subscribe: RawSubscribe;
  cleanupCalls: number;
} {
  const listeners: RawInvalidationListener[] = [];
  const scopes: string[] = [];
  const harness = {
    cleanupCalls: 0,
    listeners,
    scopes,
    subscribe: (
      scope: string,
      listener: RawInvalidationListener,
    ) => {
      harness.scopes.push(scope);
      harness.listeners.push(listener);
      return () => {
        harness.cleanupCalls += 1;
      };
    },
  };
  return harness;
}

function counterTarget(
  onDispatch?: () => void,
): {
  readonly target: SqlCatalogRevisionTarget;
  prepared: number;
  dispatched: number;
} {
  const counter = {
    dispatched: 0,
    prepared: 0,
    target: {
      prepareCatalogChange: () => {
        counter.prepared += 1;
        return () => {
          counter.dispatched += 1;
          onDispatch?.();
        };
      },
    },
  };
  return counter;
}

describe("catalog epoch coordinator construction and membership", () => {
  it("authenticates providers and freezes its closed API", () => {
    expect(createSqlCatalogEpochCoordinator(null)).toEqual({
      reason: "invalid-provider",
      status: "unavailable",
    });
    expect(
      createSqlCatalogEpochCoordinator({
        ...capturedProvider(undefined, "copied"),
      }),
    ).toEqual({
      reason: "invalid-provider",
      status: "unavailable",
    });

    const owner = coordinator(undefined, "provider-a");
    expect(owner.providerId).toBe("provider-a");
    expect(Object.isFrozen(owner)).toBe(true);
  });

  it("validates exact bounded well-formed scopes without raw errors", () => {
    const owner = coordinator();
    expect(
      owner.prepareScopeMembership("", counterTarget().target),
    ).toEqual({
      reason: "invalid-scope",
      status: "unavailable",
    });
    for (const scope of [
      null,
      1,
      "bad\0scope",
      "\ud800",
      "\ud800a",
      "\udc00",
      "x".repeat(MAX_CATALOG_SCOPE_LENGTH + 1),
    ]) {
      expect(
        owner.prepareScopeMembership(scope, counterTarget().target),
      ).toEqual({
        reason: "invalid-scope",
        status: "unavailable",
      });
    }
    expect(
      owner.prepareScopeMembership(
        `\ud83d\ude80${"x".repeat(MAX_CATALOG_SCOPE_LENGTH - 2)}`,
        counterTarget().target,
      ).status,
    ).toBe("prepared");
  });

  it("uses two-phase activation and exposes only a frozen expected epoch", () => {
    const owner = coordinator();
    const membership = prepared(owner, "scope");
    expect(membership.captureEpoch()).toEqual({
      reason: "inactive",
      status: "unavailable",
    });
    expect(membership.activate()).toEqual({ status: "active" });
    expect(membership.activate()).toEqual({ status: "active" });
    const first = capture(membership);
    expect(first.expectedEpoch).toBeNull();
    expect(Object.keys(first)).toEqual(["expectedEpoch"]);
    expect(Object.isFrozen(first)).toBe(true);
    membership.dispose();
    membership.dispose();
    expect(membership.captureEpoch()).toEqual({
      reason: "disposed",
      status: "unavailable",
    });
    expect(membership.activate()).toEqual({
      reason: "disposed",
      status: "unavailable",
    });
  });

  it("does not retain a membership if target capture disposes the coordinator", () => {
    const owner = coordinator();
    const target = new Proxy<SqlCatalogRevisionTarget>(
      {
        prepareCatalogChange: () => null,
      },
      {
        get(value, property, receiver) {
          if (property === "prepareCatalogChange") {
            owner.dispose();
            return 1;
          }
          return Reflect.get(value, property, receiver);
        },
      },
    );
    const result = owner.prepareScopeMembership("scope", target);
    expect(result).toEqual({
      reason: "disposed",
      status: "unavailable",
    });
    expect(
      owner.prepareScopeMembership("later", counterTarget().target),
    ).toEqual({
      reason: "disposed",
      status: "unavailable",
    });

    const throwingOwner = coordinator();
    expect(
      throwingOwner.prepareScopeMembership("scope", {
        get prepareCatalogChange(): never {
          throwingOwner.dispose();
          throw new Error("dispose before hostile getter failure");
        },
      }),
    ).toEqual({
      reason: "disposed",
      status: "unavailable",
    });
  });

  it("reserves membership capacity before a hostile target getter can reenter", () => {
    const owner = coordinator();
    const memberships: SqlCatalogScopeMembership[] = [];
    const rejected: string[] = [];
    let getterCalls = 0;
    let remaining = MAX_CATALOG_MEMBERSHIPS + 16;
    const target = {
      get prepareCatalogChange(): SqlCatalogRevisionTarget["prepareCatalogChange"] {
        getterCalls += 1;
        if (remaining > 0) {
          remaining -= 1;
          const nested = owner.prepareScopeMembership("scope", target);
          if (nested.status === "prepared") {
            memberships.push(nested.membership);
          } else {
            rejected.push(nested.reason);
          }
        }
        return () => null;
      },
    };

    const outer = owner.prepareScopeMembership("scope", target);
    if (outer.status === "prepared") {
      memberships.push(outer.membership);
    } else {
      rejected.push(outer.reason);
    }
    expect(memberships).toHaveLength(MAX_CATALOG_MEMBERSHIPS);
    expect(getterCalls).toBe(MAX_CATALOG_MEMBERSHIPS);
    expect(remaining).toBe(16);
    expect(rejected).toEqual(["membership-capacity"]);
    expect(
      owner.prepareScopeMembership("overflow", counterTarget().target),
    ).toEqual({
      reason: "membership-capacity",
      status: "unavailable",
    });

    for (const membership of memberships) membership.dispose();
    const reused = Array.from(
      { length: MAX_CATALOG_MEMBERSHIPS },
      (_, index) =>
        owner.prepareScopeMembership(
          `reused-${index}`,
          counterTarget().target,
        ),
    );
    expect(reused.every((result) => result.status === "prepared")).toBe(
      true,
    );
    for (const result of reused) {
      if (result.status === "prepared") result.membership.dispose();
    }
  });

  it.each([
    {
      name: "a throwing getter",
      target: {
        get prepareCatalogChange(): never {
          throw new Error("hostile target getter");
        },
      },
    },
    {
      name: "a non-callable runtime value",
      target: new Proxy<SqlCatalogRevisionTarget>(
        {
          prepareCatalogChange: () => null,
        },
        {
          get(value, property, receiver) {
            return property === "prepareCatalogChange"
              ? 1
              : Reflect.get(value, property, receiver);
          },
        },
      ),
    },
  ])(
    "rejects $name without consuming the reserved membership slot",
    ({ target }) => {
      const owner = coordinator();
      const existing = Array.from(
        { length: MAX_CATALOG_MEMBERSHIPS - 1 },
        (_, index) => prepared(owner, `existing-${index}`),
      );
      expect(
        owner.prepareScopeMembership("invalid-target", target),
      ).toEqual({
        reason: "invalid-target",
        status: "unavailable",
      });
      const final = owner.prepareScopeMembership(
        "final",
        counterTarget().target,
      );
      expect(final.status).toBe("prepared");
      expect(
        owner.prepareScopeMembership(
          "overflow",
          counterTarget().target,
        ),
      ).toEqual({
        reason: "membership-capacity",
        status: "unavailable",
      });

      for (const membership of existing) membership.dispose();
      if (final.status === "prepared") final.membership.dispose();
    },
  );

  it.each([1, 10, 50])(
    "shares one subscription across %i same-scope members",
    (count) => {
      const harness = listenerProvider();
      const owner = coordinator(harness.subscribe);
      const memberships = Array.from({ length: count }, () =>
        active(owner, "shared"),
      );
      expect(harness.scopes).toEqual(["shared"]);
      const secondScope = active(owner, "other");
      expect(harness.scopes).toEqual(["shared", "other"]);
      for (const membership of memberships.slice(0, -1)) {
        membership.dispose();
      }
      expect(harness.cleanupCalls).toBe(0);
      memberships.at(-1)?.dispose();
      expect(harness.cleanupCalls).toBe(1);
      secondScope.dispose();
      expect(harness.cleanupCalls).toBe(2);
    },
  );

  it("supports providers with no subscription", () => {
    const owner = coordinator();
    const membership = active(owner, "static");
    const first = capture(membership);
    const outcome = submit(owner, first, epoch(3));
    expect(outcome.result).toEqual({ status: "submitted" });
    expect(outcome.decisions).toEqual([
      {
        epoch: epoch(3),
        observation: "baseline",
        status: "usable",
      },
    ]);
    expect(Object.isFrozen(outcome.result)).toBe(true);
    expect(Object.isFrozen(outcome.decisions[0])).toBe(true);
    expect(capture(membership).expectedEpoch).toEqual(epoch(3));
  });

  it("never invokes provider search", () => {
    let searchCalls = 0;
    const captured = captureSqlRelationCatalogProvider({
      id: "search-is-out-of-scope",
      search: async () => {
        searchCalls += 1;
        throw new Error("search must remain scheduler-owned");
      },
    });
    if (captured.status !== "accepted") {
      throw new Error("Expected an accepted provider fixture");
    }
    const created = createSqlCatalogEpochCoordinator(captured.value);
    if (created.status !== "created") {
      throw new Error("Expected a coordinator fixture");
    }
    const membership = active(created.coordinator, "scope");
    submit(created.coordinator, capture(membership), epoch(1));
    created.coordinator.dispose();
    expect(searchCalls).toBe(0);
  });

  it("enforces exact capacity edges and reuses released capacity", () => {
    const owner = coordinator();
    const inactive = Array.from(
      { length: MAX_CATALOG_MEMBERSHIPS },
      (_, index) => prepared(owner, `prepared-${index}`),
    );
    expect(
      owner.prepareScopeMembership("overflow", counterTarget().target),
    ).toEqual({
      reason: "membership-capacity",
      status: "unavailable",
    });
    inactive[0]?.dispose();
    expect(
      owner.prepareScopeMembership("reused", counterTarget().target)
        .status,
    ).toBe("prepared");

    const scopeOwner = coordinator();
    const scopes = Array.from(
      { length: MAX_CATALOG_LIVE_SCOPES },
      (_, index) => active(scopeOwner, `scope-${index}`),
    );
    const blocked = prepared(scopeOwner, "scope-overflow");
    expect(blocked.activate()).toEqual({
      reason: "scope-capacity",
      status: "unavailable",
    });
    scopes[0]?.dispose();
    expect(blocked.activate()).toEqual({ status: "active" });

    const memberOwner = coordinator();
    const sameScope = Array.from(
      { length: MAX_CATALOG_MEMBERSHIPS_PER_SCOPE },
      () => active(memberOwner, "crowded"),
    );
    const extra = prepared(memberOwner, "crowded");
    expect(extra.activate()).toEqual({
      reason: "scope-membership-capacity",
      status: "unavailable",
    });
    sameScope[0]?.dispose();
    expect(extra.activate()).toEqual({ status: "active" });
  });

  it("reclaims scope structure across ten thousand incarnations", () => {
    const harness = listenerProvider();
    const owner = coordinator(harness.subscribe);
    for (let index = 0; index < 10_000; index += 1) {
      active(owner, `scope-${index}`).dispose();
    }
    expect(harness.scopes).toHaveLength(10_000);
    expect(harness.cleanupCalls).toBe(10_000);
    expect(active(owner, "after-churn").captureEpoch().status).toBe(
      "captured",
    );
  });
});

describe("response epoch observations and capture authority", () => {
  it("classifies baseline, equal, advance, stale, conflicts, and malformed epochs", () => {
    const target = counterTarget();
    const owner = coordinator();
    const membership = active(owner, "scope", target.target);

    const baseline = submit(owner, capture(membership), epoch(1));
    expect(baseline.decisions).toEqual([
      {
        epoch: epoch(1),
        observation: "baseline",
        status: "usable",
      },
    ]);
    expect(target.dispatched).toBe(0);

    const equal = submit(owner, capture(membership), epoch(1));
    expect(equal.decisions[0]).toMatchObject({
      observation: "equal",
      status: "usable",
    });

    const advance = submit(owner, capture(membership), epoch(2));
    expect(advance.decisions).toEqual([
      { epoch: epoch(2), status: "superseded" },
    ]);
    expect(target.dispatched).toBe(1);
    expect(capture(membership).expectedEpoch).toEqual(epoch(2));

    expect(
      submit(owner, capture(membership), epoch(1)).decisions,
    ).toEqual([{ reason: "stale", status: "discarded" }]);
    expect(
      submit(owner, capture(membership), epoch(2, "other")).decisions,
    ).toEqual([
      { reason: "token-conflict", status: "discarded" },
    ]);
    for (const malformed of [
      null,
      {},
      { generation: -1, token: "bad" },
      { generation: 3, token: "\ud800" },
    ]) {
      expect(
        submit(owner, capture(membership), malformed).decisions,
      ).toEqual([{ reason: "malformed", status: "discarded" }]);
    }
  });

  it("claims captures once and keeps immediate rejection callback-free", () => {
    const owner = coordinator();
    const membership = active(owner, "scope");
    const oneUse = capture(membership);
    let callbackCalls = 0;
    expect(
      owner.submitResponseEpoch(oneUse, epoch(1), () => {
        callbackCalls += 1;
        const replay = owner.submitResponseEpoch(
          oneUse,
          epoch(1),
          () => {
            callbackCalls += 100;
          },
        );
        expect(replay).toEqual({
          decision: { reason: "retired", status: "discarded" },
          status: "settled",
        });
      }),
    ).toEqual({ status: "submitted" });
    expect(callbackCalls).toBe(1);
    expect(
      owner.submitResponseEpoch(oneUse, epoch(1), () => {
        callbackCalls += 100;
      }),
    ).toEqual({
      decision: { reason: "retired", status: "discarded" },
      status: "settled",
    });
    expect(callbackCalls).toBe(1);

    for (const forged of [
      null,
      {},
      { ...capture(membership) },
    ]) {
      expect(
        owner.submitResponseEpoch(forged, epoch(1), () => {
          callbackCalls += 100;
        }),
      ).toEqual({
        decision: { reason: "malformed", status: "discarded" },
        status: "settled",
      });
    }
    expect(callbackCalls).toBe(1);
  });

  it("supersedes equal-current work captured before an accepted change", () => {
    const harness = listenerProvider();
    const owner = coordinator(harness.subscribe);
    const membership = active(owner, "scope");
    submit(owner, capture(membership), epoch(1));
    const beforeInvalidation = capture(membership);
    harness.listeners[0]?.(invalidation(2));
    expect(
      submit(owner, beforeInvalidation, epoch(2)).decisions,
    ).toEqual([{ epoch: epoch(2), status: "superseded" }]);

    const beforeResponse = capture(membership);
    expect(
      submit(owner, capture(membership), epoch(3)).decisions,
    ).toEqual([{ epoch: epoch(3), status: "superseded" }]);
    expect(submit(owner, beforeResponse, epoch(3)).decisions).toEqual([
      { epoch: epoch(3), status: "superseded" },
    ]);
  });

  it("rejects cross-coordinator, retired, and cross-incarnation captures", () => {
    const provider = capturedProvider();
    const createdA = createSqlCatalogEpochCoordinator(provider);
    const createdB = createSqlCatalogEpochCoordinator(provider);
    if (createdA.status !== "created" || createdB.status !== "created") {
      throw new Error("Expected coordinator fixtures");
    }
    const first = active(createdA.coordinator, "scope");
    const stale = capture(first);
    expect(
      createdB.coordinator.submitResponseEpoch(
        stale,
        epoch(1),
        () => {
          throw new Error("must not run");
        },
      ),
    ).toEqual({
      decision: { reason: "malformed", status: "discarded" },
      status: "settled",
    });
    first.dispose();
    active(createdA.coordinator, "scope");
    expect(
      createdA.coordinator.submitResponseEpoch(
        stale,
        epoch(1),
        () => {
          throw new Error("must not run");
        },
      ),
    ).toEqual({
      decision: { reason: "retired", status: "discarded" },
      status: "settled",
    });
  });

  it("fails closed when hostile response decoding retires membership or coordinator", () => {
    const memberOwner = coordinator();
    const member = active(memberOwner, "scope");
    const memberEpoch = new Proxy(epoch(1), {
      ownKeys(value) {
        member.dispose();
        return Reflect.ownKeys(value);
      },
    });
    const retired = submit(
      memberOwner,
      capture(member),
      memberEpoch,
    );
    expect(retired.result).toEqual({ status: "submitted" });
    expect(retired.decisions).toEqual([
      { reason: "retired", status: "discarded" },
    ]);

    const serviceOwner = coordinator();
    const serviceMember = active(serviceOwner, "scope");
    const serviceEpoch = new Proxy(epoch(1), {
      ownKeys(value) {
        serviceOwner.dispose();
        return Reflect.ownKeys(value);
      },
    });
    const disposed = submit(
      serviceOwner,
      capture(serviceMember),
      serviceEpoch,
    );
    expect(disposed.result).toEqual({ status: "submitted" });
    expect(disposed.decisions).toEqual([
      { reason: "disposed", status: "discarded" },
    ]);
  });
});

describe("subscription invalidation ordering and isolation", () => {
  it("classifies baseline/equal/advance while preserving state-before-listener and insertion order", () => {
    const harness = listenerProvider();
    const owner = coordinator(harness.subscribe);
    const order: string[] = [];
    let first: SqlCatalogScopeMembership;
    const firstTarget: SqlCatalogRevisionTarget = {
      prepareCatalogChange: () => {
        order.push(`prepare-a:${capture(first).expectedEpoch?.generation}`);
        return () => {
          order.push(
            `dispatch-a:${capture(first).expectedEpoch?.generation}`,
          );
        };
      },
    };
    first = active(owner, "scope", firstTarget);
    const second = active(owner, "scope", {
      prepareCatalogChange: () => {
        order.push("prepare-b");
        return () => order.push("dispatch-b");
      },
    });
    const notify = harness.listeners[0];
    notify?.(invalidation(1));
    notify?.(invalidation(1));
    notify?.(invalidation(0));
    notify?.(invalidation(1, "conflict"));
    notify?.(invalidation(2));
    expect(order).toEqual([
      "prepare-a:1",
      "prepare-b",
      "dispatch-a:1",
      "dispatch-b",
      "prepare-a:2",
      "prepare-b",
      "dispatch-a:2",
      "dispatch-b",
    ]);
    expect(capture(second).expectedEpoch).toEqual(epoch(2));
  });

  it("includes members activated after a reentrant invalidation is queued", () => {
    const harness = listenerProvider();
    const owner = coordinator(harness.subscribe);
    const joinedCounter = counterTarget();
    let joined: SqlCatalogScopeMembership | undefined;
    let joinedAtActivation:
      | SqlCatalogEpochCapture["expectedEpoch"]
      | undefined;
    let firstPrepared = 0;
    let firstDispatched = 0;
    const first = active(owner, "scope", {
      prepareCatalogChange: () => {
        firstPrepared += 1;
        return () => {
          firstDispatched += 1;
          if (firstDispatched !== 1) return;
          harness.listeners[0]?.(invalidation(2));
          joined = active(owner, "scope", {
            ...joinedCounter.target,
          });
          joinedAtActivation = capture(joined).expectedEpoch;
        };
      },
    });

    harness.listeners[0]?.(invalidation(1));
    expect(joinedAtActivation).toEqual(epoch(1));
    expect({ firstDispatched, firstPrepared }).toEqual({
      firstDispatched: 2,
      firstPrepared: 2,
    });
    expect(joinedCounter).toMatchObject({
      dispatched: 1,
      prepared: 1,
    });
    expect(capture(first).expectedEpoch).toEqual(epoch(2));
    expect(capture(joined ?? first).expectedEpoch).toEqual(epoch(2));
  });

  it("isolates listener failure and skips a member disposed by an earlier listener", () => {
    const harness = listenerProvider();
    const owner = coordinator(harness.subscribe);
    const events: string[] = [];
    let second: SqlCatalogScopeMembership;
    active(owner, "scope", {
      prepareCatalogChange: () => () => {
        events.push("first");
        second.dispose();
        throw new Error("listener failure");
      },
    });
    second = active(owner, "scope", {
      prepareCatalogChange: () => () => events.push("second"),
    });
    active(owner, "scope", {
      prepareCatalogChange: () => {
        throw new Error("prepare failure");
      },
    });
    active(owner, "scope", {
      prepareCatalogChange: () => () => events.push("last"),
    });
    expect(() =>
      harness.listeners[0]?.(invalidation(1)),
    ).not.toThrow();
    expect(events).toEqual(["first", "last"]);
  });

  it("skips a queued audience member disposed during preparation", () => {
    const harness = listenerProvider();
    const owner = coordinator(harness.subscribe);
    const events: string[] = [];
    let second: SqlCatalogScopeMembership;
    active(owner, "scope", {
      prepareCatalogChange: () => {
        events.push("prepare-first");
        second.dispose();
        return () => events.push("dispatch-first");
      },
    });
    second = active(owner, "scope", {
      prepareCatalogChange: () => {
        events.push("prepare-second");
        return () => events.push("dispatch-second");
      },
    });
    harness.listeners[0]?.(invalidation(1));
    expect(events).toEqual([
      "prepare-first",
      "dispatch-first",
    ]);
  });

  it("retires failed revision targets without blocking live members or early cleanup", () => {
    const harness = listenerProvider();
    const owner = coordinator(harness.subscribe);
    const nullTarget = active(owner, "scope", {
      prepareCatalogChange: () => null,
    });
    const throwingTarget = active(owner, "scope", {
      prepareCatalogChange: () => {
        throw new Error("prepare failed");
      },
    });
    const good = counterTarget();
    const goodMembership = active(owner, "scope", good.target);

    harness.listeners[0]?.(invalidation(1));
    expect(nullTarget.captureEpoch()).toEqual({
      reason: "disposed",
      status: "unavailable",
    });
    expect(throwingTarget.captureEpoch()).toEqual({
      reason: "disposed",
      status: "unavailable",
    });
    expect(good).toMatchObject({ dispatched: 1, prepared: 1 });
    expect(capture(goodMembership).expectedEpoch).toEqual(epoch(1));
    expect(harness.cleanupCalls).toBe(0);

    nullTarget.dispose();
    throwingTarget.dispose();
    expect(harness.cleanupCalls).toBe(0);
    goodMembership.dispose();
    expect(harness.cleanupCalls).toBe(1);
  });

  it("fails closed against hostile decode reentrancy without reversing epochs", () => {
    const harness = listenerProvider();
    const owner = coordinator(harness.subscribe);
    const observed: number[] = [];
    const membership = active(owner, "scope", {
      prepareCatalogChange: () => () => {
        const generation = capture(membership).expectedEpoch?.generation;
        if (generation !== undefined) observed.push(generation);
      },
    });
    const hostileEpoch = new Proxy(epoch(1), {
      ownKeys(target) {
        harness.listeners[0]?.(invalidation(2));
        return Reflect.ownKeys(target);
      },
    });
    harness.listeners[0]?.({ epoch: hostileEpoch });
    expect(observed).toEqual([1]);
    expect(capture(membership).expectedEpoch).toEqual(epoch(1));
  });

  it("drops decoded work if hostile decoding retires its subscription", () => {
    const harness = listenerProvider();
    const owner = coordinator(harness.subscribe);
    const target = counterTarget();
    const membership = active(owner, "scope", target.target);
    const hostileEpoch = new Proxy(epoch(1), {
      ownKeys(value) {
        membership.dispose();
        return Reflect.ownKeys(value);
      },
    });
    expect(() =>
      harness.listeners[0]?.({ epoch: hostileEpoch }),
    ).not.toThrow();
    expect(target.dispatched).toBe(0);
    expect(membership.captureEpoch()).toEqual({
      reason: "disposed",
      status: "unavailable",
    });
  });

  it("fans higher responses out atomically and drains reentrant responses FIFO", () => {
    const owner = coordinator();
    const events: string[] = [];
    let first: SqlCatalogScopeMembership;
    let reentered = false;
    first = active(owner, "scope", {
      prepareCatalogChange: () => {
        events.push(
          `prepare-a:${capture(first).expectedEpoch?.generation}`,
        );
        return () => {
          events.push("dispatch-a");
          if (!reentered) {
            reentered = true;
            const nested = owner.submitResponseEpoch(
              capture(first),
              epoch(3),
              (decision) => events.push(`decision-${decision.status}`),
            );
            expect(nested).toEqual({ status: "submitted" });
          }
        };
      },
    });
    const second = active(owner, "scope", {
      prepareCatalogChange: () => {
        events.push(
          `prepare-b:${capture(first).expectedEpoch?.generation}`,
        );
        return () => events.push("dispatch-b");
      },
    });
    submit(owner, capture(first), epoch(1));
    const result = owner.submitResponseEpoch(
      capture(first),
      epoch(2),
      (decision) => events.push(`decision-${decision.status}`),
    );
    expect(result).toEqual({ status: "submitted" });
    expect(events).toEqual([
      "prepare-a:2",
      "prepare-b:2",
      "decision-superseded",
      "dispatch-a",
      "dispatch-b",
      "prepare-a:3",
      "prepare-b:3",
      "decision-superseded",
      "dispatch-a",
      "dispatch-b",
    ]);
    expect(capture(first).expectedEpoch).toEqual(epoch(3));
    expect(capture(second).expectedEpoch).toEqual(epoch(3));
  });

  it("includes members activated after a higher response is queued", () => {
    const harness = listenerProvider();
    const owner = coordinator(harness.subscribe);
    const decisions: SqlCatalogResponseEpochDecision[] = [];
    const joinedCounter = counterTarget();
    let admission: SqlCatalogResponseEpochSubmissionResult | undefined;
    let joined: SqlCatalogScopeMembership | undefined;
    let joinedAtActivation:
      | SqlCatalogEpochCapture["expectedEpoch"]
      | undefined;
    let firstPrepared = 0;
    let firstDispatched = 0;
    let responseCapture: SqlCatalogEpochCapture;
    const first = active(owner, "scope", {
      prepareCatalogChange: () => {
        firstPrepared += 1;
        return () => {
          firstDispatched += 1;
          if (firstDispatched !== 1) return;
          admission = owner.submitResponseEpoch(
            responseCapture,
            epoch(2),
            (decision) => decisions.push(decision),
          );
          joined = active(owner, "scope", joinedCounter.target);
          joinedAtActivation = capture(joined).expectedEpoch;
        };
      },
    });
    responseCapture = capture(first);

    harness.listeners[0]?.(invalidation(1));
    expect(admission).toEqual({ status: "submitted" });
    expect(joinedAtActivation).toEqual(epoch(1));
    expect(decisions).toEqual([
      { epoch: epoch(2), status: "superseded" },
    ]);
    expect({ firstDispatched, firstPrepared }).toEqual({
      firstDispatched: 2,
      firstPrepared: 2,
    });
    expect(joinedCounter).toMatchObject({
      dispatched: 1,
      prepared: 1,
    });
    expect(capture(first).expectedEpoch).toEqual(epoch(2));
    expect(capture(joined ?? first).expectedEpoch).toEqual(epoch(2));
  });

  it("does not dispatch a higher response after preparation disposes the coordinator", () => {
    const owner = coordinator();
    let dispatchCalls = 0;
    let disposeDuringPrepare = false;
    const membership = active(owner, "scope", {
      prepareCatalogChange: () => {
        if (disposeDuringPrepare) owner.dispose();
        return () => {
          dispatchCalls += 1;
        };
      },
    });
    submit(owner, capture(membership), epoch(1));
    disposeDuringPrepare = true;
    const outcome = submit(owner, capture(membership), epoch(2));
    expect(outcome.result).toEqual({ status: "submitted" });
    expect(outcome.decisions).toEqual([
      { reason: "disposed", status: "discarded" },
    ]);
    expect(dispatchCalls).toBe(0);
  });

  it("discards a higher response whose capture retires during preparation", () => {
    const owner = coordinator();
    let retireDuringPrepare = false;
    let dispatchCalls = 0;
    let membership: SqlCatalogScopeMembership;
    membership = active(owner, "scope", {
      prepareCatalogChange: () => {
        if (retireDuringPrepare) membership.dispose();
        return () => {
          dispatchCalls += 1;
        };
      },
    });
    submit(owner, capture(membership), epoch(1));
    retireDuringPrepare = true;

    const outcome = submit(owner, capture(membership), epoch(2));
    expect(outcome.result).toEqual({ status: "submitted" });
    expect(outcome.decisions).toEqual([
      { reason: "retired", status: "discarded" },
    ]);
    expect(dispatchCalls).toBe(0);
    expect(membership.captureEpoch()).toEqual({
      reason: "disposed",
      status: "unavailable",
    });
  });

  it("settles a retired response before cleaning a last membership disposed during preparation", () => {
    const events: string[] = [];
    let disposeDuringPrepare = false;
    let membership: SqlCatalogScopeMembership;
    const owner = coordinator(
      () => () => {
        events.push("cleanup");
      },
    );
    membership = active(owner, "scope", {
      prepareCatalogChange: () => {
        if (disposeDuringPrepare) {
          events.push("prepare-start");
          membership.dispose();
          events.push("prepare-end");
        }
        return () => events.push("dispatch");
      },
    });
    submit(owner, capture(membership), epoch(1));
    disposeDuringPrepare = true;

    const result = owner.submitResponseEpoch(
      capture(membership),
      epoch(2),
      (decision) => {
        events.push(`decision-${decision.status}`);
      },
    );
    expect(result).toEqual({ status: "submitted" });
    expect(events).toEqual([
      "prepare-start",
      "prepare-end",
      "decision-discarded",
      "cleanup",
    ]);
  });

  it("discards an admitted response when its membership retires before processing", () => {
    const harness = listenerProvider();
    const owner = coordinator(harness.subscribe);
    const decisions: SqlCatalogResponseEpochDecision[] = [];
    let admission: SqlCatalogResponseEpochSubmissionResult | undefined;
    let membership: SqlCatalogScopeMembership;
    membership = active(owner, "scope", {
      prepareCatalogChange: () => () => {
        admission = owner.submitResponseEpoch(
          capture(membership),
          epoch(2),
          (decision) => decisions.push(decision),
        );
        membership.dispose();
      },
    });
    harness.listeners[0]?.(invalidation(1));
    expect(admission).toEqual({ status: "submitted" });
    expect(decisions).toEqual([
      { reason: "retired", status: "discarded" },
    ]);
  });
});

describe("hostile subscription lifecycle", () => {
  it("buffers a valid synchronous callback until subscribe succeeds", () => {
    let listenerCalls = 0;
    const owner = coordinator((_scope, notify) => {
      notify(invalidation(1));
      return () => {};
    });
    const membership = prepared(owner, "scope", {
      prepareCatalogChange: () => () => {
        listenerCalls += 1;
      },
    });
    expect(membership.activate()).toEqual({ status: "active" });
    expect(listenerCalls).toBe(1);
    expect(capture(membership).expectedEpoch).toEqual(epoch(1));
  });

  it("flushes a synchronous callback to every member active when subscribe commits", () => {
    let second: SqlCatalogScopeMembership;
    const firstCounter = counterTarget();
    const secondCounter = counterTarget();
    const owner = coordinator((_scope, notify) => {
      notify(invalidation(1));
      expect(second.activate()).toEqual({ status: "active" });
      return () => {};
    });
    const first = prepared(owner, "scope", firstCounter.target);
    second = prepared(owner, "scope", secondCounter.target);

    expect(first.activate()).toEqual({ status: "active" });
    expect(firstCounter).toMatchObject({ dispatched: 1, prepared: 1 });
    expect(secondCounter).toMatchObject({ dispatched: 1, prepared: 1 });
    expect(capture(first).expectedEpoch).toEqual(epoch(1));
    expect(capture(second).expectedEpoch).toEqual(epoch(1));
  });

  it("includes a member activated between two buffered synchronous invalidations", () => {
    const firstCounter = {
      dispatched: 0,
      prepared: 0,
    };
    const secondCounter = counterTarget();
    let second: SqlCatalogScopeMembership;
    let secondAtActivation:
      | SqlCatalogEpochCapture["expectedEpoch"]
      | undefined;
    const owner = coordinator((_scope, notify) => {
      notify(invalidation(1));
      notify(invalidation(2));
      return () => {};
    });
    const first = prepared(owner, "scope", {
      prepareCatalogChange: () => {
        firstCounter.prepared += 1;
        return () => {
          firstCounter.dispatched += 1;
          if (firstCounter.dispatched !== 1) return;
          expect(second.activate()).toEqual({ status: "active" });
          secondAtActivation = capture(second).expectedEpoch;
        };
      },
    });
    second = prepared(owner, "scope", secondCounter.target);

    expect(first.activate()).toEqual({ status: "active" });
    expect(secondAtActivation).toEqual(epoch(1));
    expect(firstCounter).toEqual({ dispatched: 2, prepared: 2 });
    expect(secondCounter).toMatchObject({
      dispatched: 1,
      prepared: 1,
    });
    expect(capture(first).expectedEpoch).toEqual(epoch(2));
    expect(capture(second).expectedEpoch).toEqual(epoch(2));
  });

  it("discards malformed buffered callbacks and all buffered work when subscribe fails", () => {
    let listenerCalls = 0;
    for (const subscribe of [
      (_scope: string, notify: RawInvalidationListener) => {
        notify({ epoch: { generation: -1, token: "bad" } });
        return () => {};
      },
      (_scope: string, notify: RawInvalidationListener) => {
        notify(invalidation(1));
        throw new Error("subscribe failed");
      },
      (_scope: string, notify: RawInvalidationListener) => {
        notify(invalidation(1));
        return null;
      },
    ]) {
      const owner = coordinator(subscribe);
      const membership = active(owner, "scope", {
        prepareCatalogChange: () => () => {
          listenerCalls += 1;
        },
      });
      expect(capture(membership).expectedEpoch).toBeNull();
    }
    expect(listenerCalls).toBe(0);
  });

  it("captures one cleanup closure, invokes it this-free once, and rejects non-functions without getters", () => {
    const receivers: unknown[] = [];
    let getterCalls = 0;
    const validOwner = coordinator(
      () =>
        function (this: unknown) {
          receivers.push(this);
        },
    );
    const membership = active(validOwner, "scope");
    membership.dispose();
    membership.dispose();
    expect(membership.activate()).toEqual({
      reason: "disposed",
      status: "unavailable",
    });
    expect(membership.captureEpoch()).toEqual({
      reason: "disposed",
      status: "unavailable",
    });
    validOwner.dispose();
    expect(receivers).toEqual([undefined]);

    const nonEnumerable = {};
    Object.defineProperty(nonEnumerable, "dispose", {
      enumerable: false,
      value: () => {},
    });
    const invalidCleanupValues: unknown[] = [
      {},
      Object.create({ dispose() {} }),
      nonEnumerable,
      new Proxy(
        { dispose() {} },
        {
          getOwnPropertyDescriptor() {
            throw new Error("hostile");
          },
        },
      ),
      {
        get dispose() {
          getterCalls += 1;
          return () => {};
        },
      },
    ];
    for (const cleanupValue of invalidCleanupValues) {
      const owner = coordinator(() => cleanupValue);
      expect(active(owner, "scope").captureEpoch().status).toBe(
        "captured",
      );
    }
    expect(getterCalls).toBe(0);
  });

  it("isolates thrown cleanup and retains no live callback after failed subscribe", () => {
    let retained: RawInvalidationListener | undefined;
    const owner = coordinator((_scope, notify) => {
      retained = notify;
      return () => {
        throw new Error("cleanup failed");
      };
    });
    const target = counterTarget();
    const membership = active(owner, "scope", target.target);
    expect(() => membership.dispose()).not.toThrow();
    retained?.(invalidation(1));
    expect(target.dispatched).toBe(0);

    let failedRetained: RawInvalidationListener | undefined;
    const failedOwner = coordinator((_scope, notify) => {
      failedRetained = notify;
      return null;
    });
    const failedTarget = counterTarget();
    active(failedOwner, "scope", failedTarget.target);
    failedRetained?.(invalidation(1));
    expect(failedTarget.dispatched).toBe(0);
  });

  it("drains rejected and hostile cleanup results after making state inert", async () => {
    let asyncCleanupCalls = 0;
    const rejectingOwner = coordinator(
      () => async () => {
        asyncCleanupCalls += 1;
        throw new Error("async cleanup failed");
      },
    );
    const rejectingMembership = active(rejectingOwner, "scope");
    rejectingMembership.dispose();
    rejectingMembership.dispose();

    let applyCalls = 0;
    let thenReads = 0;
    const thenProperty = ["th", "en"].join("");
    const hostileResult = Object.defineProperty({}, thenProperty, {
      get() {
        thenReads += 1;
        throw new Error("hostile then getter");
      },
    });
    const hostileCleanup = new Proxy(() => hostileResult, {
      apply(target, receiver, argumentsList) {
        applyCalls += 1;
        expect(receiver).toBeUndefined();
        return Reflect.apply(target, receiver, argumentsList);
      },
    });
    const hostileOwner = coordinator(() => hostileCleanup);
    const hostileMembership = active(hostileOwner, "scope");
    hostileMembership.dispose();
    hostileMembership.dispose();

    let thenCalls = 0;
    let reentrantOwner: SqlCatalogEpochCoordinator;
    const reentrantResult = Object.defineProperty(
      {},
      thenProperty,
      {
        value: (resolve: () => void): void => {
          thenCalls += 1;
          const replacement = active(
            reentrantOwner,
            "replacement",
          );
          replacement.dispose();
          resolve();
        },
      },
    );
    const reentrantCleanup = () => reentrantResult;
    let reentrantSubscriptions = 0;
    reentrantOwner = coordinator(() => {
      reentrantSubscriptions += 1;
      return reentrantSubscriptions === 1
        ? reentrantCleanup
        : () => {};
    });
    active(reentrantOwner, "scope").dispose();

    await Promise.resolve();
    await Promise.resolve();
    expect(asyncCleanupCalls).toBe(1);
    expect(applyCalls).toBe(1);
    expect(thenReads).toBe(1);
    expect(thenCalls).toBe(1);
  });

  it("retries a failed subscription only in a new last-owner incarnation", () => {
    const listeners: RawInvalidationListener[] = [];
    let attempts = 0;
    const owner = coordinator((_scope, notify) => {
      attempts += 1;
      listeners.push(notify);
      if (attempts === 1) return null;
      return () => {};
    });
    const first = active(owner, "scope");
    const second = active(owner, "scope");
    expect(attempts).toBe(1);
    first.dispose();
    expect(attempts).toBe(1);
    second.dispose();
    const replacement = active(owner, "scope");
    expect(attempts).toBe(2);
    listeners[0]?.(invalidation(10));
    expect(capture(replacement).expectedEpoch).toBeNull();
    listeners[1]?.(invalidation(1));
    expect(capture(replacement).expectedEpoch).toEqual(epoch(1));
  });

  it("retires old callbacks before reentrant cleanup installs a replacement", () => {
    const listeners: RawInvalidationListener[] = [];
    const memberships: SqlCatalogScopeMembership[] = [];
    let owner: SqlCatalogEpochCoordinator;
    const provider = (_scope: string, notify: RawInvalidationListener) => {
      listeners.push(notify);
      return () => {
        if (memberships.length === 1) {
          memberships.push(active(owner, "scope"));
        }
      };
    };
    owner = coordinator(provider);
    memberships.push(active(owner, "scope"));
    memberships[0]?.dispose();
    expect(listeners).toHaveLength(2);
    listeners[0]?.(invalidation(10));
    expect(
      capture(memberships[1] ?? memberships[0]!).expectedEpoch,
    ).toBeNull();
    listeners[1]?.(invalidation(1));
    expect(
      capture(memberships[1] ?? memberships[0]!).expectedEpoch,
    ).toEqual(epoch(1));
  });

  it("returns unavailable when synchronous activation work disposes membership or coordinator", () => {
    let membership: SqlCatalogScopeMembership;
    const memberOwner = coordinator((_scope, notify) => {
      notify(invalidation(1));
      return () => {};
    });
    membership = prepared(memberOwner, "scope", {
      prepareCatalogChange: () => () => membership.dispose(),
    });
    expect(membership.activate()).toEqual({
      reason: "disposed",
      status: "unavailable",
    });

    let service: SqlCatalogEpochCoordinator;
    service = coordinator((_scope, notify) => {
      notify(invalidation(1));
      return () => {};
    });
    const serviceMembership = prepared(service, "scope", {
      prepareCatalogChange: () => () => service.dispose(),
    });
    expect(serviceMembership.activate()).toEqual({
      reason: "coordinator-disposed",
      status: "unavailable",
    });
  });

  it("quarantines 257 callbacks across microtasks and cleans an install-time overload once", async () => {
    let notify: RawInvalidationListener | undefined;
    let cleanupCalls = 0;
    const owner = coordinator((_scope, listener) => {
      notify = listener;
      return () => {
        cleanupCalls += 1;
      };
    });
    const membership = active(owner, "scope");
    for (
      let index = 0;
      index < MAX_CATALOG_CALLBACKS_PER_RESET_WINDOW;
      index += 1
    ) {
      await Promise.resolve();
      notify?.({ malformed: index });
    }
    await Promise.resolve();
    notify?.(invalidation(1));
    expect(cleanupCalls).toBe(1);
    expect(capture(membership).expectedEpoch).toBeNull();

    let installCleanup = 0;
    const installOwner = coordinator((_scope, listener) => {
      for (
        let index = 0;
        index <= MAX_CATALOG_CALLBACKS_PER_RESET_WINDOW;
        index += 1
      ) {
        listener({ malformed: index });
      }
      return () => {
        installCleanup += 1;
      };
    });
    active(installOwner, "scope");
    expect(installCleanup).toBe(1);
  });

  it("resets callback allowance only after its reset timer fires", async () => {
    let notify: RawInvalidationListener | undefined;
    const owner = coordinator((_scope, listener) => {
      notify = listener;
      return () => {};
    });
    const membership = active(owner, "scope");
    for (
      let index = 0;
      index < MAX_CATALOG_CALLBACKS_PER_RESET_WINDOW;
      index += 1
    ) {
      notify?.({ malformed: index });
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    notify?.(invalidation(1));
    expect(capture(membership).expectedEpoch).toEqual(epoch(1));
  });

  it("conservatively counts an earlier queued MessageChannel task in the reset window", async () => {
    let notify: RawInvalidationListener | undefined;
    let cleanupCalls = 0;
    const owner = coordinator((_scope, listener) => {
      notify = listener;
      return () => {
        cleanupCalls += 1;
      };
    });
    const membership = active(owner, "scope");
    const channel = new MessageChannel();
    const messageTask = new Promise<void>((resolve) => {
      channel.port2.once("message", () => {
        notify?.(invalidation(1));
        resolve();
      });
    });
    channel.port1.postMessage("queued-before-reset-timer");
    for (
      let index = 0;
      index < MAX_CATALOG_CALLBACKS_PER_RESET_WINDOW;
      index += 1
    ) {
      notify?.({ malformed: index });
    }
    await messageTask;
    channel.port1.close();
    channel.port2.close();

    expect(cleanupCalls).toBe(1);
    expect(capture(membership).expectedEpoch).toBeNull();
  });
});

describe("service disposal and bounded command draining", () => {
  it("deduplicates install-time overload cleanup within one outer barrier", () => {
    let driverNotify: RawInvalidationListener | undefined;
    let overloadedCleanupCalls = 0;
    let driverCleanupCalls = 0;
    let preparedOverloads = false;
    let owner: SqlCatalogEpochCoordinator;
    owner = coordinator((scope, notify) => {
      if (scope === "driver") {
        driverNotify = notify;
      } else {
        for (
          let index = 0;
          index <= MAX_CATALOG_CALLBACKS_PER_RESET_WINDOW;
          index += 1
        ) {
          notify({ malformed: index });
        }
      }
      return () => {
        if (scope === "driver") {
          driverCleanupCalls += 1;
        } else {
          overloadedCleanupCalls += 1;
        }
      };
    });
    const driver = active(owner, "driver", {
      prepareCatalogChange: () => {
        if (!preparedOverloads) {
          preparedOverloads = true;
          for (
            let index = 0;
            index < MAX_CATALOG_CLEANUPS_PER_BARRIER;
            index += 1
          ) {
            active(owner, `overloaded-${index}`).dispose();
          }
        }
        return () => {};
      },
    });

    driverNotify?.(invalidation(1));
    expect(overloadedCleanupCalls).toBe(
      MAX_CATALOG_CLEANUPS_PER_BARRIER,
    );
    expect(driverCleanupCalls).toBe(0);
    expect(capture(driver).expectedEpoch).toEqual(epoch(1));
    expect(
      owner.prepareScopeMembership(
        "after-deduplicated-cleanup",
        counterTarget().target,
      ).status,
    ).toBe("prepared");

    driver.dispose();
    expect(driverCleanupCalls).toBe(1);
  });

  it("quarantines cleanup reentrancy at the documented barrier limit", () => {
    const listeners = new Map<string, RawInvalidationListener>();
    let cleanupCalls = 0;
    let cleanupDepth = 0;
    let lateCleanupCalls = 0;
    let maximumCleanupDepth = 0;
    let sentinelCleanupCalls = 0;
    let subscriptionCalls = 0;
    let owner: SqlCatalogEpochCoordinator;
    owner = coordinator((scope, notify) => {
      subscriptionCalls += 1;
      listeners.set(scope, notify);
      const installsAfterCleanupLimit =
        subscriptionCalls ===
        MAX_CATALOG_CLEANUPS_PER_BARRIER + 2;
      if (installsAfterCleanupLimit) {
        for (
          let index = 0;
          index <= MAX_CATALOG_CALLBACKS_PER_RESET_WINDOW;
          index += 1
        ) {
          notify({ malformed: index });
        }
      }
      return () => {
        if (installsAfterCleanupLimit) {
          lateCleanupCalls += 1;
          return;
        }
        cleanupDepth += 1;
        maximumCleanupDepth = Math.max(
          maximumCleanupDepth,
          cleanupDepth,
        );
        cleanupCalls += 1;
        if (scope === "sentinel") {
          sentinelCleanupCalls += 1;
        } else {
          const next = active(
            owner,
            `cleanup-chain-${subscriptionCalls}`,
          );
          next.dispose();
        }
        cleanupDepth -= 1;
      };
    });
    const sentinelTarget = counterTarget();
    const sentinel = active(
      owner,
      "sentinel",
      sentinelTarget.target,
    );
    active(owner, "cleanup-chain-0", {
      prepareCatalogChange: () => null,
    });

    listeners.get("cleanup-chain-0")?.(invalidation(1));
    expect(subscriptionCalls).toBe(
      MAX_CATALOG_CLEANUPS_PER_BARRIER + 2,
    );
    expect(cleanupCalls).toBe(
      MAX_CATALOG_CLEANUPS_PER_BARRIER,
    );
    expect(maximumCleanupDepth).toBe(1);
    expect(lateCleanupCalls).toBe(0);
    expect(sentinelCleanupCalls).toBe(0);
    expect(sentinel.captureEpoch()).toEqual({
      reason: "disposed",
      status: "unavailable",
    });
    expect(
      owner.prepareScopeMembership(
        "after-overflow",
        counterTarget().target,
      ),
    ).toEqual({
      reason: "disposed",
      status: "unavailable",
    });

    listeners.get("sentinel")?.(invalidation(2));
    owner.dispose();
    sentinel.dispose();
    expect(sentinelTarget.dispatched).toBe(0);
    expect(cleanupCalls).toBe(
      MAX_CATALOG_CLEANUPS_PER_BARRIER,
    );
    expect(lateCleanupCalls).toBe(0);
    expect(sentinelCleanupCalls).toBe(0);
  });

  it("retires callbacks, members, and cleanup exactly once on disposal", () => {
    const harness = listenerProvider();
    const owner = coordinator(harness.subscribe);
    const target = counterTarget();
    const membership = active(owner, "scope", target.target);
    const retained = harness.listeners[0];
    owner.dispose();
    owner.dispose();
    expect(harness.cleanupCalls).toBe(1);
    retained?.(invalidation(1));
    expect(target.dispatched).toBe(0);
    expect(membership.activate()).toEqual({
      reason: "coordinator-disposed",
      status: "unavailable",
    });
    expect(membership.captureEpoch()).toEqual({
      reason: "disposed",
      status: "unavailable",
    });
    membership.dispose();
    membership.dispose();
    expect(harness.cleanupCalls).toBe(1);
    expect(
      owner.prepareScopeMembership("new", target.target),
    ).toEqual({
      reason: "disposed",
      status: "unavailable",
    });
    let callbackCalls = 0;
    expect(
      owner.submitResponseEpoch({}, epoch(1), () => {
        callbackCalls += 1;
      }),
    ).toEqual({
      decision: { reason: "disposed", status: "discarded" },
      status: "settled",
    });
    expect(callbackCalls).toBe(0);
  });

  it("retires the provider callback before reentrant cleanup", () => {
    let retained: RawInvalidationListener | undefined;
    let cleanupCalls = 0;
    let payloadReads = 0;
    const hostilePayload = new Proxy(
      {},
      {
        get(target, property, receiver) {
          payloadReads += 1;
          return Reflect.get(target, property, receiver);
        },
        getOwnPropertyDescriptor(target, property) {
          payloadReads += 1;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
        ownKeys(target) {
          payloadReads += 1;
          return Reflect.ownKeys(target);
        },
      },
    );
    const owner = coordinator((_scope, listener) => {
      retained = listener;
      return () => {
        cleanupCalls += 1;
        retained?.(hostilePayload);
      };
    });
    const target = counterTarget();
    const membership = active(owner, "scope", target.target);

    expect(() => owner.dispose()).not.toThrow();
    owner.dispose();
    expect(cleanupCalls).toBe(1);
    expect(payloadReads).toBe(0);
    expect(target.dispatched).toBe(0);

    expect(() => retained?.(hostilePayload)).not.toThrow();
    expect(payloadReads).toBe(0);
    expect(target.dispatched).toBe(0);
    expect(membership.activate()).toEqual({
      reason: "coordinator-disposed",
      status: "unavailable",
    });
    expect(membership.captureEpoch()).toEqual({
      reason: "disposed",
      status: "unavailable",
    });
    membership.dispose();
    membership.dispose();
    expect(cleanupCalls).toBe(1);
    expect(
      owner.prepareScopeMembership("new", target.target),
    ).toEqual({
      reason: "disposed",
      status: "unavailable",
    });
    let callbackCalls = 0;
    expect(
      owner.submitResponseEpoch({}, epoch(2), () => {
        callbackCalls += 1;
      }),
    ).toEqual({
      decision: { reason: "disposed", status: "discarded" },
      status: "settled",
    });
    expect(callbackCalls).toBe(0);
  });

  it("settles queued response sinks as disposed without recursive callbacks", () => {
    const harness = listenerProvider();
    const owner = coordinator(harness.subscribe);
    const decisions: SqlCatalogResponseEpochDecision[] = [];
    let queuedResult: SqlCatalogResponseEpochSubmissionResult | undefined;
    const membership = active(owner, "scope", {
      prepareCatalogChange: () => () => {
        queuedResult = owner.submitResponseEpoch(
          capture(membership),
          epoch(2),
          (decision) => decisions.push(decision),
        );
        owner.dispose();
      },
    });
    harness.listeners[0]?.(invalidation(1));
    expect(queuedResult).toEqual({ status: "submitted" });
    expect(decisions).toEqual([
      { reason: "disposed", status: "discarded" },
    ]);
  });

  it("isolates thrown decision callbacks and continues draining", () => {
    const owner = coordinator();
    const membership = active(owner, "scope");
    expect(() =>
      owner.submitResponseEpoch(
        capture(membership),
        epoch(1),
        () => {
          throw new Error("consumer failure");
        },
      ),
    ).not.toThrow();
    const next = submit(owner, capture(membership), epoch(1));
    expect(next.decisions).toEqual([
      {
        epoch: epoch(1),
        observation: "equal",
        status: "usable",
      },
    ]);
  });

  it("bounds response commands and keeps overload rejection nonrecursive", () => {
    const harness = listenerProvider();
    const owner = coordinator(harness.subscribe);
    const membership = active(owner, "scope", {
      prepareCatalogChange: () => () => {
        const admitted: SqlCatalogEpochCapture[] = [];
        for (
          let index = 0;
          index < MAX_CATALOG_EPOCH_COMMANDS;
          index += 1
        ) {
          admitted.push(capture(membership));
        }
        for (const item of admitted) {
          expect(
            owner.submitResponseEpoch(item, epoch(1), () => {}),
          ).toEqual({ status: "submitted" });
        }
        let recursiveCalls = 0;
        const overflow = capture(membership);
        const result = owner.submitResponseEpoch(
          overflow,
          epoch(1),
          () => {
            recursiveCalls += 1;
            owner.submitResponseEpoch(
              capture(membership),
              epoch(1),
              () => {
                recursiveCalls += 1;
              },
            );
          },
        );
        expect(result).toEqual({
          decision: { reason: "overloaded", status: "discarded" },
          status: "settled",
        });
        expect(recursiveCalls).toBe(0);
        expect(
          owner.submitResponseEpoch(overflow, epoch(1), () => {
            recursiveCalls += 1;
          }),
        ).toEqual({
          decision: { reason: "retired", status: "discarded" },
          status: "settled",
        });
      },
    });
    harness.listeners[0]?.(invalidation(1));
    expect(capture(membership).expectedEpoch).toEqual(epoch(1));
  });

  it("caps one-at-a-time response chains by total admissions per drain", () => {
    const owner = coordinator();
    const membership = active(owner, "scope");
    const captures = Array.from(
      { length: MAX_CATALOG_EPOCH_COMMANDS + 1 },
      () => capture(membership),
    );
    let callbacks = 0;
    let callbackDepth = 0;
    let maximumCallbackDepth = 0;
    let overflow: SqlCatalogResponseEpochSubmissionResult | undefined;

    const onDecision = (): void => {
      callbackDepth += 1;
      maximumCallbackDepth = Math.max(
        maximumCallbackDepth,
        callbackDepth,
      );
      callbacks += 1;
      const next = captures[callbacks];
      if (next) {
        const result = owner.submitResponseEpoch(
          next,
          epoch(1),
          onDecision,
        );
        if (result.status === "settled") overflow = result;
      }
      callbackDepth -= 1;
    };

    const first = captures[0];
    if (!first) throw new Error("Expected an epoch capture");
    expect(
      owner.submitResponseEpoch(first, epoch(1), onDecision),
    ).toEqual({ status: "submitted" });
    expect(callbacks).toBe(MAX_CATALOG_EPOCH_COMMANDS);
    expect(maximumCallbackDepth).toBe(1);
    expect(overflow).toEqual({
      decision: { reason: "overloaded", status: "discarded" },
      status: "settled",
    });

    let afterDrain = 0;
    expect(
      owner.submitResponseEpoch(
        capture(membership),
        epoch(1),
        () => {
          afterDrain += 1;
        },
      ),
    ).toEqual({ status: "submitted" });
    expect(afterDrain).toBe(1);
  });

  it("quarantines the overflowing invalidation subscription and retires its queued commands", () => {
    const listeners = new Map<string, RawInvalidationListener>();
    const cleanupScopes: string[] = [];
    const owner = coordinator((scope, notify) => {
      listeners.set(scope, notify);
      return () => cleanupScopes.push(scope);
    });
    const stormMemberships = Array.from({ length: 5 }, (_, index) =>
      active(owner, `storm-${index}`),
    );
    let fired = false;
    active(owner, "trigger", {
      prepareCatalogChange: () => () => {
        if (fired) return;
        fired = true;
        for (let scopeIndex = 0; scopeIndex < 5; scopeIndex += 1) {
          const notify = listeners.get(`storm-${scopeIndex}`);
          for (let generation = 1; generation <= 205; generation += 1) {
            notify?.(invalidation(generation));
          }
        }
      },
    });
    listeners.get("trigger")?.(invalidation(1));
    expect(cleanupScopes).toEqual(["storm-4"]);
    for (const membership of stormMemberships.slice(0, 4)) {
      expect(capture(membership).expectedEpoch).toEqual(epoch(205));
    }
    expect(capture(stormMemberships[4]!).expectedEpoch).toBeNull();
  });
});
