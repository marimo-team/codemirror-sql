// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  createNodeSqlParserBrowserExecutor,
  type NodeSqlParserBrowserExecutorDeadlineScheduler,
  type NodeSqlParserBrowserExecutorEventType,
  type NodeSqlParserBrowserExecutorOptions,
  type NodeSqlParserBrowserExecutorOutcome,
  type NodeSqlParserBrowserExecutorSubmission,
  type NodeSqlParserBrowserExecutorWorker,
} from "../node-sql-parser-browser-executor.js";
import {
  decodeNodeSqlParserWireRequest,
  encodeNodeSqlParserWireBackendOutcome,
  encodeNodeSqlParserWireReady,
  type NodeSqlParserWireMessage,
  type NodeSqlParserWireRequest,
} from "../node-sql-parser-wire.js";

type WorkerListener = (event: unknown) => void;

interface ScheduledDeadline {
  readonly callback: () => void;
  readonly deadline: number;
  readonly handle: number;
}

class ManualDeadlineScheduler
  implements NodeSqlParserBrowserExecutorDeadlineScheduler
{
  readonly clearedHandles: number[] = [];
  readonly scheduledDelays: number[] = [];
  #deadlines = new Map<number, ScheduledDeadline>();
  #nextHandle = 1;
  #now = 0;

  clearTimeout(handle: unknown): void {
    if (typeof handle !== "number") {
      throw new TypeError("test scheduler received an invalid handle");
    }
    this.clearedHandles.push(handle);
    this.#deadlines.delete(handle);
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.scheduledDelays.push(delayMs);
    this.#deadlines.set(handle, {
      callback,
      deadline: this.#now + delayMs,
      handle,
    });
    return handle;
  }

  advanceBy(milliseconds: number): void {
    const target = this.#now + milliseconds;
    for (;;) {
      const next = [...this.#deadlines.values()]
        .filter(({ deadline }) => deadline <= target)
        .sort(
          (left, right) =>
            left.deadline - right.deadline ||
            left.handle - right.handle,
        )[0];
      if (next === undefined) {
        break;
      }
      this.#now = next.deadline;
      this.#deadlines.delete(next.handle);
      next.callback();
    }
    this.#now = target;
  }

  pendingCount(): number {
    return this.#deadlines.size;
  }
}

interface FakeWorkerFailures {
  readonly add?: NodeSqlParserBrowserExecutorEventType;
  readonly post?: boolean;
  readonly retainRemovedListeners?: boolean;
  readonly remove?: NodeSqlParserBrowserExecutorEventType;
  readonly terminate?: boolean;
}

class FakeWorker implements NodeSqlParserBrowserExecutorWorker {
  readonly posted: unknown[] = [];
  readonly removed: NodeSqlParserBrowserExecutorEventType[] = [];
  readonly failures: FakeWorkerFailures;
  #addHook:
    | ((type: NodeSqlParserBrowserExecutorEventType) => void)
    | undefined;
  #postHook: ((message: unknown) => void) | undefined;
  #listeners = new Map<
    NodeSqlParserBrowserExecutorEventType,
    Set<WorkerListener>
  >();
  #terminateCalls = 0;

  constructor(failures: FakeWorkerFailures = {}) {
    this.failures = failures;
  }

  addEventListener(
    type: NodeSqlParserBrowserExecutorEventType,
    listener: WorkerListener,
  ): void {
    if (this.failures.add === type) {
      throw new Error("private addEventListener failure");
    }
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
    this.#addHook?.(type);
  }

  dispatch(type: NodeSqlParserBrowserExecutorEventType, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
  }

  emit(message: unknown): void {
    this.dispatch("message", { data: message });
  }

  listenerCount(type?: NodeSqlParserBrowserExecutorEventType): number {
    if (type !== undefined) {
      return this.#listeners.get(type)?.size ?? 0;
    }
    return [...this.#listeners.values()].reduce(
      (count, listeners) => count + listeners.size,
      0,
    );
  }

  postMessage(message: unknown): void {
    if (this.failures.post) {
      throw new Error("private postMessage failure");
    }
    this.posted.push(message);
    this.#postHook?.(message);
  }

  removeEventListener(
    type: NodeSqlParserBrowserExecutorEventType,
    listener: WorkerListener,
  ): void {
    this.removed.push(type);
    if (!this.failures.retainRemovedListeners) {
      this.#listeners.get(type)?.delete(listener);
    }
    if (this.failures.remove === type) {
      throw new Error("private removeEventListener failure");
    }
  }

  terminate(): void {
    this.#terminateCalls += 1;
    if (this.failures.terminate) {
      throw new Error("private terminate failure");
    }
  }

  terminateCalls(): number {
    return this.#terminateCalls;
  }

  setPostHook(hook: ((message: unknown) => void) | undefined): void {
    this.#postHook = hook;
  }

  setAddHook(
    hook:
      | ((type: NodeSqlParserBrowserExecutorEventType) => void)
      | undefined,
  ): void {
    this.#addHook = hook;
  }
}

class FakeWorkerFactory {
  readonly created: FakeWorker[] = [];
  readonly queued: FakeWorker[] = [];
  #failure: Error | undefined;

  create = (): FakeWorker => {
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
    const worker = this.queued.shift() ?? new FakeWorker();
    this.created.push(worker);
    return worker;
  };

  enqueue(worker: FakeWorker): void {
    this.queued.push(worker);
  }

  fail(error = new Error("private worker factory failure")): void {
    this.#failure = error;
  }

  recover(): void {
    this.#failure = undefined;
  }
}

interface Harness {
  readonly factory: FakeWorkerFactory;
  readonly options: NodeSqlParserBrowserExecutorOptions;
  readonly scheduler: ManualDeadlineScheduler;
}

function harness(
  overrides: Partial<NodeSqlParserBrowserExecutorOptions> = {},
): Harness {
  const factory = new FakeWorkerFactory();
  const scheduler = new ManualDeadlineScheduler();
  return {
    factory,
    options: {
      deadlineScheduler: scheduler,
      executionDeadlineMs: 30,
      maxQueuedRequests: 2,
      maxQueuedTextUnits: 30,
      queueDeadlineMs: 20,
      startupDeadlineMs: 10,
      workerFactory: factory.create,
      ...overrides,
    },
    scheduler,
  };
}

function postedRequest(worker: FakeWorker, index = 0): NodeSqlParserWireRequest {
  const request = decodeNodeSqlParserWireRequest(worker.posted[index]);
  if (request === null) {
    throw new Error("test worker did not receive a valid request");
  }
  return request;
}

function createdWorker(
  factory: FakeWorkerFactory,
  index = 0,
): FakeWorker {
  const worker = factory.created[index];
  if (worker === undefined) {
    throw new Error(`test worker generation ${index} was not created`);
  }
  return worker;
}

function ready(worker: FakeWorker): void {
  worker.emit(encodeNodeSqlParserWireReady());
}

function respond(
  worker: FakeWorker,
  outcome:
    | { readonly kind: "parsed"; readonly statementKind: "query" }
    | { readonly kind: "syntax-rejected" }
    | {
        readonly kind: "unsupported";
        readonly reason: "multiple-statements" | "resource-limit";
      }
    | {
        readonly kind: "failed";
        readonly code: "backend" | "malformed-output" | "module-load";
      },
  index = 0,
): void {
  const backendOutcome =
    outcome.kind === "parsed"
      ? {
          ...outcome,
          root: Object.freeze({}),
        }
      : outcome.kind === "failed"
        ? {
            ...outcome,
            retryable: outcome.code === "module-load",
          }
      : outcome;
  worker.emit(
    encodeNodeSqlParserWireBackendOutcome(
      postedRequest(worker, index).requestId,
      backendOutcome,
    ),
  );
}

async function outcome(
  submission: NodeSqlParserBrowserExecutorSubmission,
): Promise<NodeSqlParserBrowserExecutorOutcome> {
  return submission.result;
}

async function expectPending(
  submission: NodeSqlParserBrowserExecutorSubmission,
): Promise<void> {
  const sentinel = Symbol("pending");
  expect(
    await Promise.race([
      submission.result,
      Promise.resolve(sentinel),
    ]),
  ).toBe(sentinel);
}

describe("node-sql-parser browser executor admission", () => {
  it("starts lazily, waits for ready, and sends a frozen closed request", async () => {
    const { factory, options, scheduler } = harness();
    const executor = createNodeSqlParserBrowserExecutor(options);

    expect(factory.created).toHaveLength(0);
    expect(scheduler.pendingCount()).toBe(0);

    const submission = executor.submit({
      grammar: "postgresql",
      text: "SELECT 1",
    });
    const worker = createdWorker(factory);
    expect(worker.posted).toHaveLength(0);
    expect(worker.listenerCount()).toBe(3);
    expect(scheduler.scheduledDelays).toStrictEqual([20, 10]);

    ready(worker);
    const request = postedRequest(worker);
    expect(request).toStrictEqual({
      grammar: "postgresql",
      kind: "parse",
      protocolVersion: 1,
      requestId: 1,
      text: "SELECT 1",
    });
    expect(Object.isFrozen(request)).toBe(true);

    respond(worker, {
      kind: "parsed",
      statementKind: "query",
    });
    const result = await outcome(submission);
    expect(result).toStrictEqual({
      kind: "parsed",
      statementKind: "query",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("runs one request at a time in FIFO order across grammars", async () => {
    const { factory, options } = harness({
      maxQueuedRequests: 3,
    });
    const executor = createNodeSqlParserBrowserExecutor(options);
    const first = executor.submit({
      grammar: "postgresql",
      text: "SELECT 1",
    });
    const second = executor.submit({
      grammar: "bigquery",
      text: "SELECT 2",
    });
    const third = executor.submit({
      grammar: "postgresql",
      text: "SELECT 3",
    });
    const worker = createdWorker(factory);

    ready(worker);
    expect(worker.posted).toHaveLength(1);
    expect(postedRequest(worker).text).toBe("SELECT 1");
    respond(worker, { kind: "syntax-rejected" });
    expect(await outcome(first)).toStrictEqual({
      kind: "syntax-rejected",
    });
    expect(worker.posted).toHaveLength(2);
    expect(postedRequest(worker, 1)).toMatchObject({
      grammar: "bigquery",
      text: "SELECT 2",
    });

    respond(worker, {
      kind: "unsupported",
      reason: "multiple-statements",
    }, 1);
    expect(await outcome(second)).toStrictEqual({
      kind: "unsupported",
      reason: "multiple-statements",
    });
    expect(postedRequest(worker, 2).text).toBe("SELECT 3");

    respond(worker, {
      kind: "parsed",
      statementKind: "query",
    }, 2);
    expect(await outcome(third)).toStrictEqual({
      kind: "parsed",
      statementKind: "query",
    });
  });

  it("handles a response dispatched synchronously from postMessage", async () => {
    const { factory, options, scheduler } = harness();
    const worker = new FakeWorker();
    factory.enqueue(worker);
    worker.setPostHook((value) => {
      const request = decodeNodeSqlParserWireRequest(value);
      if (request === null) {
        throw new Error("expected a valid request");
      }
      worker.emit(
        encodeNodeSqlParserWireBackendOutcome(request.requestId, {
          kind: "syntax-rejected",
        }),
      );
    });
    const executor = createNodeSqlParserBrowserExecutor(options);
    const submission = executor.submit({
      grammar: "postgresql",
      text: "SELECT 1",
    });

    ready(worker);
    expect(await outcome(submission)).toStrictEqual({
      kind: "syntax-rejected",
    });
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("bounds queued count without disturbing admitted work", async () => {
    const { factory, options } = harness({
      maxQueuedRequests: 1,
      maxQueuedTextUnits: 100,
    });
    const executor = createNodeSqlParserBrowserExecutor(options);
    const active = executor.submit({
      grammar: "postgresql",
      text: "active",
    });
    const worker = createdWorker(factory);
    ready(worker);
    const queued = executor.submit({
      grammar: "postgresql",
      text: "queued",
    });
    const rejected = executor.submit({
      grammar: "postgresql",
      text: "rejected",
    });

    expect(await outcome(rejected)).toStrictEqual({
      code: "queue-limit",
      kind: "failed",
    });
    expect(postedRequest(worker).text).toBe("active");
    respond(worker, { kind: "syntax-rejected" });
    expect(await outcome(active)).toStrictEqual({
      kind: "syntax-rejected",
    });
    expect(postedRequest(worker, 1).text).toBe("queued");
    respond(worker, { kind: "syntax-rejected" }, 1);
    expect(await outcome(queued)).toStrictEqual({
      kind: "syntax-rejected",
    });
  });

  it("bounds retained queued UTF-16 units independently of count", async () => {
    const { factory, options } = harness({
      maxQueuedRequests: 4,
      maxQueuedTextUnits: 4,
    });
    const executor = createNodeSqlParserBrowserExecutor(options);
    const active = executor.submit({
      grammar: "postgresql",
      text: "a",
    });
    const worker = createdWorker(factory);
    ready(worker);
    const twoAstralUnits = executor.submit({
      grammar: "postgresql",
      text: "😀",
    });
    const twoMore = executor.submit({
      grammar: "postgresql",
      text: "xy",
    });
    const overLimit = executor.submit({
      grammar: "postgresql",
      text: "z",
    });

    expect(await outcome(overLimit)).toStrictEqual({
      code: "queue-limit",
      kind: "failed",
    });
    respond(worker, { kind: "syntax-rejected" });
    await outcome(active);
    expect(postedRequest(worker, 1).text).toBe("😀");
    respond(worker, { kind: "syntax-rejected" }, 1);
    await outcome(twoAstralUnits);
    expect(postedRequest(worker, 2).text).toBe("xy");
    respond(worker, { kind: "syntax-rejected" }, 2);
    await outcome(twoMore);
  });

  it("rejects an oversized input without creating a worker", async () => {
    const { factory, options } = harness();
    const executor = createNodeSqlParserBrowserExecutor(options);
    const submission = executor.submit({
      grammar: "postgresql",
      text: "x".repeat(16 * 1024 + 1),
    });

    expect(await outcome(submission)).toStrictEqual({
      kind: "unsupported",
      reason: "resource-limit",
    });
    expect(factory.created).toHaveLength(0);
  });
});

describe("node-sql-parser browser executor deadlines and cancellation", () => {
  it("applies a startup deadline and retires a silent worker", async () => {
    const { factory, options, scheduler } = harness();
    const executor = createNodeSqlParserBrowserExecutor(options);
    const submission = executor.submit({
      grammar: "postgresql",
      text: "SELECT 1",
    });
    const worker = createdWorker(factory);

    scheduler.advanceBy(9);
    await expectPending(submission);
    scheduler.advanceBy(1);
    expect(await outcome(submission)).toStrictEqual({
      code: "startup-timeout",
      kind: "failed",
    });
    expect(worker.terminateCalls()).toBe(1);
    expect(worker.listenerCount()).toBe(0);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("measures queue time from admission without resetting on ready", async () => {
    const { factory, options, scheduler } = harness({
      queueDeadlineMs: 20,
      startupDeadlineMs: 50,
    });
    const executor = createNodeSqlParserBrowserExecutor(options);
    const first = executor.submit({
      grammar: "postgresql",
      text: "SELECT 1",
    });
    const second = executor.submit({
      grammar: "postgresql",
      text: "SELECT 2",
    });
    const worker = createdWorker(factory);

    scheduler.advanceBy(15);
    ready(worker);
    expect(worker.posted).toHaveLength(1);
    scheduler.advanceBy(5);
    expect(await outcome(second)).toStrictEqual({
      code: "queue-timeout",
      kind: "failed",
    });
    await expectPending(first);
    respond(worker, { kind: "syntax-rejected" });
    expect(await outcome(first)).toStrictEqual({
      kind: "syntax-rejected",
    });
  });

  it("starts the execution deadline before posting and retires on timeout", async () => {
    const { factory, options, scheduler } = harness();
    const executor = createNodeSqlParserBrowserExecutor(options);
    const submission = executor.submit({
      grammar: "postgresql",
      text: "SELECT 1",
    });
    const worker = createdWorker(factory);
    ready(worker);

    scheduler.advanceBy(29);
    await expectPending(submission);
    scheduler.advanceBy(1);
    expect(await outcome(submission)).toStrictEqual({
      code: "execution-timeout",
      kind: "failed",
    });
    expect(worker.terminateCalls()).toBe(1);
    expect(worker.listenerCount()).toBe(0);
  });

  it("cancels queued work promptly and releases its queue capacity", async () => {
    const { factory, options } = harness({
      maxQueuedRequests: 1,
      maxQueuedTextUnits: 6,
    });
    const executor = createNodeSqlParserBrowserExecutor(options);
    const active = executor.submit({
      grammar: "postgresql",
      text: "active",
    });
    const worker = createdWorker(factory);
    ready(worker);
    const cancelled = executor.submit({
      grammar: "postgresql",
      text: "queued",
    });

    cancelled.cancel();
    cancelled.cancel();
    expect(await outcome(cancelled)).toStrictEqual({
      kind: "cancelled",
    });
    const replacement = executor.submit({
      grammar: "postgresql",
      text: "next",
    });

    respond(worker, { kind: "syntax-rejected" });
    await outcome(active);
    expect(postedRequest(worker, 1).text).toBe("next");
    respond(worker, { kind: "syntax-rejected" }, 1);
    expect(await outcome(replacement)).toStrictEqual({
      kind: "syntax-rejected",
    });
  });

  it("cancels active work promptly but drains its response before advancing", async () => {
    const { factory, options, scheduler } = harness({
      queueDeadlineMs: 100,
    });
    const executor = createNodeSqlParserBrowserExecutor(options);
    const active = executor.submit({
      grammar: "postgresql",
      text: "active",
    });
    const queued = executor.submit({
      grammar: "postgresql",
      text: "queued",
    });
    const worker = createdWorker(factory);
    ready(worker);

    active.cancel();
    active.cancel();
    expect(await outcome(active)).toStrictEqual({
      kind: "cancelled",
    });
    expect(worker.posted).toHaveLength(1);
    expect(scheduler.pendingCount()).toBeGreaterThan(0);

    respond(worker, { kind: "syntax-rejected" });
    expect(worker.posted).toHaveLength(2);
    expect(postedRequest(worker, 1).text).toBe("queued");
    respond(worker, { kind: "syntax-rejected" }, 1);
    expect(await outcome(queued)).toStrictEqual({
      kind: "syntax-rejected",
    });
  });

  it("keeps the execution safety deadline after active cancellation", async () => {
    const { factory, options, scheduler } = harness({
      queueDeadlineMs: 100,
    });
    const executor = createNodeSqlParserBrowserExecutor(options);
    const active = executor.submit({
      grammar: "postgresql",
      text: "active",
    });
    const queued = executor.submit({
      grammar: "postgresql",
      text: "queued",
    });
    const firstWorker = createdWorker(factory);
    ready(firstWorker);
    active.cancel();
    await outcome(active);

    scheduler.advanceBy(30);
    expect(firstWorker.terminateCalls()).toBe(1);
    const secondWorker = createdWorker(factory, 1);
    ready(secondWorker);
    expect(postedRequest(secondWorker).text).toBe("queued");
    respond(secondWorker, { kind: "syntax-rejected" });
    expect(await outcome(queued)).toStrictEqual({
      kind: "syntax-rejected",
    });
  });

  it("does not reset a queued deadline across generation replacement", async () => {
    const { factory, options, scheduler } = harness({
      executionDeadlineMs: 200,
      queueDeadlineMs: 100,
      startupDeadlineMs: 200,
    });
    const executor = createNodeSqlParserBrowserExecutor(options);
    const active = executor.submit({
      grammar: "postgresql",
      text: "active",
    });
    const queued = executor.submit({
      grammar: "postgresql",
      text: "queued",
    });
    const firstWorker = createdWorker(factory);
    ready(firstWorker);

    scheduler.advanceBy(60);
    firstWorker.dispatch("error", {});
    expect(await outcome(active)).toStrictEqual({
      code: "worker-failure",
      kind: "failed",
    });
    createdWorker(factory, 1);
    scheduler.advanceBy(39);
    await expectPending(queued);
    scheduler.advanceBy(1);
    expect(await outcome(queued)).toStrictEqual({
      code: "queue-timeout",
      kind: "failed",
    });
    executor.dispose();
  });

  it("cancels during startup without ever posting the request", async () => {
    const { factory, options } = harness();
    const executor = createNodeSqlParserBrowserExecutor(options);
    const submission = executor.submit({
      grammar: "postgresql",
      text: "SELECT 1",
    });
    const worker = createdWorker(factory);

    submission.cancel();
    expect(await outcome(submission)).toStrictEqual({
      kind: "cancelled",
    });
    ready(worker);
    expect(worker.posted).toHaveLength(0);
    executor.dispose();
  });
});

describe("node-sql-parser browser executor hostile worker handling", () => {
  it.each([
    undefined,
    null,
    {},
    { data: null },
    { data: { kind: "ready", protocolVersion: 2 } },
    {
      data: {
        extra: true,
        kind: "ready",
        protocolVersion: 1,
      },
    },
  ])("fails closed for malformed message event %#", async (event) => {
    const { factory, options } = harness();
    const executor = createNodeSqlParserBrowserExecutor(options);
    const submission = executor.submit({
      grammar: "postgresql",
      text: "SELECT 1",
    });
    const worker = createdWorker(factory);

    worker.dispatch("message", event);
    expect(await outcome(submission)).toStrictEqual({
      code: "protocol-error",
      kind: "failed",
    });
    expect(worker.terminateCalls()).toBe(1);
  });

  it("fails closed when a message data getter throws", async () => {
    const { factory, options } = harness();
    const executor = createNodeSqlParserBrowserExecutor(options);
    const submission = executor.submit({
      grammar: "postgresql",
      text: "SELECT private",
    });
    const worker = createdWorker(factory);

    worker.dispatch("message", {
      get data() {
        throw new Error("private data getter failure");
      },
    });
    expect(await outcome(submission)).toStrictEqual({
      code: "protocol-error",
      kind: "failed",
    });
  });

  it("retires on unsolicited and duplicate ready messages", async () => {
    const { factory, options } = harness();
    const executor = createNodeSqlParserBrowserExecutor(options);
    const submission = executor.submit({
      grammar: "postgresql",
      text: "SELECT 1",
    });
    const worker = createdWorker(factory);

    ready(worker);
    ready(worker);
    expect(await outcome(submission)).toStrictEqual({
      code: "protocol-error",
      kind: "failed",
    });
    expect(worker.terminateCalls()).toBe(1);
  });

  it("retires when the worker reports a protocol error", async () => {
    const { factory, options } = harness();
    const executor = createNodeSqlParserBrowserExecutor(options);
    const submission = executor.submit({
      grammar: "postgresql",
      text: "SELECT 1",
    });
    const worker = createdWorker(factory);

    worker.emit({
      code: "invalid-request",
      kind: "protocol-error",
      protocolVersion: 1,
    } satisfies NodeSqlParserWireMessage);
    expect(await outcome(submission)).toStrictEqual({
      code: "protocol-error",
      kind: "failed",
    });
    expect(worker.terminateCalls()).toBe(1);
  });

  it("retires on a mismatched response and never replays active work", async () => {
    const { factory, options } = harness();
    const executor = createNodeSqlParserBrowserExecutor(options);
    const active = executor.submit({
      grammar: "postgresql",
      text: "active",
    });
    const queued = executor.submit({
      grammar: "postgresql",
      text: "queued",
    });
    const firstWorker = createdWorker(factory);
    ready(firstWorker);
    const activeId = postedRequest(firstWorker).requestId;

    firstWorker.emit({
      kind: "syntax-rejected",
      protocolVersion: 1,
      requestId: activeId + 1,
    } satisfies NodeSqlParserWireMessage);
    expect(await outcome(active)).toStrictEqual({
      code: "protocol-error",
      kind: "failed",
    });
    const secondWorker = createdWorker(factory, 1);
    ready(secondWorker);
    expect(secondWorker.posted).toHaveLength(1);
    expect(postedRequest(secondWorker).text).toBe("queued");
    respond(secondWorker, { kind: "syntax-rejected" });
    expect(await outcome(queued)).toStrictEqual({
      kind: "syntax-rejected",
    });
    expect(
      firstWorker.posted.filter(
        (value) =>
          decodeNodeSqlParserWireRequest(value)?.text === "active",
      ),
    ).toHaveLength(1);
  });

  it("ignores late messages from a retired generation", async () => {
    const { factory, options } = harness();
    const retainedWorker = new FakeWorker({
      remove: "message",
      retainRemovedListeners: true,
    });
    factory.enqueue(retainedWorker);
    const executor = createNodeSqlParserBrowserExecutor(options);
    const active = executor.submit({
      grammar: "postgresql",
      text: "active",
    });
    const queued = executor.submit({
      grammar: "postgresql",
      text: "queued",
    });
    const firstWorker = createdWorker(factory);
    ready(firstWorker);
    firstWorker.dispatch("error", new Error("private worker error"));
    expect(await outcome(active)).toStrictEqual({
      code: "worker-failure",
      kind: "failed",
    });
    const secondWorker = createdWorker(factory, 1);

    firstWorker.emit(encodeNodeSqlParserWireReady());
    firstWorker.dispatch(
      "message",
      new Proxy(
        {},
        {
          get() {
            throw new Error("must not inspect retired event");
          },
        },
      ),
    );
    let staleFailureInspections = 0;
    firstWorker.dispatch("error", {
      get preventDefault() {
        staleFailureInspections += 1;
        throw new Error("must not inspect retired failure event");
      },
    });
    expect(staleFailureInspections).toBe(0);
    expect(secondWorker.posted).toHaveLength(0);
    ready(secondWorker);
    expect(postedRequest(secondWorker).text).toBe("queued");
    respond(secondWorker, { kind: "syntax-rejected" });
    expect(await outcome(queued)).toStrictEqual({
      kind: "syntax-rejected",
    });
  });

  it.each(["error", "messageerror"] as const)(
    "retires on a worker %s event without leaking event details",
    async (eventType) => {
      const { factory, options } = harness();
      const executor = createNodeSqlParserBrowserExecutor(options);
      const submission = executor.submit({
        grammar: "postgresql",
        text: "SELECT private",
      });
      const worker = createdWorker(factory);

      worker.dispatch(
        eventType,
        new Error("private event detail"),
      );
      expect(await outcome(submission)).toStrictEqual({
        code: "worker-failure",
        kind: "failed",
      });
      expect(worker.terminateCalls()).toBe(1);
    },
  );

  it("safely prevents the default handling of worker failures", async () => {
    const { factory, options } = harness();
    const executor = createNodeSqlParserBrowserExecutor(options);
    const submission = executor.submit({
      grammar: "postgresql",
      text: "SELECT private",
    });
    const worker = createdWorker(factory);
    let prevented = 0;

    worker.dispatch("error", {
      preventDefault() {
        prevented += 1;
      },
    });
    expect(await outcome(submission)).toStrictEqual({
      code: "worker-failure",
      kind: "failed",
    });
    expect(prevented).toBe(1);
  });

  it("accepts primitive worker failure events without inspection", async () => {
    const { factory, options } = harness();
    const executor = createNodeSqlParserBrowserExecutor(options);
    const submission = executor.submit({
      grammar: "postgresql",
      text: "SELECT private",
    });
    const worker = createdWorker(factory);

    worker.dispatch("error", "private event detail");
    expect(await outcome(submission)).toStrictEqual({
      code: "worker-failure",
      kind: "failed",
    });
  });

  it.each(["backend", "malformed-output", "module-load"] as const)(
    "retires after a valid %s failure and preserves never-posted work",
    async (code) => {
      const { factory, options } = harness();
      const executor = createNodeSqlParserBrowserExecutor(options);
      const active = executor.submit({
        grammar: "postgresql",
        text: "active",
      });
      const queued = executor.submit({
        grammar: "bigquery",
        text: "queued",
      });
      const firstWorker = createdWorker(factory);
      ready(firstWorker);

      respond(firstWorker, { code, kind: "failed" });
      expect(await outcome(active)).toStrictEqual({
        code,
        kind: "failed",
      });
      expect(firstWorker.terminateCalls()).toBe(1);
      const secondWorker = createdWorker(factory, 1);
      ready(secondWorker);
      expect(postedRequest(secondWorker)).toMatchObject({
        grammar: "bigquery",
        text: "queued",
      });
      expect(postedRequest(secondWorker).requestId).toBe(
        postedRequest(firstWorker).requestId + 1,
      );
      respond(secondWorker, { kind: "syntax-rejected" });
      expect(await outcome(queued)).toStrictEqual({
        kind: "syntax-rejected",
      });
    },
  );

  it("retires on a duplicate terminal response", async () => {
    const { factory, options } = harness();
    const executor = createNodeSqlParserBrowserExecutor(options);
    const first = executor.submit({
      grammar: "postgresql",
      text: "first",
    });
    const second = executor.submit({
      grammar: "postgresql",
      text: "second",
    });
    const worker = createdWorker(factory);
    ready(worker);
    const duplicate = encodeNodeSqlParserWireBackendOutcome(
      postedRequest(worker).requestId,
      { kind: "syntax-rejected" },
    );

    worker.emit(duplicate);
    await outcome(first);
    expect(worker.posted).toHaveLength(2);
    worker.emit(duplicate);
    expect(await outcome(second)).toStrictEqual({
      code: "protocol-error",
      kind: "failed",
    });
    expect(worker.terminateCalls()).toBe(1);
  });
});

describe("node-sql-parser browser executor host failure containment", () => {
  it("contains worker factory failure and settles the startup waiter", async () => {
    const { factory, options, scheduler } = harness();
    factory.fail();
    const executor = createNodeSqlParserBrowserExecutor(options);
    const submission = executor.submit({
      grammar: "postgresql",
      text: "SELECT private",
    });

    expect(await outcome(submission)).toStrictEqual({
      code: "worker-failure",
      kind: "failed",
    });
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("can create a fresh generation on a later submission after factory failure", async () => {
    const { factory, options } = harness();
    factory.fail();
    const executor = createNodeSqlParserBrowserExecutor(options);
    const failed = executor.submit({
      grammar: "postgresql",
      text: "first",
    });
    expect(await outcome(failed)).toStrictEqual({
      code: "worker-failure",
      kind: "failed",
    });

    factory.recover();
    const recovered = executor.submit({
      grammar: "postgresql",
      text: "second",
    });
    const worker = createdWorker(factory);
    ready(worker);
    respond(worker, { kind: "syntax-rejected" });
    expect(await outcome(recovered)).toStrictEqual({
      kind: "syntax-rejected",
    });
  });

  it("contains disposal reentrancy from the worker factory", async () => {
    const worker = new FakeWorker();
    const scheduler = new ManualDeadlineScheduler();
    let executor:
      | ReturnType<typeof createNodeSqlParserBrowserExecutor>
      | undefined;
    executor = createNodeSqlParserBrowserExecutor({
      deadlineScheduler: scheduler,
      executionDeadlineMs: 30,
      maxQueuedRequests: 2,
      maxQueuedTextUnits: 30,
      queueDeadlineMs: 20,
      startupDeadlineMs: 10,
      workerFactory() {
        executor?.dispose();
        return worker;
      },
    });

    const submission = executor.submit({
      grammar: "postgresql",
      text: "SELECT private",
    });
    expect(await outcome(submission)).toStrictEqual({
      code: "disposed",
      kind: "failed",
    });
    expect(worker.listenerCount()).toBe(0);
    expect(worker.terminateCalls()).toBe(1);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("keeps one authoritative generation during factory submission reentrancy", async () => {
    const outerWorker = new FakeWorker();
    const nestedWorker = new FakeWorker();
    const scheduler = new ManualDeadlineScheduler();
    let calls = 0;
    let executor:
      | ReturnType<typeof createNodeSqlParserBrowserExecutor>
      | undefined;
    let nestedSubmission:
      | NodeSqlParserBrowserExecutorSubmission
      | undefined;
    executor = createNodeSqlParserBrowserExecutor({
      deadlineScheduler: scheduler,
      executionDeadlineMs: 30,
      maxQueuedRequests: 3,
      maxQueuedTextUnits: 30,
      queueDeadlineMs: 20,
      startupDeadlineMs: 10,
      workerFactory() {
        calls += 1;
        if (calls === 1) {
          nestedSubmission = executor?.submit({
            grammar: "postgresql",
            text: "nested",
          });
          return outerWorker;
        }
        return nestedWorker;
      },
    });

    const first = executor.submit({
      grammar: "postgresql",
      text: "first",
    });
    if (nestedSubmission === undefined) {
      throw new Error("nested submission was not created");
    }
    expect(calls).toBe(1);
    expect(outerWorker.listenerCount()).toBe(3);
    expect(outerWorker.terminateCalls()).toBe(0);
    expect(nestedWorker.listenerCount()).toBe(0);

    ready(outerWorker);
    expect(postedRequest(outerWorker).text).toBe("first");
    respond(outerWorker, { kind: "syntax-rejected" });
    expect(await outcome(first)).toStrictEqual({
      kind: "syntax-rejected",
    });
    expect(postedRequest(outerWorker, 1).text).toBe("nested");
    respond(outerWorker, { kind: "syntax-rejected" }, 1);
    expect(await outcome(nestedSubmission)).toStrictEqual({
      kind: "syntax-rejected",
    });
    executor.dispose();
    expect(outerWorker.terminateCalls()).toBe(1);
  });

  it.each(["error", "message", "messageerror"] as const)(
    "contains %s listener installation failure",
    async (eventType) => {
      const { factory, options, scheduler } = harness();
      const worker = new FakeWorker({ add: eventType });
      factory.enqueue(worker);
      const executor = createNodeSqlParserBrowserExecutor(options);
      const submission = executor.submit({
        grammar: "postgresql",
        text: "SELECT private",
      });

      expect(await outcome(submission)).toStrictEqual({
        code: "worker-failure",
        kind: "failed",
      });
      expect(worker.terminateCalls()).toBe(1);
      expect(scheduler.pendingCount()).toBe(0);
    },
  );

  it("contains postMessage failure and never replays the active request", async () => {
    const { factory, options } = harness();
    const firstWorker = new FakeWorker({ post: true });
    factory.enqueue(firstWorker);
    const executor = createNodeSqlParserBrowserExecutor(options);
    const active = executor.submit({
      grammar: "postgresql",
      text: "active",
    });
    const queued = executor.submit({
      grammar: "postgresql",
      text: "queued",
    });

    ready(firstWorker);
    expect(await outcome(active)).toStrictEqual({
      code: "worker-failure",
      kind: "failed",
    });
    const secondWorker = createdWorker(factory, 1);
    ready(secondWorker);
    expect(postedRequest(secondWorker).text).toBe("queued");
    respond(secondWorker, { kind: "syntax-rejected" });
    expect(await outcome(queued)).toStrictEqual({
      kind: "syntax-rejected",
    });
  });

  it.each(["error", "messageerror"] as const)(
    "stops listener installation after synchronous %s failure",
    async (eventType) => {
      const { factory, options } = harness();
      const worker = new FakeWorker();
      worker.setAddHook((type) => {
        if (type === eventType) {
          worker.dispatch("error", {});
        }
      });
      factory.enqueue(worker);
      const executor = createNodeSqlParserBrowserExecutor(options);
      const submission = executor.submit({
        grammar: "postgresql",
        text: "SELECT private",
      });

      expect(await outcome(submission)).toStrictEqual({
        code: "worker-failure",
        kind: "failed",
      });
      expect(worker.terminateCalls()).toBe(1);
    },
  );

  it("contains listener removal and terminate failures during retirement", async () => {
    const { factory, options } = harness();
    const worker = new FakeWorker({
      remove: "message",
      terminate: true,
    });
    factory.enqueue(worker);
    const executor = createNodeSqlParserBrowserExecutor(options);
    const submission = executor.submit({
      grammar: "postgresql",
      text: "SELECT private",
    });

    worker.dispatch("error", new Error("private"));
    expect(await outcome(submission)).toStrictEqual({
      code: "worker-failure",
      kind: "failed",
    });
    expect(worker.terminateCalls()).toBe(1);
    expect(worker.removed).toContain("messageerror");
  });

  it("contains a deadline scheduler set failure", async () => {
    const factory = new FakeWorkerFactory();
    const executor = createNodeSqlParserBrowserExecutor({
      deadlineScheduler: {
        clearTimeout(): void {},
        setTimeout(): unknown {
          throw new Error("private scheduler set failure");
        },
      },
      executionDeadlineMs: 30,
      maxQueuedRequests: 2,
      maxQueuedTextUnits: 30,
      queueDeadlineMs: 20,
      startupDeadlineMs: 10,
      workerFactory: factory.create,
    });
    const submission = executor.submit({
      grammar: "postgresql",
      text: "SELECT 1",
    });

    expect(await outcome(submission)).toStrictEqual({
      code: "queue-timeout",
      kind: "failed",
    });
    expect(factory.created).toHaveLength(0);
  });

  it("contains a synchronously firing queue deadline", async () => {
    const factory = new FakeWorkerFactory();
    let clearCalls = 0;
    const executor = createNodeSqlParserBrowserExecutor({
      deadlineScheduler: {
        clearTimeout(): void {
          clearCalls += 1;
        },
        setTimeout(callback): unknown {
          callback();
          return 1;
        },
      },
      executionDeadlineMs: 30,
      maxQueuedRequests: 2,
      maxQueuedTextUnits: 30,
      queueDeadlineMs: 20,
      startupDeadlineMs: 10,
      workerFactory: factory.create,
    });
    const submission = executor.submit({
      grammar: "postgresql",
      text: "SELECT 1",
    });

    expect(await outcome(submission)).toStrictEqual({
      code: "queue-timeout",
      kind: "failed",
    });
    expect(clearCalls).toBe(1);
    expect(factory.created).toHaveLength(0);
  });

  it("contains a synchronously firing startup deadline", async () => {
    const factory = new FakeWorkerFactory();
    let schedules = 0;
    const executor = createNodeSqlParserBrowserExecutor({
      deadlineScheduler: {
        clearTimeout(): void {},
        setTimeout(callback): unknown {
          schedules += 1;
          if (schedules === 2) {
            callback();
          }
          return schedules;
        },
      },
      executionDeadlineMs: 30,
      maxQueuedRequests: 2,
      maxQueuedTextUnits: 30,
      queueDeadlineMs: 20,
      startupDeadlineMs: 10,
      workerFactory: factory.create,
    });
    const submission = executor.submit({
      grammar: "postgresql",
      text: "SELECT 1",
    });

    expect(await outcome(submission)).toStrictEqual({
      code: "startup-timeout",
      kind: "failed",
    });
    expect(createdWorker(factory).terminateCalls()).toBe(1);
  });

  it("contains a synchronously firing execution deadline", async () => {
    const factory = new FakeWorkerFactory();
    let schedules = 0;
    const executor = createNodeSqlParserBrowserExecutor({
      deadlineScheduler: {
        clearTimeout(): void {},
        setTimeout(callback): unknown {
          schedules += 1;
          if (schedules === 3) {
            callback();
          }
          return schedules;
        },
      },
      executionDeadlineMs: 30,
      maxQueuedRequests: 2,
      maxQueuedTextUnits: 30,
      queueDeadlineMs: 20,
      startupDeadlineMs: 10,
      workerFactory: factory.create,
    });
    const submission = executor.submit({
      grammar: "postgresql",
      text: "SELECT 1",
    });
    const worker = createdWorker(factory);

    ready(worker);
    expect(await outcome(submission)).toStrictEqual({
      code: "execution-timeout",
      kind: "failed",
    });
    expect(worker.posted).toHaveLength(0);
  });

  it("contains deadline scheduler clear failures", async () => {
    const factory = new FakeWorkerFactory();
    const manual = new ManualDeadlineScheduler();
    const executor = createNodeSqlParserBrowserExecutor({
      deadlineScheduler: {
        clearTimeout(): void {
          throw new Error("private scheduler clear failure");
        },
        setTimeout: manual.setTimeout.bind(manual),
      },
      executionDeadlineMs: 30,
      maxQueuedRequests: 2,
      maxQueuedTextUnits: 30,
      queueDeadlineMs: 20,
      startupDeadlineMs: 10,
      workerFactory: factory.create,
    });
    const submission = executor.submit({
      grammar: "postgresql",
      text: "SELECT 1",
    });
    const worker = createdWorker(factory);

    ready(worker);
    respond(worker, { kind: "syntax-rejected" });
    expect(await outcome(submission)).toStrictEqual({
      kind: "syntax-rejected",
    });
    executor.dispose();
  });

  it("ignores cleared queue, startup, and execution callbacks that fire late", async () => {
    const factory = new FakeWorkerFactory();
    const manual = new ManualDeadlineScheduler();
    const executor = createNodeSqlParserBrowserExecutor({
      deadlineScheduler: {
        clearTimeout(): void {},
        setTimeout: manual.setTimeout.bind(manual),
      },
      executionDeadlineMs: 30,
      maxQueuedRequests: 2,
      maxQueuedTextUnits: 30,
      queueDeadlineMs: 10,
      startupDeadlineMs: 20,
      workerFactory: factory.create,
    });
    const submission = executor.submit({
      grammar: "postgresql",
      text: "SELECT 1",
    });
    const worker = createdWorker(factory);
    ready(worker);
    respond(worker, { kind: "syntax-rejected" });
    expect(await outcome(submission)).toStrictEqual({
      kind: "syntax-rejected",
    });

    manual.advanceBy(30);
    expect(worker.terminateCalls()).toBe(0);
    executor.dispose();
  });

  it("constructs the private default module worker lazily", async () => {
    const workers: FakeWorker[] = [];
    const constructorCalls: {
      readonly options: unknown;
      readonly url: unknown;
    }[] = [];
    class DefaultWorker extends FakeWorker {
      constructor(url: unknown, options: unknown) {
        super();
        workers.push(this);
        constructorCalls.push({ options, url });
      }
    }
    vi.stubGlobal("Worker", DefaultWorker);
    try {
      const executor = createNodeSqlParserBrowserExecutor({
        executionDeadlineMs: 30,
        maxQueuedRequests: 2,
        maxQueuedTextUnits: 30,
        queueDeadlineMs: 20,
        startupDeadlineMs: 10,
      });
      expect(workers).toHaveLength(0);
      const submission = executor.submit({
        grammar: "postgresql",
        text: "SELECT 1",
      });
      const worker = workers[0];
      if (worker === undefined) {
        throw new Error("default worker was not constructed");
      }
      expect(constructorCalls).toHaveLength(1);
      expect(constructorCalls[0]?.options).toStrictEqual({
        name: "codemirror-sql-parser",
        type: "module",
      });
      expect(String(constructorCalls[0]?.url)).toContain(
        "node-sql-parser-browser-worker.js",
      );

      ready(worker);
      respond(worker, { kind: "syntax-rejected" });
      expect(await outcome(submission)).toStrictEqual({
        kind: "syntax-rejected",
      });
      executor.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("node-sql-parser browser executor disposal and validation", () => {
  it("disposes starting, active, and queued submissions exactly once", async () => {
    const { factory, options, scheduler } = harness();
    const executor = createNodeSqlParserBrowserExecutor(options);
    const first = executor.submit({
      grammar: "postgresql",
      text: "first",
    });
    const second = executor.submit({
      grammar: "postgresql",
      text: "second",
    });
    const worker = createdWorker(factory);
    ready(worker);

    executor.dispose();
    executor.dispose();
    first.cancel();
    second.cancel();
    expect(await outcome(first)).toStrictEqual({
      code: "disposed",
      kind: "failed",
    });
    expect(await outcome(second)).toStrictEqual({
      code: "disposed",
      kind: "failed",
    });
    expect(worker.terminateCalls()).toBe(1);
    expect(worker.listenerCount()).toBe(0);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("disposes while a cancelled active request is draining", async () => {
    const { factory, options } = harness({
      queueDeadlineMs: 100,
    });
    const executor = createNodeSqlParserBrowserExecutor(options);
    const active = executor.submit({
      grammar: "postgresql",
      text: "active",
    });
    const queued = executor.submit({
      grammar: "postgresql",
      text: "queued",
    });
    const worker = createdWorker(factory);
    ready(worker);
    const lateResponse = encodeNodeSqlParserWireBackendOutcome(
      postedRequest(worker).requestId,
      { kind: "syntax-rejected" },
    );
    active.cancel();
    expect(await outcome(active)).toStrictEqual({
      kind: "cancelled",
    });

    executor.dispose();
    expect(await outcome(queued)).toStrictEqual({
      code: "disposed",
      kind: "failed",
    });
    worker.emit(lateResponse);
    expect(worker.posted).toHaveLength(1);
    expect(worker.terminateCalls()).toBe(1);
  });

  it("settles submissions made after disposal without creating a worker", async () => {
    const { factory, options } = harness();
    const executor = createNodeSqlParserBrowserExecutor(options);
    executor.dispose();

    const submission = executor.submit({
      grammar: "postgresql",
      text: "SELECT 1",
    });
    expect(await outcome(submission)).toStrictEqual({
      code: "disposed",
      kind: "failed",
    });
    submission.cancel();
    expect(Object.isFrozen(submission)).toBe(true);
    expect(factory.created).toHaveLength(0);
  });

  it.each([
    ["executionDeadlineMs", 0],
    ["executionDeadlineMs", 2_147_483_648],
    ["executionDeadlineMs", Number.POSITIVE_INFINITY],
    ["maxQueuedRequests", -1],
    ["maxQueuedRequests", 1.5],
    ["maxQueuedTextUnits", -1],
    ["maxQueuedTextUnits", Number.NaN],
    ["queueDeadlineMs", 0],
    ["startupDeadlineMs", -1],
  ] as const)("rejects invalid %s=%s", (name, value) => {
    const { options } = harness();

    expect(() =>
      createNodeSqlParserBrowserExecutor({
        ...options,
        [name]: value,
      }),
    ).toThrow(TypeError);
  });

  it("rejects invalid runtime inputs synchronously", () => {
    const { options } = harness();
    const executor = createNodeSqlParserBrowserExecutor(options);

    expect(() =>
      Reflect.apply(executor.submit, executor, [{
        grammar: "sqlite",
        text: "SELECT 1",
      }]),
    ).toThrow(TypeError);
    expect(() =>
      Reflect.apply(executor.submit, executor, [{
        grammar: "postgresql",
        text: 1,
      }]),
    ).toThrow(TypeError);
    expect(() =>
      Reflect.apply(executor.submit, executor, [
        new Proxy(
          {},
          {
            get() {
              throw new Error("private input getter failure");
            },
          },
        ),
      ]),
    ).toThrow(TypeError);
  });

  it("rejects hostile and structurally invalid options", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("private options getter failure");
        },
      },
    );
    expect(() =>
      Reflect.apply(createNodeSqlParserBrowserExecutor, undefined, [
        hostile,
      ]),
    ).toThrow(TypeError);

    const { options } = harness();
    expect(() =>
      Reflect.apply(createNodeSqlParserBrowserExecutor, undefined, [
        {
          ...options,
          deadlineScheduler: {
            clearTimeout: 1,
            setTimeout(): unknown {
              return 1;
            },
          },
        },
      ]),
    ).toThrow(TypeError);
    expect(() =>
      Reflect.apply(createNodeSqlParserBrowserExecutor, undefined, [
        {
          ...options,
          workerFactory: 1,
        },
      ]),
    ).toThrow(TypeError);
  });
});
