import type {
  SqlCatalogContainerComponent,
  SqlCatalogContainerRole,
  SqlCatalogEpoch,
  SqlCatalogFailureCode,
  SqlCatalogInvalidation,
  SqlCatalogReadyCoverage,
  SqlCatalogRelationKind,
  SqlCatalogRetryPolicy,
  SqlCatalogSearchRequest,
  SqlCanonicalRelationPath,
} from "./relation-completion-types.js";
import type { SqlRelationDialectRuntime } from "./relation-dialect.js";
import { isSqlRelationDialectRuntime } from "./relation-runtime-auth.js";
import type {
  SqlIdentifierComponent,
  SqlIdentifierPath,
} from "./types.js";

export const MAX_CATALOG_PROVIDER_ID_LENGTH = 256;
export const MAX_CATALOG_SCOPE_LENGTH = 512;
export const MAX_CATALOG_DIALECT_ID_LENGTH = 128;
export const MAX_CATALOG_EPOCH_TOKEN_LENGTH = 256;
export const MAX_CATALOG_CONTINUATION_TOKEN_LENGTH = 2_048;
export const MAX_CATALOG_ENTITY_ID_LENGTH = 256;
export const MAX_CATALOG_DETAIL_LENGTH = 1_024;
export const MAX_CATALOG_IDENTIFIER_LENGTH = 256;
export const MAX_CATALOG_SEARCH_PATHS = 32;
export const MAX_CATALOG_SEARCH_PATH_COMPONENTS = 4;
export const MAX_CATALOG_RELATION_PATH_COMPONENTS = 32;
export const MAX_CATALOG_RELATIONS = 100;
export const MAX_CATALOG_REQUEST_TEXT_LENGTH = 16_384;
export const MAX_CATALOG_RESPONSE_TEXT_LENGTH = 65_536;
export const MAX_CATALOG_RESPONSE_OWN_KEYS = 16_384;
export const MAX_CATALOG_DECODE_DEPTH = 8;

const MAX_CATALOG_REQUEST_OBJECTS = 1_024;
const MAX_CATALOG_REQUEST_OWN_KEYS = 1_024;
const MAX_CATALOG_RESPONSE_OBJECTS = 4_096;

const capturedProviderBrand: unique symbol = Symbol(
  "CapturedSqlRelationCatalogProvider",
);

export interface CapturedSqlRelationCatalogProvider {
  readonly [capturedProviderBrand]:
    "CapturedSqlRelationCatalogProvider";
}

export interface SqlCapturedRelationCatalogProviderContext {
  readonly id: string;
  readonly search: (
    this: void,
    request: SqlCatalogSearchRequest,
    signal: AbortSignal,
  ) => unknown;
  readonly subscribe:
    | ((
        this: void,
        scope: string,
        listener: (event: unknown) => void,
      ) => unknown)
    | null;
}

export type SqlCatalogBoundaryFailureReason =
  | "duplicate-entity-id"
  | "illegal-relation-path"
  | "invalid-shape"
  | "resource-limit";

export type SqlCatalogBoundaryResult<Value> =
  | {
      readonly status: "accepted";
      readonly value: Value;
    }
  | {
      readonly status: "malformed";
      readonly reason: SqlCatalogBoundaryFailureReason;
    };

export interface SqlValidatedCatalogRelation {
  readonly canonicalPath: SqlCanonicalRelationPath;
  readonly completionPath: SqlCanonicalRelationPath;
  readonly completionPathStart: number;
  readonly completionText: string;
  readonly detail?: string;
  readonly entityId: string;
  readonly matchQuality: "exact" | "equivalent";
  readonly relationKind: SqlCatalogRelationKind;
}

export type SqlValidatedCatalogSearchResponse =
  | {
      readonly status: "ready";
      readonly coverage: SqlCatalogReadyCoverage;
      readonly epoch: SqlCatalogEpoch;
      readonly relations: readonly SqlValidatedCatalogRelation[];
    }
  | {
      readonly status: "loading";
      readonly epoch: SqlCatalogEpoch;
    }
  | {
      readonly status: "failed";
      readonly code: SqlCatalogFailureCode;
      readonly epoch: SqlCatalogEpoch;
      readonly retry: SqlCatalogRetryPolicy;
    };

export type SqlCatalogEpochComparison =
  | {
      readonly kind: "baseline";
      readonly epoch: SqlCatalogEpoch;
    }
  | {
      readonly kind: "equal";
      readonly epoch: SqlCatalogEpoch;
    }
  | {
      readonly kind: "advance";
      readonly epoch: SqlCatalogEpoch;
      readonly previous: SqlCatalogEpoch;
    }
  | {
      readonly kind: "stale";
      readonly observed: SqlCatalogEpoch;
      readonly received: SqlCatalogEpoch;
    }
  | {
      readonly kind: "token-conflict";
      readonly observed: SqlCatalogEpoch;
      readonly received: SqlCatalogEpoch;
    }
  | {
      readonly kind: "malformed";
    };

interface DecodeBudget {
  objects: number;
  properties: number;
  textLength: number;
}

interface DecodeLimits {
  readonly maximumDepth: number;
  readonly maximumObjects: number;
  readonly maximumProperties: number;
  readonly maximumTextLength: number;
}

interface DecodeState {
  readonly budget: DecodeBudget;
  exhausted: boolean;
  readonly limits: DecodeLimits;
}

interface DataRecord {
  readonly fields: ReadonlyMap<string, unknown>;
}

interface CapturedProviderFunctions {
  readonly id: string;
  readonly search: Function;
  readonly subscribe: Function | null;
}

const capturedProviders = new WeakMap<
  object,
  CapturedProviderFunctions
>();

const FAILURE_CODES: ReadonlySet<string> = new Set([
  "authentication",
  "authorization",
  "invalid-configuration",
  "rate-limited",
  "unavailable",
  "unknown",
]);

const RETRY_POLICIES: ReadonlySet<string> = new Set([
  "after-invalidation",
  "never",
  "next-request",
]);

const RELATION_KINDS: ReadonlySet<string> = new Set([
  "external-relation",
  "materialized-view",
  "table",
  "temporary-table",
  "view",
]);

const CONTAINER_ROLES: ReadonlySet<string> = new Set([
  "catalog",
  "dataset",
  "project",
  "schema",
]);

function isCatalogContainerRole(
  value: string,
): value is SqlCatalogContainerRole {
  return CONTAINER_ROLES.has(value);
}

function isCatalogFailureCode(
  value: string,
): value is SqlCatalogFailureCode {
  return FAILURE_CODES.has(value);
}

function isCatalogRetryPolicy(
  value: string,
): value is SqlCatalogRetryPolicy {
  return RETRY_POLICIES.has(value);
}

function isCatalogRelationKind(
  value: string,
): value is SqlCatalogRelationKind {
  return RELATION_KINDS.has(value);
}

function accepted<Value>(
  value: Value,
): SqlCatalogBoundaryResult<Value> {
  return Object.freeze({ status: "accepted", value });
}

function malformed<Value>(
  reason: SqlCatalogBoundaryFailureReason,
): SqlCatalogBoundaryResult<Value> {
  return Object.freeze({ reason, status: "malformed" });
}

function malformedFromState<Value>(
  state: DecodeState,
  reason: SqlCatalogBoundaryFailureReason = "invalid-shape",
): SqlCatalogBoundaryResult<Value> {
  return malformed(state.exhausted ? "resource-limit" : reason);
}

const PROVIDER_DECODE_LIMITS: DecodeLimits = Object.freeze({
  maximumDepth: 1,
  maximumObjects: 1,
  maximumProperties: 3,
  maximumTextLength: MAX_CATALOG_PROVIDER_ID_LENGTH,
});

const REQUEST_DECODE_LIMITS: DecodeLimits = Object.freeze({
  maximumDepth: MAX_CATALOG_DECODE_DEPTH,
  maximumObjects: MAX_CATALOG_REQUEST_OBJECTS,
  maximumProperties: MAX_CATALOG_REQUEST_OWN_KEYS,
  maximumTextLength: MAX_CATALOG_REQUEST_TEXT_LENGTH,
});

const RESPONSE_DECODE_LIMITS: DecodeLimits = Object.freeze({
  maximumDepth: MAX_CATALOG_DECODE_DEPTH,
  maximumObjects: MAX_CATALOG_RESPONSE_OBJECTS,
  maximumProperties: MAX_CATALOG_RESPONSE_OWN_KEYS,
  maximumTextLength: MAX_CATALOG_RESPONSE_TEXT_LENGTH,
});

function createDecodeState(limits: DecodeLimits): DecodeState {
  return {
    budget: {
      objects: 0,
      properties: 0,
      textLength: 0,
    },
    exhausted: false,
    limits,
  };
}

function consumeObject(
  state: DecodeState,
  propertyCount: number,
  depth: number,
): boolean {
  if (depth > state.limits.maximumDepth) {
    state.exhausted = true;
    return false;
  }
  state.budget.objects += 1;
  state.budget.properties += propertyCount;
  if (
    state.budget.objects > state.limits.maximumObjects ||
    state.budget.properties > state.limits.maximumProperties
  ) {
    state.exhausted = true;
    return false;
  }
  return true;
}

function consumeText(
  state: DecodeState,
  value: string,
  minimumLength: number,
  maximumLength: number,
): string | null {
  if (value.length > maximumLength) {
    state.exhausted = true;
    return null;
  }
  if (
    value.length >
    state.limits.maximumTextLength - state.budget.textLength
  ) {
    state.exhausted = true;
    return null;
  }
  if (
    value.length < minimumLength ||
    value.includes("\0") ||
    !isWellFormed(value)
  ) {
    return null;
  }
  state.budget.textLength += value.length;
  return value;
}

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function readRecord(
  state: DecodeState,
  value: unknown,
  maximumOwnKeys: number,
  depth: number,
): DataRecord | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > maximumOwnKeys ||
    !consumeObject(state, keys.length, depth)
  ) {
    return null;
  }
  const fields = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== "string" || fields.has(key)) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      return null;
    }
    fields.set(key, descriptor.value);
  }
  return { fields };
}

function readArray(
  state: DecodeState,
  value: unknown,
  maximumLength: number,
  depth: number,
): readonly unknown[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    return null;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(
    value,
    "length",
  );
  if (
    !lengthDescriptor ||
    !("value" in lengthDescriptor) ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    return null;
  }
  const length = lengthDescriptor.value;
  if (length > maximumLength) {
    state.exhausted = true;
    return null;
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== length + 1 ||
    !consumeObject(state, keys.length, depth)
  ) {
    return null;
  }
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      value,
      String(index),
    );
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      return null;
    }
    output.push(descriptor.value);
  }
  for (const key of keys) {
    if (
      typeof key !== "string" ||
      (key !== "length" &&
        (!/^(0|[1-9]\d*)$/.test(key) ||
          Number(key) >= length))
    ) {
      return null;
    }
  }
  return output;
}

function hasExactKeys(
  record: DataRecord,
  keys: readonly string[],
): boolean {
  if (record.fields.size !== keys.length) {
    return false;
  }
  return keys.every((key) => record.fields.has(key));
}

function decodeEpoch(
  state: DecodeState,
  value: unknown,
  depth: number,
): SqlCatalogEpoch | null {
  const record = readRecord(state, value, 2, depth);
  if (!record || !hasExactKeys(record, ["generation", "token"])) {
    return null;
  }
  const generation = record.fields.get("generation");
  const tokenValue = record.fields.get("token");
  if (
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    typeof tokenValue !== "string"
  ) {
    return null;
  }
  const token = consumeText(
    state,
    tokenValue,
    1,
    MAX_CATALOG_EPOCH_TOKEN_LENGTH,
  );
  return token
    ? Object.freeze({
        generation: generation === 0 ? 0 : generation,
        token,
      })
    : null;
}

function decodeIdentifierComponent(
  state: DecodeState,
  value: unknown,
  allowEmpty: boolean,
  depth: number,
): SqlIdentifierComponent | null {
  const record = readRecord(state, value, 2, depth);
  if (!record || !hasExactKeys(record, ["quoted", "value"])) {
    return null;
  }
  const quoted = record.fields.get("quoted");
  const rawValue = record.fields.get("value");
  if (typeof quoted !== "boolean" || typeof rawValue !== "string") {
    return null;
  }
  const decodedValue = consumeText(
    state,
    rawValue,
    allowEmpty ? 0 : 1,
    MAX_CATALOG_IDENTIFIER_LENGTH,
  );
  return decodedValue === null
    ? null
    : Object.freeze({ quoted, value: decodedValue });
}

function decodeIdentifierPath(
  state: DecodeState,
  value: unknown,
  maximumLength: number,
  allowEmpty: boolean,
  depth: number,
): SqlIdentifierPath | null {
  const values = readArray(state, value, maximumLength, depth);
  if (!values || (!allowEmpty && values.length === 0)) {
    return null;
  }
  const components: SqlIdentifierComponent[] = [];
  for (const candidate of values) {
    const component = decodeIdentifierComponent(
      state,
      candidate,
      false,
      depth + 1,
    );
    if (!component) {
      return null;
    }
    components.push(component);
  }
  return Object.freeze(components);
}

function decodeSearchPaths(
  state: DecodeState,
  value: unknown,
  depth: number,
): readonly SqlIdentifierPath[] | null {
  const paths = readArray(
    state,
    value,
    MAX_CATALOG_SEARCH_PATHS,
    depth,
  );
  if (!paths) {
    return null;
  }
  const output: SqlIdentifierPath[] = [];
  for (const path of paths) {
    const decoded = decodeIdentifierPath(
      state,
      path,
      MAX_CATALOG_SEARCH_PATH_COMPONENTS,
      false,
      depth + 1,
    );
    if (!decoded) {
      return null;
    }
    output.push(decoded);
  }
  return Object.freeze(output);
}

function decodeCoverage(
  state: DecodeState,
  value: unknown,
  depth: number,
): SqlCatalogReadyCoverage | null {
  const record = readRecord(state, value, 2, depth);
  if (!record) {
    return null;
  }
  const kind = record.fields.get("kind");
  if (kind === "complete" || kind === "partial") {
    return hasExactKeys(record, ["kind"])
      ? Object.freeze({ kind })
      : null;
  }
  if (
    kind !== "paginated" ||
    !hasExactKeys(record, ["continuationToken", "kind"])
  ) {
    return null;
  }
  const tokenValue = record.fields.get("continuationToken");
  if (typeof tokenValue !== "string") {
    return null;
  }
  const continuationToken = consumeText(
    state,
    tokenValue,
    1,
    MAX_CATALOG_CONTINUATION_TOKEN_LENGTH,
  );
  return continuationToken
    ? Object.freeze({ continuationToken, kind })
    : null;
}

function decodeCanonicalPath(
  state: DecodeState,
  value: unknown,
  depth: number,
): SqlCanonicalRelationPath | null {
  const values = readArray(
    state,
    value,
    MAX_CATALOG_RELATION_PATH_COMPONENTS,
    depth,
  );
  if (!values || values.length === 0) {
    return null;
  }
  const containers: SqlCatalogContainerComponent[] = [];
  let relation:
    | {
        readonly quoted: boolean;
        readonly role: "relation";
        readonly value: string;
      }
    | null = null;
  for (let index = 0; index < values.length; index += 1) {
    const record = readRecord(
      state,
      values[index],
      3,
      depth + 1,
    );
    if (
      !record ||
      !hasExactKeys(record, ["quoted", "role", "value"])
    ) {
      return null;
    }
    const quoted = record.fields.get("quoted");
    const role = record.fields.get("role");
    const rawValue = record.fields.get("value");
    if (
      typeof quoted !== "boolean" ||
      typeof role !== "string" ||
      typeof rawValue !== "string"
    ) {
      return null;
    }
    const decodedValue = consumeText(
      state,
      rawValue,
      1,
      MAX_CATALOG_IDENTIFIER_LENGTH,
    );
    if (!decodedValue) {
      return null;
    }
    const final = index === values.length - 1;
    if (final) {
      if (role !== "relation") {
        return null;
      }
      relation = Object.freeze({
        quoted,
        role,
        value: decodedValue,
      });
    } else {
      if (!isCatalogContainerRole(role)) {
        return null;
      }
      const container: SqlCatalogContainerComponent = {
        quoted,
        role,
        value: decodedValue,
      };
      containers.push(Object.freeze(container));
    }
  }
  return relation
    ? Object.freeze([...containers, relation])
    : null;
}

function completionSuffix(
  path: SqlCanonicalRelationPath,
  start: number,
): SqlCanonicalRelationPath | null {
  const relation = path[path.length - 1];
  if (!relation || relation.role !== "relation") {
    return null;
  }
  const containers: SqlCatalogContainerComponent[] = [];
  for (let index = start; index < path.length - 1; index += 1) {
    const component = path[index];
    if (!component || component.role === "relation") {
      return null;
    }
    containers.push(component);
  }
  return Object.freeze([...containers, relation]);
}

function decodeRelation(
  state: DecodeState,
  value: unknown,
  dialect: SqlRelationDialectRuntime,
  depth: number,
): SqlCatalogBoundaryResult<SqlValidatedCatalogRelation> {
  const record = readRecord(state, value, 6, depth);
  if (!record) {
    return malformedFromState(state);
  }
  const keys = record.fields.has("detail")
    ? [
        "canonicalPath",
        "completionPathStart",
        "detail",
        "entityId",
        "matchQuality",
        "relationKind",
      ]
    : [
        "canonicalPath",
        "completionPathStart",
        "entityId",
        "matchQuality",
        "relationKind",
      ];
  if (!hasExactKeys(record, keys)) {
    return malformedFromState(state);
  }
  const entityIdValue = record.fields.get("entityId");
  const relationKind = record.fields.get("relationKind");
  const matchQuality = record.fields.get("matchQuality");
  const completionPathStart = record.fields.get(
    "completionPathStart",
  );
  if (
    typeof entityIdValue !== "string" ||
    typeof relationKind !== "string" ||
    !isCatalogRelationKind(relationKind) ||
    (matchQuality !== "exact" &&
      matchQuality !== "equivalent") ||
    typeof completionPathStart !== "number" ||
    !Number.isSafeInteger(completionPathStart)
  ) {
    return malformedFromState(state);
  }
  const entityId = consumeText(
    state,
    entityIdValue,
    1,
    MAX_CATALOG_ENTITY_ID_LENGTH,
  );
  if (!entityId) {
    return malformedFromState(state);
  }
  const path = decodeCanonicalPath(
    state,
    record.fields.get("canonicalPath"),
    depth + 1,
  );
  if (
    !path ||
    completionPathStart < 0 ||
    completionPathStart >= path.length
  ) {
    return malformedFromState(state);
  }
  const suffix = completionSuffix(path, completionPathStart);
  if (!suffix) {
    return malformedFromState(state, "illegal-relation-path");
  }
  const fullRender = dialect.completion.renderRelationPath(path);
  const completionRender =
    dialect.completion.renderRelationPath(suffix);
  if (
    fullRender.status !== "rendered" ||
    completionRender.status !== "rendered"
  ) {
    return malformedFromState(state, "illegal-relation-path");
  }
  const detailValue = record.fields.get("detail");
  let detail: string | undefined;
  if (record.fields.has("detail")) {
    if (typeof detailValue !== "string") {
      return malformedFromState(state);
    }
    const decodedDetail = consumeText(
      state,
      detailValue,
      0,
      MAX_CATALOG_DETAIL_LENGTH,
    );
    if (decodedDetail === null) {
      return malformedFromState(state);
    }
    detail = decodedDetail;
  }
  const base: Omit<SqlValidatedCatalogRelation, "detail"> = {
    canonicalPath: path,
    completionPath: suffix,
    completionPathStart,
    completionText: completionRender.text,
    entityId,
    matchQuality,
    relationKind,
  };
  return accepted(
    Object.freeze(
      detail === undefined ? base : { ...base, detail },
    ),
  );
}

export function captureSqlRelationCatalogProvider(
  candidate: unknown,
): SqlCatalogBoundaryResult<CapturedSqlRelationCatalogProvider> {
  try {
    const state = createDecodeState(PROVIDER_DECODE_LIMITS);
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      (Object.getPrototypeOf(candidate) !== Object.prototype &&
        Object.getPrototypeOf(candidate) !== null)
    ) {
      return malformed("invalid-shape");
    }
    const idDescriptor = Object.getOwnPropertyDescriptor(
      candidate,
      "id",
    );
    const searchDescriptor = Object.getOwnPropertyDescriptor(
      candidate,
      "search",
    );
    const subscribeDescriptor = Object.getOwnPropertyDescriptor(
      candidate,
      "subscribe",
    );
    if (
      !idDescriptor ||
      !idDescriptor.enumerable ||
      !("value" in idDescriptor) ||
      !searchDescriptor ||
      !searchDescriptor.enumerable ||
      !("value" in searchDescriptor) ||
      (subscribeDescriptor !== undefined &&
        (!subscribeDescriptor.enumerable ||
          !("value" in subscribeDescriptor))) ||
      !consumeObject(
        state,
        subscribeDescriptor === undefined ? 2 : 3,
        1,
      )
    ) {
      return malformedFromState(state);
    }
    const idValue = idDescriptor.value;
    const search = searchDescriptor.value;
    const subscribeValue = subscribeDescriptor?.value;
    if (
      typeof idValue !== "string" ||
      typeof search !== "function" ||
      (subscribeDescriptor !== undefined &&
        subscribeValue !== undefined &&
        typeof subscribeValue !== "function")
    ) {
      return malformedFromState(state);
    }
    const id = consumeText(
      state,
      idValue,
      1,
      MAX_CATALOG_PROVIDER_ID_LENGTH,
    );
    if (!id) {
      return malformedFromState(state);
    }
    const provider: CapturedSqlRelationCatalogProvider =
      Object.freeze({
        [capturedProviderBrand]:
          "CapturedSqlRelationCatalogProvider" as const,
      });
    capturedProviders.set(
      provider,
      Object.freeze({
        id,
        search,
        subscribe:
          typeof subscribeValue === "function"
            ? subscribeValue
            : null,
      }),
    );
    return accepted(provider);
  } catch {
    return malformed("invalid-shape");
  }
}

export function resolveSqlRelationCatalogProvider(
  candidate: unknown,
): SqlCapturedRelationCatalogProviderContext | null {
  if (
    candidate === null ||
    typeof candidate !== "object"
  ) {
    return null;
  }
  const captured = capturedProviders.get(candidate);
  if (!captured) {
    return null;
  }
  const subscribe = captured.subscribe;
  return Object.freeze({
    id: captured.id,
    search: (
      request: SqlCatalogSearchRequest,
      signal: AbortSignal,
    ): unknown =>
      Reflect.apply(captured.search, undefined, [
        request,
        signal,
      ]),
    subscribe: subscribe
      ? (
          scope: string,
          listener: (event: unknown) => void,
        ): unknown =>
          Reflect.apply(subscribe, undefined, [
            scope,
            listener,
          ])
      : null,
  });
}

export function createSqlCatalogSearchRequest(
  candidate: unknown,
): SqlCatalogBoundaryResult<SqlCatalogSearchRequest> {
  try {
    const state = createDecodeState(REQUEST_DECODE_LIMITS);
    const record = readRecord(state, candidate, 8, 1);
    if (
      !record ||
      !hasExactKeys(record, [
        "continuationToken",
        "dialectId",
        "expectedEpoch",
        "limit",
        "prefix",
        "qualifier",
        "scope",
        "searchPaths",
      ])
    ) {
      return malformedFromState(state);
    }
    const scopeValue = record.fields.get("scope");
    const dialectIdValue = record.fields.get("dialectId");
    const limit = record.fields.get("limit");
    if (
      typeof scopeValue !== "string" ||
      typeof dialectIdValue !== "string" ||
      typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_CATALOG_RELATIONS
    ) {
      return malformedFromState(state);
    }
    const scope = consumeText(
      state,
      scopeValue,
      1,
      MAX_CATALOG_SCOPE_LENGTH,
    );
    const dialectId = consumeText(
      state,
      dialectIdValue,
      1,
      MAX_CATALOG_DIALECT_ID_LENGTH,
    );
    const searchPaths = decodeSearchPaths(
      state,
      record.fields.get("searchPaths"),
      2,
    );
    const qualifier = decodeIdentifierPath(
      state,
      record.fields.get("qualifier"),
      MAX_CATALOG_RELATION_PATH_COMPONENTS - 1,
      true,
      2,
    );
    const prefix = decodeIdentifierComponent(
      state,
      record.fields.get("prefix"),
      true,
      2,
    );
    if (
      !scope ||
      !dialectId ||
      !searchPaths ||
      !qualifier ||
      !prefix
    ) {
      return malformedFromState(state);
    }
    const expectedEpochValue = record.fields.get("expectedEpoch");
    const expectedEpoch =
      expectedEpochValue === null
        ? null
        : decodeEpoch(state, expectedEpochValue, 2);
    if (expectedEpochValue !== null && !expectedEpoch) {
      return malformedFromState(state);
    }
    const continuationValue = record.fields.get(
      "continuationToken",
    );
    let continuationToken: string | null = null;
    if (continuationValue !== null) {
      if (typeof continuationValue !== "string") {
        return malformedFromState(state);
      }
      continuationToken = consumeText(
        state,
        continuationValue,
        1,
        MAX_CATALOG_CONTINUATION_TOKEN_LENGTH,
      );
      if (!continuationToken) {
        return malformedFromState(state);
      }
    }
    return accepted(
      Object.freeze({
        continuationToken,
        dialectId,
        expectedEpoch,
        limit,
        prefix,
        qualifier,
        scope,
        searchPaths,
      }),
    );
  } catch {
    return malformed("invalid-shape");
  }
}

export function decodeSqlCatalogSearchResponse(
  candidate: unknown,
  requestLimit: number,
  dialect: SqlRelationDialectRuntime,
): SqlCatalogBoundaryResult<SqlValidatedCatalogSearchResponse> {
  try {
    if (
      !Number.isSafeInteger(requestLimit) ||
      requestLimit < 1 ||
      requestLimit > MAX_CATALOG_RELATIONS ||
      !isSqlRelationDialectRuntime(dialect)
    ) {
      return malformed("invalid-shape");
    }
    const state = createDecodeState(RESPONSE_DECODE_LIMITS);
    const record = readRecord(state, candidate, 4, 1);
    if (!record) {
      return malformedFromState(state);
    }
    const status = record.fields.get("status");
    if (status === "loading") {
      if (!hasExactKeys(record, ["epoch", "status"])) {
        return malformedFromState(state);
      }
      const epoch = decodeEpoch(
        state,
        record.fields.get("epoch"),
        2,
      );
      return epoch
        ? accepted(Object.freeze({ epoch, status }))
        : malformedFromState(state);
    }
    if (status === "failed") {
      if (
        !hasExactKeys(record, [
          "code",
          "epoch",
          "retry",
          "status",
        ])
      ) {
        return malformedFromState(state);
      }
      const epoch = decodeEpoch(
        state,
        record.fields.get("epoch"),
        2,
      );
      const code = record.fields.get("code");
      const retry = record.fields.get("retry");
      if (
        !epoch ||
        typeof code !== "string" ||
        !isCatalogFailureCode(code) ||
        typeof retry !== "string" ||
        !isCatalogRetryPolicy(retry)
      ) {
        return malformedFromState(state);
      }
      const response: Extract<
        SqlValidatedCatalogSearchResponse,
        { readonly status: "failed" }
      > = {
        code,
        epoch,
        retry,
        status,
      };
      return accepted(Object.freeze(response));
    }
    if (
      status !== "ready" ||
      !hasExactKeys(record, [
        "coverage",
        "epoch",
        "relations",
        "status",
      ])
    ) {
      return malformedFromState(state);
    }
    const epoch = decodeEpoch(
      state,
      record.fields.get("epoch"),
      2,
    );
    const coverage = decodeCoverage(
      state,
      record.fields.get("coverage"),
      2,
    );
    const relations = readArray(
      state,
      record.fields.get("relations"),
      requestLimit,
      2,
    );
    if (!epoch || !coverage || !relations) {
      return malformedFromState(state);
    }
    const entityIds = new Set<string>();
    const decodedRelations: SqlValidatedCatalogRelation[] = [];
    for (const relation of relations) {
      const decoded = decodeRelation(
        state,
        relation,
        dialect,
        3,
      );
      if (decoded.status === "malformed") {
        return decoded;
      }
      if (entityIds.has(decoded.value.entityId)) {
        return malformed("duplicate-entity-id");
      }
      entityIds.add(decoded.value.entityId);
      decodedRelations.push(decoded.value);
    }
    return accepted(
      Object.freeze({
        coverage,
        epoch,
        relations: Object.freeze(decodedRelations),
        status,
      }),
    );
  } catch {
    return malformed("invalid-shape");
  }
}

export function decodeSqlCatalogInvalidation(
  candidate: unknown,
): SqlCatalogBoundaryResult<SqlCatalogInvalidation> {
  try {
    const state = createDecodeState(RESPONSE_DECODE_LIMITS);
    const record = readRecord(state, candidate, 1, 1);
    if (!record || !hasExactKeys(record, ["epoch"])) {
      return malformedFromState(state);
    }
    const epoch = decodeEpoch(
      state,
      record.fields.get("epoch"),
      2,
    );
    return epoch
      ? accepted(Object.freeze({ epoch }))
      : malformedFromState(state);
  } catch {
    return malformed("invalid-shape");
  }
}

export function compareSqlCatalogEpoch(
  observedCandidate: unknown,
  receivedCandidate: unknown,
): SqlCatalogEpochComparison {
  try {
    const received = decodeEpoch(
      createDecodeState(RESPONSE_DECODE_LIMITS),
      receivedCandidate,
      1,
    );
    if (!received) {
      return Object.freeze({ kind: "malformed" });
    }
    if (observedCandidate === null) {
      return Object.freeze({ epoch: received, kind: "baseline" });
    }
    const observed = decodeEpoch(
      createDecodeState(RESPONSE_DECODE_LIMITS),
      observedCandidate,
      1,
    );
    if (!observed) {
      return Object.freeze({ kind: "malformed" });
    }
    if (received.generation < observed.generation) {
      return Object.freeze({
        kind: "stale",
        observed,
        received,
      });
    }
    if (received.generation > observed.generation) {
      return Object.freeze({
        epoch: received,
        kind: "advance",
        previous: observed,
      });
    }
    if (received.token !== observed.token) {
      return Object.freeze({
        kind: "token-conflict",
        observed,
        received,
      });
    }
    return Object.freeze({ epoch: received, kind: "equal" });
  } catch {
    return Object.freeze({ kind: "malformed" });
  }
}
