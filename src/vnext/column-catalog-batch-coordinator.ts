import {
  captureSqlColumnCatalogProvider,
  createSqlColumnCatalogBatchRequest,
  decodeSqlColumnCatalogBatchResponse,
  MAX_COLUMN_DIALECT_ID_LENGTH,
  MAX_COLUMN_SCOPE_LENGTH,
  resolveSqlColumnCatalogProvider,
  type CapturedSqlColumnCatalogProvider,
  type SqlCapturedColumnCatalogProviderContext,
} from "./column-catalog-boundary.js";
import type {
  SqlColumnCatalogBatchRequest,
  SqlColumnCatalogRelationReference,
  SqlColumnCatalogRelationResult,
} from "./column-catalog-types.js";
import type {
  SqlCatalogEpoch,
} from "./relation-completion-types.js";
import type { SqlIdentifierPath } from "./types.js";

export const DEFAULT_COLUMN_CACHE_ENTRIES = 1_024;
export const MAX_COLUMN_CACHE_ENTRIES = 8_192;

export interface SqlColumnCatalogOwnerOptions {
  readonly dialectId: string;
  readonly scope: string;
}

export interface SqlColumnCatalogBatchInput {
  readonly expectedEpoch: SqlCatalogEpoch | null;
  readonly relations: readonly SqlColumnCatalogRelationReference[];
  readonly searchPaths: readonly SqlIdentifierPath[];
}

export type SqlColumnCatalogBatchOutcome =
  | {
      readonly epoch: SqlCatalogEpoch;
      readonly providerId: string;
      readonly relations: readonly SqlColumnCatalogRelationResult[];
      readonly scope: string;
      readonly status: "usable";
    }
  | {
      readonly status: "cancelled";
    }
  | {
      readonly status: "superseded";
    }
  | {
      readonly reason:
        | "disposed"
        | "invalid-request"
        | "malformed-response"
        | "provider-failed";
      readonly status: "unavailable";
    };

export interface SqlColumnCatalogBatchTicket {
  readonly cancel: (this: void) => void;
  readonly result: Promise<SqlColumnCatalogBatchOutcome>;
}

export interface SqlColumnCatalogBatchOwner {
  readonly dispose: (this: void) => void;
  readonly request: (
    this: void,
    input: SqlColumnCatalogBatchInput,
  ) => SqlColumnCatalogBatchTicket;
}

export type SqlColumnCatalogBatchOwnerResult =
  | {
      readonly owner: SqlColumnCatalogBatchOwner;
      readonly status: "prepared";
    }
  | {
      readonly reason: "disposed" | "invalid-options";
      readonly status: "unavailable";
    };

export interface SqlColumnCatalogBatchCoordinator {
  readonly dispose: (this: void) => void;
  readonly prepareOwner: (
    this: void,
    options: SqlColumnCatalogOwnerOptions,
  ) => SqlColumnCatalogBatchOwnerResult;
  readonly providerId: string;
}

export type SqlColumnCatalogBatchCoordinatorResult =
  | {
      readonly coordinator: SqlColumnCatalogBatchCoordinator;
      readonly status: "created";
    }
  | {
      readonly reason: "invalid-options" | "invalid-provider";
      readonly status: "unavailable";
    };

interface CoordinatorState {
  readonly cache: Map<string, ReadyRelation>;
  readonly capturedProvider: CapturedSqlColumnCatalogProvider;
  readonly context: SqlCapturedColumnCatalogProviderContext;
  disposed: boolean;
  readonly maxCacheEntries: number;
  readonly owners: Set<OwnerState>;
}

interface OwnerState {
  active: ConsumerState | null;
  readonly dialectId: string;
  disposed: boolean;
  owner: CoordinatorState | null;
  observedEpoch: SqlCatalogEpoch | null;
  readonly scope: string;
}

interface ConsumerState {
  readonly controller: AbortController;
  readonly owner: OwnerState;
  resolve: ((value: SqlColumnCatalogBatchOutcome) => void) | null;
  settled: boolean;
}

type ReadyRelation = Extract<
  SqlColumnCatalogRelationResult,
  { readonly status: "ready" }
>;

const CANCELLED: SqlColumnCatalogBatchOutcome =
  Object.freeze({ status: "cancelled" });
const SUPERSEDED: SqlColumnCatalogBatchOutcome =
  Object.freeze({ status: "superseded" });

function unavailable(
  reason: Extract<
    SqlColumnCatalogBatchOutcome,
    { readonly status: "unavailable" }
  >["reason"],
): SqlColumnCatalogBatchOutcome {
  return Object.freeze({ reason, status: "unavailable" });
}

function dataProperty(
  value: unknown,
  key: string,
): { readonly found: true; readonly value: unknown } | null {
  if (value === null || typeof value !== "object") return null;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return null;
  }
  return descriptor && "value" in descriptor
    ? { found: true, value: descriptor.value }
    : null;
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" &&
      value.length > 0 &&
      value.length <= maximum
    ? value
    : null;
}

function cacheKey(
  request: SqlColumnCatalogBatchRequest,
  reference: SqlColumnCatalogRelationReference,
  epoch: SqlCatalogEpoch,
): string {
  const segment = (value: string): string =>
    `${value.length}:${value}`;
  const path = reference.path.map((component) =>
    segment(`${component.quoted ? "q" : "u"}${component.value}`)
  ).join("");
  const searchPaths = request.searchPaths.map((searchPath) =>
    segment(searchPath.map((component) =>
      segment(`${component.quoted ? "q" : "u"}${component.value}`)
    ).join(""))
  ).join("");
  return [
    segment(request.scope),
    segment(request.dialectId),
    segment(String(epoch.generation)),
    segment(epoch.token),
    segment(reference.relationEntityId ?? ""),
    segment(path),
    segment(searchPaths),
  ].join("");
}

function cacheGet(
  state: CoordinatorState,
  key: string,
): ReadyRelation | null {
  const value = state.cache.get(key);
  if (!value) return null;
  state.cache.delete(key);
  state.cache.set(key, value);
  return value;
}

function cacheSet(
  state: CoordinatorState,
  key: string,
  value: ReadyRelation,
): void {
  state.cache.delete(key);
  state.cache.set(key, value);
  while (state.cache.size > state.maxCacheEntries) {
    const oldest = state.cache.keys().next().value;
    if (typeof oldest !== "string") break;
    state.cache.delete(oldest);
  }
}

function withRequestKey(
  relation: ReadyRelation,
  requestKey: string,
): ReadyRelation {
  return relation.requestKey === requestKey
    ? relation
    : Object.freeze({ ...relation, requestKey });
}

function settle(
  consumer: ConsumerState,
  outcome: SqlColumnCatalogBatchOutcome,
): void {
  if (consumer.settled) return;
  consumer.settled = true;
  if (consumer.owner.active === consumer) {
    consumer.owner.active = null;
  }
  const resolve = consumer.resolve;
  consumer.resolve = null;
  resolve?.(outcome);
}

function cancelConsumer(
  consumer: ConsumerState,
  outcome: SqlColumnCatalogBatchOutcome,
): void {
  if (consumer.settled) return;
  consumer.controller.abort();
  settle(consumer, outcome);
}

function makeSettledTicket(
  outcome: SqlColumnCatalogBatchOutcome,
): SqlColumnCatalogBatchTicket {
  return Object.freeze({
    cancel: (): void => {},
    result: Promise.resolve(outcome),
  });
}

function combineRelations(
  request: SqlColumnCatalogBatchRequest,
  cached: ReadonlyMap<string, ReadyRelation>,
  loaded: readonly SqlColumnCatalogRelationResult[],
): readonly SqlColumnCatalogRelationResult[] | null {
  const byKey = new Map<string, SqlColumnCatalogRelationResult>();
  for (const relation of loaded) byKey.set(relation.requestKey, relation);
  const output: SqlColumnCatalogRelationResult[] = [];
  for (const reference of request.relations) {
    const cachedRelation = cached.get(reference.requestKey);
    const relation = cachedRelation
      ? withRequestKey(cachedRelation, reference.requestKey)
      : byKey.get(reference.requestKey);
    if (!relation) return null;
    output.push(relation);
  }
  return Object.freeze(output);
}

function startProviderWork(
  state: CoordinatorState,
  owner: OwnerState,
  fullRequest: SqlColumnCatalogBatchRequest,
  missingRequest: SqlColumnCatalogBatchRequest,
  cached: ReadonlyMap<string, ReadyRelation>,
  consumer: ConsumerState,
): void {
  let providerResult: unknown;
  try {
    providerResult = state.context.loadColumns(
      missingRequest,
      consumer.controller.signal,
    );
  } catch {
    settle(consumer, unavailable("provider-failed"));
    return;
  }
  Promise.resolve(providerResult).then(
    (value) => {
      if (
        consumer.settled ||
        consumer.controller.signal.aborted ||
        state.disposed ||
        owner.disposed ||
        owner.owner !== state
      ) {
        return;
      }
      const decoded = decodeSqlColumnCatalogBatchResponse(
        state.capturedProvider,
        missingRequest,
        value,
      );
      if (decoded.status === "malformed") {
        settle(consumer, unavailable("malformed-response"));
        return;
      }
      owner.observedEpoch = decoded.value.epoch;
      for (const relation of decoded.value.relations) {
        if (
          relation.status !== "ready" ||
          relation.coverage !== "complete"
        ) continue;
        const reference = missingRequest.relations.find(
          (candidate) => candidate.requestKey === relation.requestKey,
        );
        if (reference) {
          cacheSet(
            state,
            cacheKey(missingRequest, reference, decoded.value.epoch),
            relation,
          );
        }
      }
      const relations = combineRelations(
        fullRequest,
        cached,
        decoded.value.relations,
      );
      settle(
        consumer,
        relations
          ? Object.freeze({
              providerId: state.context.id,
              epoch: decoded.value.epoch,
              relations,
              scope: owner.scope,
              status: "usable",
            })
          : unavailable("malformed-response"),
      );
    },
    () => {
      if (!consumer.settled) {
        settle(consumer, unavailable("provider-failed"));
      }
    },
  );
}

function requestColumns(
  owner: OwnerState,
  input: unknown,
): SqlColumnCatalogBatchTicket {
  const state = owner.owner;
  if (!state || state.disposed || owner.disposed) {
    return makeSettledTicket(unavailable("disposed"));
  }
  const expectedEpoch = dataProperty(input, "expectedEpoch");
  const relations = dataProperty(input, "relations");
  const searchPaths = dataProperty(input, "searchPaths");
  if (!expectedEpoch || !relations || !searchPaths) {
    return makeSettledTicket(unavailable("invalid-request"));
  }
  const created = createSqlColumnCatalogBatchRequest({
    dialectId: owner.dialectId,
    expectedEpoch: expectedEpoch.value === null
      ? owner.observedEpoch
      : expectedEpoch.value,
    relations: relations.value,
    scope: owner.scope,
    searchPaths: searchPaths.value,
  });
  if (created.status === "malformed") {
    return makeSettledTicket(unavailable("invalid-request"));
  }
  const request = created.value;
  if (owner.active) cancelConsumer(owner.active, SUPERSEDED);

  const cached = new Map<string, ReadyRelation>();
  const missing: SqlColumnCatalogRelationReference[] = [];
  for (const reference of request.relations) {
    const key = request.expectedEpoch === null
      ? null
      : cacheKey(request, reference, request.expectedEpoch);
    const cachedRelation = key === null ? null : cacheGet(state, key);
    if (cachedRelation) {
      cached.set(reference.requestKey, cachedRelation);
    } else {
      missing.push(reference);
    }
  }
  if (missing.length === 0) {
    const combined = combineRelations(request, cached, []);
    if (request.expectedEpoch === null) {
      return makeSettledTicket(unavailable("invalid-request"));
    }
    return makeSettledTicket(
      Object.freeze({
        epoch: request.expectedEpoch,
        providerId: state.context.id,
        relations: combined ?? Object.freeze([]),
        scope: owner.scope,
        status: "usable",
      }),
    );
  }
  const missingCreated = createSqlColumnCatalogBatchRequest({
    dialectId: request.dialectId,
    expectedEpoch: request.expectedEpoch,
    relations: missing,
    scope: request.scope,
    searchPaths: request.searchPaths,
  });
  if (missingCreated.status === "malformed") {
    return makeSettledTicket(unavailable("invalid-request"));
  }
  let resolveResult: (
    value: SqlColumnCatalogBatchOutcome,
  ) => void = (): void => {};
  const result = new Promise<SqlColumnCatalogBatchOutcome>((resolve) => {
    resolveResult = resolve;
  });
  const consumer: ConsumerState = {
    controller: new AbortController(),
    owner,
    resolve: resolveResult,
    settled: false,
  };
  owner.active = consumer;
  const ticket = Object.freeze({
    cancel: (): void => cancelConsumer(consumer, CANCELLED),
    result,
  });
  startProviderWork(
    state,
    owner,
    request,
    missingCreated.value,
    cached,
    consumer,
  );
  return ticket;
}

function disposeOwner(owner: OwnerState): void {
  if (owner.disposed) return;
  owner.disposed = true;
  if (owner.active) {
    cancelConsumer(owner.active, unavailable("disposed"));
  }
  owner.owner?.owners.delete(owner);
  owner.owner = null;
}

function prepareOwner(
  state: CoordinatorState,
  input: unknown,
): SqlColumnCatalogBatchOwnerResult {
  if (state.disposed) {
    return Object.freeze({ reason: "disposed", status: "unavailable" });
  }
  const scopeProperty = dataProperty(input, "scope");
  const dialectProperty = dataProperty(input, "dialectId");
  const scope = boundedString(
    scopeProperty?.value,
    MAX_COLUMN_SCOPE_LENGTH,
  );
  const dialectId = boundedString(
    dialectProperty?.value,
    MAX_COLUMN_DIALECT_ID_LENGTH,
  );
  if (scope === null || dialectId === null) {
    return Object.freeze({
      reason: "invalid-options",
      status: "unavailable",
    });
  }
  const owner: OwnerState = {
    active: null,
    dialectId,
    disposed: false,
    owner: state,
    observedEpoch: null,
    scope,
  };
  state.owners.add(owner);
  return Object.freeze({
    owner: Object.freeze({
      dispose: (): void => disposeOwner(owner),
      request: (input_: SqlColumnCatalogBatchInput) =>
        requestColumns(owner, input_),
    }),
    status: "prepared",
  });
}

function disposeCoordinator(state: CoordinatorState): void {
  if (state.disposed) return;
  state.disposed = true;
  state.cache.clear();
  for (const owner of state.owners) disposeOwner(owner);
}

export function createSqlColumnCatalogBatchCoordinator(
  input: unknown,
): SqlColumnCatalogBatchCoordinatorResult {
  const providerProperty = dataProperty(input, "provider");
  if (!providerProperty) {
    return Object.freeze({
      reason: "invalid-provider",
      status: "unavailable",
    });
  }
  const captured = captureSqlColumnCatalogProvider(
    providerProperty.value,
  );
  if (captured.status === "malformed") {
    return Object.freeze({
      reason: "invalid-provider",
      status: "unavailable",
    });
  }
  const context = resolveSqlColumnCatalogProvider(captured.value);
  if (!context) {
    return Object.freeze({
      reason: "invalid-provider",
      status: "unavailable",
    });
  }
  const maximumProperty = dataProperty(input, "maxCacheEntries");
  const maximum = maximumProperty?.value ?? DEFAULT_COLUMN_CACHE_ENTRIES;
  if (
    typeof maximum !== "number" ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > MAX_COLUMN_CACHE_ENTRIES
  ) {
    return Object.freeze({
      reason: "invalid-options",
      status: "unavailable",
    });
  }
  const state: CoordinatorState = {
    cache: new Map(),
    capturedProvider: captured.value,
    context,
    disposed: false,
    maxCacheEntries: maximum,
    owners: new Set(),
  };
  return Object.freeze({
    coordinator: Object.freeze({
      dispose: (): void => disposeCoordinator(state),
      prepareOwner: (options: SqlColumnCatalogOwnerOptions) =>
        prepareOwner(state, options),
      providerId: context.id,
    }),
    status: "created",
  });
}
