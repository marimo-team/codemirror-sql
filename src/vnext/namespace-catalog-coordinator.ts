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
  readonly map: Map<string, SqlNamespaceCatalogSearchResponse>;
  off: boolean;
  readonly id: string;
  readonly limit: number;
  readonly load: SqlCapturedNamespaceCatalogProviderContext["search"];
  readonly pool: Set<OwnerState>;
  readonly wire: CapturedSqlNamespaceCatalogProvider;
}

interface OwnerState {
  job: ConsumerState | null;
  readonly lang: string;
  gen: number;
  off: boolean;
  rev: SqlCatalogEpoch | null;
  root: CoordinatorState | null;
  readonly scope: string;
}

interface ConsumerState {
  readonly abort: AbortController;
  done: boolean;
  end:
    | ((value: SqlNamespaceCatalogSearchOutcome) => void)
    | null;
  readonly host: OwnerState;
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
  const value = state.map.get(key);
  if (!value) return null;
  state.map.delete(key);
  state.map.set(key, value);
  return value;
}

function cacheSet(
  state: CoordinatorState,
  key: string,
  value: SqlNamespaceCatalogSearchResponse,
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

function settle(
  consumer: ConsumerState,
  outcome: SqlNamespaceCatalogSearchOutcome,
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

function cancel(
  consumer: ConsumerState,
  outcome: SqlNamespaceCatalogSearchOutcome,
): void {
  if (consumer.done) return;
  consumer.abort.abort();
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
    pending = state.load(
      request,
      consumer.abort.signal,
    );
  } catch {
    settle(consumer, unavailable("provider-failed"));
    return;
  }
  Promise.resolve(pending).then(
    (value) => {
      if (
        consumer.done ||
        consumer.abort.signal.aborted ||
        state.off ||
        owner.off ||
        owner.root !== state
      ) {
        return;
      }
      const decoded = decodeSqlNamespaceCatalogSearchResponse(
        state.wire,
        request,
        value,
      );
      if (decoded.status === "malformed") {
        settle(consumer, unavailable("malformed-response"));
        return;
      }
      owner.rev = decoded.value.epoch;
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
        providerId: state.id,
        response: decoded.value,
        scope: owner.scope,
        status: "usable",
      }));
    },
    () => {
      if (!consumer.done) {
        settle(consumer, unavailable("provider-failed"));
      }
    },
  );
}

function request(
  owner: OwnerState,
  input: unknown,
): SqlNamespaceCatalogSearchTicket {
  const state = owner.root;
  if (!state || state.off || owner.off) {
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
    dialectId: owner.lang,
    expectedEpoch: expected.value === null
      ? owner.rev
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
  owner.gen += 1;
  const generation = owner.gen;
  if (owner.job) cancel(owner.job, SUPERSEDED);
  if (generation !== owner.gen) {
    return settledTicket(
      owner.off ? unavailable("disposed") : SUPERSEDED,
    );
  }
  const normalized = created.value;
  const key = normalized.expectedEpoch === null
    ? null
    : cacheKey(normalized, normalized.expectedEpoch);
  const cached = key === null ? null : cacheGet(state, key);
  if (cached) {
    return settledTicket(Object.freeze({
      providerId: state.id,
      response: cached,
      scope: owner.scope,
      status: "usable",
    }));
  }
  let resolveResult: (
    value: SqlNamespaceCatalogSearchOutcome
  ) => void = (): void => {};
  const result = new Promise<SqlNamespaceCatalogSearchOutcome>(
    (resolve) => {
      resolveResult = resolve;
    },
  );
  const consumer: ConsumerState = {
    abort: new AbortController(),
    done: false,
    end: resolveResult,
    host: owner,
  };
  owner.job = consumer;
  const ticket = Object.freeze({
    cancel: (): void => cancel(consumer, CANCELLED),
    result,
  });
  providerWork(state, owner, normalized, consumer);
  return ticket;
}

function disposeOwner(owner: OwnerState): void {
  if (owner.off) return;
  owner.off = true;
  owner.gen += 1;
  if (owner.job) cancel(owner.job, unavailable("disposed"));
  owner.root?.pool.delete(owner);
  owner.root = null;
}

function prepareOwner(
  state: CoordinatorState,
  value: unknown,
): SqlNamespaceCatalogOwnerResult {
  if (state.off) {
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
    job: null,
    gen: 0,
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
      request: (input: SqlNamespaceCatalogSearchInput) =>
        request(owner, input),
    }),
    status: "prepared",
  });
}

function dispose(state: CoordinatorState): void {
  if (state.off) return;
  state.off = true;
  state.map.clear();
  for (const owner of state.pool) disposeOwner(owner);
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
    id: context.id,
    limit: maximum,
    load: context.search,
    map: new Map(),
    off: false,
    pool: new Set(),
    wire: captured.value,
  };
  return Object.freeze({
    coordinator: Object.freeze({
      dispose: (): void => dispose(state),
      prepareOwner: (options: SqlNamespaceCatalogOwnerOptions) =>
        prepareOwner(state, options),
      providerId: state.id,
    }),
    status: "created",
  });
}
