import {
  MAX_NODE_SQL_PARSER_STATEMENT_LENGTH,
} from "./node-sql-parser-backend.js";
import {
  decodeNodeSqlParserWireMessage,
  encodeNodeSqlParserWireRequest,
  type NodeSqlParserWireFailureCode,
  type NodeSqlParserWireGrammar,
} from "./node-sql-parser-wire.js";
import type { SqlStatementKind } from "./syntax.js";

export interface NodeSqlParserBrowserExecutorLimits {
  readonly executionDeadlineMs: number;
  readonly maxQueuedRequests: number;
  readonly maxQueuedTextUnits: number;
  readonly queueDeadlineMs: number;
  readonly startupDeadlineMs: number;
}

export type NodeSqlParserBrowserExecutorEventType =
  | "error"
  | "message"
  | "messageerror";

export interface NodeSqlParserBrowserExecutorWorker {
  readonly addEventListener: (
    type: NodeSqlParserBrowserExecutorEventType,
    listener: (event: unknown) => void,
  ) => void;
  readonly postMessage: (message: unknown) => void;
  readonly removeEventListener: (
    type: NodeSqlParserBrowserExecutorEventType,
    listener: (event: unknown) => void,
  ) => void;
  readonly terminate: () => void;
}

export interface NodeSqlParserBrowserExecutorDeadlineScheduler {
  readonly clearTimeout: (handle: unknown) => void;
  readonly setTimeout: (
    callback: () => void,
    delayMs: number,
  ) => unknown;
}

export interface NodeSqlParserBrowserExecutorOptions
  extends NodeSqlParserBrowserExecutorLimits {
  readonly deadlineScheduler?: NodeSqlParserBrowserExecutorDeadlineScheduler;
  readonly workerFactory?: () => NodeSqlParserBrowserExecutorWorker;
}

export interface NodeSqlParserBrowserExecutorInput {
  readonly grammar: NodeSqlParserWireGrammar;
  readonly text: string;
}

export type NodeSqlParserBrowserExecutorFailureCode =
  | NodeSqlParserWireFailureCode
  | "disposed"
  | "execution-timeout"
  | "protocol-error"
  | "queue-limit"
  | "queue-timeout"
  | "startup-timeout"
  | "worker-failure";

export type NodeSqlParserBrowserExecutorOutcome =
  | {
      readonly kind: "parsed";
      readonly statementKind: SqlStatementKind;
    }
  | {
      readonly kind: "syntax-rejected";
    }
  | {
      readonly kind: "unsupported";
      readonly reason: "multiple-statements" | "resource-limit";
    }
  | {
      readonly kind: "failed";
      readonly code: NodeSqlParserBrowserExecutorFailureCode;
    }
  | {
      readonly kind: "cancelled";
    };

export interface NodeSqlParserBrowserExecutorSubmission {
  readonly cancel: () => void;
  readonly result: Promise<NodeSqlParserBrowserExecutorOutcome>;
}

export interface NodeSqlParserBrowserExecutor {
  readonly dispose: () => void;
  readonly submit: (
    input: NodeSqlParserBrowserExecutorInput,
  ) => NodeSqlParserBrowserExecutorSubmission;
}

interface Deadline {
  readonly handle: unknown;
}

interface DetachedQueueEntry {
  readonly deadline: Deadline | null;
  readonly entry: QueueEntry;
}

interface DetachedActiveRequest {
  readonly deadline: Deadline | null;
  readonly request: ActiveRequest;
}

interface RevokedGeneration {
  readonly startupDeadline: Deadline | null;
  readonly target: WorkerGeneration;
}

interface QueueEntry {
  consumerSettled: boolean;
  grammar: NodeSqlParserWireGrammar;
  location: "active" | "done" | "queued";
  queueDeadline: Deadline | null;
  resolve:
    | ((outcome: NodeSqlParserBrowserExecutorOutcome) => void)
    | null;
  text: string;
  textUnits: number;
}

interface ActiveRequest {
  draining: boolean;
  readonly entry: QueueEntry;
  executionDeadline: Deadline | null;
  readonly generation: WorkerGeneration;
  posted: boolean;
  readonly requestId: number;
}

interface WorkerGeneration {
  readonly onFailure: (event: unknown) => void;
  readonly onMessage: (event: unknown) => void;
  startupDeadline: Deadline | null;
  state: "ready" | "retired" | "starting";
  readonly worker: NodeSqlParserBrowserExecutorWorker;
}

interface NormalizedOptions extends NodeSqlParserBrowserExecutorLimits {
  readonly deadlineScheduler: NodeSqlParserBrowserExecutorDeadlineScheduler;
  readonly workerFactory: () => NodeSqlParserBrowserExecutorWorker;
}

const DEFAULT_DEADLINE_SCHEDULER: NodeSqlParserBrowserExecutorDeadlineScheduler =
  Object.freeze({
    clearTimeout(handle: unknown): void {
      Reflect.apply(globalThis.clearTimeout, globalThis, [handle]);
    },
    setTimeout(callback: () => void, delayMs: number): unknown {
      return globalThis.setTimeout(callback, delayMs);
    },
  });

function createDefaultWorker(): NodeSqlParserBrowserExecutorWorker {
  const worker = new Worker(
    new URL("./node-sql-parser-browser-worker.js", import.meta.url),
    { name: "codemirror-sql-parser", type: "module" },
  );
  return Object.freeze({
    addEventListener(
      type: NodeSqlParserBrowserExecutorEventType,
      listener: (event: unknown) => void,
    ): void {
      worker.addEventListener(type, listener);
    },
    postMessage(message: unknown): void {
      worker.postMessage(message);
    },
    removeEventListener(
      type: NodeSqlParserBrowserExecutorEventType,
      listener: (event: unknown) => void,
    ): void {
      worker.removeEventListener(type, listener);
    },
    terminate(): void {
      worker.terminate();
    },
  });
}

function requirePositiveSafeInteger(
  value: number,
  label: string,
): void {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function requireDeadline(value: number, label: string): void {
  requirePositiveSafeInteger(value, label);
  if (value > 2_147_483_647) {
    throw new TypeError(`${label} exceeds the platform timer limit`);
  }
}

function normalizeDeadlineScheduler(
  scheduler:
    | NodeSqlParserBrowserExecutorDeadlineScheduler
    | undefined,
): NodeSqlParserBrowserExecutorDeadlineScheduler {
  if (scheduler === undefined) {
    return DEFAULT_DEADLINE_SCHEDULER;
  }
  let clearTimeoutMethod: (handle: unknown) => void;
  let setTimeoutMethod: (
    callback: () => void,
    delayMs: number,
  ) => unknown;
  try {
    clearTimeoutMethod = scheduler.clearTimeout;
    setTimeoutMethod = scheduler.setTimeout;
    if (
      typeof clearTimeoutMethod !== "function" ||
      typeof setTimeoutMethod !== "function"
    ) {
      throw new TypeError();
    }
  } catch {
    throw new TypeError(
      "deadlineScheduler must implement deadlines",
    );
  }
  return Object.freeze({
    clearTimeout(handle: unknown): void {
      Reflect.apply(clearTimeoutMethod, scheduler, [handle]);
    },
    setTimeout(callback: () => void, delayMs: number): unknown {
      return Reflect.apply(setTimeoutMethod, scheduler, [
        callback,
        delayMs,
      ]);
    },
  });
}

function normalizeOptions(
  options: NodeSqlParserBrowserExecutorOptions,
): NormalizedOptions {
  let deadlineScheduler:
    | NodeSqlParserBrowserExecutorDeadlineScheduler
    | undefined;
  let executionDeadlineMs: number;
  let maxQueuedRequests: number;
  let maxQueuedTextUnits: number;
  let queueDeadlineMs: number;
  let startupDeadlineMs: number;
  let workerFactory:
    | (() => NodeSqlParserBrowserExecutorWorker)
    | undefined;
  try {
    deadlineScheduler = options.deadlineScheduler;
    executionDeadlineMs = options.executionDeadlineMs;
    maxQueuedRequests = options.maxQueuedRequests;
    maxQueuedTextUnits = options.maxQueuedTextUnits;
    queueDeadlineMs = options.queueDeadlineMs;
    startupDeadlineMs = options.startupDeadlineMs;
    workerFactory = options.workerFactory;
  } catch {
    throw new TypeError("invalid parser executor options");
  }
  requireDeadline(
    executionDeadlineMs,
    "executionDeadlineMs",
  );
  requirePositiveSafeInteger(
    maxQueuedRequests,
    "maxQueuedRequests",
  );
  requirePositiveSafeInteger(
    maxQueuedTextUnits,
    "maxQueuedTextUnits",
  );
  requireDeadline(
    queueDeadlineMs,
    "queueDeadlineMs",
  );
  requireDeadline(
    startupDeadlineMs,
    "startupDeadlineMs",
  );
  if (
    workerFactory !== undefined &&
    typeof workerFactory !== "function"
  ) {
    throw new TypeError("workerFactory must be a function");
  }
  return Object.freeze({
    deadlineScheduler: normalizeDeadlineScheduler(
      deadlineScheduler,
    ),
    executionDeadlineMs,
    maxQueuedRequests,
    maxQueuedTextUnits,
    queueDeadlineMs,
    startupDeadlineMs,
    workerFactory: workerFactory ?? createDefaultWorker,
  });
}

function requireInput(
  input: NodeSqlParserBrowserExecutorInput,
): NodeSqlParserBrowserExecutorInput {
  try {
    const grammar = input.grammar;
    const text = input.text;
    if (
      (grammar !== "bigquery" && grammar !== "postgresql") ||
      typeof text !== "string"
    ) {
      throw new TypeError("invalid parser executor input");
    }
    return Object.freeze({
      grammar,
      text,
    });
  } catch {
    throw new TypeError("invalid parser executor input");
  }
}

function failedOutcome(
  code: NodeSqlParserBrowserExecutorFailureCode,
): NodeSqlParserBrowserExecutorOutcome {
  return Object.freeze({ code, kind: "failed" });
}

function cancelledOutcome(): NodeSqlParserBrowserExecutorOutcome {
  return Object.freeze({ kind: "cancelled" });
}

function resourceLimitOutcome(): NodeSqlParserBrowserExecutorOutcome {
  return Object.freeze({
    kind: "unsupported",
    reason: "resource-limit",
  });
}

function readMessageData(event: unknown): unknown {
  if (typeof event !== "object" || event === null) {
    return undefined;
  }
  try {
    return Reflect.get(event, "data");
  } catch {
    return undefined;
  }
}

function preventDefault(event: unknown): void {
  if (typeof event !== "object" || event === null) {
    return;
  }
  try {
    const method = Reflect.get(event, "preventDefault");
    if (typeof method === "function") {
      Reflect.apply(method, event, []);
    }
  } catch {
    // Worker failures remain closed for hostile event objects.
  }
}

export function createNodeSqlParserBrowserExecutor(
  options: NodeSqlParserBrowserExecutorOptions,
): NodeSqlParserBrowserExecutor {
  const normalized = normalizeOptions(options);

  const limits = Object.freeze({
    executionDeadlineMs: normalized.executionDeadlineMs,
    maxQueuedRequests: normalized.maxQueuedRequests,
    maxQueuedTextUnits: normalized.maxQueuedTextUnits,
    queueDeadlineMs: normalized.queueDeadlineMs,
    startupDeadlineMs: normalized.startupDeadlineMs,
  });
  const scheduler = normalized.deadlineScheduler;
  const workerFactory = normalized.workerFactory;

  let active: ActiveRequest | null = null;
  let creatingWorker = false;
  let disposed = false;
  let generation: WorkerGeneration | null = null;
  let nextRequestId = 1;
  let pumping = false;
  let pumpRequested = false;
  let queuedTextUnits = 0;
  const queue: QueueEntry[] = [];

  function clearDeadline(deadline: Deadline | null): void {
    if (deadline === null) {
      return;
    }
    try {
      scheduler.clearTimeout(deadline.handle);
    } catch {
      // Deadline cleanup cannot be allowed to expose host failures.
    }
  }

  function scheduleDeadline(
    callback: () => void,
    delayMs: number,
  ): Deadline | null {
    let fired = false;
    let handle: unknown;
    try {
      handle = scheduler.setTimeout(() => {
        fired = true;
        callback();
      }, delayMs);
    } catch {
      callback();
      return null;
    }
    if (fired) {
      clearDeadline({ handle });
      return null;
    }
    return { handle };
  }

  function settleConsumer(
    entry: QueueEntry,
    outcome: NodeSqlParserBrowserExecutorOutcome,
  ): void {
    if (entry.consumerSettled) {
      return;
    }
    entry.consumerSettled = true;
    const resolve = entry.resolve;
    entry.resolve = null;
    resolve?.(outcome);
  }

  function removeQueuedEntry(entry: QueueEntry): boolean {
    if (entry.location !== "queued") {
      return false;
    }
    const index = queue.indexOf(entry);
    if (index < 0) {
      return false;
    }
    queue.splice(index, 1);
    queuedTextUnits -= entry.textUnits;
    entry.location = "done";
    const deadline = entry.queueDeadline;
    entry.queueDeadline = null;
    entry.text = "";
    entry.textUnits = 0;
    clearDeadline(deadline);
    return true;
  }

  function detachAllQueued(): readonly DetachedQueueEntry[] {
    const entries = queue.splice(0);
    queuedTextUnits = 0;
    return entries.map((entry) => {
      const deadline = entry.queueDeadline;
      entry.location = "done";
      entry.queueDeadline = null;
      entry.text = "";
      entry.textUnits = 0;
      return { deadline, entry };
    });
  }

  function cleanupDetachedQueue(
    detached: readonly DetachedQueueEntry[],
  ): void {
    for (const { deadline } of detached) {
      clearDeadline(deadline);
    }
  }

  function settleDetachedQueue(
    detached: readonly DetachedQueueEntry[],
    createOutcome: () => NodeSqlParserBrowserExecutorOutcome,
  ): void {
    cleanupDetachedQueue(detached);
    for (const { entry } of detached) {
      settleConsumer(entry, createOutcome());
    }
  }

  function detachActiveRequest(
    target?: WorkerGeneration,
  ): DetachedActiveRequest | null {
    const request = active;
    if (
      request === null ||
      (target !== undefined && request.generation !== target)
    ) {
      return null;
    }
    active = null;
    const deadline = request.executionDeadline;
    request.executionDeadline = null;
    request.entry.location = "done";
    request.entry.text = "";
    request.entry.textUnits = 0;
    return { deadline, request };
  }

  function cleanupDetachedActive(
    detached: DetachedActiveRequest | null,
  ): void {
    if (detached !== null) {
      clearDeadline(detached.deadline);
    }
  }

  function settleDetachedActive(
    detached: DetachedActiveRequest | null,
    outcome: NodeSqlParserBrowserExecutorOutcome,
  ): void {
    cleanupDetachedActive(detached);
    if (detached !== null && !detached.request.draining) {
      settleConsumer(detached.request.entry, outcome);
    }
  }

  function revokeGeneration(
    target: WorkerGeneration,
  ): RevokedGeneration | null {
    if (target.state === "retired" || generation !== target) {
      return null;
    }
    target.state = "retired";
    generation = null;
    const startupDeadline = target.startupDeadline;
    target.startupDeadline = null;
    return { startupDeadline, target };
  }

  function cleanupRevokedGeneration(
    revoked: RevokedGeneration | null,
  ): void {
    if (revoked === null) {
      return;
    }
    clearDeadline(revoked.startupDeadline);
    removeGenerationListeners(revoked.target);
    try {
      revoked.target.worker.terminate();
    } catch {
      // A retired generation is never reused even if termination throws.
    }
  }

  function rejectAllQueued(
    createOutcome: () => NodeSqlParserBrowserExecutorOutcome,
  ): void {
    const detached = detachAllQueued();
    settleDetachedQueue(detached, createOutcome);
  }

  function removeGenerationListeners(
    target: WorkerGeneration,
  ): void {
    for (const type of [
      "message",
      "error",
      "messageerror",
    ] as const) {
      try {
        target.worker.removeEventListener(
          type,
          type === "message" ? target.onMessage : target.onFailure,
        );
      } catch {
        // Termination below remains authoritative.
      }
    }
  }

  function installGenerationListener(
    target: WorkerGeneration,
    type: NodeSqlParserBrowserExecutorEventType,
    listener: (event: unknown) => void,
  ): boolean {
    try {
      target.worker.addEventListener(type, listener);
    } catch {
      failGeneration(target, "worker-failure");
      try {
        target.worker.removeEventListener(type, listener);
      } catch {
        // The retired generation is never reused.
      }
      return false;
    }
    if (generation === target && target.state !== "retired") {
      return true;
    }
    try {
      target.worker.removeEventListener(type, listener);
    } catch {
      // The retired generation is never reused.
    }
    return false;
  }

  function startGeneration(): void {
    if (
      disposed ||
      creatingWorker ||
      generation !== null ||
      queue.length === 0
    ) {
      return;
    }

    let worker: NodeSqlParserBrowserExecutorWorker;
    creatingWorker = true;
    try {
      worker = workerFactory();
    } catch {
      creatingWorker = false;
      rejectAllQueued(() => failedOutcome("worker-failure"));
      return;
    }
    creatingWorker = false;
    if (disposed || generation !== null || queue.length === 0) {
      try {
        worker.terminate();
      } catch {
        // An unowned worker is never installed or reused.
      }
      return;
    }

    const target: WorkerGeneration = {
      onFailure: (event) => {
        if (generation !== target || target.state === "retired") {
          return;
        }
        failGeneration(target, "worker-failure");
        preventDefault(event);
      },
      onMessage: (event) => {
        if (generation !== target || target.state === "retired") {
          return;
        }
        receiveMessage(target, readMessageData(event));
      },
      startupDeadline: null,
      state: "starting",
      worker,
    };
    generation = target;

    const deadline = scheduleDeadline(() => {
      if (generation === target && target.state === "starting") {
        failGeneration(target, "startup-timeout");
      }
    }, limits.startupDeadlineMs);
    if (generation !== target || target.state !== "starting") {
      clearDeadline(deadline);
      return;
    }
    target.startupDeadline = deadline;

    if (
      !installGenerationListener(
        target,
        "error",
        target.onFailure,
      ) ||
      !installGenerationListener(
        target,
        "messageerror",
        target.onFailure,
      ) ||
      !installGenerationListener(
        target,
        "message",
        target.onMessage,
      )
    ) {
      return;
    }
  }

  function restartAfterReadyFailure(): void {
    if (!disposed && queue.length > 0 && generation === null) {
      startGeneration();
    }
  }

  function failGeneration(
    target: WorkerGeneration,
    code: NodeSqlParserBrowserExecutorFailureCode,
  ): void {
    if (generation !== target || target.state === "retired") {
      return;
    }
    const failedDuringStartup = target.state === "starting";
    const detachedActive = detachActiveRequest(target);
    const detachedQueue = failedDuringStartup
      ? detachAllQueued()
      : [];
    const revoked = revokeGeneration(target);

    cleanupDetachedActive(detachedActive);
    cleanupDetachedQueue(detachedQueue);
    cleanupRevokedGeneration(revoked);

    for (const { entry } of detachedQueue) {
      settleConsumer(entry, failedOutcome(code));
    }
    if (
      detachedActive !== null &&
      !detachedActive.request.draining
    ) {
      settleConsumer(
        detachedActive.request.entry,
        failedOutcome(code),
      );
    }
    if (!failedDuringStartup) {
      restartAfterReadyFailure();
    }
  }

  function finishActive(
    request: ActiveRequest,
    outcome: NodeSqlParserBrowserExecutorOutcome,
  ): void {
    const detached = detachActiveRequest(request.generation);
    settleDetachedActive(detached, outcome);
    pump();
  }

  function receiveMessage(
    target: WorkerGeneration,
    data: unknown,
  ): void {
    const message = decodeNodeSqlParserWireMessage(data);
    if (message === null) {
      failGeneration(target, "protocol-error");
      return;
    }

    if (message.kind === "ready") {
      if (target.state !== "starting" || active !== null) {
        failGeneration(target, "protocol-error");
        return;
      }
      target.state = "ready";
      const startupDeadline = target.startupDeadline;
      target.startupDeadline = null;
      clearDeadline(startupDeadline);
      if (generation === target && target.state === "ready") {
        pump();
      }
      return;
    }

    if (message.kind === "protocol-error") {
      failGeneration(target, "protocol-error");
      return;
    }

    const request = active;
    if (
      target.state !== "ready" ||
      request === null ||
      request.generation !== target ||
      !request.posted ||
      message.requestId !== request.requestId
    ) {
      failGeneration(target, "protocol-error");
      return;
    }

    switch (message.kind) {
      case "parsed":
        finishActive(
          request,
          Object.freeze({
            kind: "parsed",
            statementKind: message.statementKind,
          }),
        );
        return;
      case "syntax-rejected":
        finishActive(
          request,
          Object.freeze({ kind: "syntax-rejected" }),
        );
        return;
      case "unsupported":
        finishActive(
          request,
          Object.freeze({
            kind: "unsupported",
            reason: message.reason,
          }),
        );
        return;
      case "failed": {
        failGeneration(target, message.code);
        return;
      }
    }
  }

  function allocateRequestId(): number | null {
    if (nextRequestId > Number.MAX_SAFE_INTEGER) {
      return null;
    }
    const requestId = nextRequestId;
    nextRequestId += 1;
    return requestId;
  }

  function pumpOnce(): void {
    if (disposed || active !== null || queue.length === 0) {
      return;
    }
    if (generation === null) {
      startGeneration();
      return;
    }
    if (generation.state !== "ready") {
      return;
    }

    const requestId = allocateRequestId();
    if (requestId === null) {
      const target = generation;
      const detachedQueue = detachAllQueued();
      const revoked = revokeGeneration(target);
      cleanupDetachedQueue(detachedQueue);
      cleanupRevokedGeneration(revoked);
      for (const { entry } of detachedQueue) {
        settleConsumer(entry, failedOutcome("protocol-error"));
      }
      return;
    }

    const entry = queue.shift();
    if (entry === undefined) {
      return;
    }
    const target = generation;
    const queueDeadline = entry.queueDeadline;
    queuedTextUnits -= entry.textUnits;
    entry.queueDeadline = null;
    entry.location = "active";
    const request: ActiveRequest = {
      draining: false,
      entry,
      executionDeadline: null,
      generation: target,
      posted: false,
      requestId,
    };
    active = request;
    clearDeadline(queueDeadline);
    if (
      disposed ||
      generation !== target ||
      target.state !== "ready" ||
      active !== request
    ) {
      return;
    }

    const executionDeadline = scheduleDeadline(() => {
      if (
        generation === target &&
        active === request &&
        target.state === "ready"
      ) {
        failGeneration(target, "execution-timeout");
      }
    }, limits.executionDeadlineMs);
    if (generation === target && active === request) {
      request.executionDeadline = executionDeadline;
    } else {
      clearDeadline(executionDeadline);
      return;
    }

    let postMessage: (message: unknown) => void;
    try {
      postMessage = target.worker.postMessage;
      if (typeof postMessage !== "function") {
        throw new TypeError("worker postMessage must be callable");
      }
    } catch {
      failGeneration(target, "worker-failure");
      return;
    }
    if (
      disposed ||
      generation !== target ||
      target.state !== "ready" ||
      active !== request
    ) {
      return;
    }

    try {
      const wireRequest = encodeNodeSqlParserWireRequest(
        entry.grammar,
        requestId,
        entry.text,
      );
      request.posted = true;
      Reflect.apply(postMessage, target.worker, [wireRequest]);
      entry.text = "";
      entry.textUnits = 0;
    } catch {
      entry.text = "";
      entry.textUnits = 0;
      failGeneration(target, "worker-failure");
    }
  }

  function pump(): void {
    pumpRequested = true;
    if (pumping) {
      return;
    }
    pumping = true;
    try {
      while (pumpRequested) {
        pumpRequested = false;
        pumpOnce();
      }
    } finally {
      pumping = false;
    }
  }

  function cancel(entry: QueueEntry): void {
    if (entry.location === "queued") {
      if (removeQueuedEntry(entry)) {
        settleConsumer(entry, cancelledOutcome());
      }
      return;
    }
    if (
      entry.location === "active" &&
      active !== null &&
      active.entry === entry
    ) {
      active.draining = true;
      if (active.posted) {
        entry.text = "";
        entry.textUnits = 0;
      }
      settleConsumer(entry, cancelledOutcome());
    }
  }

  function immediateSubmission(
    outcome: NodeSqlParserBrowserExecutorOutcome,
  ): NodeSqlParserBrowserExecutorSubmission {
    return Object.freeze({
      cancel(): void {},
      result: Promise.resolve(outcome),
    });
  }

  function submit(
    rawInput: NodeSqlParserBrowserExecutorInput,
  ): NodeSqlParserBrowserExecutorSubmission {
    const input = requireInput(rawInput);
    if (disposed) {
      return immediateSubmission(failedOutcome("disposed"));
    }
    if (input.text.length > MAX_NODE_SQL_PARSER_STATEMENT_LENGTH) {
      return immediateSubmission(resourceLimitOutcome());
    }
    if (
      queue.length >= limits.maxQueuedRequests ||
      input.text.length >
        limits.maxQueuedTextUnits - queuedTextUnits
    ) {
      return immediateSubmission(failedOutcome("queue-limit"));
    }

    let resolve:
      | ((outcome: NodeSqlParserBrowserExecutorOutcome) => void)
      | undefined;
    const result = new Promise<NodeSqlParserBrowserExecutorOutcome>(
      (settle) => {
        resolve = settle;
      },
    );
    if (resolve === undefined) {
      throw new Error("parser executor promise was not initialized");
    }
    const entry: QueueEntry = {
      consumerSettled: false,
      grammar: input.grammar,
      location: "queued",
      queueDeadline: null,
      resolve,
      text: input.text,
      textUnits: input.text.length,
    };
    queue.push(entry);
    queuedTextUnits += entry.textUnits;

    const queueDeadline = scheduleDeadline(() => {
      if (removeQueuedEntry(entry)) {
        settleConsumer(entry, failedOutcome("queue-timeout"));
      }
    }, limits.queueDeadlineMs);
    if (entry.location === "queued") {
      entry.queueDeadline = queueDeadline;
    } else {
      clearDeadline(queueDeadline);
    }
    pump();

    return Object.freeze({
      cancel: () => {
        cancel(entry);
      },
      result,
    });
  }

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    const target = generation;
    const detachedActive = detachActiveRequest();
    const detachedQueue = detachAllQueued();
    const revoked =
      target === null ? null : revokeGeneration(target);

    cleanupDetachedActive(detachedActive);
    cleanupDetachedQueue(detachedQueue);
    cleanupRevokedGeneration(revoked);

    for (const { entry } of detachedQueue) {
      settleConsumer(entry, failedOutcome("disposed"));
    }
    if (
      detachedActive !== null &&
      !detachedActive.request.draining
    ) {
      settleConsumer(
        detachedActive.request.entry,
        failedOutcome("disposed"),
      );
    }
  }

  return Object.freeze({ dispose, submit });
}
