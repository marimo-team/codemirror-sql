import type {
  SqlValidatedCatalogSearchResponse,
} from "./relation-catalog-boundary.js";
import type { SqlRelationDialectRuntime } from "./relation-dialect.js";
import type {
  SqlCatalogEpoch,
  SqlCatalogFailureCode,
  SqlCatalogRetryPolicy,
  SqlCatalogSearchRequest,
} from "./relation-completion-types.js";
import type {
  SqlIdentifierComponent,
  SqlIdentifierPath,
} from "./types.js";

export const MAX_CATALOG_POLICY_STORE_ENTRIES = 256;
export const MAX_CATALOG_POLICY_STORE_RETAINED_BYTES =
  2 * 1_024 * 1_024;

export type SqlCatalogSearchPolicyProbe =
  | {
      readonly status: "ready";
      readonly response: Extract<
        SqlValidatedCatalogSearchResponse,
        { readonly status: "ready" }
      >;
    }
  | {
      readonly status: "failed";
      readonly code: SqlCatalogFailureCode;
      readonly epoch: SqlCatalogEpoch;
      readonly retry: Exclude<
        SqlCatalogRetryPolicy,
        "next-request"
      >;
    }
  | {
      readonly status: "miss";
      readonly loadingEpoch: SqlCatalogEpoch | null;
    }
  | {
      readonly status: "disposed";
    }
  | {
      readonly status: "overloaded";
    };

export type SqlCatalogSearchPolicyRecordResult =
  | {
      readonly status: "accepted";
      readonly response: SqlValidatedCatalogSearchResponse;
      readonly retained:
        | "failure-gate"
        | "loading-barrier"
        | "none"
        | "ready";
    }
  | {
      readonly status: "conflict";
      readonly reason:
        | "capacity"
        | "epoch-mismatch"
        | "loading-transition"
        | "retry-gated";
    }
  | {
      readonly status: "disposed";
    };

export interface SqlCatalogSearchPolicyStoreMetrics {
  readonly entries: number;
  readonly failureGates: number;
  readonly loadingBarriers: number;
  readonly readyEntries: number;
  readonly retainedBytes: number;
}

export interface SqlCatalogSearchPolicyStore {
  readonly advanceScope: (
    this: void,
    scope: string,
    epoch: SqlCatalogEpoch,
  ) => void;
  readonly dispose: (this: void) => void;
  readonly metrics: (
    this: void,
  ) => SqlCatalogSearchPolicyStoreMetrics;
  readonly probe: (
    this: void,
    request: SqlCatalogSearchRequest,
    dialect: SqlRelationDialectRuntime,
  ) => SqlCatalogSearchPolicyProbe;
  readonly record: (
    this: void,
    request: SqlCatalogSearchRequest,
    dialect: SqlRelationDialectRuntime,
    response: SqlValidatedCatalogSearchResponse,
  ) => SqlCatalogSearchPolicyRecordResult;
}

interface StructuralKey {
  readonly continuationToken: string | null;
  readonly dialect: SqlRelationDialectRuntime;
  readonly dialectId: string;
  readonly limit: number;
  readonly prefix: SqlIdentifierComponent;
  readonly qualifier: SqlIdentifierPath;
  readonly scope: string;
  readonly searchPaths: readonly SqlIdentifierPath[];
}

interface RetainedRecordBase {
  readonly bytes: number;
  readonly key: StructuralKey;
  lastUse: bigint;
}

interface ReadyRecord extends RetainedRecordBase {
  readonly kind: "ready";
  readonly response: Extract<
    SqlValidatedCatalogSearchResponse,
    { readonly status: "ready" }
  >;
}

interface LoadingRecord extends RetainedRecordBase {
  readonly epoch: SqlCatalogEpoch;
  readonly kind: "loading";
}

interface FailureRecord extends RetainedRecordBase {
  readonly code: SqlCatalogFailureCode;
  readonly epoch: SqlCatalogEpoch;
  readonly kind: "failure";
  readonly retry: Exclude<
    SqlCatalogRetryPolicy,
    "next-request"
  >;
}

type RetainedRecord =
  | FailureRecord
  | LoadingRecord
  | ReadyRecord;

interface StoreState {
  disposed: boolean;
  readonly records: RetainedRecord[];
  retainedBytes: number;
  saturated: boolean;
  sequence: bigint;
}

const DISPOSED_PROBE: SqlCatalogSearchPolicyProbe =
  Object.freeze({ status: "disposed" });
const DISPOSED_RECORD: SqlCatalogSearchPolicyRecordResult =
  Object.freeze({ status: "disposed" });
const KEY_FIXED_BYTES = 160;
const PATH_FIXED_BYTES = 24;
const COMPONENT_FIXED_BYTES = 24;
const RESPONSE_FIXED_BYTES = 96;
const RELATION_FIXED_BYTES = 128;

function sameEpoch(
  left: SqlCatalogEpoch,
  right: SqlCatalogEpoch,
): boolean {
  return (
    left.generation === right.generation &&
    left.token === right.token
  );
}

function sameComponent(
  left: SqlIdentifierComponent,
  right: SqlIdentifierComponent,
): boolean {
  return (
    left.quoted === right.quoted &&
    left.value === right.value
  );
}

function samePath(
  left: SqlIdentifierPath,
  right: SqlIdentifierPath,
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftComponent = left[index];
    const rightComponent = right[index];
    if (
      !leftComponent ||
      !rightComponent ||
      !sameComponent(leftComponent, rightComponent)
    ) {
      return false;
    }
  }
  return true;
}

function sameBaseKey(
  left: StructuralKey,
  right: StructuralKey,
): boolean {
  if (
    left.dialect !== right.dialect ||
    left.dialectId !== right.dialectId ||
    left.scope !== right.scope ||
    left.limit !== right.limit ||
    left.continuationToken !== right.continuationToken ||
    !sameComponent(left.prefix, right.prefix) ||
    !samePath(left.qualifier, right.qualifier) ||
    left.searchPaths.length !== right.searchPaths.length
  ) {
    return false;
  }
  for (
    let index = 0;
    index < left.searchPaths.length;
    index += 1
  ) {
    const leftPath = left.searchPaths[index];
    const rightPath = right.searchPaths[index];
    if (
      !leftPath ||
      !rightPath ||
      !samePath(leftPath, rightPath)
    ) {
      return false;
    }
  }
  return true;
}

function keyFrom(
  request: SqlCatalogSearchRequest,
  dialect: SqlRelationDialectRuntime,
): StructuralKey {
  return {
    continuationToken: request.continuationToken,
    dialect,
    dialectId: request.dialectId,
    limit: request.limit,
    prefix: request.prefix,
    qualifier: request.qualifier,
    scope: request.scope,
    searchPaths: request.searchPaths,
  };
}

function textBytes(value: string): number {
  return 16 + value.length * 2;
}

function componentBytes(
  component: SqlIdentifierComponent,
): number {
  return COMPONENT_FIXED_BYTES + textBytes(component.value);
}

function pathBytes(path: SqlIdentifierPath): number {
  let bytes = PATH_FIXED_BYTES;
  for (const component of path) {
    bytes += componentBytes(component);
  }
  return bytes;
}

function keyBytes(key: StructuralKey): number {
  let bytes =
    KEY_FIXED_BYTES +
    textBytes(key.scope) +
    textBytes(key.dialectId) +
    componentBytes(key.prefix) +
    pathBytes(key.qualifier);
  if (key.continuationToken !== null) {
    bytes += textBytes(key.continuationToken);
  }
  for (const path of key.searchPaths) {
    bytes += pathBytes(path);
  }
  return bytes;
}

function epochBytes(epoch: SqlCatalogEpoch): number {
  return 32 + textBytes(epoch.token);
}

function readyResponseBytes(
  response: Extract<
    SqlValidatedCatalogSearchResponse,
    { readonly status: "ready" }
  >,
): number {
  let bytes =
    RESPONSE_FIXED_BYTES + epochBytes(response.epoch);
  if (response.coverage.kind === "paginated") {
    bytes += textBytes(response.coverage.continuationToken);
  }
  for (const relation of response.relations) {
    bytes +=
      RELATION_FIXED_BYTES +
      textBytes(relation.entityId) +
      textBytes(relation.completionText);
    if (relation.detail !== undefined) {
      bytes += textBytes(relation.detail);
    }
    for (const component of relation.canonicalPath) {
      bytes += componentBytes(component);
    }
    for (const component of relation.completionPath) {
      bytes += componentBytes(component);
    }
  }
  return bytes;
}

function touch(
  state: StoreState,
  record: RetainedRecord,
): void {
  state.sequence += 1n;
  record.lastUse = state.sequence;
}

function removeAt(state: StoreState, index: number): void {
  const removed = state.records.splice(index, 1);
  for (const record of removed) {
    state.retainedBytes -= record.bytes;
  }
}

function removeWhere(
  state: StoreState,
  predicate: (record: RetainedRecord) => boolean,
): void {
  for (
    let index = state.records.length - 1;
    index >= 0;
    index -= 1
  ) {
    const record = state.records[index];
    if (record && predicate(record)) removeAt(state, index);
  }
}

function retainReady(
  state: StoreState,
  record: ReadyRecord,
): boolean {
  if (
    record.bytes >
    MAX_CATALOG_POLICY_STORE_RETAINED_BYTES
  ) {
    return false;
  }
  touch(state, record);
  state.records.push(record);
  state.retainedBytes += record.bytes;
  while (
    state.records.length >
      MAX_CATALOG_POLICY_STORE_ENTRIES ||
    state.retainedBytes >
      MAX_CATALOG_POLICY_STORE_RETAINED_BYTES
  ) {
    let oldestIndex = state.records.indexOf(record);
    for (let index = 0; index < state.records.length; index += 1) {
      const candidate = state.records[index];
      const oldest = state.records[oldestIndex];
      if (
        candidate?.kind === "ready" &&
        oldest &&
        candidate.lastUse < oldest.lastUse
      ) {
        oldestIndex = index;
      }
    }
    removeAt(state, oldestIndex);
  }
  return state.records.includes(record);
}

function retainGate(
  state: StoreState,
  record: FailureRecord | LoadingRecord,
): boolean {
  if (
    record.bytes >
    MAX_CATALOG_POLICY_STORE_RETAINED_BYTES
  ) {
    return false;
  }
  while (
    state.records.length >=
      MAX_CATALOG_POLICY_STORE_ENTRIES ||
    state.retainedBytes + record.bytes >
      MAX_CATALOG_POLICY_STORE_RETAINED_BYTES
  ) {
    let oldestReadyIndex = -1;
    for (let index = 0; index < state.records.length; index += 1) {
      const candidate = state.records[index];
      const oldest =
        oldestReadyIndex < 0
          ? null
          : state.records[oldestReadyIndex];
      if (
        candidate?.kind === "ready" &&
        (!oldest || candidate.lastUse < oldest.lastUse)
      ) {
        oldestReadyIndex = index;
      }
    }
    if (oldestReadyIndex < 0) return false;
    removeAt(state, oldestReadyIndex);
  }
  touch(state, record);
  state.records.push(record);
  state.retainedBytes += record.bytes;
  return true;
}

function findReady(
  state: StoreState,
  key: StructuralKey,
  epoch: SqlCatalogEpoch,
): ReadyRecord | null {
  for (const record of state.records) {
    if (
      record.kind === "ready" &&
      sameEpoch(record.response.epoch, epoch) &&
      sameBaseKey(record.key, key)
    ) {
      return record;
    }
  }
  return null;
}

function findNeverGate(
  state: StoreState,
  key: StructuralKey,
): FailureRecord | null {
  for (const record of state.records) {
    if (
      record.kind === "failure" &&
      record.retry === "never" &&
      sameBaseKey(record.key, key)
    ) {
      return record;
    }
  }
  return null;
}

function findEpochGate(
  state: StoreState,
  key: StructuralKey,
  epoch: SqlCatalogEpoch,
): FailureRecord | LoadingRecord | null {
  for (const record of state.records) {
    if (
      record.kind !== "ready" &&
      (record.kind === "loading" ||
        record.retry !== "never") &&
      sameEpoch(record.epoch, epoch) &&
      sameBaseKey(record.key, key)
    ) {
      return record;
    }
  }
  return null;
}

function accepted(
  response: SqlValidatedCatalogSearchResponse,
  retained:
    | "failure-gate"
    | "loading-barrier"
    | "none"
    | "ready",
): SqlCatalogSearchPolicyRecordResult {
  return Object.freeze({
    response,
    retained,
    status: "accepted",
  });
}

function conflict(
  reason:
    | "capacity"
    | "epoch-mismatch"
    | "loading-transition"
    | "retry-gated",
): SqlCatalogSearchPolicyRecordResult {
  return Object.freeze({ reason, status: "conflict" });
}

function probe(
  state: StoreState,
  request: SqlCatalogSearchRequest,
  dialect: SqlRelationDialectRuntime,
): SqlCatalogSearchPolicyProbe {
  if (state.disposed) return DISPOSED_PROBE;
  if (state.saturated) {
    return Object.freeze({ status: "overloaded" });
  }
  const key = keyFrom(request, dialect);
  const epoch = request.expectedEpoch;
  if (epoch === null) {
    return Object.freeze({
      loadingEpoch: null,
      status: "miss",
    });
  }
  const neverGate = findNeverGate(state, key);
  if (neverGate) {
    touch(state, neverGate);
    return Object.freeze({
      code: neverGate.code,
      epoch: request.expectedEpoch ?? neverGate.epoch,
      retry: neverGate.retry,
      status: "failed",
    });
  }
  const ready = findReady(state, key, epoch);
  if (ready) {
    touch(state, ready);
    return Object.freeze({
      response: ready.response,
      status: "ready",
    });
  }
  const gate = findEpochGate(state, key, epoch);
  if (!gate) {
    return Object.freeze({
      loadingEpoch: null,
      status: "miss",
    });
  }
  touch(state, gate);
  if (gate.kind === "loading") {
    return Object.freeze({
      loadingEpoch: gate.epoch,
      status: "miss",
    });
  }
  return Object.freeze({
    code: gate.code,
    epoch: gate.epoch,
    retry: gate.retry,
    status: "failed",
  });
}

function recordResponse(
  state: StoreState,
  request: SqlCatalogSearchRequest,
  dialect: SqlRelationDialectRuntime,
  response: SqlValidatedCatalogSearchResponse,
): SqlCatalogSearchPolicyRecordResult {
  if (state.disposed) return DISPOSED_RECORD;
  if (state.saturated) return conflict("capacity");
  if (
    request.expectedEpoch !== null &&
    !sameEpoch(request.expectedEpoch, response.epoch)
  ) {
    return conflict("epoch-mismatch");
  }
  const key = keyFrom(request, dialect);
  const neverGate = findNeverGate(state, key);
  if (neverGate) return conflict("retry-gated");
  const epochGate = findEpochGate(
    state,
    key,
    response.epoch,
  );
  if (response.status === "ready") {
    if (epochGate?.kind === "loading") {
      return conflict("loading-transition");
    }
    if (epochGate?.kind === "failure") {
      return conflict("retry-gated");
    }
    removeWhere(
      state,
      (candidate) =>
        candidate.kind === "ready" &&
        sameEpoch(candidate.response.epoch, response.epoch) &&
        sameBaseKey(candidate.key, key),
    );
    const retained = retainReady(state, {
      bytes: keyBytes(key) + readyResponseBytes(response),
      key,
      kind: "ready",
      lastUse: 0n,
      response,
    });
    return accepted(response, retained ? "ready" : "none");
  }
  if (response.status === "loading") {
    if (epochGate?.kind === "failure") {
      return conflict("retry-gated");
    }
    if (epochGate?.kind === "loading") {
      touch(state, epochGate);
      return accepted(response, "loading-barrier");
    }
    removeWhere(
      state,
      (candidate) =>
        candidate.kind === "loading" &&
        sameEpoch(candidate.epoch, response.epoch) &&
        sameBaseKey(candidate.key, key),
    );
    const retained = retainGate(state, {
      bytes: keyBytes(key) + epochBytes(response.epoch) + 64,
      epoch: response.epoch,
      key,
      kind: "loading",
      lastUse: 0n,
    });
    if (retained) {
      return accepted(response, "loading-barrier");
    }
    state.saturated = true;
    return conflict("capacity");
  }
  if (response.retry === "next-request") {
    return accepted(response, "none");
  }
  const replacedGates = state.records.filter(
    (candidate): candidate is FailureRecord | LoadingRecord =>
      candidate.kind !== "ready" &&
      ((candidate.kind === "loading" &&
        sameEpoch(candidate.epoch, response.epoch)) ||
        (candidate.kind === "failure" &&
          (response.retry === "never" ||
            candidate.retry === response.retry))) &&
      sameBaseKey(candidate.key, key),
  );
  removeWhere(
    state,
    (candidate) =>
      candidate.kind === "loading" &&
      sameEpoch(candidate.epoch, response.epoch) &&
      sameBaseKey(candidate.key, key),
  );
  removeWhere(
    state,
    (candidate) =>
      candidate.kind === "failure" &&
      (response.retry === "never" ||
        candidate.retry === response.retry) &&
      sameBaseKey(candidate.key, key),
  );
  const retained = retainGate(state, {
    bytes:
      keyBytes(key) +
      epochBytes(response.epoch) +
      textBytes(response.code) +
      80,
    code: response.code,
    epoch: response.epoch,
    key,
    kind: "failure",
    lastUse: 0n,
    retry: response.retry,
  });
  if (!retained) {
    for (const replaced of replacedGates) {
      retainGate(state, replaced);
    }
    state.saturated = true;
  }
  return retained
    ? accepted(response, "failure-gate")
    : conflict("capacity");
}

function advanceScope(
  state: StoreState,
  scope: string,
  epoch: SqlCatalogEpoch,
): void {
  if (state.disposed) return;
  removeWhere(state, (record) => {
    if (record.key.scope !== scope) return false;
    if (
      record.kind === "failure" &&
      record.retry === "never"
    ) {
      return false;
    }
    const recordEpoch =
      record.kind === "ready"
        ? record.response.epoch
        : record.epoch;
    return !sameEpoch(recordEpoch, epoch);
  });
}

function metrics(
  state: StoreState,
): SqlCatalogSearchPolicyStoreMetrics {
  let failureGates = 0;
  let loadingBarriers = 0;
  let readyEntries = 0;
  for (const record of state.records) {
    if (record.kind === "failure") failureGates += 1;
    else if (record.kind === "loading") {
      loadingBarriers += 1;
    } else readyEntries += 1;
  }
  return Object.freeze({
    entries: state.records.length,
    failureGates,
    loadingBarriers,
    readyEntries,
    retainedBytes: state.retainedBytes,
  });
}

export function createSqlCatalogSearchPolicyStore(): SqlCatalogSearchPolicyStore {
  const state: StoreState = {
    disposed: false,
    records: [],
    retainedBytes: 0,
    saturated: false,
    sequence: 0n,
  };
  return Object.freeze({
    advanceScope: (
      scope: string,
      epoch: SqlCatalogEpoch,
    ): void => {
      advanceScope(state, scope, epoch);
    },
    dispose: (): void => {
      if (state.disposed) return;
      state.disposed = true;
      state.records.length = 0;
      state.retainedBytes = 0;
      state.saturated = false;
    },
    metrics: (): SqlCatalogSearchPolicyStoreMetrics =>
      metrics(state),
    probe: (
      request: SqlCatalogSearchRequest,
      dialect: SqlRelationDialectRuntime,
    ): SqlCatalogSearchPolicyProbe =>
      probe(state, request, dialect),
    record: (
      request: SqlCatalogSearchRequest,
      dialect: SqlRelationDialectRuntime,
      response: SqlValidatedCatalogSearchResponse,
    ): SqlCatalogSearchPolicyRecordResult =>
      recordResponse(state, request, dialect, response),
  });
}
