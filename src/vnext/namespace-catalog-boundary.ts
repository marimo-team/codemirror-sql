import type { SqlCatalogEpoch } from "./relation-completion-types.js";
import type {
  SqlCanonicalNamespacePath,
  SqlNamespaceCatalogContainer,
  SqlNamespaceCatalogResolvedContainer,
  SqlNamespaceCatalogSearchRequest,
  SqlNamespaceCatalogSearchResponse,
  SqlNamespaceContainerRole,
  SqlNamespacePathComponent,
} from "./namespace-catalog-types.js";
import {
  isDataArray,
  type SqlIdentifierComponent,
  type SqlIdentifierPath,
} from "./types.js";

export const MAX_NAMESPACE_PROVIDER_ID_LENGTH = 256;
export const MAX_NAMESPACE_SCOPE_LENGTH = 512;
export const MAX_NAMESPACE_DIALECT_ID_LENGTH = 128;
export const MAX_NAMESPACE_EPOCH_TOKEN_LENGTH = 256;
export const MAX_NAMESPACE_ENTITY_ID_LENGTH = 256;
export const MAX_NAMESPACE_IDENTIFIER_LENGTH = 256;
export const MAX_NAMESPACE_INSERT_TEXT_LENGTH = 1_024;
export const MAX_NAMESPACE_DETAIL_LENGTH = 1_024;
export const MAX_NAMESPACE_PATH_COMPONENTS = 32;
export const MAX_NAMESPACE_SEARCH_PATHS = 32;
export const MAX_NAMESPACE_SEARCH_PATH_COMPONENTS = 8;
export const MAX_NAMESPACE_RESULTS = 128;

const capturedProviderBrand: unique symbol = Symbol(
  "CapturedSqlNamespaceCatalogProvider",
);

export interface CapturedSqlNamespaceCatalogProvider {
  readonly [capturedProviderBrand]:
    "CapturedSqlNamespaceCatalogProvider";
}

export interface SqlCapturedNamespaceCatalogProviderContext {
  readonly id: string;
  readonly search: (
    this: void,
    request: SqlNamespaceCatalogSearchRequest,
    signal: AbortSignal,
  ) => unknown;
}

export type SqlNamespaceBoundaryFailureReason =
  | "duplicate-entity-id"
  | "invalid-shape"
  | "resource-limit";

export type SqlNamespaceBoundaryResult<Value> =
  | {
      readonly status: "accepted";
      readonly value: Value;
    }
  | {
      readonly reason: SqlNamespaceBoundaryFailureReason;
      readonly status: "malformed";
    };

interface DataRecord {
  readonly fields: ReadonlyMap<string, unknown>;
}

const capturedProviders = new WeakMap<
  object,
  { readonly id: string; readonly search: Function }
>();

function accepted<Value>(
  value: Value,
): SqlNamespaceBoundaryResult<Value> {
  return Object.freeze({ status: "accepted", value });
}

function malformed<Value>(
  reason: SqlNamespaceBoundaryFailureReason,
): SqlNamespaceBoundaryResult<Value> {
  return Object.freeze({ reason, status: "malformed" });
}

function record(
  value: unknown,
  allowed: ReadonlySet<string>,
): DataRecord | null {
  if (
    value === null ||
    typeof value !== "object"
  ) return null;
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  const fields = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) return null;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return null;
    }
    if (!descriptor || !("value" in descriptor)) return null;
    fields.set(key, descriptor.value);
  }
  return { fields };
}

function required(
  source: DataRecord,
  key: string,
): unknown {
  return source.fields.has(key)
    ? source.fields.get(key)
    : undefined;
}

function boundedString(
  value: unknown,
  maximum: number,
  allowEmpty = false,
): string | null {
  return typeof value === "string" &&
      value.length <= maximum &&
      (allowEmpty || value.length > 0)
    ? value
    : null;
}

function arrayLength(
  value: unknown,
  maximum: number,
): number | null {
  if (!isDataArray(value)) return null;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    return null;
  }
  const length = descriptor && "value" in descriptor
    ? descriptor.value
    : undefined;
  return typeof length === "number" &&
      Number.isSafeInteger(length) &&
      length >= 0 &&
      length <= maximum
    ? length
    : null;
}

function arrayElement(
  value: unknown,
  index: number,
): unknown | null {
  if (!isDataArray(value)) return null;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, String(index));
  } catch {
    return null;
  }
  return descriptor && "value" in descriptor
    ? descriptor.value
    : null;
}

function identifier(
  value: unknown,
  allowEmpty = false,
): SqlIdentifierComponent | null {
  const source = record(value, new Set(["quoted", "value"]));
  if (!source) return null;
  const quoted = required(source, "quoted");
  const text = boundedString(
    required(source, "value"),
    MAX_NAMESPACE_IDENTIFIER_LENGTH,
    allowEmpty,
  );
  return typeof quoted === "boolean" && text !== null
    ? Object.freeze({ quoted, value: text })
    : null;
}

function identifierPath(
  value: unknown,
  maximum: number,
): SqlIdentifierPath | null {
  const length = arrayLength(value, maximum);
  if (length === null) return null;
  const output: SqlIdentifierComponent[] = [];
  for (let index = 0; index < length; index += 1) {
    const component = identifier(arrayElement(value, index));
    if (!component) return null;
    output.push(component);
  }
  return Object.freeze(output);
}

function searchPaths(
  value: unknown,
): readonly SqlIdentifierPath[] | null {
  const length = arrayLength(value, MAX_NAMESPACE_SEARCH_PATHS);
  if (length === null) return null;
  const output: SqlIdentifierPath[] = [];
  for (let index = 0; index < length; index += 1) {
    const path = identifierPath(
      arrayElement(value, index),
      MAX_NAMESPACE_SEARCH_PATH_COMPONENTS,
    );
    if (!path) return null;
    output.push(path);
  }
  return Object.freeze(output);
}

function epoch(value: unknown): SqlCatalogEpoch | null {
  const source = record(value, new Set(["generation", "token"]));
  if (!source) return null;
  const generation = required(source, "generation");
  const token = boundedString(
    required(source, "token"),
    MAX_NAMESPACE_EPOCH_TOKEN_LENGTH,
  );
  return typeof generation === "number" &&
      Number.isSafeInteger(generation) &&
      generation >= 0 &&
      token !== null
    ? Object.freeze({ generation, token })
    : null;
}

function sameEpoch(
  left: SqlCatalogEpoch,
  right: SqlCatalogEpoch,
): boolean {
  return left.generation === right.generation &&
    left.token === right.token;
}

function role(value: unknown): SqlNamespaceContainerRole | null {
  return value === "catalog" ||
      value === "schema" ||
      value === "project" ||
      value === "dataset"
    ? value
    : null;
}

function namespacePath(
  value: unknown,
): SqlCanonicalNamespacePath | null {
  const length = arrayLength(value, MAX_NAMESPACE_PATH_COMPONENTS);
  if (length === null || length === 0) return null;
  const output: SqlNamespacePathComponent[] = [];
  for (let index = 0; index < length; index += 1) {
    const source = record(
      arrayElement(value, index),
      new Set(["quoted", "role", "value"]),
    );
    if (!source) return null;
    const componentRole = role(required(source, "role"));
    const component = identifier({
      quoted: required(source, "quoted"),
      value: required(source, "value"),
    });
    if (!componentRole || !component) return null;
    output.push(Object.freeze({ ...component, role: componentRole }));
  }
  const first = output[0];
  if (!first) return null;
  return Object.freeze([first, ...output.slice(1)]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePath(
  left: SqlCanonicalNamespacePath,
  right: SqlCanonicalNamespacePath,
): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftComponent = left[index];
    const rightComponent = right[index];
    if (!leftComponent || !rightComponent) continue;
    const compared =
      compareText(leftComponent.role, rightComponent.role) ||
      Number(rightComponent.quoted) - Number(leftComponent.quoted) ||
      compareText(leftComponent.value, rightComponent.value);
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

function sameContainer(
  left: SqlNamespaceCatalogContainer,
  right: SqlNamespaceCatalogContainer,
): boolean {
  return left.containerEntityId === right.containerEntityId &&
    left.detail === right.detail &&
    left.insertText === right.insertText &&
    left.matchQuality === right.matchQuality &&
    comparePath(left.canonicalPath, right.canonicalPath) === 0;
}

export function captureSqlNamespaceCatalogProvider(
  value: unknown,
): SqlNamespaceBoundaryResult<CapturedSqlNamespaceCatalogProvider> {
  const source = record(value, new Set(["id", "search"]));
  const id = source
    ? boundedString(
        required(source, "id"),
        MAX_NAMESPACE_PROVIDER_ID_LENGTH,
      )
    : null;
  const search = source ? required(source, "search") : null;
  if (!source || id === null || typeof search !== "function") {
    return malformed("invalid-shape");
  }
  const capturedValue: CapturedSqlNamespaceCatalogProvider = {
    [capturedProviderBrand]: "CapturedSqlNamespaceCatalogProvider",
  };
  const captured = Object.freeze(capturedValue);
  capturedProviders.set(captured, { id, search });
  return accepted(captured);
}

export function resolveSqlNamespaceCatalogProvider(
  provider: CapturedSqlNamespaceCatalogProvider,
): SqlCapturedNamespaceCatalogProviderContext | null {
  const captured = capturedProviders.get(provider);
  return captured
    ? Object.freeze({
        id: captured.id,
        search: (
          request: SqlNamespaceCatalogSearchRequest,
          signal: AbortSignal,
        ): unknown =>
          Reflect.apply(captured.search, undefined, [request, signal]),
      })
    : null;
}

export function createSqlNamespaceCatalogSearchRequest(
  value: unknown,
): SqlNamespaceBoundaryResult<SqlNamespaceCatalogSearchRequest> {
  const source = record(
    value,
    new Set([
      "dialectId",
      "expectedEpoch",
      "limit",
      "prefix",
      "qualifier",
      "scope",
      "searchPaths",
    ]),
  );
  if (!source) return malformed("invalid-shape");
  const dialectId = boundedString(
    required(source, "dialectId"),
    MAX_NAMESPACE_DIALECT_ID_LENGTH,
  );
  const scope = boundedString(
    required(source, "scope"),
    MAX_NAMESPACE_SCOPE_LENGTH,
  );
  const expectedValue = required(source, "expectedEpoch");
  const expectedEpoch = expectedValue === null
    ? null
    : epoch(expectedValue);
  const limit = required(source, "limit");
  const prefix = identifier(required(source, "prefix"), true);
  const qualifier = identifierPath(
    required(source, "qualifier"),
    MAX_NAMESPACE_PATH_COMPONENTS,
  );
  const paths = searchPaths(required(source, "searchPaths"));
  if (
    dialectId === null ||
    scope === null ||
    expectedEpoch === null && expectedValue !== null ||
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_NAMESPACE_RESULTS ||
    !prefix ||
    !qualifier ||
    !paths
  ) {
    return malformed("invalid-shape");
  }
  return accepted(Object.freeze({
    dialectId,
    expectedEpoch,
    limit,
    prefix,
    qualifier,
    scope,
    searchPaths: paths,
  }));
}

function decodeContainer(
  value: unknown,
  providerId: string,
  scope: string,
  responseEpoch: SqlCatalogEpoch,
): SqlNamespaceCatalogResolvedContainer | null {
  const source = record(
    value,
    new Set([
      "canonicalPath",
      "containerEntityId",
      "detail",
      "insertText",
      "matchQuality",
    ]),
  );
  if (!source) return null;
  const canonicalPath = namespacePath(
    required(source, "canonicalPath"),
  );
  const containerEntityId = boundedString(
    required(source, "containerEntityId"),
    MAX_NAMESPACE_ENTITY_ID_LENGTH,
  );
  const insertText = boundedString(
    required(source, "insertText"),
    MAX_NAMESPACE_INSERT_TEXT_LENGTH,
  );
  const matchQuality = required(source, "matchQuality");
  const rawDetail = required(source, "detail");
  const detail = rawDetail === undefined
    ? undefined
    : boundedString(rawDetail, MAX_NAMESPACE_DETAIL_LENGTH, true);
  if (
    !canonicalPath ||
    containerEntityId === null ||
    insertText === null ||
    (matchQuality !== "exact" && matchQuality !== "equivalent") ||
    detail === null
  ) {
    return null;
  }
  return Object.freeze({
    canonicalPath,
    containerEntityId,
    ...(detail === undefined ? {} : { detail }),
    insertText,
    matchQuality,
    provenance: Object.freeze({
      containerEntityId,
      epoch: responseEpoch,
      providerId,
      scope,
    }),
  });
}

export function decodeSqlNamespaceCatalogSearchResponse(
  provider: CapturedSqlNamespaceCatalogProvider,
  request: SqlNamespaceCatalogSearchRequest,
  value: unknown,
): SqlNamespaceBoundaryResult<SqlNamespaceCatalogSearchResponse> {
  const context = resolveSqlNamespaceCatalogProvider(provider);
  if (!context) return malformed("invalid-shape");
  const source = record(
    value,
    new Set([
      "code",
      "containers",
      "coverage",
      "epoch",
      "retry",
      "status",
    ]),
  );
  if (!source) return malformed("invalid-shape");
  const responseEpoch = epoch(required(source, "epoch"));
  if (
    !responseEpoch ||
    request.expectedEpoch !== null &&
      !sameEpoch(request.expectedEpoch, responseEpoch)
  ) {
    return malformed("invalid-shape");
  }
  const status = required(source, "status");
  if (status === "loading") {
    if (source.fields.size !== 2) return malformed("invalid-shape");
    return accepted(Object.freeze({
      epoch: responseEpoch,
      status,
    }));
  }
  if (status === "failed") {
    const code = required(source, "code");
    const retry = required(source, "retry");
    if (
      source.fields.size !== 4 ||
      (
        code !== "authentication" &&
        code !== "authorization" &&
        code !== "invalid-configuration" &&
        code !== "rate-limited" &&
        code !== "unavailable" &&
        code !== "unknown"
      ) ||
      (
        retry !== "after-invalidation" &&
        retry !== "never" &&
        retry !== "next-request"
      )
    ) {
      return malformed("invalid-shape");
    }
    return accepted(Object.freeze({
      code,
      epoch: responseEpoch,
      retry,
      status,
    }));
  }
  const coverage = required(source, "coverage");
  const rawContainers = required(source, "containers");
  const length = arrayLength(rawContainers, request.limit);
  if (
    status !== "ready" ||
    source.fields.size !== 4 ||
    (coverage !== "complete" && coverage !== "partial") ||
    length === null
  ) {
    return malformed("invalid-shape");
  }
  const byId = new Map<
    string,
    SqlNamespaceCatalogResolvedContainer
  >();
  for (let index = 0; index < length; index += 1) {
    const container = decodeContainer(
      arrayElement(rawContainers, index),
      context.id,
      request.scope,
      responseEpoch,
    );
    if (!container) return malformed("invalid-shape");
    const prior = byId.get(container.containerEntityId);
    if (prior && !sameContainer(prior, container)) {
      return malformed("duplicate-entity-id");
    }
    byId.set(container.containerEntityId, container);
  }
  const containers = [...byId.values()].sort((left, right) =>
    (left.matchQuality === right.matchQuality
      ? 0
      : left.matchQuality === "exact"
        ? -1
        : 1) ||
    left.canonicalPath.length - right.canonicalPath.length ||
    comparePath(left.canonicalPath, right.canonicalPath) ||
    compareText(left.containerEntityId, right.containerEntityId)
  );
  return accepted(Object.freeze({
    containers: Object.freeze(containers),
    coverage,
    epoch: responseEpoch,
    status,
  }));
}
