import {
  createSqlCatalogSearchRequest,
  decodeSqlCatalogSearchResponse,
  isValidSqlCatalogScope,
  resolveSqlRelationCatalogProvider,
} from "./relation-catalog-boundary.js";
import type {
  CapturedSqlRelationCatalogProvider,
  SqlValidatedCatalogSearchResponse,
} from "./relation-catalog-boundary.js";
import {
  createSqlCatalogEpochCoordinator,
} from "./relation-catalog-epoch-coordinator.js";
import type {
  SqlCatalogEpochCapture,
  SqlCatalogEpochCoordinator,
  SqlCatalogResponseEpochDecision,
  SqlCatalogRevisionTarget,
  SqlCatalogScopeMembership,
} from "./relation-catalog-epoch-coordinator.js";
import {
  createSqlCatalogSearchPolicyStore,
} from "./relation-catalog-search-policy-store.js";
import type {
  SqlCatalogSearchPolicyStore,
} from "./relation-catalog-search-policy-store.js";
import type {
  SqlCatalogEpoch,
  SqlCatalogSearchRequest,
} from "./relation-completion-types.js";
import type { SqlRelationDialectRuntime } from "./relation-dialect.js";
import {
  isSqlRelationDialectRuntime,
} from "./relation-runtime-auth.js";
import type {
  SqlIdentifierComponent,
  SqlIdentifierPath,
} from "./types.js";

export const MAX_CATALOG_ACTIVE_SEARCH_WORK = 8;
export const MAX_CATALOG_QUEUED_SEARCH_WORK = 64;
export const DEFAULT_CATALOG_QUEUE_DEADLINE_MS = 100;
export const DEFAULT_CATALOG_EXECUTION_DEADLINE_MS = 250;
export const DEFAULT_CATALOG_SYNCHRONOUS_BUDGET_MS = 8;
export const DEFAULT_CATALOG_REFRESH_LEASE_MS = 1_000;
export const MIN_CATALOG_QUEUE_DEADLINE_MS = 10;
export const MAX_CATALOG_QUEUE_DEADLINE_MS = 2_000;
export const MIN_CATALOG_EXECUTION_DEADLINE_MS = 10;
export const MAX_CATALOG_EXECUTION_DEADLINE_MS = 5_000;
export const MIN_CATALOG_SYNCHRONOUS_BUDGET_MS = 1;
export const MAX_CATALOG_SYNCHRONOUS_BUDGET_MS = 50;
export const MIN_CATALOG_REFRESH_LEASE_MS = 1;
export const MAX_CATALOG_REFRESH_LEASE_MS = 5_000;

export interface SqlCatalogSearchDeadlineScheduler {
  readonly clearTimeout: (
    this: void,
    handle: unknown,
  ) => void;
  readonly now: (this: void) => number;
  readonly setTimeout: (
    this: void,
    callback: (this: void) => void,
    delayMs: number,
  ) => unknown;
}

export interface SqlCatalogSearchWorkOptions {
  readonly deadlineScheduler?: SqlCatalogSearchDeadlineScheduler;
  readonly executionDeadlineMs?: number;
  readonly queueDeadlineMs?: number;
  readonly refreshLeaseMs?: number;
  readonly synchronousBudgetMs?: number;
}

export interface SqlCatalogSearchWorkInput {
  readonly continuationToken: string | null;
  readonly limit: number;
  readonly prefix: SqlIdentifierComponent;
  readonly qualifier: SqlIdentifierPath;
  readonly searchPaths: readonly SqlIdentifierPath[];
}

export type SqlCatalogSearchWorkUnavailableReason =
  | "disposed"
  | "execution-timeout"
  | "inactive"
  | "invalid-request"
  | "malformed-response"
  | "overloaded"
  | "provider-failed"
  | "queue-timeout";

export type SqlCatalogSearchWorkOutcome =
  | {
      readonly status: "usable";
      readonly observation: "baseline" | "equal";
      readonly response: SqlValidatedCatalogSearchResponse;
    }
  | {
      readonly status: "superseded";
    }
  | {
      readonly status: "cancelled";
    }
  | {
      readonly status: "unavailable";
      readonly reason: SqlCatalogSearchWorkUnavailableReason;
    };

export type SqlCatalogSearchAvailabilityTarget = (
  this: void,
) =>
  | ((this: void) => undefined)
  | null;

export type SqlCatalogSearchRefreshRetentionResult =
  | {
      readonly status: "retained";
      readonly remainingLeaseMs: number;
    }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "disposed"
        | "expired"
        | "invalid-target"
        | "not-retainable"
        | "superseded";
    };

export interface SqlCatalogSearchWorkTicket {
  readonly cancel: (this: void) => void;
  readonly retainForRefresh: (
    this: void,
    prepareAvailability: SqlCatalogSearchAvailabilityTarget,
  ) => SqlCatalogSearchRefreshRetentionResult;
  readonly result: Promise<SqlCatalogSearchWorkOutcome>;
}

export interface SqlCatalogSearchWorkOwner {
  readonly activate: SqlCatalogScopeMembership["activate"];
  readonly request: (
    this: void,
    input: SqlCatalogSearchWorkInput,
  ) => SqlCatalogSearchWorkTicket;
  readonly dispose: (this: void) => void;
}

export type SqlCatalogSearchWorkOwnerResult =
  | {
      readonly status: "prepared";
      readonly owner: SqlCatalogSearchWorkOwner;
    }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "disposed"
        | "invalid-dialect"
        | "invalid-scope"
        | "invalid-target"
        | "membership-capacity";
    };

export interface SqlCatalogSearchWorkCoordinator {
  readonly prepareOwner: (
    this: void,
    scope: unknown,
    dialect: SqlRelationDialectRuntime,
    target: SqlCatalogRevisionTarget,
  ) => SqlCatalogSearchWorkOwnerResult;
  readonly providerId: string;
  readonly dispose: (this: void) => void;
}

export type SqlCatalogSearchWorkCoordinatorResult =
  | {
      readonly status: "created";
      readonly coordinator: SqlCatalogSearchWorkCoordinator;
    }
  | {
      readonly status: "unavailable";
      readonly reason: "invalid-options" | "invalid-provider";
    };

interface NormalizedOptions {
  readonly deadlineScheduler: SqlCatalogSearchDeadlineScheduler;
  readonly executionDeadlineMs: number;
  readonly queueDeadlineMs: number;
  readonly refreshLeaseMs: number;
  readonly synchronousBudgetMs: number;
}

interface OwnerState {
  current: ConsumerState | null;
  readonly dialect: SqlRelationDialectRuntime;
  disposed: boolean;
  readonly membership: SqlCatalogScopeMembership;
  owner: CoordinatorState | null;
  refreshObserver: RefreshObserverState | null;
  requestToken: object | null;
  readonly scope: string;
}

interface ConsumerState {
  readonly capture: SqlCatalogEpochCapture;
  cancelled: boolean;
  readonly kind: "consumer";
  owner: OwnerState | null;
  resolve: (outcome: SqlCatalogSearchWorkOutcome) => void;
  readonly retention: TicketRetentionState;
  settled: boolean;
  work: WorkState | null;
}

interface TicketRetentionState {
  consumer: ConsumerState | null;
  observer: RefreshObserverState | null;
}

interface RefreshObserverState {
  readonly capture: SqlCatalogEpochCapture;
  readonly kind: "observer";
  readonly prepareAvailability: SqlCatalogSearchAvailabilityTarget;
  readonly owner: OwnerState;
  readonly retention: TicketRetentionState;
  timer: DeadlineCell | null;
  work: WorkState | null;
}

interface WorkState {
  abortController: AbortController | null;
  abortIssued: boolean;
  dialect: SqlRelationDialectRuntime | null;
  decisionCell: ResponseDecisionCell | null;
  executionDeadline: number | null;
  executionTimer: DeadlineCell | null;
  joinable: boolean;
  readonly observers: Set<RefreshObserverState>;
  readonly owners: Set<ConsumerState>;
  phase:
    | "active"
    | "deciding"
    | "queued"
    | "retired"
    | "terminal";
  providerCell: ProviderResultCell | null;
  queueDeadline: number;
  queueTimer: DeadlineCell | null;
  request: SqlCatalogSearchRequest | null;
  scope: string;
}

interface DeadlineCell {
  active: boolean;
  generation: number;
  handle: unknown;
  tick: ((generation: number) => void) | null;
}

interface ProviderResultCell {
  active: boolean;
  deliver:
    | ((
        fulfilled: boolean,
        value: unknown,
      ) => void)
    | null;
}

interface CoordinatorState {
  activeCount: number;
  disposed: boolean;
  readonly epochs: SqlCatalogEpochCoordinator;
  readonly joinable: Set<WorkState>;
  lastNow: number;
  readonly notifications: Set<AvailabilityNotificationState>;
  readonly options: NormalizedOptions;
  readonly owners: Set<OwnerState>;
  readonly policyStore: SqlCatalogSearchPolicyStore;
  pumpRequested: boolean;
  pumping: boolean;
  readonly queue: WorkState[];
  search:
    | ((
        this: void,
        request: SqlCatalogSearchRequest,
        signal: AbortSignal,
      ) => unknown)
    | null;
  readonly works: Set<WorkState>;
}

interface ResponseDecisionCell {
  active: boolean;
  advancing: boolean;
  candidates: readonly ResponseCandidate[];
  index: number;
  pending: SqlCatalogResponseEpochDecision | null;
  readonly dialect: SqlRelationDialectRuntime;
  readonly request: SqlCatalogSearchRequest;
  readonly response: SqlValidatedCatalogSearchResponse;
  readonly state: CoordinatorState;
  readonly work: WorkState;
}

type ResponseCandidate = ConsumerState | RefreshObserverState;

interface DetachedSettlement {
  readonly outcome: SqlCatalogSearchWorkOutcome;
  readonly resolve: (
    outcome: SqlCatalogSearchWorkOutcome,
  ) => void;
}

interface AvailabilityNotificationState {
  active: boolean;
  readonly owner: OwnerState;
  readonly requestToken: object | null;
  readonly scope: string;
}

interface AvailabilityPreparation {
  readonly notification: AvailabilityNotificationState;
  readonly prepare: SqlCatalogSearchAvailabilityTarget;
}

interface AvailabilityDispatch {
  readonly dispatch: Function;
  readonly notification: AvailabilityNotificationState;
}

interface Effects {
  readonly aborts: AbortController[];
  readonly availabilityPreparations: AvailabilityPreparation[];
  pump: boolean;
  readonly settlements: DetachedSettlement[];
  readonly timers: DeadlineCell[];
}

const HOST_CLEAR_TIMEOUT = globalThis.clearTimeout;
const HOST_SET_TIMEOUT = globalThis.setTimeout;
const HOST_PERFORMANCE = globalThis.performance;
const HOST_NOW = HOST_PERFORMANCE.now;
const INTRINSIC_PROMISE = Promise;
const INTRINSIC_PROMISE_RESOLVE = Promise.resolve;
const INTRINSIC_PROMISE_THEN = Promise.prototype.then;
const IGNORE_DETACHED_REJECTION = (): void => {};
const MAX_SYNCHRONOUS_DEADLINE_REARMS = 256;

const DEFAULT_DEADLINE_SCHEDULER: SqlCatalogSearchDeadlineScheduler =
  Object.freeze({
    clearTimeout(handle: unknown): void {
      Reflect.apply(HOST_CLEAR_TIMEOUT, globalThis, [
        handle,
      ]);
    },
    now(): number {
      return Reflect.apply(HOST_NOW, HOST_PERFORMANCE, []);
    },
    setTimeout(
      callback: (this: void) => void,
      delayMs: number,
    ): unknown {
      return Reflect.apply(HOST_SET_TIMEOUT, globalThis, [
        callback,
        delayMs,
      ]);
    },
  });

const CANCELLED_OUTCOME: SqlCatalogSearchWorkOutcome =
  Object.freeze({ status: "cancelled" });
const SUPERSEDED_OUTCOME: SqlCatalogSearchWorkOutcome =
  Object.freeze({ status: "superseded" });

function unavailableOutcome(
  reason: SqlCatalogSearchWorkUnavailableReason,
): SqlCatalogSearchWorkOutcome {
  return Object.freeze({ reason, status: "unavailable" });
}

function effects(): Effects {
  return {
    aborts: [],
    availabilityPreparations: [],
    pump: false,
    settlements: [],
    timers: [],
  };
}

function isDuration(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function normalizeOptions(
  candidate: SqlCatalogSearchWorkOptions | undefined,
): {
  readonly initialNow: number;
  readonly options: NormalizedOptions;
} | null {
  try {
    const queueDeadlineMs =
      candidate?.queueDeadlineMs ??
      DEFAULT_CATALOG_QUEUE_DEADLINE_MS;
    const executionDeadlineMs =
      candidate?.executionDeadlineMs ??
      DEFAULT_CATALOG_EXECUTION_DEADLINE_MS;
    const refreshLeaseMs =
      candidate?.refreshLeaseMs ??
      DEFAULT_CATALOG_REFRESH_LEASE_MS;
    const synchronousBudgetMs =
      candidate?.synchronousBudgetMs ??
      DEFAULT_CATALOG_SYNCHRONOUS_BUDGET_MS;
    const deadlineScheduler =
      candidate?.deadlineScheduler ??
      DEFAULT_DEADLINE_SCHEDULER;
    const clearTimeoutMethod = deadlineScheduler.clearTimeout;
    const nowMethod = deadlineScheduler.now;
    const setTimeoutMethod = deadlineScheduler.setTimeout;
    if (
      !isDuration(
        queueDeadlineMs,
        MIN_CATALOG_QUEUE_DEADLINE_MS,
        MAX_CATALOG_QUEUE_DEADLINE_MS,
      ) ||
      !isDuration(
        executionDeadlineMs,
        MIN_CATALOG_EXECUTION_DEADLINE_MS,
        MAX_CATALOG_EXECUTION_DEADLINE_MS,
      ) ||
      !isDuration(
        synchronousBudgetMs,
        MIN_CATALOG_SYNCHRONOUS_BUDGET_MS,
        MAX_CATALOG_SYNCHRONOUS_BUDGET_MS,
      ) ||
      !isDuration(
        refreshLeaseMs,
        MIN_CATALOG_REFRESH_LEASE_MS,
        MAX_CATALOG_REFRESH_LEASE_MS,
      ) ||
      typeof nowMethod !== "function" ||
      typeof setTimeoutMethod !== "function" ||
      typeof clearTimeoutMethod !== "function"
    ) {
      return null;
    }
    const initialNow = Reflect.apply(
      nowMethod,
      undefined,
      [],
    );
    if (
      typeof initialNow !== "number" ||
      !Number.isFinite(initialNow) ||
      initialNow < 0
    ) {
      return null;
    }
    const capturedScheduler: SqlCatalogSearchDeadlineScheduler =
      Object.freeze({
        clearTimeout(handle: unknown): void {
          Reflect.apply(clearTimeoutMethod, undefined, [handle]);
        },
        now(): number {
          return Reflect.apply(nowMethod, undefined, []);
        },
        setTimeout(
          callback: (this: void) => void,
          delayMs: number,
        ): unknown {
          return Reflect.apply(setTimeoutMethod, undefined, [
            callback,
            delayMs,
          ]);
        },
      });
    return {
      initialNow,
      options: Object.freeze({
        deadlineScheduler: capturedScheduler,
        executionDeadlineMs,
        queueDeadlineMs,
        refreshLeaseMs,
        synchronousBudgetMs,
      }),
    };
  } catch {
    return null;
  }
}

function readNow(state: CoordinatorState): number | null {
  let value: unknown;
  try {
    value = Reflect.apply(
      state.options.deadlineScheduler.now,
      undefined,
      [],
    );
  } catch {
    return null;
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < state.lastNow
  ) {
    return null;
  }
  state.lastNow = value;
  return value;
}

function deadlineFrom(
  now: number,
  duration: number,
): number | null {
  const deadline = now + duration;
  return Number.isFinite(deadline) && deadline > now
    ? deadline
    : null;
}

function clearDeadline(
  state: CoordinatorState,
  cell: DeadlineCell,
): void {
  if (!cell.active) return;
  cell.active = false;
  cell.generation += 1;
  cell.tick = null;
  try {
    Reflect.apply(
      state.options.deadlineScheduler.clearTimeout,
      undefined,
      [cell.handle],
    );
  } catch {
    // Deadline cleanup cannot reopen retired work.
  }
}

function scheduleDeadline(
  state: CoordinatorState,
  deadline: number,
  expire: () => void,
): DeadlineCell {
  const cell: DeadlineCell = {
    active: true,
    generation: 0,
    handle: undefined,
    tick: null,
  };
  let arming = false;
  let synchronousRearms = 0;
  const expireNow = (): void => {
    if (!cell.active) return;
    cell.active = false;
    cell.generation += 1;
    cell.tick = null;
    expire();
  };
  const arm = (): void => {
    arming = true;
    try {
      for (;;) {
        const now = readNow(state);
        if (now === null || now >= deadline) {
          expireNow();
          return;
        }
        const generation = cell.generation + 1;
        cell.generation = generation;
        const token = { fired: false };
        const callback = (): void => {
          token.fired = true;
          cell.tick?.(generation);
        };
        let handle: unknown;
        try {
          handle = Reflect.apply(
            state.options.deadlineScheduler.setTimeout,
            undefined,
            [callback, deadline - now],
          );
        } catch {
          expireNow();
          return;
        }
        if (!token.fired) {
          cell.handle = handle;
          return;
        }
        try {
          Reflect.apply(
            state.options.deadlineScheduler.clearTimeout,
            undefined,
            [handle],
          );
        } catch {
          // The synchronously fired generation is already obsolete.
        }
        if (!cell.active) return;
        synchronousRearms += 1;
        if (
          synchronousRearms >
            MAX_SYNCHRONOUS_DEADLINE_REARMS
        ) {
          expireNow();
          return;
        }
      }
    } finally {
      arming = false;
    }
  };
  cell.tick = (generation): void => {
    if (
      !cell.active ||
      generation !== cell.generation
    ) {
      return;
    }
    const now = readNow(state);
    if (now === null || now >= deadline) {
      expireNow();
      return;
    }
    if (!arming) arm();
  };
  arm();
  return cell;
}

function settleDetached(
  list: DetachedSettlement[],
  consumer: ConsumerState,
  outcome: SqlCatalogSearchWorkOutcome,
): void {
  consumer.settled = true;
  consumer.retention.consumer = null;
  const resolve = consumer.resolve;
  consumer.resolve = IGNORE_DETACHED_REJECTION;
  consumer.work = null;
  const owner = consumer.owner;
  consumer.owner = null;
  if (owner?.current === consumer) owner.current = null;
  list.push({ outcome, resolve });
}

function runEffects(
  state: CoordinatorState,
  pending: Effects,
): void {
  const availabilityDispatches: AvailabilityDispatch[] = [];
  for (const timer of pending.timers) {
    clearDeadline(state, timer);
  }
  for (const preparation of pending.availabilityPreparations) {
    const { notification, prepare } = preparation;
    if (!isCurrentNotification(state, notification)) {
      retireNotification(state, notification);
      continue;
    }
    let candidate: unknown;
    try {
      candidate = Reflect.apply(prepare, undefined, []);
    } catch {
      retireNotification(state, notification);
      continue;
    }
    if (
      typeof candidate === "function" &&
      isCurrentNotification(state, notification)
    ) {
      availabilityDispatches.push({
        dispatch: candidate,
        notification,
      });
    } else if (candidate !== null) {
      drainDetachedSettlement(candidate);
      retireNotification(state, notification);
    } else {
      retireNotification(state, notification);
    }
  }
  for (const settlement of pending.settlements) {
    settlement.resolve(settlement.outcome);
  }
  for (const controller of pending.aborts) {
    try {
      controller.abort();
    } catch {
      // Work was made inert before provider abort.
    }
  }
  for (const item of availabilityDispatches) {
    const { dispatch, notification } = item;
    if (!isCurrentNotification(state, notification)) {
      retireNotification(state, notification);
      continue;
    }
    retireNotification(state, notification);
    try {
      const result = Reflect.apply(dispatch, undefined, []);
      if (result !== undefined) {
        drainDetachedSettlement(result);
      }
    } catch {
      // Availability state was already detached and cannot reopen.
    }
  }
  if (pending.pump) pump(state);
}

function isCurrentNotification(
  state: CoordinatorState,
  notification: AvailabilityNotificationState,
): boolean {
  const owner = notification.owner;
  return (
    notification.active &&
    !state.disposed &&
    !owner.disposed &&
    owner.owner === state &&
    owner.requestToken === notification.requestToken
  );
}

function retireNotification(
  state: CoordinatorState,
  notification: AvailabilityNotificationState,
): void {
  if (!notification.active) return;
  notification.active = false;
  state.notifications.delete(notification);
}

function retireNotifications(
  state: CoordinatorState,
  predicate: (
    notification: AvailabilityNotificationState,
  ) => boolean,
): void {
  for (const notification of state.notifications) {
    if (predicate(notification)) {
      retireNotification(state, notification);
    }
  }
}

function hasWorkOwners(work: WorkState): boolean {
  return work.owners.size > 0 || work.observers.size > 0;
}

function sameComponent(
  left: SqlIdentifierComponent,
  right: SqlIdentifierComponent,
): boolean {
  return (
    left.value === right.value &&
    left.quoted === right.quoted
  );
}

function samePath(
  left: SqlIdentifierPath,
  right: SqlIdentifierPath,
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (
      leftPart === undefined ||
      rightPart === undefined ||
      !sameComponent(leftPart, rightPart)
    ) {
      return false;
    }
  }
  return true;
}

function sameRequest(
  work: WorkState,
  request: SqlCatalogSearchRequest,
  dialect: SqlRelationDialectRuntime,
): boolean {
  const existing = work.request;
  if (
    !work.joinable ||
    existing === null ||
    work.dialect !== dialect ||
    existing.scope !== request.scope ||
    existing.dialectId !== request.dialectId ||
    existing.limit !== request.limit ||
    existing.continuationToken !== request.continuationToken ||
    !sameComponent(existing.prefix, request.prefix) ||
    !samePath(existing.qualifier, request.qualifier) ||
    existing.searchPaths.length !== request.searchPaths.length
  ) {
    return false;
  }
  const leftEpoch = existing.expectedEpoch;
  const rightEpoch = request.expectedEpoch;
  if (
    (leftEpoch === null) !== (rightEpoch === null) ||
    (leftEpoch !== null &&
      rightEpoch !== null &&
      (leftEpoch.generation !== rightEpoch.generation ||
        leftEpoch.token !== rightEpoch.token))
  ) {
    return false;
  }
  for (
    let index = 0;
    index < existing.searchPaths.length;
    index += 1
  ) {
    const left = existing.searchPaths[index];
    const right = request.searchPaths[index];
    if (
      left === undefined ||
      right === undefined ||
      !samePath(left, right)
    ) {
      return false;
    }
  }
  return true;
}

function removeQueued(
  state: CoordinatorState,
  work: WorkState,
): void {
  const index = state.queue.indexOf(work);
  if (index >= 0) state.queue.splice(index, 1);
}

function removeJoinable(
  state: CoordinatorState,
  work: WorkState,
): void {
  if (!work.joinable) return;
  work.joinable = false;
  state.joinable.delete(work);
}

function revokeProviderCell(work: WorkState): void {
  const cell = work.providerCell;
  work.providerCell = null;
  if (!cell) return;
  cell.active = false;
  cell.deliver = null;
}

function revokeDecisionCell(work: WorkState): void {
  const cell = work.decisionCell;
  work.decisionCell = null;
  if (!cell) return;
  cell.active = false;
  cell.candidates = [];
  cell.pending = null;
}

function detachAbort(
  work: WorkState,
  pending: Effects,
): void {
  const controller = work.abortController;
  work.abortController = null;
  if (controller && !work.abortIssued) {
    work.abortIssued = true;
    pending.aborts.push(controller);
  }
}

function detachOwners(
  work: WorkState,
  outcome: SqlCatalogSearchWorkOutcome,
  pending: Effects,
): void {
  const consumers = [...work.owners];
  work.owners.clear();
  for (const consumer of consumers) {
    settleDetached(pending.settlements, consumer, outcome);
  }
}

function detachObserverState(
  observer: RefreshObserverState,
  pending: Effects,
): void {
  const work = observer.work;
  if (!work) return;
  observer.work = null;
  work.observers.delete(observer);
  const owner = observer.owner;
  owner.refreshObserver = null;
  const timer = observer.timer;
  observer.timer = null;
  if (timer) pending.timers.push(timer);
  observer.retention.observer = null;
}

function detachObservers(
  work: WorkState,
  pending: Effects,
): void {
  const observers = [...work.observers];
  for (const observer of observers) {
    detachObserverState(observer, pending);
  }
}

function finishWork(
  state: CoordinatorState,
  work: WorkState,
  outcome: SqlCatalogSearchWorkOutcome,
  pending: Effects,
  abort: boolean,
): void {
  if (work.phase === "terminal") return;
  const occupied =
    work.phase === "active" ||
    work.phase === "deciding" ||
    work.phase === "retired";
  removeJoinable(state, work);
  removeQueued(state, work);
  state.works.delete(work);
  work.phase = "terminal";
  if (occupied && state.activeCount > 0) {
    state.activeCount -= 1;
    pending.pump = true;
  }
  const queueTimer = work.queueTimer;
  const executionTimer = work.executionTimer;
  work.queueTimer = null;
  work.executionTimer = null;
  if (queueTimer) pending.timers.push(queueTimer);
  if (executionTimer) pending.timers.push(executionTimer);
  revokeProviderCell(work);
  revokeDecisionCell(work);
  detachOwners(work, outcome, pending);
  detachObservers(work, pending);
  if (abort) detachAbort(work, pending);
  else work.abortController = null;
  work.dialect = null;
  work.request = null;
  work.scope = "";
}

function retireActiveOwners(
  state: CoordinatorState,
  work: WorkState,
  outcome: SqlCatalogSearchWorkOutcome,
  pending: Effects,
): void {
  removeJoinable(state, work);
  work.phase = "retired";
  detachOwners(work, outcome, pending);
  detachObservers(work, pending);
  detachAbort(work, pending);
  work.dialect = null;
  work.request = null;
  work.scope = "";
}

function retireUnownedWork(
  state: CoordinatorState,
  work: WorkState,
  pending: Effects,
): void {
  if (work.phase === "queued") {
    finishWork(
      state,
      work,
      CANCELLED_OUTCOME,
      pending,
      false,
    );
  } else if (work.phase === "active") {
    retireActiveOwners(
      state,
      work,
      CANCELLED_OUTCOME,
      pending,
    );
  } else if (work.phase === "deciding") {
    finishWork(
      state,
      work,
      CANCELLED_OUTCOME,
      pending,
      false,
    );
  }
}

function detachConsumerInto(
  state: CoordinatorState,
  consumer: ConsumerState,
  outcome: SqlCatalogSearchWorkOutcome,
  pending: Effects,
): void {
  const work = consumer.work;
  if (work) {
    work.owners.delete(consumer);
  }
  settleDetached(pending.settlements, consumer, outcome);
  if (work && !hasWorkOwners(work)) {
    retireUnownedWork(state, work, pending);
  }
}

function detachConsumer(
  state: CoordinatorState,
  consumer: ConsumerState,
  outcome: SqlCatalogSearchWorkOutcome,
): void {
  const pending = effects();
  detachConsumerInto(
    state,
    consumer,
    outcome,
    pending,
  );
  runEffects(state, pending);
}

function detachRefreshObserverInto(
  state: CoordinatorState,
  observer: RefreshObserverState,
  pending: Effects,
): void {
  const work = observer.work;
  detachObserverState(observer, pending);
  if (!work || hasWorkOwners(work)) return;
  retireUnownedWork(state, work, pending);
}

function detachRefreshObserver(
  state: CoordinatorState,
  observer: RefreshObserverState,
): void {
  const pending = effects();
  detachRefreshObserverInto(state, observer, pending);
  runEffects(state, pending);
}

function handleQueueTimeout(
  state: CoordinatorState,
  work: WorkState,
): void {
  if (work.phase !== "queued") return;
  const pending = effects();
  finishWork(
    state,
    work,
    unavailableOutcome("queue-timeout"),
    pending,
    false,
  );
  runEffects(state, pending);
}

function handleExecutionTimeout(
  state: CoordinatorState,
  work: WorkState,
): void {
  if (
    work.phase !== "active" &&
    work.phase !== "retired" &&
    work.phase !== "deciding"
  ) {
    return;
  }
  const pending = effects();
  finishWork(
    state,
    work,
    unavailableOutcome("execution-timeout"),
    pending,
    true,
  );
  runEffects(state, pending);
}

function workPhase(work: WorkState): WorkState["phase"] {
  return work.phase;
}

function deliverProviderResult(
  cell: ProviderResultCell,
  fulfilled: boolean,
  value: unknown,
): void {
  if (!cell.active) return;
  cell.active = false;
  const deliver = cell.deliver;
  cell.deliver = null;
  deliver?.(fulfilled, value);
}

function attachProviderResult(
  state: CoordinatorState,
  work: WorkState,
  value: unknown,
): boolean {
  const cell: ProviderResultCell = {
    active: true,
    deliver: (fulfilled, result): void => {
      handleProviderResult(state, work, fulfilled, result);
    },
  };
  work.providerCell = cell;
  const onFulfilled = (result: unknown): void => {
    deliverProviderResult(cell, true, result);
  };
  const onRejected = (reason: unknown): void => {
    deliverProviderResult(cell, false, reason);
  };
  try {
    const promise = Reflect.apply(
      INTRINSIC_PROMISE_RESOLVE,
      INTRINSIC_PROMISE,
      [value],
    );
    Reflect.apply(INTRINSIC_PROMISE_THEN, promise, [
      onFulfilled,
      onRejected,
    ]);
    return true;
  } catch {
    revokeProviderCell(work);
    return false;
  }
}

function drainDetachedSettlement(value: unknown): void {
  try {
    const promise = Reflect.apply(
      INTRINSIC_PROMISE_RESOLVE,
      INTRINSIC_PROMISE,
      [value],
    );
    Reflect.apply(INTRINSIC_PROMISE_THEN, promise, [
      undefined,
      IGNORE_DETACHED_REJECTION,
    ]);
  } catch {
    // The detached result has no authority over coordinator state.
  }
}

function settleDecision(
  cell: ResponseDecisionCell,
  decision: SqlCatalogResponseEpochDecision,
): void {
  if (!cell.active) return;
  cell.pending = decision;
  advanceDecision(cell);
}

function finishDecision(
  cell: ResponseDecisionCell,
  state: CoordinatorState,
  work: WorkState,
  outcome: SqlCatalogSearchWorkOutcome,
): void {
  cell.active = false;
  const pending = effects();
  finishWork(state, work, outcome, pending, false);
  runEffects(state, pending);
}

function prepareAvailabilityObservers(
  state: CoordinatorState,
  work: WorkState,
  pending: Effects,
): void {
  const observers = [...work.observers];
  for (const observer of observers) {
    const prepare = observer.prepareAvailability;
    const notification: AvailabilityNotificationState = {
      active: true,
      owner: observer.owner,
      requestToken: observer.owner.requestToken,
      scope: observer.owner.scope,
    };
    state.notifications.add(notification);
    detachObserverState(observer, pending);
    pending.availabilityPreparations.push({
      notification,
      prepare,
    });
  }
}

function finishUsableDecision(
  cell: ResponseDecisionCell,
  state: CoordinatorState,
  work: WorkState,
  outcome: Extract<
    SqlCatalogSearchWorkOutcome,
    { readonly status: "usable" }
  >,
): void {
  const recorded = state.policyStore.record(
    cell.request,
    cell.dialect,
    outcome.response,
  );
  if (recorded.status !== "accepted") {
    finishDecision(
      cell,
      state,
      work,
      recorded.status === "conflict" &&
        recorded.reason === "capacity"
          ? unavailableOutcome("overloaded")
          : SUPERSEDED_OUTCOME,
    );
    return;
  }
  cell.active = false;
  const pending = effects();
  if (outcome.response.status === "ready") {
    prepareAvailabilityObservers(state, work, pending);
  }
  finishWork(state, work, outcome, pending, false);
  runEffects(state, pending);
}

function decisionOutcome(
  decision: Exclude<
    SqlCatalogResponseEpochDecision,
    { readonly status: "usable" }
  >,
): SqlCatalogSearchWorkOutcome {
  if (decision.status === "superseded") {
    return SUPERSEDED_OUTCOME;
  }
  switch (decision.reason) {
    case "disposed":
      return unavailableOutcome("disposed");
    case "malformed":
      return unavailableOutcome("malformed-response");
    case "overloaded":
      return unavailableOutcome("overloaded");
    case "retired":
    case "stale":
    case "token-conflict":
      return SUPERSEDED_OUTCOME;
  }
}

function rekeyUnobservedWork(
  state: CoordinatorState,
  producingWork: WorkState,
  response: SqlValidatedCatalogSearchResponse,
): void {
  const scope = producingWork.scope;
  for (const work of state.joinable) {
    if (work === producingWork || work.scope !== scope) {
      continue;
    }
    const request = work.request;
    if (!request || request.expectedEpoch !== null) {
      continue;
    }
    work.request = Object.freeze({
      ...request,
      expectedEpoch: response.epoch,
    });
  }
}

function advanceDecision(cell: ResponseDecisionCell): void {
  if (!cell.active || cell.advancing) return;
  cell.advancing = true;
  try {
    for (;;) {
      if (!cell.active) return;
      const state = cell.state;
      const work = cell.work;
      const response = cell.response;
      const pendingDecision = cell.pending;
      cell.pending = null;
      if (pendingDecision) {
        if (
          pendingDecision.status === "discarded" &&
          pendingDecision.reason === "retired"
        ) {
          // Try a capture belonging to another live shared owner.
        } else if (pendingDecision.status === "usable") {
          if (pendingDecision.observation === "baseline") {
            rekeyUnobservedWork(state, work, response);
          }
          finishUsableDecision(
            cell,
            state,
            work,
            Object.freeze({
              observation: pendingDecision.observation,
              response,
              status: "usable",
            }),
          );
          return;
        } else {
          finishDecision(
            cell,
            state,
            work,
            decisionOutcome(pendingDecision),
          );
          return;
        }
      }
      let capture: SqlCatalogEpochCapture | null = null;
      while (cell.index < cell.candidates.length) {
        const candidate = cell.candidates[cell.index];
        cell.index += 1;
        if (
          candidate &&
          (candidate.kind === "observer"
            ? candidate.work !== null
            : !candidate.settled) &&
          candidate.work === work
        ) {
          capture = candidate.capture;
          break;
        }
      }
      if (!capture) {
        finishDecision(
          cell,
          state,
          work,
          SUPERSEDED_OUTCOME,
        );
        return;
      }
      const submitted = state.epochs.submitResponseEpoch(
        capture,
        response.epoch,
        (decision): void => {
          settleDecision(cell, decision);
        },
      );
      if (submitted.status === "submitted") {
        if (cell.pending === null) return;
        continue;
      }
      cell.pending = submitted.decision;
    }
  } finally {
    cell.advancing = false;
    if (cell.active && cell.pending !== null) {
      advanceDecision(cell);
    }
  }
}

function handleProviderResult(
  state: CoordinatorState,
  work: WorkState,
  fulfilled: boolean,
  raw: unknown,
): void {
  if (
    work.phase !== "active" &&
    work.phase !== "retired"
  ) {
    return;
  }
  revokeProviderCell(work);
  if (work.phase === "retired") {
    const pending = effects();
    finishWork(
      state,
      work,
      CANCELLED_OUTCOME,
      pending,
      false,
    );
    runEffects(state, pending);
    return;
  }
  const now = readNow(state);
  const phaseAfterClock = workPhase(work);
  if (
    state.disposed ||
    (phaseAfterClock !== "active" &&
      phaseAfterClock !== "retired")
  ) {
    return;
  }
  if (phaseAfterClock === "retired") {
    const pending = effects();
    finishWork(
      state,
      work,
      CANCELLED_OUTCOME,
      pending,
      false,
    );
    runEffects(state, pending);
    return;
  }
  if (
    now === null ||
    work.executionDeadline === null ||
    now >= work.executionDeadline
  ) {
    handleExecutionTimeout(state, work);
    return;
  }
  removeJoinable(state, work);
  work.phase = "deciding";
  if (!fulfilled) {
    const pending = effects();
    finishWork(
      state,
      work,
      unavailableOutcome("provider-failed"),
      pending,
      false,
    );
    runEffects(state, pending);
    return;
  }
  const request = work.request;
  const dialect = work.dialect;
  if (!request || !dialect) {
    const pending = effects();
    finishWork(
      state,
      work,
      unavailableOutcome("disposed"),
      pending,
      false,
    );
    runEffects(state, pending);
    return;
  }
  const decoded = decodeSqlCatalogSearchResponse(
    raw,
    request.limit,
    dialect,
  );
  if (
    state.disposed ||
    work.phase !== "deciding" ||
    !hasWorkOwners(work)
  ) {
    return;
  }
  const afterDecode = readNow(state);
  if (
    state.disposed ||
    work.phase !== "deciding" ||
    !hasWorkOwners(work) ||
    afterDecode === null ||
    work.executionDeadline === null ||
    afterDecode >= work.executionDeadline
  ) {
    handleExecutionTimeout(state, work);
    return;
  }
  if (decoded.status !== "accepted") {
    const pending = effects();
    finishWork(
      state,
      work,
      unavailableOutcome("malformed-response"),
      pending,
      false,
    );
    runEffects(state, pending);
    return;
  }
  const cell: ResponseDecisionCell = {
    active: true,
    advancing: false,
    candidates: [
      ...work.owners,
      ...work.observers,
    ],
    dialect,
    index: 0,
    pending: null,
    request,
    response: decoded.value,
    state,
    work,
  };
  work.decisionCell = cell;
  advanceDecision(cell);
}

function startWork(
  state: CoordinatorState,
  work: WorkState,
): void {
  const startedAt = readNow(state);
  if (
    state.disposed ||
    work.phase !== "queued" ||
    !hasWorkOwners(work)
  ) {
    return;
  }
  if (
    startedAt === null ||
    startedAt >= work.queueDeadline
  ) {
    handleQueueTimeout(state, work);
    return;
  }
  const queueTimer = work.queueTimer;
  work.queueTimer = null;
  work.phase = "active";
  state.activeCount += 1;
  const controller = new AbortController();
  work.abortController = controller;
  const executionDeadline = deadlineFrom(
    startedAt,
    state.options.executionDeadlineMs,
  );
  if (executionDeadline === null) {
    handleExecutionTimeout(state, work);
    if (queueTimer) clearDeadline(state, queueTimer);
    return;
  }
  work.executionDeadline = executionDeadline;
  const executionTimer = scheduleDeadline(
    state,
    executionDeadline,
    () => handleExecutionTimeout(state, work),
  );
  if (work.phase !== "active") {
    clearDeadline(state, executionTimer);
    if (queueTimer) clearDeadline(state, queueTimer);
    return;
  }
  work.executionTimer = executionTimer;
  if (queueTimer) clearDeadline(state, queueTimer);
  const search = state.search;
  const request = work.request;
  if (!search || !request || state.disposed) {
    const pending = effects();
    finishWork(
      state,
      work,
      unavailableOutcome("disposed"),
      pending,
      true,
    );
    runEffects(state, pending);
    return;
  }
  let returned: unknown;
  try {
    returned = Reflect.apply(search, undefined, [
      request,
      controller.signal,
    ]);
  } catch {
    const pending = effects();
    finishWork(
      state,
      work,
      unavailableOutcome("provider-failed"),
      pending,
      true,
    );
    runEffects(state, pending);
    return;
  }
  const phaseAfterSearch = workPhase(work);
  if (
    state.disposed ||
    phaseAfterSearch === "terminal"
  ) {
    drainDetachedSettlement(returned);
    return;
  }
  const attached = attachProviderResult(state, work, returned);
  const observedAt = readNow(state);
  if (
    !attached ||
    observedAt === null ||
    observedAt - startedAt >
      state.options.synchronousBudgetMs
  ) {
    const pending = effects();
    finishWork(
      state,
      work,
      unavailableOutcome(
        attached
          ? "execution-timeout"
          : "provider-failed",
      ),
      pending,
      true,
    );
    runEffects(state, pending);
  }
}

function pump(state: CoordinatorState): void {
  state.pumpRequested = true;
  if (state.pumping || state.disposed) return;
  state.pumping = true;
  try {
    while (state.pumpRequested && !state.disposed) {
      state.pumpRequested = false;
      while (
        state.activeCount <
          MAX_CATALOG_ACTIVE_SEARCH_WORK &&
        state.queue.length > 0
      ) {
        const work = state.queue.shift();
        if (!work) break;
        startWork(state, work);
      }
    }
  } finally {
    state.pumping = false;
  }
}

function makeImmediateTicket(
  outcome: SqlCatalogSearchWorkOutcome,
): SqlCatalogSearchWorkTicket {
  return Object.freeze({
    cancel: (): void => {},
    retainForRefresh:
      (): SqlCatalogSearchRefreshRetentionResult =>
        Object.freeze({
          reason:
            outcome.status === "unavailable" &&
            outcome.reason === "disposed"
              ? "disposed"
              : "not-retainable",
          status: "unavailable",
        }),
    result: new INTRINSIC_PROMISE<SqlCatalogSearchWorkOutcome>(
      (resolve) => {
        resolve(outcome);
      },
    ),
  });
}

function unavailableRetention(
  reason: Extract<
    SqlCatalogSearchRefreshRetentionResult,
    { readonly status: "unavailable" }
  >["reason"],
): SqlCatalogSearchRefreshRetentionResult {
  return Object.freeze({ reason, status: "unavailable" });
}

function retainConsumerForRefresh(
  state: CoordinatorState,
  consumer: ConsumerState,
  owner: OwnerState,
  work: WorkState,
  prepareAvailability: SqlCatalogSearchAvailabilityTarget,
): SqlCatalogSearchRefreshRetentionResult {
  if (typeof prepareAvailability !== "function") {
    return unavailableRetention("invalid-target");
  }
  const retention = consumer.retention;
  const hardDeadline =
    work.phase === "queued"
      ? work.queueDeadline
      : work.executionDeadline;
  const requestToken = owner.requestToken;
  const now = readNow(state);
  if (
    state.disposed ||
    owner.disposed ||
    owner.owner !== state
  ) {
    return unavailableRetention("disposed");
  }
  if (
    owner.requestToken !== requestToken ||
    consumer.settled ||
    consumer.work !== work ||
    owner.current !== consumer
  ) {
    return unavailableRetention("superseded");
  }
  if (
    now === null ||
    hardDeadline === null ||
    now >= hardDeadline
  ) {
    return unavailableRetention("expired");
  }
  const leaseDeadline = deadlineFrom(
    now,
    state.options.refreshLeaseMs,
  );
  if (leaseDeadline === null) {
    return unavailableRetention("expired");
  }
  const deadline = Math.min(
    hardDeadline,
    leaseDeadline,
  );
  const observer: RefreshObserverState = {
    capture: consumer.capture,
    kind: "observer",
    owner,
    prepareAvailability,
    retention,
    timer: null,
    work,
  };
  work.observers.add(observer);
  owner.refreshObserver = observer;
  retention.observer = observer;
  const pending = effects();
  work.owners.delete(consumer);
  settleDetached(
    pending.settlements,
    consumer,
    CANCELLED_OUTCOME,
  );
  const timer = scheduleDeadline(
    state,
    deadline,
    () => detachRefreshObserver(state, observer),
  );
  if (observer.work) {
    observer.timer = timer;
  } else {
    clearDeadline(state, timer);
  }
  runEffects(state, pending);
  if (!observer.work) {
    return unavailableRetention(
      state.disposed || owner.disposed
        ? "disposed"
        : owner.requestToken !== requestToken
          ? "superseded"
          : "expired",
    );
  }
  return Object.freeze({
    remainingLeaseMs: deadline - now,
    status: "retained",
  });
}

function makeConsumer(
  capture: SqlCatalogEpochCapture,
  owner: OwnerState,
): {
  readonly consumer: ConsumerState;
  readonly ticket: SqlCatalogSearchWorkTicket;
} {
  let resolve: (outcome: SqlCatalogSearchWorkOutcome) => void =
    IGNORE_DETACHED_REJECTION;
  const result =
    new INTRINSIC_PROMISE<SqlCatalogSearchWorkOutcome>(
      (settle) => {
        resolve = settle;
      },
    );
  const retention: TicketRetentionState = {
    consumer: null,
    observer: null,
  };
  const consumer: ConsumerState = {
    cancelled: false,
    capture,
    kind: "consumer",
    owner,
    resolve,
    retention,
    settled: false,
    work: null,
  };
  retention.consumer = consumer;
  return {
    consumer,
    ticket: Object.freeze({
      cancel: (): void => {
        if (consumer.cancelled) return;
        consumer.cancelled = true;
        const observer = retention.observer;
        const observerState = observer?.owner?.owner;
        if (observer && observerState) {
          detachRefreshObserver(
            observerState,
            observer,
          );
          return;
        }
        if (consumer.settled) return;
        const state = consumer.owner?.owner;
        if (state) {
          detachConsumer(
            state,
            consumer,
            CANCELLED_OUTCOME,
          );
        }
      },
      retainForRefresh: (
        prepareAvailability:
          SqlCatalogSearchAvailabilityTarget,
      ): SqlCatalogSearchRefreshRetentionResult => {
        const retainedConsumer = retention.consumer;
        const retainedOwner = retainedConsumer?.owner;
        const retainedWork = retainedConsumer?.work;
        const state = retainedOwner?.owner;
        if (
          !retainedConsumer ||
          !retainedOwner ||
          !retainedWork ||
          !state
        ) {
          return unavailableRetention("not-retainable");
        }
        return retainConsumerForRefresh(
          state,
          retainedConsumer,
          retainedOwner,
          retainedWork,
          prepareAvailability,
        );
      },
      result,
    }),
  };
}

function findWork(
  state: CoordinatorState,
  request: SqlCatalogSearchRequest,
  dialect: SqlRelationDialectRuntime,
): WorkState | null {
  for (const work of state.joinable) {
    if (sameRequest(work, request, dialect)) return work;
  }
  return null;
}

function replaceOwnerConsumer(
  state: CoordinatorState,
  owner: OwnerState,
  consumer: ConsumerState,
  work: WorkState,
): void {
  const pending = effects();
  const previous = owner.current;
  const previousObserver = owner.refreshObserver;
  work.owners.add(consumer);
  consumer.work = work;
  owner.current = consumer;
  if (previous && previous !== consumer) {
    detachConsumerInto(
      state,
      previous,
      SUPERSEDED_OUTCOME,
      pending,
    );
  }
  if (previousObserver) {
    detachRefreshObserverInto(
      state,
      previousObserver,
      pending,
    );
  }
  runEffects(state, pending);
}

function replaceOwnerWithImmediate(
  state: CoordinatorState,
  owner: OwnerState,
  requestToken: object,
  outcome: SqlCatalogSearchWorkOutcome,
): SqlCatalogSearchWorkTicket {
  const pending = effects();
  const previous = owner.current;
  const previousObserver = owner.refreshObserver;
  if (previous) {
    detachConsumerInto(
      state,
      previous,
      SUPERSEDED_OUTCOME,
      pending,
    );
  }
  if (previousObserver) {
    detachRefreshObserverInto(
      state,
      previousObserver,
      pending,
    );
  }
  runEffects(state, pending);
  if (
    state.disposed ||
    owner.disposed ||
    owner.owner !== state
  ) {
    return makeImmediateTicket(
      unavailableOutcome("disposed"),
    );
  }
  if (owner.requestToken !== requestToken) {
    return makeImmediateTicket(SUPERSEDED_OUTCOME);
  }
  return makeImmediateTicket(outcome);
}

function requestWork(
  state: CoordinatorState,
  owner: OwnerState,
  input: SqlCatalogSearchWorkInput,
): SqlCatalogSearchWorkTicket {
  const requestToken = {};
  owner.requestToken = requestToken;
  const captured = owner.membership.captureEpoch();
  if (
    state.disposed ||
    owner.disposed ||
    owner.owner !== state
  ) {
    return makeImmediateTicket(
      unavailableOutcome("disposed"),
    );
  }
  if (owner.requestToken !== requestToken) {
    return makeImmediateTicket(SUPERSEDED_OUTCOME);
  }
  if (captured.status !== "captured") {
    const pending = effects();
    const previous = owner.current;
    if (previous) {
      detachConsumerInto(
        state,
        previous,
        SUPERSEDED_OUTCOME,
        pending,
      );
    }
    if (owner.refreshObserver) {
      detachRefreshObserverInto(
        state,
        owner.refreshObserver,
        pending,
      );
    }
    runEffects(state, pending);
    return makeImmediateTicket(
      unavailableOutcome(
        captured.reason === "inactive"
          ? "inactive"
          : "disposed",
      ),
    );
  }
  let request: SqlCatalogSearchRequest | null = null;
  try {
    const requestResult = createSqlCatalogSearchRequest({
      continuationToken: input.continuationToken,
      dialectId: owner.dialect.id,
      expectedEpoch: captured.capture.expectedEpoch,
      limit: input.limit,
      prefix: input.prefix,
      qualifier: input.qualifier,
      scope: owner.scope,
      searchPaths: input.searchPaths,
    });
    if (requestResult.status === "accepted") {
      request = requestResult.value;
    }
  } catch {
    // Hostile runtime input is an invalid request.
  }
  if (
    state.disposed ||
    owner.disposed ||
    owner.owner !== state
  ) {
    return makeImmediateTicket(
      unavailableOutcome("disposed"),
    );
  }
  if (owner.requestToken !== requestToken) {
    return makeImmediateTicket(SUPERSEDED_OUTCOME);
  }
  if (!request) {
    return replaceOwnerWithImmediate(
      state,
      owner,
      requestToken,
      unavailableOutcome("invalid-request"),
    );
  }
  const policy = state.policyStore.probe(
    request,
    owner.dialect,
  );
  if (policy.status === "ready") {
    return replaceOwnerWithImmediate(
      state,
      owner,
      requestToken,
      Object.freeze({
        observation: "equal",
        response: policy.response,
        status: "usable",
      }),
    );
  }
  if (policy.status === "failed") {
    return replaceOwnerWithImmediate(
      state,
      owner,
      requestToken,
      Object.freeze({
        observation: "equal",
        response: Object.freeze({
          code: policy.code,
          epoch: policy.epoch,
          retry: policy.retry,
          status: "failed",
        }),
        status: "usable",
      }),
    );
  }
  if (policy.status === "overloaded") {
    return replaceOwnerWithImmediate(
      state,
      owner,
      requestToken,
      unavailableOutcome("overloaded"),
    );
  }
  if (
    policy.status === "miss" &&
    policy.loadingEpoch !== null &&
    state.epochs.hasLiveSubscription(owner.scope)
  ) {
    return replaceOwnerWithImmediate(
      state,
      owner,
      requestToken,
      Object.freeze({
        observation: "equal",
        response: Object.freeze({
          epoch: policy.loadingEpoch,
          status: "loading",
        }),
        status: "usable",
      }),
    );
  }
  const created = makeConsumer(captured.capture, owner);
  const existing = findWork(
    state,
    request,
    owner.dialect,
  );
  if (existing) {
    replaceOwnerConsumer(
      state,
      owner,
      created.consumer,
      existing,
    );
    return created.ticket;
  }
  const pending = effects();
  const previous = owner.current;
  const previousObserver = owner.refreshObserver;
  if (previous) {
    detachConsumerInto(
      state,
      previous,
      SUPERSEDED_OUTCOME,
      pending,
    );
  }
  if (previousObserver) {
    detachRefreshObserverInto(
      state,
      previousObserver,
      pending,
    );
  }
  if (
    state.queue.length >=
    MAX_CATALOG_QUEUED_SEARCH_WORK
  ) {
    runEffects(state, pending);
    return makeImmediateTicket(
      unavailableOutcome("overloaded"),
    );
  }
  const now = readNow(state);
  const disposedDuringClock =
    state.disposed ||
    owner.disposed ||
    owner.owner !== state;
  if (
    owner.requestToken !== requestToken ||
    disposedDuringClock
  ) {
    runEffects(state, pending);
    return makeImmediateTicket(
      disposedDuringClock
        ? unavailableOutcome("disposed")
        : SUPERSEDED_OUTCOME,
    );
  }
  if (now === null) {
    runEffects(state, pending);
    return makeImmediateTicket(
      unavailableOutcome("execution-timeout"),
    );
  }
  const queueDeadline = deadlineFrom(
    now,
    state.options.queueDeadlineMs,
  );
  if (queueDeadline === null) {
    runEffects(state, pending);
    return makeImmediateTicket(
      unavailableOutcome("execution-timeout"),
    );
  }
  const work: WorkState = {
    abortController: null,
    abortIssued: false,
    decisionCell: null,
    dialect: owner.dialect,
    executionDeadline: null,
    executionTimer: null,
    joinable: true,
    observers: new Set(),
    owners: new Set([created.consumer]),
    phase: "queued",
    providerCell: null,
    queueDeadline,
    queueTimer: null,
    request,
    scope: owner.scope,
  };
  created.consumer.work = work;
  owner.current = created.consumer;
  state.joinable.add(work);
  state.works.add(work);
  state.queue.push(work);
  runEffects(state, pending);
  pump(state);
  if (work.phase !== "queued") {
    return created.ticket;
  }
  const queueTimer = scheduleDeadline(
    state,
    queueDeadline,
    () => handleQueueTimeout(state, work),
  );
  if (work.phase === "queued") {
    work.queueTimer = queueTimer;
  } else {
    clearDeadline(state, queueTimer);
  }
  return created.ticket;
}

function prepareTransition(
  state: CoordinatorState,
  scope: string,
  epoch: SqlCatalogEpoch,
): (() => undefined) | null {
  retireNotifications(
    state,
    (notification) => notification.scope === scope,
  );
  state.policyStore.advanceScope(scope, epoch);
  const pending = effects();
  for (const work of state.works) {
    if (
      work.scope !== scope ||
      work.phase === "retired" ||
      work.phase === "terminal"
    ) {
      continue;
    }
    if (work.phase === "active") {
      retireActiveOwners(
        state,
        work,
        SUPERSEDED_OUTCOME,
        pending,
      );
    } else {
      finishWork(
        state,
        work,
        SUPERSEDED_OUTCOME,
        pending,
        false,
      );
    }
  }
  if (
    pending.aborts.length === 0 &&
    pending.settlements.length === 0 &&
    pending.timers.length === 0 &&
    !pending.pump
  ) {
    return null;
  }
  return (): undefined => {
    runEffects(state, pending);
    return undefined;
  };
}

function unavailableOwner(
  reason: Exclude<
    SqlCatalogSearchWorkOwnerResult,
    { readonly status: "prepared" }
  >["reason"],
): SqlCatalogSearchWorkOwnerResult {
  return Object.freeze({ reason, status: "unavailable" });
}

function disposeOwner(owner: OwnerState): void {
  if (owner.disposed) return;
  const state = owner.owner;
  owner.disposed = true;
  owner.owner = null;
  owner.requestToken = null;
  if (state) {
    retireNotifications(
      state,
      (notification) => notification.owner === owner,
    );
    state.owners.delete(owner);
  }
  const current = owner.current;
  const observer = owner.refreshObserver;
  owner.current = null;
  owner.refreshObserver = null;
  if (state && (current || observer)) {
    const pending = effects();
    if (current) {
      detachConsumerInto(
        state,
        current,
        CANCELLED_OUTCOME,
        pending,
      );
    }
    if (observer) {
      detachRefreshObserverInto(
        state,
        observer,
        pending,
      );
    }
    runEffects(state, pending);
  }
  owner.membership.dispose();
}

function createOwnerHandle(
  owner: OwnerState,
): SqlCatalogSearchWorkOwner {
  return Object.freeze({
    activate: () => {
      return owner.membership.activate();
    },
    dispose: (): void => {
      disposeOwner(owner);
    },
    request: (
      input: SqlCatalogSearchWorkInput,
    ): SqlCatalogSearchWorkTicket => {
      const state = owner.owner;
      if (!state || owner.disposed) {
        return makeImmediateTicket(
          unavailableOutcome("disposed"),
        );
      }
      return requestWork(state, owner, input);
    },
  });
}

function prepareOwner(
  state: CoordinatorState,
  scope: unknown,
  dialect: SqlRelationDialectRuntime,
  target: SqlCatalogRevisionTarget,
): SqlCatalogSearchWorkOwnerResult {
  if (state.disposed) return unavailableOwner("disposed");
  if (!isValidSqlCatalogScope(scope)) {
    return unavailableOwner("invalid-scope");
  }
  if (!isSqlRelationDialectRuntime(dialect)) {
    return unavailableOwner("invalid-dialect");
  }
  const prepared = state.epochs.prepareScopeMembership(
    scope,
    target,
  );
  if (prepared.status !== "prepared") {
    return unavailableOwner(
      prepared.reason === "disposed"
        ? "disposed"
        : prepared.reason,
    );
  }
  const owner: OwnerState = {
    current: null,
    dialect,
    disposed: false,
    membership: prepared.membership,
    owner: state,
    refreshObserver: null,
    requestToken: null,
    scope,
  };
  state.owners.add(owner);
  return Object.freeze({
    owner: createOwnerHandle(owner),
    status: "prepared",
  });
}

function disposeCoordinatorState(
  state: CoordinatorState,
): void {
  if (state.disposed) return;
  state.disposed = true;
  state.search = null;
  state.pumpRequested = false;
  retireNotifications(state, () => true);
  const pending = effects();
  for (const work of state.works) {
    finishWork(
      state,
      work,
      unavailableOutcome("disposed"),
      pending,
      true,
    );
  }
  for (const owner of state.owners) {
    owner.disposed = true;
    owner.current = null;
    owner.owner = null;
    owner.refreshObserver = null;
    owner.requestToken = null;
  }
  state.owners.clear();
  state.policyStore.dispose();
  state.epochs.dispose();
  runEffects(state, pending);
}

export function createSqlCatalogSearchWorkCoordinator(
  provider: CapturedSqlRelationCatalogProvider,
  options?: SqlCatalogSearchWorkOptions,
): SqlCatalogSearchWorkCoordinatorResult {
  const context = resolveSqlRelationCatalogProvider(provider);
  if (!context) {
    return Object.freeze({
      reason: "invalid-provider",
      status: "unavailable",
    });
  }
  const normalized = normalizeOptions(options);
  if (!normalized) {
    return Object.freeze({
      reason: "invalid-options",
      status: "unavailable",
    });
  }
  let state: CoordinatorState | null = null;
  const epochResult = createSqlCatalogEpochCoordinator(
    provider,
    (scope, epoch): (() => undefined) | null =>
      state ? prepareTransition(state, scope, epoch) : null,
    (): undefined => {
      if (state) disposeCoordinatorState(state);
      return undefined;
    },
  );
  if (epochResult.status !== "created") {
    return Object.freeze({
      reason: "invalid-provider",
      status: "unavailable",
    });
  }
  state = {
    activeCount: 0,
    disposed: false,
    epochs: epochResult.coordinator,
    joinable: new Set(),
    lastNow: normalized.initialNow,
    notifications: new Set(),
    options: normalized.options,
    owners: new Set(),
    policyStore: createSqlCatalogSearchPolicyStore(),
    pumpRequested: false,
    pumping: false,
    queue: [],
    search: context.search,
    works: new Set(),
  };
  const capturedState = state;
  return Object.freeze({
    coordinator: Object.freeze({
      dispose: (): void => {
        disposeCoordinatorState(capturedState);
      },
      prepareOwner: (
        scope: unknown,
        dialect: SqlRelationDialectRuntime,
        target: SqlCatalogRevisionTarget,
      ): SqlCatalogSearchWorkOwnerResult =>
        prepareOwner(
          capturedState,
          scope,
          dialect,
          target,
        ),
      providerId: context.id,
    }),
    status: "created",
  });
}
