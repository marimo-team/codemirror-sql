import type { SqlCatalogEpoch } from "./relation-completion-types.js";
import type {
  SqlColumnCatalogBatchRequest,
  SqlColumnCatalogBatchResponse,
  SqlColumnCatalogColumn,
  SqlColumnCatalogRelationReference,
  SqlColumnCatalogRelationResult,
  SqlColumnCatalogResolvedColumn,
} from "./column-catalog-types.js";
import {
  isDataArray,
  type SqlIdentifierComponent,
  type SqlIdentifierPath,
} from "./types.js";

export const MAX_COLUMN_PROVIDER_ID_LENGTH = 256;
export const MAX_COLUMN_SCOPE_LENGTH = 512;
export const MAX_COLUMN_DIALECT_ID_LENGTH = 128;
export const MAX_COLUMN_EPOCH_TOKEN_LENGTH = 256;
export const MAX_COLUMN_ENTITY_ID_LENGTH = 256;
export const MAX_COLUMN_NAME_LENGTH = 256;
export const MAX_COLUMN_INSERT_TEXT_LENGTH = 1_024;
export const MAX_COLUMN_TYPE_LENGTH = 512;
export const MAX_COLUMN_DETAIL_LENGTH = 1_024;
export const MAX_COLUMN_BATCH_RELATIONS = 64;
export const MAX_COLUMN_RELATION_PATH_COMPONENTS = 32;
export const MAX_COLUMN_SEARCH_PATHS = 32;
export const MAX_COLUMN_SEARCH_PATH_COMPONENTS = 8;
export const MAX_COLUMNS_PER_RELATION = 256;
export const MAX_COLUMNS_PER_BATCH = 4_096;

const capturedColumnProviders = new WeakMap<
  object,
  {
    readonly id: string;
    readonly loadColumns: Function;
  }
>();
const capturedColumnProviderBrand: unique symbol = Symbol(
  "CapturedSqlColumnCatalogProvider",
);

export interface CapturedSqlColumnCatalogProvider {
  readonly [capturedColumnProviderBrand]:
    "CapturedSqlColumnCatalogProvider";
}

export interface SqlCapturedColumnCatalogProviderContext {
  readonly id: string;
  readonly loadColumns: (
    this: void,
    request: SqlColumnCatalogBatchRequest,
    signal: AbortSignal,
  ) => unknown;
}

export type SqlColumnBoundaryFailureReason =
  | "duplicate-column-entity-id"
  | "duplicate-request-key"
  | "invalid-shape"
  | "resource-limit"
  | "unexpected-relation";

export type SqlColumnBoundaryResult<Value> =
  | {
      readonly status: "accepted";
      readonly value: Value;
    }
  | {
      readonly reason: SqlColumnBoundaryFailureReason;
      readonly status: "malformed";
    };

interface DataRecord {
  readonly fields: ReadonlyMap<string, unknown>;
}

const FAILURE_CODES = new Set([
  "authentication",
  "authorization",
  "invalid-configuration",
  "rate-limited",
  "unavailable",
  "unknown",
]);
const RETRY_POLICIES = new Set([
  "after-invalidation",
  "never",
  "next-request",
]);

type FailureCode = Extract<
  SqlColumnCatalogRelationResult,
  { readonly status: "failed" }
>["code"];
type RetryPolicy = Extract<
  SqlColumnCatalogRelationResult,
  { readonly status: "failed" }
>["retry"];

function isFailureCode(value: unknown): value is FailureCode {
  return typeof value === "string" && FAILURE_CODES.has(value);
}

function isRetryPolicy(value: unknown): value is RetryPolicy {
  return typeof value === "string" && RETRY_POLICIES.has(value);
}

function accepted<Value>(
  value: Value,
): SqlColumnBoundaryResult<Value> {
  return Object.freeze({ status: "accepted", value });
}

function malformed<Value>(
  reason: SqlColumnBoundaryFailureReason,
): SqlColumnBoundaryResult<Value> {
  return Object.freeze({ reason, status: "malformed" });
}

function readRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
): DataRecord | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  const fields = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== "string" || !allowedKeys.has(key)) return null;
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

function required(record: DataRecord, key: string): unknown {
  return record.fields.has(key) ? record.fields.get(key) : undefined;
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" &&
      value.length > 0 &&
      value.length <= maximum
    ? value
    : null;
}

function optionalBoundedString(
  value: unknown,
  maximum: number,
): string | undefined | null {
  return value === undefined
    ? undefined
    : boundedString(value, maximum);
}

function decodeEpoch(value: unknown): SqlCatalogEpoch | null {
  const record = readRecord(
    value,
    new Set(["generation", "token"]),
  );
  if (!record) return null;
  const generation = required(record, "generation");
  const token = boundedString(
    required(record, "token"),
    MAX_COLUMN_EPOCH_TOKEN_LENGTH,
  );
  if (
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    token === null
  ) {
    return null;
  }
  return Object.freeze({ generation, token });
}

function decodeExpectedEpoch(
  value: unknown,
): SqlCatalogEpoch | null | undefined {
  return value === null ? null : decodeEpoch(value) ?? undefined;
}

function readArrayElement(
  values: readonly unknown[],
  index: number,
): { readonly found: true; readonly value: unknown } | null {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(values, index);
  } catch {
    return null;
  }
  return descriptor && "value" in descriptor
    ? { found: true, value: descriptor.value }
    : null;
}

function readArrayLength(value: unknown, maximum: number): number | null {
  if (!isDataArray(value)) return null;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    return null;
  }
  if (
    !descriptor ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "number" ||
    !Number.isSafeInteger(descriptor.value) ||
    descriptor.value < 0 ||
    descriptor.value > maximum
  ) {
    return null;
  }
  return descriptor.value;
}

function decodeIdentifierPath(
  value: unknown,
  maximumComponents: number,
): SqlIdentifierPath | null {
  const length = readArrayLength(value, maximumComponents);
  if (length === null || length === 0 || !Array.isArray(value)) return null;
  const output: SqlIdentifierComponent[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = readArrayElement(value, index);
    if (!item) return null;
    const record = readRecord(
      item.value,
      new Set(["quoted", "value"]),
    );
    if (!record) return null;
    const identifier = boundedString(
      required(record, "value"),
      MAX_COLUMN_NAME_LENGTH,
    );
    const quoted = required(record, "quoted");
    if (identifier === null || typeof quoted !== "boolean") return null;
    output.push(Object.freeze({ quoted, value: identifier }));
  }
  return Object.freeze(output);
}

function decodeSearchPaths(value: unknown): readonly SqlIdentifierPath[] | null {
  const length = readArrayLength(value, MAX_COLUMN_SEARCH_PATHS);
  if (length === null || !Array.isArray(value)) return null;
  const paths: SqlIdentifierPath[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = readArrayElement(value, index);
    if (!item) return null;
    const path = decodeIdentifierPath(
      item.value,
      MAX_COLUMN_SEARCH_PATH_COMPONENTS,
    );
    if (!path) return null;
    paths.push(path);
  }
  return Object.freeze(paths);
}

function decodeRelationReference(
  value: unknown,
): SqlColumnCatalogRelationReference | null {
  const record = readRecord(
    value,
    new Set(["path", "requestKey"]),
  );
  if (!record) return null;
  const requestKey = boundedString(
    required(record, "requestKey"),
    MAX_COLUMN_ENTITY_ID_LENGTH,
  );
  const path = decodeIdentifierPath(
    required(record, "path"),
    MAX_COLUMN_RELATION_PATH_COMPONENTS,
  );
  if (requestKey === null || !path) return null;
  return Object.freeze({
    path,
    requestKey,
  });
}

function sameEpoch(left: SqlCatalogEpoch, right: SqlCatalogEpoch): boolean {
  return left.generation === right.generation && left.token === right.token;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function captureSqlColumnCatalogProvider(
  provider: unknown,
): SqlColumnBoundaryResult<CapturedSqlColumnCatalogProvider> {
  const record = readRecord(provider, new Set(["id", "loadColumns"]));
  if (!record) return malformed("invalid-shape");
  const id = boundedString(
    required(record, "id"),
    MAX_COLUMN_PROVIDER_ID_LENGTH,
  );
  const loadColumns = required(record, "loadColumns");
  if (id === null || typeof loadColumns !== "function") {
    return malformed("invalid-shape");
  }
  const capturedValue: CapturedSqlColumnCatalogProvider = {
    [capturedColumnProviderBrand]: "CapturedSqlColumnCatalogProvider",
  };
  const captured = Object.freeze(capturedValue);
  capturedColumnProviders.set(captured, { id, loadColumns });
  return accepted(captured);
}

export function resolveSqlColumnCatalogProvider(
  provider: unknown,
): SqlCapturedColumnCatalogProviderContext | null {
  if (provider === null || typeof provider !== "object") return null;
  const captured = capturedColumnProviders.get(provider);
  if (!captured) return null;
  return Object.freeze({
    id: captured.id,
    loadColumns: (
      request: SqlColumnCatalogBatchRequest,
      signal: AbortSignal,
    ): unknown =>
      Reflect.apply(
        captured.loadColumns,
        undefined,
        [request, signal],
      ),
  });
}

export function createSqlColumnCatalogBatchRequest(
  input: unknown,
): SqlColumnBoundaryResult<SqlColumnCatalogBatchRequest> {
  const record = readRecord(
    input,
    new Set([
      "dialectId",
      "expectedEpoch",
      "relations",
      "scope",
      "searchPaths",
    ]),
  );
  if (!record) return malformed("invalid-shape");
  const scope = boundedString(
    required(record, "scope"),
    MAX_COLUMN_SCOPE_LENGTH,
  );
  const dialectId = boundedString(
    required(record, "dialectId"),
    MAX_COLUMN_DIALECT_ID_LENGTH,
  );
  const expectedEpoch = decodeExpectedEpoch(
    required(record, "expectedEpoch"),
  );
  const relationsValue = required(record, "relations");
  const searchPaths = decodeSearchPaths(required(record, "searchPaths"));
  const relationCount = readArrayLength(
    relationsValue,
    MAX_COLUMN_BATCH_RELATIONS,
  );
  if (
    scope === null ||
    dialectId === null ||
    expectedEpoch === undefined ||
    relationCount === null ||
    !Array.isArray(relationsValue) ||
    searchPaths === null
  ) {
    return malformed("invalid-shape");
  }
  const keys = new Set<string>();
  const relations: SqlColumnCatalogRelationReference[] = [];
  for (let index = 0; index < relationCount; index += 1) {
    const item = readArrayElement(relationsValue, index);
    if (!item) return malformed("invalid-shape");
    const reference = decodeRelationReference(item.value);
    if (!reference) return malformed("invalid-shape");
    if (keys.has(reference.requestKey)) {
      return malformed("duplicate-request-key");
    }
    keys.add(reference.requestKey);
    relations.push(reference);
  }
  if (relations.length === 0) return malformed("invalid-shape");
  relations.sort((left, right) =>
    compareText(left.requestKey, right.requestKey)
  );
  return accepted(Object.freeze({
    dialectId,
    expectedEpoch,
    relations: Object.freeze(relations),
    searchPaths,
    scope,
  }));
}

function decodeColumn(
  value: unknown,
  providerId: string,
  request: SqlColumnCatalogBatchRequest,
  epoch: SqlCatalogEpoch,
  relationEntityId: string,
): SqlColumnCatalogResolvedColumn | null {
  const record = readRecord(
    value,
    new Set([
      "columnEntityId",
      "dataType",
      "detail",
      "identifier",
      "insertText",
      "ordinal",
    ]),
  );
  if (!record) return null;
  const columnEntityId = boundedString(
    required(record, "columnEntityId"),
    MAX_COLUMN_ENTITY_ID_LENGTH,
  );
  const identifierRecord = readRecord(
    required(record, "identifier"),
    new Set(["quoted", "value"]),
  );
  const identifierValue = identifierRecord
    ? boundedString(
        required(identifierRecord, "value"),
        MAX_COLUMN_NAME_LENGTH,
      )
    : null;
  const quoted = identifierRecord
    ? required(identifierRecord, "quoted")
    : null;
  const insertText = boundedString(
    required(record, "insertText"),
    MAX_COLUMN_INSERT_TEXT_LENGTH,
  );
  const ordinal = required(record, "ordinal");
  const dataType = optionalBoundedString(
    required(record, "dataType"),
    MAX_COLUMN_TYPE_LENGTH,
  );
  const detail = optionalBoundedString(
    required(record, "detail"),
    MAX_COLUMN_DETAIL_LENGTH,
  );
  if (
    columnEntityId === null ||
    identifierValue === null ||
    typeof quoted !== "boolean" ||
    insertText === null ||
    dataType === null ||
    detail === null ||
    typeof ordinal !== "number" ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0
  ) {
    return null;
  }
  const column: SqlColumnCatalogColumn = {
    columnEntityId,
    identifier: Object.freeze({
      quoted,
      value: identifierValue,
    }),
    insertText,
    ordinal,
    ...(dataType === undefined ? {} : { dataType }),
    ...(detail === undefined ? {} : { detail }),
  };
  return Object.freeze({
    ...column,
    provenance: Object.freeze({
      columnEntityId,
      epoch,
      providerId,
      relationEntityId,
      scope: request.scope,
    }),
  });
}

function sameColumn(
  left: SqlColumnCatalogResolvedColumn,
  right: SqlColumnCatalogResolvedColumn,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function decodeReadyRelation(
  record: DataRecord,
  providerId: string,
  request: SqlColumnCatalogBatchRequest,
  epoch: SqlCatalogEpoch,
  requestKey: string,
  relationEntityId: string,
): SqlColumnBoundaryResult<SqlColumnCatalogRelationResult> {
  const coverage = required(record, "coverage");
  const columnsValue = required(record, "columns");
  const columnCount = readArrayLength(
    columnsValue,
    MAX_COLUMNS_PER_RELATION,
  );
  if (
    (coverage !== "complete" && coverage !== "partial") ||
    columnCount === null ||
    !isDataArray(columnsValue)
  ) {
    return malformed("invalid-shape");
  }
  const byId = new Map<string, SqlColumnCatalogResolvedColumn>();
  for (let index = 0; index < columnCount; index += 1) {
    const item = readArrayElement(columnsValue, index);
    if (!item) return malformed("invalid-shape");
    const column = decodeColumn(
      item.value,
      providerId,
      request,
      epoch,
      relationEntityId,
    );
    if (!column) return malformed("invalid-shape");
    const previous = byId.get(column.columnEntityId);
    if (previous && !sameColumn(previous, column)) {
      return malformed("duplicate-column-entity-id");
    }
    byId.set(column.columnEntityId, column);
  }
  const columns = [...byId.values()].sort((left, right) =>
    left.ordinal - right.ordinal ||
    compareText(left.identifier.value, right.identifier.value) ||
    compareText(left.columnEntityId, right.columnEntityId)
  );
  return accepted(Object.freeze({
    columns: Object.freeze(columns),
    coverage,
    relationEntityId,
    requestKey,
    status: "ready",
  }));
}

function decodeRelation(
  value: unknown,
  providerId: string,
  request: SqlColumnCatalogBatchRequest,
  epoch: SqlCatalogEpoch,
): SqlColumnBoundaryResult<SqlColumnCatalogRelationResult> {
  const record = readRecord(
    value,
    new Set([
      "code",
      "columns",
      "coverage",
      "relationEntityId",
      "requestKey",
      "retry",
      "status",
    ]),
  );
  if (!record) return malformed("invalid-shape");
  const requestKey = boundedString(
    required(record, "requestKey"),
    MAX_COLUMN_ENTITY_ID_LENGTH,
  );
  const status = required(record, "status");
  if (requestKey === null) return malformed("invalid-shape");
  if (status === "ready") {
    const relationEntityId = boundedString(
      required(record, "relationEntityId"),
      MAX_COLUMN_ENTITY_ID_LENGTH,
    );
    if (
      relationEntityId === null ||
      record.fields.size !== 5
    ) return malformed("invalid-shape");
    return decodeReadyRelation(
      record,
      providerId,
      request,
      epoch,
      requestKey,
      relationEntityId,
    );
  }
  if (status === "loading") {
    if (record.fields.size !== 2) return malformed("invalid-shape");
    return accepted(Object.freeze({
      requestKey,
      status,
    }));
  }
  const code = required(record, "code");
  const retry = required(record, "retry");
  if (
    status !== "failed" ||
    record.fields.size !== 4 ||
    !isFailureCode(code) ||
    !isRetryPolicy(retry)
  ) {
    return malformed("invalid-shape");
  }
  return accepted(Object.freeze({
    code,
    requestKey,
    retry,
    status,
  }));
}

export function decodeSqlColumnCatalogBatchResponse(
  provider: CapturedSqlColumnCatalogProvider,
  request: SqlColumnCatalogBatchRequest,
  value: unknown,
): SqlColumnBoundaryResult<SqlColumnCatalogBatchResponse> {
  const context = resolveSqlColumnCatalogProvider(provider);
  const record = readRecord(value, new Set(["epoch", "relations"]));
  if (!context || !record) return malformed("invalid-shape");
  const epoch = decodeEpoch(required(record, "epoch"));
  const relationsValue = required(record, "relations");
  const relationCount = readArrayLength(
    relationsValue,
    MAX_COLUMN_BATCH_RELATIONS,
  );
  if (
    epoch === null ||
    (request.expectedEpoch !== null &&
      !sameEpoch(epoch, request.expectedEpoch)) ||
    relationCount === null ||
    !Array.isArray(relationsValue)
  ) {
    return malformed("invalid-shape");
  }
  if (relationCount > request.relations.length) {
    return malformed("resource-limit");
  }
  const requested = new Set(
    request.relations.map((relation) => relation.requestKey),
  );
  const byId = new Map<string, SqlColumnCatalogRelationResult>();
  let columnCount = 0;
  for (let index = 0; index < relationCount; index += 1) {
    const item = readArrayElement(relationsValue, index);
    if (!item) return malformed("invalid-shape");
    const decoded = decodeRelation(
      item.value,
      context.id,
      request,
      epoch,
    );
    if (decoded.status === "malformed") return decoded;
    const relation = decoded.value;
    if (!requested.has(relation.requestKey)) {
      return malformed("unexpected-relation");
    }
    if (byId.has(relation.requestKey)) {
      return malformed("duplicate-request-key");
    }
    if (relation.status === "ready") {
      columnCount += relation.columns.length;
      if (columnCount > MAX_COLUMNS_PER_BATCH) {
        return malformed("resource-limit");
      }
    }
    byId.set(relation.requestKey, relation);
  }
  if (byId.size !== requested.size) return malformed("invalid-shape");
  return accepted(Object.freeze({
    epoch,
    relations: Object.freeze(
      [...byId.values()].sort((left, right) =>
        compareText(left.requestKey, right.requestKey)
      ),
    ),
  }));
}
