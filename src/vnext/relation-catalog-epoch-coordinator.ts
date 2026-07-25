import {
  compareSqlCatalogEpoch,
  decodeSqlCatalogInvalidation,
  isValidSqlCatalogScope,
  resolveSqlRelationCatalogProvider,
} from "./relation-catalog-boundary.js";
import type { SqlCapturedRelationCatalogProviderContext } from "./relation-catalog-boundary.js";
import type { SqlCatalogEpoch } from "./relation-completion-types.js";

export const MAX_CATALOG_LIVE_SCOPES = 128;
export const MAX_CATALOG_MEMBERSHIPS = 1_024;
export const MAX_CATALOG_MEMBERSHIPS_PER_SCOPE = 256;
export const MAX_CATALOG_CALLBACKS_PER_RESET_WINDOW = 256;
export const MAX_CATALOG_EPOCH_COMMANDS = 1_024;
export const MAX_CATALOG_CLEANUPS_PER_BARRIER = 1_024;

export interface SqlCatalogRevisionTarget {
  readonly prepareCatalogChange: (
    this: void,
  ) => ((this: void) => void) | null;
}

export type SqlCatalogEpochTransitionTarget = (
  this: void,
  scope: string,
  epoch: SqlCatalogEpoch,
) =>
  | ((this: void) => undefined)
  | null;

const epochCaptureBrand: unique symbol = Symbol(
  "SqlCatalogEpochCapture",
);
const EPOCH_CAPTURE_KIND = "SqlCatalogEpochCapture";

export interface SqlCatalogEpochCapture {
  readonly [epochCaptureBrand]: "SqlCatalogEpochCapture";
  readonly expectedEpoch: SqlCatalogEpoch | null;
}

export type SqlCatalogMembershipActivationResult =
  | { readonly status: "active" }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "disposed"
        | "scope-capacity"
        | "scope-membership-capacity"
        | "coordinator-disposed";
    };

export type SqlCatalogEpochCaptureResult =
  | {
      readonly status: "captured";
      readonly capture: SqlCatalogEpochCapture;
    }
  | {
      readonly status: "unavailable";
      readonly reason: "inactive" | "disposed";
    };

export interface SqlCatalogScopeMembership {
  readonly activate: (
    this: void,
  ) => SqlCatalogMembershipActivationResult;
  readonly captureEpoch: (
    this: void,
  ) => SqlCatalogEpochCaptureResult;
  readonly dispose: (this: void) => void;
}

export type SqlCatalogScopeMembershipResult =
  | {
      readonly status: "prepared";
      readonly membership: SqlCatalogScopeMembership;
    }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "disposed"
        | "invalid-scope"
        | "invalid-target"
        | "membership-capacity";
    };

export type SqlCatalogResponseEpochDecision =
  | {
      readonly status: "usable";
      readonly observation: "baseline" | "equal";
      readonly epoch: SqlCatalogEpoch;
    }
  | {
      readonly status: "superseded";
      readonly epoch: SqlCatalogEpoch;
    }
  | {
      readonly status: "discarded";
      readonly reason:
        | "stale"
        | "token-conflict"
        | "retired"
        | "disposed"
        | "malformed"
        | "overloaded";
    };

export type SqlCatalogResponseEpochSubmissionResult =
  | {
      readonly status: "submitted";
    }
  | {
      readonly status: "settled";
      readonly decision: Extract<
        SqlCatalogResponseEpochDecision,
        { readonly status: "discarded" }
      >;
    };

export interface SqlCatalogEpochCoordinator {
  readonly providerId: string;
  readonly prepareScopeMembership: (
    this: void,
    scope: unknown,
    target: SqlCatalogRevisionTarget,
  ) => SqlCatalogScopeMembershipResult;
  readonly submitResponseEpoch: (
    this: void,
    capture: unknown,
    epoch: unknown,
    onDecision: (
      this: void,
      decision: SqlCatalogResponseEpochDecision,
    ) => void,
  ) => SqlCatalogResponseEpochSubmissionResult;
  readonly dispose: (this: void) => void;
}

export type SqlCatalogEpochCoordinatorResult =
  | {
      readonly status: "created";
      readonly coordinator: SqlCatalogEpochCoordinator;
    }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "invalid-disposal-target"
        | "invalid-provider"
        | "invalid-transition-target";
    };

interface CoordinatorState {
  cleanupAdmissions: number;
  cleanupDeferralDepth: number;
  cleanupOverloaded: boolean;
  disposed: boolean;
  draining: boolean;
  readonly captures: WeakMap<object, CaptureState>;
  readonly commands: EpochCommand[];
  readonly deferredCleanup: Set<SubscriptionState>;
  readonly memberships: Set<MembershipState>;
  onDispose: ((this: void) => undefined) | null;
  prepareEpochTransition: Function | null;
  readonly providerId: string;
  readonly scopes: Map<string, ScopeEntry>;
  subscribe: SqlCapturedRelationCatalogProviderContext["subscribe"];
}

interface ScopeEntry {
  readonly members: Set<MembershipState>;
  notificationSequence: number;
  observedEpoch: SqlCatalogEpoch | null;
  readonly scope: string;
  subscription: SubscriptionState | null;
  subscriptionAttempted: boolean;
}

interface MembershipState {
  active: boolean;
  disposed: boolean;
  disposedByCoordinator: boolean;
  entry: ScopeEntry | null;
  owner: CoordinatorState | null;
  prepareCatalogChange: (this: void) => unknown;
  readonly scope: string;
}

interface CaptureState {
  claimed: boolean;
  readonly entry: ScopeEntry;
  readonly membership: MembershipState;
  readonly notificationSequence: number;
  readonly owner: CoordinatorState;
}

interface CallbackCell {
  active: boolean;
  callbackCount: number;
  decode:
    | ((value: unknown) => SqlCatalogEpoch | null)
    | null;
  decoding: boolean;
  deliver:
    | ((value: SqlCatalogEpoch) => void)
    | null;
  overload: (() => void) | null;
  resetTimer: ReturnType<typeof setTimeout> | null;
}

interface SubscriptionState {
  readonly cell: CallbackCell;
  cleanupCalled: boolean;
  cleanup: Function | null;
  failed: boolean;
  installing: boolean;
  readonly pending: SqlCatalogEpoch[];
}

interface InvalidationCommand {
  readonly entry: ScopeEntry;
  readonly kind: "invalidation";
  readonly subscription: SubscriptionState;
  readonly epoch: SqlCatalogEpoch;
}

interface ResponseCommand {
  readonly capture: CaptureState;
  readonly epoch: unknown;
  readonly kind: "response";
  readonly onDecision: (
    this: void,
    decision: SqlCatalogResponseEpochDecision,
  ) => void;
}

type EpochCommand = InvalidationCommand | ResponseCommand;

const ACTIVE_RESULT: SqlCatalogMembershipActivationResult =
  Object.freeze({ status: "active" });
const SUBMITTED_RESULT: SqlCatalogResponseEpochSubmissionResult =
  Object.freeze({ status: "submitted" });
const NO_PREPARE_CATALOG_CHANGE = (): null => null;
const IGNORE_DETACHED_REJECTION = (): void => {};
const INTRINSIC_PROMISE = Promise;
const INTRINSIC_PROMISE_RESOLVE = Promise.resolve;
const INTRINSIC_PROMISE_THEN = Promise.prototype.then;
const FAILED_EPOCH_TRANSITION: unique symbol = Symbol(
  "FailedSqlCatalogEpochTransition",
);

function unavailableActivation(
  reason: Exclude<
    SqlCatalogMembershipActivationResult,
    { readonly status: "active" }
  >["reason"],
): SqlCatalogMembershipActivationResult {
  return Object.freeze({ reason, status: "unavailable" });
}

function discarded(
  reason: Extract<
    SqlCatalogResponseEpochDecision,
    { readonly status: "discarded" }
  >["reason"],
): Extract<
  SqlCatalogResponseEpochDecision,
  { readonly status: "discarded" }
> {
  return Object.freeze({ reason, status: "discarded" });
}

function settled(
  decision: Extract<
    SqlCatalogResponseEpochDecision,
    { readonly status: "discarded" }
  >,
): SqlCatalogResponseEpochSubmissionResult {
  return Object.freeze({ decision, status: "settled" });
}

function settleDecision(
  onDecision: (
    this: void,
    decision: SqlCatalogResponseEpochDecision,
  ) => void,
  decision: SqlCatalogResponseEpochDecision,
): void {
  try {
    onDecision(decision);
  } catch {
    // Consumers cannot break the serialized epoch gate.
  }
}

function snapshotAudience(
  entry: ScopeEntry,
): readonly MembershipState[] {
  const audience: MembershipState[] = [];
  for (const member of entry.members) {
    audience.push(member);
  }
  return audience;
}

function resetCallbackAllowance(cell: CallbackCell): void {
  cell.resetTimer = null;
  cell.callbackCount = 0;
}

function receiveSubscriptionCallback(
  cell: CallbackCell,
  value: unknown,
): void {
  if (!cell.active) return;
  cell.callbackCount += 1;
  if (cell.resetTimer === null) {
    cell.resetTimer = setTimeout(
      resetCallbackAllowance,
      0,
      cell,
    );
  }
  if (
    cell.callbackCount >
    MAX_CATALOG_CALLBACKS_PER_RESET_WINDOW
  ) {
    const overload = cell.overload;
    cell.active = false;
    cell.deliver = null;
    cell.overload = null;
    clearTimeout(cell.resetTimer);
    cell.resetTimer = null;
    overload?.();
    return;
  }
  if (cell.decoding) return;
  const decode = cell.decode;
  if (!decode) return;
  cell.decoding = true;
  let decoded: SqlCatalogEpoch | null;
  try {
    decoded = decode(value);
  } finally {
    cell.decoding = false;
  }
  if (decoded) cell.deliver?.(decoded);
}

function retireCallbackCell(cell: CallbackCell): void {
  cell.active = false;
  cell.callbackCount = 0;
  cell.decode = null;
  cell.decoding = false;
  cell.deliver = null;
  cell.overload = null;
  if (cell.resetTimer !== null) {
    clearTimeout(cell.resetTimer);
    cell.resetTimer = null;
  }
}

function captureCleanup(candidate: unknown): Function | null {
  return typeof candidate === "function" ? candidate : null;
}

function drainDetachedSettlement(result: unknown): void {
  if (
    result === null ||
    (typeof result !== "object" &&
      typeof result !== "function")
  ) {
    return;
  }
  try {
    const settlement = Reflect.apply(
      INTRINSIC_PROMISE_RESOLVE,
      INTRINSIC_PROMISE,
      [result],
    );
    Reflect.apply(INTRINSIC_PROMISE_THEN, settlement, [
      undefined,
      IGNORE_DETACHED_REJECTION,
    ]);
  } catch {
    // The detached value is hostile and cannot be observed safely.
  }
}

function cleanupSubscription(
  state: CoordinatorState,
  subscription: SubscriptionState,
): void {
  if (subscription.cleanupCalled) {
    subscription.cleanup = null;
    return;
  }
  const cleanup = subscription.cleanup;
  if (!cleanup) return;
  subscription.cleanupCalled = true;
  subscription.cleanup = null;
  try {
    const result = Reflect.apply(cleanup, undefined, []);
    if (result !== undefined) {
      disposeCoordinator(state);
      drainDetachedSettlement(result);
    }
  } catch {
    disposeCoordinator(state);
  }
}

function abandonSubscriptionCleanup(
  subscription: SubscriptionState,
): void {
  subscription.cleanupCalled = true;
  subscription.cleanup = null;
}

function quarantineCleanupOverflow(
  state: CoordinatorState,
  rejected: SubscriptionState,
): void {
  abandonSubscriptionCleanup(rejected);
  state.cleanupOverloaded = true;
  disposeCoordinator(state);
  for (const subscription of state.deferredCleanup) {
    abandonSubscriptionCleanup(subscription);
  }
  state.deferredCleanup.clear();
}

function scheduleSubscriptionCleanup(
  state: CoordinatorState,
  subscription: SubscriptionState,
): void {
  if (subscription.cleanupCalled) {
    subscription.cleanup = null;
    return;
  }
  if (state.cleanupOverloaded) {
    abandonSubscriptionCleanup(subscription);
    return;
  }
  if (state.deferredCleanup.has(subscription)) return;
  if (
    state.cleanupAdmissions >=
    MAX_CATALOG_CLEANUPS_PER_BARRIER
  ) {
    quarantineCleanupOverflow(state, subscription);
    return;
  }
  state.cleanupAdmissions += 1;
  state.deferredCleanup.add(subscription);
  if (state.cleanupDeferralDepth === 0) {
    flushDeferredCleanup(state);
  }
}

function enterCleanupBarrier(state: CoordinatorState): void {
  if (state.cleanupDeferralDepth === 0) {
    state.cleanupAdmissions = 0;
  }
  state.cleanupDeferralDepth += 1;
}

function flushDeferredCleanup(state: CoordinatorState): void {
  if (state.deferredCleanup.size === 0) return;
  state.cleanupDeferralDepth = 1;
  try {
    while (state.deferredCleanup.size > 0) {
      for (const subscription of state.deferredCleanup) {
        state.deferredCleanup.delete(subscription);
        cleanupSubscription(state, subscription);
        break;
      }
    }
  } finally {
    state.cleanupDeferralDepth = 0;
    if (!state.cleanupOverloaded) {
      state.cleanupAdmissions = 0;
    }
  }
}

function leaveCleanupBarrier(state: CoordinatorState): void {
  state.cleanupDeferralDepth -= 1;
  if (state.cleanupDeferralDepth === 0) {
    flushDeferredCleanup(state);
    if (!state.cleanupOverloaded) {
      state.cleanupAdmissions = 0;
    }
  }
}

function disableSubscription(
  state: CoordinatorState,
  entry: ScopeEntry,
  subscription: SubscriptionState,
): void {
  if (entry.subscription === subscription) {
    entry.subscription = null;
  }
  subscription.failed = true;
  subscription.pending.length = 0;
  retireCallbackCell(subscription.cell);
  scheduleSubscriptionCleanup(state, subscription);
}

function enqueueCommand(
  state: CoordinatorState,
  command: EpochCommand,
): boolean {
  if (state.commands.length >= MAX_CATALOG_EPOCH_COMMANDS) {
    if (command.kind === "response") {
      return false;
    } else {
      disableSubscription(
        state,
        command.entry,
        command.subscription,
      );
    }
    return false;
  }
  state.commands.push(command);
  if (!state.draining) drainCommands(state);
  return true;
}

function enqueueInvalidation(
  state: CoordinatorState,
  entry: ScopeEntry,
  subscription: SubscriptionState,
  epoch: SqlCatalogEpoch,
): void {
  if (
    state.disposed ||
    entry.subscription !== subscription ||
    subscription.failed
  ) {
    return;
  }
  enqueueCommand(state, {
    entry,
    epoch,
    kind: "invalidation",
    subscription,
  });
}

function decodeSubscriptionValue(
  state: CoordinatorState,
  entry: ScopeEntry,
  subscription: SubscriptionState,
  value: unknown,
): SqlCatalogEpoch | null {
  const decoded = decodeSqlCatalogInvalidation(value);
  if (decoded.status !== "accepted") return null;
  if (
    state.disposed ||
    entry.subscription !== subscription ||
    subscription.failed
  ) {
    return null;
  }
  return decoded.value.epoch;
}

function deliverSubscriptionValue(
  state: CoordinatorState,
  entry: ScopeEntry,
  subscription: SubscriptionState,
  epoch: SqlCatalogEpoch,
): void {
  if (subscription.installing) {
    subscription.pending.push(epoch);
  } else {
    enqueueInvalidation(
      state,
      entry,
      subscription,
      epoch,
    );
  }
}

function installSubscription(
  state: CoordinatorState,
  entry: ScopeEntry,
): void {
  const subscribe = state.subscribe;
  if (
    state.disposed ||
    entry.subscriptionAttempted ||
    !subscribe
  ) {
    entry.subscriptionAttempted = true;
    return;
  }
  entry.subscriptionAttempted = true;
  const cell: CallbackCell = {
    active: true,
    callbackCount: 0,
    decode: null,
    decoding: false,
    deliver: null,
    overload: null,
    resetTimer: null,
  };
  const subscription: SubscriptionState = {
    cell,
    cleanupCalled: false,
    cleanup: null,
    failed: false,
    installing: true,
    pending: [],
  };
  entry.subscription = subscription;
  cell.decode = (
    value: unknown,
  ): SqlCatalogEpoch | null =>
    decodeSubscriptionValue(
      state,
      entry,
      subscription,
      value,
    );
  cell.deliver = (value: SqlCatalogEpoch): void => {
    deliverSubscriptionValue(
      state,
      entry,
      subscription,
      value,
    );
  };
  cell.overload = (): void => {
    disableSubscription(state, entry, subscription);
  };
  let rawCleanup: unknown;
  try {
    rawCleanup = subscribe(
      entry.scope,
      (value: unknown): void => {
        receiveSubscriptionCallback(cell, value);
      },
    );
  } catch {
    disableSubscription(state, entry, subscription);
    return;
  }
  const cleanup = captureCleanup(rawCleanup);
  if (!cleanup) {
    disableSubscription(state, entry, subscription);
    return;
  }
  subscription.cleanup = cleanup;
  subscription.installing = false;
  if (
    subscription.failed ||
    state.disposed ||
    entry.subscription !== subscription
  ) {
    disableSubscription(state, entry, subscription);
    return;
  }
  const pending = subscription.pending.splice(
    0,
    subscription.pending.length,
  );
  const stageWholeFlush = !state.draining;
  if (stageWholeFlush) state.draining = true;
  try {
    for (const epoch of pending) {
      enqueueInvalidation(
        state,
        entry,
        subscription,
        epoch,
      );
    }
  } finally {
    if (stageWholeFlush) {
      state.draining = false;
      drainCommands(state);
    }
  }
}

interface PreparedRevision {
  readonly dispatch: (this: void) => unknown;
  readonly member: MembershipState;
}

type PreparedEpochTransition =
  | Function
  | null
  | typeof FAILED_EPOCH_TRANSITION;

function prepareEpochTransition(
  state: CoordinatorState,
  scope: string,
  epoch: SqlCatalogEpoch,
): PreparedEpochTransition {
  const prepare = state.prepareEpochTransition;
  if (!prepare) return null;
  let candidate: unknown;
  try {
    candidate = Reflect.apply(prepare, undefined, [scope, epoch]);
  } catch {
    disposeCoordinator(state);
    return FAILED_EPOCH_TRANSITION;
  }
  if (candidate === null) return null;
  if (typeof candidate !== "function") {
    disposeCoordinator(state);
    drainDetachedSettlement(candidate);
    return FAILED_EPOCH_TRANSITION;
  }
  return candidate;
}

function dispatchEpochTransition(
  state: CoordinatorState,
  prepared: PreparedEpochTransition,
): void {
  if (
    prepared === null ||
    prepared === FAILED_EPOCH_TRANSITION
  ) {
    return;
  }
  try {
    const result = Reflect.apply(prepared, undefined, []);
    if (result !== undefined) {
      disposeCoordinator(state);
      drainDetachedSettlement(result);
    }
  } catch {
    disposeCoordinator(state);
  }
}

function prepareRevisions(
  audience: readonly MembershipState[],
  entry: ScopeEntry,
): readonly PreparedRevision[] {
  const prepared: PreparedRevision[] = [];
  for (const member of audience) {
    if (
      !member.active ||
      member.disposed ||
      member.entry !== entry
    ) {
      continue;
    }
    let dispatch: unknown = null;
    try {
      const prepareCatalogChange =
        member.prepareCatalogChange;
      dispatch = prepareCatalogChange();
    } catch {
      dispatch = null;
    }
    if (
      typeof dispatch === "function" &&
      member.active &&
      !member.disposed &&
      member.entry === entry
    ) {
      const dispatchFunction = dispatch;
      prepared.push({
        dispatch: (): unknown =>
          Reflect.apply(dispatchFunction, undefined, []),
        member,
      });
      continue;
    }
    detachMembership(member);
  }
  return prepared;
}

function dispatchRevisions(
  prepared: readonly PreparedRevision[],
  entry: ScopeEntry,
): void {
  for (const item of prepared) {
    if (
      !item.member.active ||
      item.member.disposed ||
      item.member.entry !== entry
    ) {
      continue;
    }
    try {
      const dispatch = item.dispatch;
      dispatch();
    } catch {
      // Listener failures are isolated from the epoch gate.
    }
  }
}

function processInvalidation(
  state: CoordinatorState,
  command: InvalidationCommand,
): void {
  enterCleanupBarrier(state);
  try {
    if (
      state.disposed ||
      state.scopes.get(command.entry.scope) !== command.entry ||
      command.entry.subscription !== command.subscription ||
      command.subscription.failed
    ) {
      return;
    }
    const comparison = compareSqlCatalogEpoch(
      command.entry.observedEpoch,
      command.epoch,
    );
    if (
      comparison.kind !== "baseline" &&
      comparison.kind !== "advance"
    ) {
      return;
    }
    const audience = snapshotAudience(command.entry);
    command.entry.observedEpoch = comparison.epoch;
    command.entry.notificationSequence += 1;
    const transition = prepareEpochTransition(
      state,
      command.entry.scope,
      comparison.epoch,
    );
    if (transition === FAILED_EPOCH_TRANSITION) return;
    const prepared = prepareRevisions(
      audience,
      command.entry,
    );
    dispatchEpochTransition(state, transition);
    dispatchRevisions(prepared, command.entry);
  } finally {
    leaveCleanupBarrier(state);
  }
}

function isLiveCapture(
  state: CoordinatorState,
  capture: CaptureState,
): boolean {
  return (
    capture.owner === state &&
    capture.membership.active &&
    !capture.membership.disposed &&
    capture.membership.entry === capture.entry &&
    state.scopes.get(capture.entry.scope) === capture.entry
  );
}

function processResponse(
  state: CoordinatorState,
  command: ResponseCommand,
): void {
  enterCleanupBarrier(state);
  try {
    if (state.disposed) {
      settleDecision(command.onDecision, discarded("disposed"));
      return;
    }
    if (!isLiveCapture(state, command.capture)) {
      settleDecision(command.onDecision, discarded("retired"));
      return;
    }
    const entry = command.capture.entry;
    const comparison = compareSqlCatalogEpoch(
      entry.observedEpoch,
      command.epoch,
    );
    if (state.disposed) {
      settleDecision(command.onDecision, discarded("disposed"));
      return;
    }
    if (!isLiveCapture(state, command.capture)) {
      settleDecision(command.onDecision, discarded("retired"));
      return;
    }
    if (comparison.kind === "malformed") {
      settleDecision(command.onDecision, discarded("malformed"));
      return;
    }
    if (comparison.kind === "stale") {
      settleDecision(command.onDecision, discarded("stale"));
      return;
    }
    if (comparison.kind === "token-conflict") {
      settleDecision(
        command.onDecision,
        discarded("token-conflict"),
      );
      return;
    }
    if (comparison.kind === "equal") {
      if (
        command.capture.notificationSequence !==
        entry.notificationSequence
      ) {
        settleDecision(
          command.onDecision,
          Object.freeze({
            epoch: comparison.epoch,
            status: "superseded",
          }),
        );
      } else {
        settleDecision(
          command.onDecision,
          Object.freeze({
            epoch: comparison.epoch,
            observation: "equal",
            status: "usable",
          }),
        );
      }
      return;
    }
    if (comparison.kind === "baseline") {
      entry.observedEpoch = comparison.epoch;
      settleDecision(
        command.onDecision,
        Object.freeze({
          epoch: comparison.epoch,
          observation: "baseline",
          status: "usable",
        }),
      );
      return;
    }
    const audience = snapshotAudience(entry);
    entry.observedEpoch = comparison.epoch;
    entry.notificationSequence += 1;
    const transition = prepareEpochTransition(
      state,
      entry.scope,
      comparison.epoch,
    );
    if (transition === FAILED_EPOCH_TRANSITION) {
      settleDecision(command.onDecision, discarded("disposed"));
      return;
    }
    const prepared = prepareRevisions(audience, entry);
    if (state.disposed) {
      settleDecision(command.onDecision, discarded("disposed"));
      dispatchEpochTransition(state, transition);
      return;
    }
    if (isLiveCapture(state, command.capture)) {
      settleDecision(
        command.onDecision,
        Object.freeze({
          epoch: comparison.epoch,
          status: "superseded",
        }),
      );
    } else {
      settleDecision(command.onDecision, discarded("retired"));
    }
    dispatchEpochTransition(state, transition);
    dispatchRevisions(prepared, entry);
  } finally {
    leaveCleanupBarrier(state);
  }
}

function drainCommands(state: CoordinatorState): void {
  state.draining = true;
  try {
    for (const command of state.commands) {
      if (command.kind === "invalidation") {
        processInvalidation(state, command);
      } else {
        processResponse(state, command);
      }
    }
  } finally {
    state.commands.length = 0;
    state.draining = false;
  }
}

function detachMembership(
  member: MembershipState,
): void {
  if (member.disposed) return;
  const owner = member.owner;
  const entry = member.entry;
  member.disposed = true;
  member.active = false;
  member.entry = null;
  member.owner = null;
  member.prepareCatalogChange = NO_PREPARE_CATALOG_CHANGE;
  if (!owner) return;
  owner.memberships.delete(member);
  if (!entry) return;
  entry.members.delete(member);
  if (entry.members.size !== 0) return;
  owner.scopes.delete(entry.scope);
  const subscription = entry.subscription;
  entry.subscription = null;
  if (subscription) {
    retireCallbackCell(subscription.cell);
    scheduleSubscriptionCleanup(owner, subscription);
  }
}

function disposeMembership(member: MembershipState): void {
  detachMembership(member);
}

function createMembershipHandle(
  member: MembershipState,
): SqlCatalogScopeMembership {
  return Object.freeze({
    activate: (): SqlCatalogMembershipActivationResult =>
      activateMembership(member),
    captureEpoch: (): SqlCatalogEpochCaptureResult =>
      captureMembershipEpoch(member),
    dispose: (): void => {
      disposeMembership(member);
    },
  });
}

function activateMembership(
  member: MembershipState,
): SqlCatalogMembershipActivationResult {
  if (member.disposed) {
    return unavailableActivation(
      member.disposedByCoordinator
        ? "coordinator-disposed"
        : "disposed",
    );
  }
  const owner = member.owner;
  if (!owner || owner.disposed) {
    return unavailableActivation("coordinator-disposed");
  }
  if (member.active) return ACTIVE_RESULT;
  let entry = owner.scopes.get(member.scope);
  if (!entry) {
    if (
      owner.scopes.size >= MAX_CATALOG_LIVE_SCOPES
    ) {
      return unavailableActivation("scope-capacity");
    }
    entry = {
      members: new Set(),
      notificationSequence: 0,
      observedEpoch: null,
      scope: member.scope,
      subscription: null,
      subscriptionAttempted: false,
    };
    owner.scopes.set(member.scope, entry);
  }
  if (
    entry.members.size >= MAX_CATALOG_MEMBERSHIPS_PER_SCOPE
  ) {
    return unavailableActivation(
      "scope-membership-capacity",
    );
  }
  member.entry = entry;
  member.active = true;
  entry.members.add(member);
  installSubscription(owner, entry);
  if (member.disposed) {
    return unavailableActivation(
      member.disposedByCoordinator
        ? "coordinator-disposed"
        : "disposed",
    );
  }
  return ACTIVE_RESULT;
}

function captureMembershipEpoch(
  member: MembershipState,
): SqlCatalogEpochCaptureResult {
  const owner = member.owner;
  if (member.disposed || !owner || owner.disposed) {
    return Object.freeze({
      reason: "disposed",
      status: "unavailable",
    });
  }
  const entry = member.entry;
  if (!member.active || !entry) {
    return Object.freeze({
      reason: "inactive",
      status: "unavailable",
    });
  }
  const captureValue: SqlCatalogEpochCapture = {
    [epochCaptureBrand]: EPOCH_CAPTURE_KIND,
    expectedEpoch: entry.observedEpoch,
  };
  const capture = Object.freeze(captureValue);
  owner.captures.set(capture, {
    claimed: false,
    entry,
    membership: member,
    notificationSequence: entry.notificationSequence,
    owner,
  });
  return Object.freeze({ capture, status: "captured" });
}

function prepareMembership(
  state: CoordinatorState,
  scope: unknown,
  target: SqlCatalogRevisionTarget,
): SqlCatalogScopeMembershipResult {
  if (state.disposed) {
    return Object.freeze({
      reason: "disposed",
      status: "unavailable",
    });
  }
  if (!isValidSqlCatalogScope(scope)) {
    return Object.freeze({
      reason: "invalid-scope",
      status: "unavailable",
    });
  }
  if (state.memberships.size >= MAX_CATALOG_MEMBERSHIPS) {
    return Object.freeze({
      reason: "membership-capacity",
      status: "unavailable",
    });
  }
  const member: MembershipState = {
    active: false,
    disposed: false,
    disposedByCoordinator: false,
    entry: null,
    owner: state,
    prepareCatalogChange: NO_PREPARE_CATALOG_CHANGE,
    scope,
  };
  state.memberships.add(member);
  let prepareCandidate: unknown;
  try {
    prepareCandidate = target.prepareCatalogChange;
  } catch {
    const reason =
      state.disposed || member.disposed
        ? "disposed"
        : "invalid-target";
    detachMembership(member);
    return Object.freeze({
      reason,
      status: "unavailable",
    });
  }
  if (state.disposed || member.disposed) {
    detachMembership(member);
    return Object.freeze({
      reason: "disposed",
      status: "unavailable",
    });
  }
  if (typeof prepareCandidate !== "function") {
    detachMembership(member);
    return Object.freeze({
      reason: "invalid-target",
      status: "unavailable",
    });
  }
  const prepareFunction = prepareCandidate;
  member.prepareCatalogChange = (): unknown =>
    Reflect.apply(prepareFunction, undefined, []);
  const membership = createMembershipHandle(member);
  return Object.freeze({ membership, status: "prepared" });
}

function submitResponse(
  state: CoordinatorState,
  captureCandidate: unknown,
  epoch: unknown,
  onDecision: (
    this: void,
    decision: SqlCatalogResponseEpochDecision,
  ) => void,
): SqlCatalogResponseEpochSubmissionResult {
  if (state.disposed) {
    return settled(discarded("disposed"));
  }
  if (
    captureCandidate === null ||
    typeof captureCandidate !== "object"
  ) {
    return settled(discarded("malformed"));
  }
  const capture = state.captures.get(captureCandidate);
  if (!capture) {
    return settled(discarded("malformed"));
  }
  if (capture.claimed) {
    return settled(discarded("retired"));
  }
  if (!isLiveCapture(state, capture)) {
    return settled(discarded("retired"));
  }
  capture.claimed = true;
  const admitted = enqueueCommand(state, {
    capture,
    epoch,
    kind: "response",
    onDecision,
  });
  return admitted
    ? SUBMITTED_RESULT
    : settled(discarded("overloaded"));
}

function disposeCoordinator(state: CoordinatorState): void {
  if (state.disposed) return;
  state.disposed = true;
  const onDispose = state.onDispose;
  state.onDispose = null;
  state.prepareEpochTransition = null;
  state.subscribe = null;
  const subscriptions: SubscriptionState[] = [];
  for (const entry of state.scopes.values()) {
    if (entry.subscription) {
      subscriptions.push(entry.subscription);
      entry.subscription = null;
    }
    entry.members.clear();
  }
  state.scopes.clear();
  for (const member of state.memberships) {
    member.active = false;
    member.disposed = true;
    member.disposedByCoordinator = true;
    member.entry = null;
    member.owner = null;
    member.prepareCatalogChange = NO_PREPARE_CATALOG_CHANGE;
  }
  state.memberships.clear();
  for (const subscription of subscriptions) {
    retireCallbackCell(subscription.cell);
  }
  if (onDispose) {
    try {
      const result = Reflect.apply(onDispose, undefined, []);
      if (result !== undefined) {
        drainDetachedSettlement(result);
      }
    } catch {
      // Disposal remains authoritative if its package owner fails.
    }
  }
  for (const subscription of subscriptions) {
    scheduleSubscriptionCleanup(state, subscription);
  }
  if (!state.draining) drainCommands(state);
}

function createCoordinatorHandle(
  state: CoordinatorState,
): SqlCatalogEpochCoordinator {
  return Object.freeze({
    dispose: (): void => {
      disposeCoordinator(state);
    },
    prepareScopeMembership: (
      scope: unknown,
      target: SqlCatalogRevisionTarget,
    ): SqlCatalogScopeMembershipResult =>
      prepareMembership(state, scope, target),
    providerId: state.providerId,
    submitResponseEpoch: (
      capture: unknown,
      epoch: unknown,
      onDecision: (
        this: void,
        decision: SqlCatalogResponseEpochDecision,
      ) => void,
    ): SqlCatalogResponseEpochSubmissionResult =>
      submitResponse(state, capture, epoch, onDecision),
  });
}

export function createSqlCatalogEpochCoordinator(
  capturedProvider: unknown,
  prepareEpochTransition?: SqlCatalogEpochTransitionTarget,
  onDispose?: (this: void) => undefined,
): SqlCatalogEpochCoordinatorResult {
  const provider = resolveSqlRelationCatalogProvider(
    capturedProvider,
  );
  if (!provider) {
    return Object.freeze({
      reason: "invalid-provider",
      status: "unavailable",
    });
  }
  if (
    prepareEpochTransition !== undefined &&
    typeof prepareEpochTransition !== "function"
  ) {
    return Object.freeze({
      reason: "invalid-transition-target",
      status: "unavailable",
    });
  }
  if (
    onDispose !== undefined &&
    typeof onDispose !== "function"
  ) {
    return Object.freeze({
      reason: "invalid-disposal-target",
      status: "unavailable",
    });
  }
  const providerId = provider.id;
  const subscribe = provider.subscribe;
  const state: CoordinatorState = {
    cleanupAdmissions: 0,
    cleanupDeferralDepth: 0,
    cleanupOverloaded: false,
    captures: new WeakMap(),
    commands: [],
    deferredCleanup: new Set(),
    disposed: false,
    draining: false,
    memberships: new Set(),
    onDispose: onDispose ?? null,
    prepareEpochTransition:
      prepareEpochTransition ?? null,
    providerId,
    scopes: new Map(),
    subscribe,
  };
  const coordinator = createCoordinatorHandle(state);
  return Object.freeze({ coordinator, status: "created" });
}
