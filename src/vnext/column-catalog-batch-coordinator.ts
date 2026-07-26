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
  readonly map: Map<string, ReadyRelation>;
  off: boolean;
  readonly id: string;
  readonly limit: number;
  readonly load: SqlCapturedColumnCatalogProviderContext["loadColumns"];
  readonly pool: Set<OwnerState>;
  readonly wire: CapturedSqlColumnCatalogProvider;
}

interface OwnerState {
  readonly lang: string;
  gen: number;
  job: ConsumerState | null;
  off: boolean;
  rev: SqlCatalogEpoch | null;
  root: CoordinatorState | null;
  readonly scope: string;
}

interface ConsumerState {
  readonly abort: AbortController;
  done: boolean;
  end: ((value: SqlColumnCatalogBatchOutcome) => void) | null;
  readonly host: OwnerState;
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
    segment(path),
    segment(searchPaths),
  ].join("");
}

function cacheGet(
  state: CoordinatorState,
  key: string,
): ReadyRelation | null {
  const value = state.map.get(key);
  if (!value) return null;
  state.map.delete(key);
  state.map.set(key, value);
  return value;
}

function cacheSet(
  state: CoordinatorState,
  key: string,
  value: ReadyRelation,
): void {
  state.map.delete(key);
  state.map.set(key, value);
  while (state.map.size > state.limit) {
    for (const oldest of state.map.keys()) {
      state.map.delete(oldest);
      break;
    }
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
  if (consumer.host.job === consumer) {
    consumer.host.job = null;
  }
  if (consumer.done) return;
  consumer.done = true;
  const resolve = consumer.end;
  consumer.end = null;
  resolve?.(outcome);
}

function cancelConsumer(
  consumer: ConsumerState,
  outcome: SqlColumnCatalogBatchOutcome,
): void {
  if (consumer.done) return;
  consumer.abort.abort();
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
  cached: ReadonlyMap<string, ReadyRelation>,
  loaded: readonly SqlColumnCatalogRelationResult[],
): readonly SqlColumnCatalogRelationResult[] {
  const output: SqlColumnCatalogRelationResult[] = [...loaded];
  for (const [requestKey, relation] of cached) {
    output.push(withRequestKey(relation, requestKey));
  }
  output.sort((left, right) =>
    left.requestKey < right.requestKey
      ? -1
      : left.requestKey > right.requestKey
      ? 1
      : 0
  );
  return Object.freeze(output);
}

function startProviderWork(
  state: CoordinatorState,
  owner: OwnerState,
  missingRequest: SqlColumnCatalogBatchRequest,
  cached: ReadonlyMap<string, ReadyRelation>,
  consumer: ConsumerState,
): void {
  let providerResult: unknown;
  try {
    providerResult = state.load(
      missingRequest,
      consumer.abort.signal,
    );
  } catch {
    settle(consumer, unavailable("provider-failed"));
    return;
  }
  Promise.resolve(providerResult).then(
    (value) => {
      if (consumer.done) return;
      let decoded: ReturnType<
        typeof decodeSqlColumnCatalogBatchResponse
      >;
      try {
        decoded = decodeSqlColumnCatalogBatchResponse(
          state.wire,
          missingRequest,
          value,
        );
      } catch {
        settle(consumer, unavailable("malformed-response"));
        return;
      }
      if (decoded.status === "malformed") {
        settle(consumer, unavailable("malformed-response"));
        return;
      }
      owner.rev = decoded.value.epoch;
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
        cached,
        decoded.value.relations,
      );
      settle(
        consumer,
        Object.freeze({
          providerId: state.id,
          epoch: decoded.value.epoch,
          relations,
          scope: owner.scope,
          status: "usable",
        }),
      );
    },
    () => {
      if (!consumer.done) {
        settle(consumer, unavailable("provider-failed"));
      }
    },
  );
}

function requestColumns(
  owner: OwnerState,
  input: unknown,
): SqlColumnCatalogBatchTicket {
  const state = owner.root;
  if (!state || state.off || owner.off) {
    return makeSettledTicket(unavailable("disposed"));
  }
  const expectedEpoch = dataProperty(input, "expectedEpoch");
  const relations = dataProperty(input, "relations");
  const searchPaths = dataProperty(input, "searchPaths");
  if (!expectedEpoch || !relations || !searchPaths) {
    return makeSettledTicket(unavailable("invalid-request"));
  }
  const created = createSqlColumnCatalogBatchRequest({
    dialectId: owner.lang,
    expectedEpoch: expectedEpoch.value === null
      ? owner.rev
      : expectedEpoch.value,
    relations: relations.value,
    scope: owner.scope,
    searchPaths: searchPaths.value,
  });
  if (created.status === "malformed") {
    return makeSettledTicket(unavailable("invalid-request"));
  }
  const request = created.value;
  owner.gen += 1;
  const generation = owner.gen;
  if (owner.job) cancelConsumer(owner.job, SUPERSEDED);
  if (generation !== owner.gen) {
    return makeSettledTicket(
      owner.off ? unavailable("disposed") : SUPERSEDED,
    );
  }

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
  if (request.expectedEpoch !== null && missing.length === 0) {
    return makeSettledTicket(
      Object.freeze({
        epoch: request.expectedEpoch,
        providerId: state.id,
        relations: combineRelations(cached, []),
        scope: owner.scope,
        status: "usable",
      }),
    );
  }
  const missingRequest: SqlColumnCatalogBatchRequest = Object.freeze({
    ...request,
    relations: Object.freeze(missing),
  });
  let resolveResult: (
    value: SqlColumnCatalogBatchOutcome,
  ) => void = (): void => {};
  const result = new Promise<SqlColumnCatalogBatchOutcome>((resolve) => {
    resolveResult = resolve;
  });
  const consumer: ConsumerState = {
    abort: new AbortController(),
    done: false,
    end: resolveResult,
    host: owner,
  };
  owner.job = consumer;
  const ticket = Object.freeze({
    cancel: (): void => cancelConsumer(consumer, CANCELLED),
    result,
  });
  startProviderWork(
    state,
    owner,
    missingRequest,
    cached,
    consumer,
  );
  return ticket;
}

function disposeOwner(owner: OwnerState): void {
  if (owner.off) return;
  owner.off = true;
  owner.gen += 1;
  if (owner.job) {
    cancelConsumer(owner.job, unavailable("disposed"));
  }
  owner.root?.pool.delete(owner);
  owner.root = null;
}

function prepareOwner(
  state: CoordinatorState,
  input: unknown,
): SqlColumnCatalogBatchOwnerResult {
  if (state.off) {
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
    gen: 0,
    job: null,
    lang: dialectId,
    off: false,
    rev: null,
    root: state,
    scope,
  };
  state.pool.add(owner);
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
  if (state.off) return;
  state.off = true;
  state.map.clear();
  for (const owner of state.pool) disposeOwner(owner);
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
    id: context.id,
    limit: maximum,
    load: context.loadColumns,
    map: new Map(),
    off: false,
    pool: new Set(),
    wire: captured.value,
  };
  return Object.freeze({
    coordinator: Object.freeze({
      dispose: (): void => disposeCoordinator(state),
      prepareOwner: (options: SqlColumnCatalogOwnerOptions) =>
        prepareOwner(state, options),
      providerId: state.id,
    }),
    status: "created",
  });
}
