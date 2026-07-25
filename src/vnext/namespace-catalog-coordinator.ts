import {
  captureSqlNamespaceCatalogProvider,
  createSqlNamespaceCatalogSearchRequest,
  decodeSqlNamespaceCatalogSearchResponse,
  MAX_NAMESPACE_DIALECT_ID_LENGTH,
  MAX_NAMESPACE_SCOPE_LENGTH,
  resolveSqlNamespaceCatalogProvider,
  type CapturedSqlNamespaceCatalogProvider,
  type SqlCapturedNamespaceCatalogProviderContext,
} from "./namespace-catalog-boundary.js";
import type {
  SqlNamespaceCatalogSearchRequest,
  SqlNamespaceCatalogSearchResponse,
} from "./namespace-catalog-types.js";
import type { SqlCatalogEpoch } from "./relation-completion-types.js";
import type {
  SqlIdentifierComponent,
  SqlIdentifierPath,
} from "./types.js";

export const DEFAULT_NAMESPACE_CACHE_ENTRIES = 256;
export const MAX_NAMESPACE_CACHE_ENTRIES = 4_096;

export interface SqlNamespaceCatalogOwnerOptions {
  readonly dialectId: string;
  readonly scope: string;
}

export interface SqlNamespaceCatalogSearchInput {
  readonly expectedEpoch: SqlCatalogEpoch | null;
  readonly limit: number;
  readonly prefix: SqlIdentifierComponent;
  readonly qualifier: SqlIdentifierPath;
  readonly searchPaths: readonly SqlIdentifierPath[];
}

export type SqlNamespaceCatalogSearchOutcome =
  | {
      readonly providerId: string;
      readonly response: SqlNamespaceCatalogSearchResponse;
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

export interface SqlNamespaceCatalogSearchTicket {
  readonly cancel: (this: void) => void;
  readonly result: Promise<SqlNamespaceCatalogSearchOutcome>;
}

export interface SqlNamespaceCatalogOwner {
  readonly dispose: (this: void) => void;
  readonly request: (
    this: void,
    input: SqlNamespaceCatalogSearchInput,
  ) => SqlNamespaceCatalogSearchTicket;
}

export type SqlNamespaceCatalogOwnerResult =
  | {
      readonly owner: SqlNamespaceCatalogOwner;
      readonly status: "prepared";
    }
  | {
      readonly reason: "disposed" | "invalid-options";
      readonly status: "unavailable";
    };

export interface SqlNamespaceCatalogCoordinator {
  readonly dispose: (this: void) => void;
  readonly prepareOwner: (
    this: void,
    options: SqlNamespaceCatalogOwnerOptions,
  ) => SqlNamespaceCatalogOwnerResult;
  readonly providerId: string;
}

export type SqlNamespaceCatalogCoordinatorResult =
  | {
      readonly coordinator: SqlNamespaceCatalogCoordinator;
      readonly status: "created";
    }
  | {
      readonly reason: "invalid-options" | "invalid-provider";
      readonly status: "unavailable";
    };

interface CoordinatorState {
  readonly cache: Map<string, SqlNamespaceCatalogSearchResponse>;
  readonly capturedProvider: CapturedSqlNamespaceCatalogProvider;
  readonly context: SqlCapturedNamespaceCatalogProviderContext;
  disposed: boolean;
  readonly maxCacheEntries: number;
  readonly owners: Set<OwnerState>;
}

interface OwnerState {
  active: ConsumerState | null;
  readonly dialectId: string;
  disposed: boolean;
  observedEpoch: SqlCatalogEpoch | null;
  owner: CoordinatorState | null;
  readonly scope: string;
}

interface ConsumerState {
  readonly controller: AbortController;
  readonly owner: OwnerState;
  resolve:
    | ((value: SqlNamespaceCatalogSearchOutcome) => void)
    | null;
  settled: boolean;
}

const CANCELLED: SqlNamespaceCatalogSearchOutcome =
  Object.freeze({ status: "cancelled" });
const SUPERSEDED: SqlNamespaceCatalogSearchOutcome =
  Object.freeze({ status: "superseded" });

function unavailable(
  reason: Extract<
    SqlNamespaceCatalogSearchOutcome,
    { readonly status: "unavailable" }
  >["reason"],
): SqlNamespaceCatalogSearchOutcome {
  return Object.freeze({ reason, status: "unavailable" });
}

function property(
  value: unknown,
  key: string,
): { readonly value: unknown } | null {
  if (value === null || typeof value !== "object") return null;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return null;
  }
  return descriptor && "value" in descriptor
    ? { value: descriptor.value }
    : null;
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" &&
      value.length > 0 &&
      value.length <= maximum
    ? value
    : null;
}

function segment(value: string): string {
  return `${value.length}:${value}`;
}

function componentKey(component: SqlIdentifierComponent): string {
  return segment(
    `${component.quoted ? "q" : "u"}${component.value}`,
  );
}

function pathKey(path: SqlIdentifierPath): string {
  return segment(path.map(componentKey).join(""));
}

function cacheKey(
  request: SqlNamespaceCatalogSearchRequest,
  responseEpoch: SqlCatalogEpoch,
): string {
  return [
    segment(request.scope),
    segment(request.dialectId),
    segment(String(responseEpoch.generation)),
    segment(responseEpoch.token),
    pathKey(request.qualifier),
    componentKey(request.prefix),
    segment(request.searchPaths.map(pathKey).join("")),
    segment(String(request.limit)),
  ].join("");
}

function cacheGet(
  state: CoordinatorState,
  key: string,
): SqlNamespaceCatalogSearchResponse | null {
  const value = state.cache.get(key);
  if (!value) return null;
  state.cache.delete(key);
  state.cache.set(key, value);
  return value;
}

function cacheSet(
  state: CoordinatorState,
  key: string,
  value: SqlNamespaceCatalogSearchResponse,
): void {
  state.cache.delete(key);
  state.cache.set(key, value);
  while (state.cache.size > state.maxCacheEntries) {
    const oldest = state.cache.keys().next().value;
    if (typeof oldest !== "string") break;
    state.cache.delete(oldest);
  }
}

function settle(
  consumer: ConsumerState,
  outcome: SqlNamespaceCatalogSearchOutcome,
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

function cancel(
  consumer: ConsumerState,
  outcome: SqlNamespaceCatalogSearchOutcome,
): void {
  if (consumer.settled) return;
  consumer.controller.abort();
  settle(consumer, outcome);
}

function settledTicket(
  outcome: SqlNamespaceCatalogSearchOutcome,
): SqlNamespaceCatalogSearchTicket {
  return Object.freeze({
    cancel: (): void => {},
    result: Promise.resolve(outcome),
  });
}

function providerWork(
  state: CoordinatorState,
  owner: OwnerState,
  request: SqlNamespaceCatalogSearchRequest,
  consumer: ConsumerState,
): void {
  let pending: unknown;
  try {
    pending = state.context.search(
      request,
      consumer.controller.signal,
    );
  } catch {
    settle(consumer, unavailable("provider-failed"));
    return;
  }
  Promise.resolve(pending).then(
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
      const decoded = decodeSqlNamespaceCatalogSearchResponse(
        state.capturedProvider,
        request,
        value,
      );
      if (decoded.status === "malformed") {
        settle(consumer, unavailable("malformed-response"));
        return;
      }
      owner.observedEpoch = decoded.value.epoch;
      if (
        decoded.value.status === "ready" &&
        decoded.value.coverage === "complete"
      ) {
        cacheSet(
          state,
          cacheKey(request, decoded.value.epoch),
          decoded.value,
        );
      }
      settle(consumer, Object.freeze({
        providerId: state.context.id,
        response: decoded.value,
        scope: owner.scope,
        status: "usable",
      }));
    },
    () => {
      if (!consumer.settled) {
        settle(consumer, unavailable("provider-failed"));
      }
    },
  );
}

function request(
  owner: OwnerState,
  input: unknown,
): SqlNamespaceCatalogSearchTicket {
  const state = owner.owner;
  if (!state || state.disposed || owner.disposed) {
    return settledTicket(unavailable("disposed"));
  }
  const expected = property(input, "expectedEpoch");
  const limit = property(input, "limit");
  const prefix = property(input, "prefix");
  const qualifier = property(input, "qualifier");
  const paths = property(input, "searchPaths");
  if (!expected || !limit || !prefix || !qualifier || !paths) {
    return settledTicket(unavailable("invalid-request"));
  }
  const created = createSqlNamespaceCatalogSearchRequest({
    dialectId: owner.dialectId,
    expectedEpoch: expected.value === null
      ? owner.observedEpoch
      : expected.value,
    limit: limit.value,
    prefix: prefix.value,
    qualifier: qualifier.value,
    scope: owner.scope,
    searchPaths: paths.value,
  });
  if (created.status === "malformed") {
    return settledTicket(unavailable("invalid-request"));
  }
  if (owner.active) cancel(owner.active, SUPERSEDED);
  const normalized = created.value;
  const key = normalized.expectedEpoch === null
    ? null
    : cacheKey(normalized, normalized.expectedEpoch);
  const cached = key === null ? null : cacheGet(state, key);
  if (cached) {
    return settledTicket(Object.freeze({
      providerId: state.context.id,
      response: cached,
      scope: owner.scope,
      status: "usable",
    }));
  }
  const resolver: {
    value:
      | ((value: SqlNamespaceCatalogSearchOutcome) => void)
      | null;
  } = { value: null };
  const result = new Promise<SqlNamespaceCatalogSearchOutcome>(
    (resolve) => {
      resolver.value = resolve;
    },
  );
  const consumer: ConsumerState = {
    controller: new AbortController(),
    owner,
    resolve: resolver.value,
    settled: false,
  };
  owner.active = consumer;
  const ticket = Object.freeze({
    cancel: (): void => cancel(consumer, CANCELLED),
    result,
  });
  providerWork(state, owner, normalized, consumer);
  return ticket;
}

function disposeOwner(owner: OwnerState): void {
  if (owner.disposed) return;
  owner.disposed = true;
  if (owner.active) cancel(owner.active, unavailable("disposed"));
  owner.owner?.owners.delete(owner);
  owner.owner = null;
}

function prepareOwner(
  state: CoordinatorState,
  value: unknown,
): SqlNamespaceCatalogOwnerResult {
  if (state.disposed) {
    return Object.freeze({ reason: "disposed", status: "unavailable" });
  }
  const dialectId = boundedString(
    property(value, "dialectId")?.value,
    MAX_NAMESPACE_DIALECT_ID_LENGTH,
  );
  const scope = boundedString(
    property(value, "scope")?.value,
    MAX_NAMESPACE_SCOPE_LENGTH,
  );
  if (!dialectId || !scope) {
    return Object.freeze({
      reason: "invalid-options",
      status: "unavailable",
    });
  }
  const owner: OwnerState = {
    active: null,
    dialectId,
    disposed: false,
    observedEpoch: null,
    owner: state,
    scope,
  };
  state.owners.add(owner);
  return Object.freeze({
    owner: Object.freeze({
      dispose: (): void => disposeOwner(owner),
      request: (input: SqlNamespaceCatalogSearchInput) =>
        request(owner, input),
    }),
    status: "prepared",
  });
}

function dispose(state: CoordinatorState): void {
  if (state.disposed) return;
  state.disposed = true;
  state.cache.clear();
  for (const owner of state.owners) disposeOwner(owner);
}

export function createSqlNamespaceCatalogCoordinator(
  value: unknown,
): SqlNamespaceCatalogCoordinatorResult {
  const captured = captureSqlNamespaceCatalogProvider(
    property(value, "provider")?.value,
  );
  if (captured.status === "malformed") {
    return Object.freeze({
      reason: "invalid-provider",
      status: "unavailable",
    });
  }
  const context = resolveSqlNamespaceCatalogProvider(captured.value);
  if (!context) {
    return Object.freeze({
      reason: "invalid-provider",
      status: "unavailable",
    });
  }
  const rawMaximum = property(value, "maxCacheEntries");
  const maximum = rawMaximum === null
    ? DEFAULT_NAMESPACE_CACHE_ENTRIES
    : rawMaximum.value;
  if (
    typeof maximum !== "number" ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > MAX_NAMESPACE_CACHE_ENTRIES
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
      dispose: (): void => dispose(state),
      prepareOwner: (options: SqlNamespaceCatalogOwnerOptions) =>
        prepareOwner(state, options),
      providerId: context.id,
    }),
    status: "created",
  });
}
