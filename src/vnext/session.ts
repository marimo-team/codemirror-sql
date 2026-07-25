import type {
  OpenSqlDocument,
  SqlDocumentContext,
  SqlDocumentSession,
  SqlDocumentUpdate,
  SqlLanguageService,
  SqlLanguageServiceOptions,
  SqlRevision,
  SqlIdentifierPath,
  SqlTextChange,
  SqlTextRange,
} from "./types.js";
import {
  createSqlColumnCatalogBatchCoordinator,
  type SqlColumnCatalogBatchCoordinator,
  type SqlColumnCatalogBatchOwner,
  type SqlColumnCatalogBatchTicket,
} from "./column-catalog-batch-coordinator.js";
import {
  composeSqlColumnCompletion,
  prepareSqlColumnCatalogRelations,
} from "./column-completion.js";
import {
  createSqlNamespaceCatalogCoordinator,
  type SqlNamespaceCatalogCoordinator,
  type SqlNamespaceCatalogOwner,
  type SqlNamespaceCatalogSearchOutcome,
  type SqlNamespaceCatalogSearchTicket,
} from "./namespace-catalog-coordinator.js";
import {
  composeSqlNamespaceCompletion,
  prepareSqlNamespaceCatalogSearch,
  type SqlNamespaceCompletionComposition,
} from "./namespace-completion.js";
import {
  MAX_NAMESPACE_RESULTS,
} from "./namespace-catalog-boundary.js";
import {
  buildSqlStatementIndex,
  findSqlStatementSlot,
  findSqlStatementSlotsIntersecting,
  type SqlLexicalProfile,
  type SqlStatementIndex,
  type SqlStatementSlot,
  updateSqlStatementIndex,
} from "./statement-index.js";
import {
  captureSqlRelationCatalogProvider,
  MAX_CATALOG_IDENTIFIER_LENGTH,
  MAX_CATALOG_SCOPE_LENGTH,
  MAX_CATALOG_SEARCH_PATH_COMPONENTS,
  MAX_CATALOG_SEARCH_PATHS,
} from "./relation-catalog-boundary.js";
import {
  createSqlCatalogSearchWorkCoordinator,
  type SqlCatalogSearchWorkCoordinator,
  type SqlCatalogSearchWorkOwner,
  type SqlCatalogSearchWorkOutcome,
  type SqlCatalogSearchWorkTicket,
} from "./relation-catalog-search-work.js";
import {
  analyzeSqlLocalColumnSite,
  analyzeSqlLocalRelationSite,
  prepareSqlLocalRelationStatement,
  type SqlLocalRelationStatementPreparation,
  type SqlLocalRelationSiteResult,
} from "./local-relation-site.js";
import {
  composeSqlRelationCompletion,
  MAX_RELATION_COMPLETION_RESULTS,
  type SqlComposableCatalogOutcome,
} from "./relation-completion.js";
import {
  createSqlCompletionRefreshToken,
  type SqlCompletionRequest,
  type SqlCompletionRefreshToken,
  type SqlCompletionIssue,
  type SqlCompletionItem,
  type SqlCompletionList,
  type SqlDisposable,
  type SqlCompletionResult,
  type SqlCompletionTask,
  type SqlSessionChangeEvent,
} from "./relation-completion-types.js";
import {
  BIGQUERY_SQL_RELATION_DIALECT,
  DREMIO_SQL_RELATION_DIALECT,
  DUCKDB_SQL_RELATION_DIALECT,
  POSTGRESQL_SQL_RELATION_DIALECT,
  type SqlRelationDialectRuntime,
} from "./relation-dialect.js";
import {
  createIdentitySqlSource,
  createMaskedSqlSource,
  isSqlSourceError,
  mapAnalysisRangeToOriginal,
  MAX_SQL_SOURCE_LENGTH,
  normalizeSqlTextRange,
  type SqlSourceSnapshot,
} from "./source.js";
import {
  createSqlDialect,
  createSqlRevisionToken,
  type SqlDialect,
  SqlSessionError,
} from "./types.js";
import type {
  SqlStatementBoundariesIntersectingRequest,
  SqlStatementBoundariesIntersectingResult,
  SqlStatementBoundary,
  SqlStatementBoundaryAtRequest,
  SqlStatementBoundaryAtResult,
  SqlStatementLexicalEnd,
} from "./statement-boundary-types.js";

const MAX_CONTEXT_DEPTH = 100;
const MAX_CONTEXT_NODES = 10_000;
const MAX_CONTEXT_PROPERTIES = 50_000;
const MAX_CONTEXT_KEY_LENGTH = 1_000_000;
const MAX_CONTEXT_STRING_LENGTH = 1_000_000;
const MAX_CONTEXT_ARRAY_LENGTH = 50_000;
const MAX_CHANGES_PER_UPDATE = 10_000;
const MAX_DIALECTS = 1_000;
const DEFAULT_CATALOG_RESPONSE_BUDGET_MS = 40;
const MAX_CATALOG_RESPONSE_BUDGET_MS = 50;
const TERMINAL_LOADING_INTENT_LEASE_MS = 1_000;

interface ResolvedCatalogContext {
  readonly scope: string;
  readonly searchPaths: readonly SqlIdentifierPath[];
}

interface CompletionRequestState {
  cancelReason: "caller" | "disposed" | "superseded" | null;
  readonly revision: SqlRevision;
  ticket:
    | SqlCatalogSearchWorkTicket
    | SqlColumnCatalogBatchTicket
    | SqlNamespaceCatalogSearchTicket
    | null;
  readonly token: SqlCompletionRefreshToken;
}

type ServiceChange =
  | {
      readonly reason: "catalog-availability";
      readonly expected: CompletionRequestState;
    }
  | {
      readonly reason: "catalog";
    };

interface SessionChangeSubscription {
  active: boolean;
  readonly listener: (event: SqlSessionChangeEvent) => void;
}

interface SessionTimerCell {
  active: boolean;
  handle: ReturnType<typeof setTimeout> | undefined;
}

interface TerminalRefreshIntent {
  readonly timer: SessionTimerCell;
  readonly token: SqlCompletionRefreshToken;
}

interface CompletionConfiguration {
  readonly catalogResponseBudgetMs: number;
}

interface SqlDialectRuntime {
  readonly dialect: SqlDialect;
  readonly lexicalProfile: SqlLexicalProfile;
  readonly relationDialect: SqlRelationDialectRuntime;
}

const sqlDialectRuntimes = new WeakMap<object, SqlDialectRuntime>();

function createBuiltinSqlDialect(
  id: string,
  displayName: string,
  relationDialect: SqlRelationDialectRuntime,
): SqlDialect {
  if (
    relationDialect.querySite.lexicalProfile !==
      relationDialect.cteLayout.lexicalProfile
  ) {
    throw new Error("Built-in SQL dialect lexical profiles must match");
  }
  const dialect = createSqlDialect(id, displayName);
  sqlDialectRuntimes.set(
    dialect,
    Object.freeze({
      dialect,
      lexicalProfile: relationDialect.querySite.lexicalProfile,
      relationDialect,
    }),
  );
  return dialect;
}

const BIGQUERY_DIALECT = createBuiltinSqlDialect(
  "bigquery",
  "BigQuery",
  BIGQUERY_SQL_RELATION_DIALECT,
);
const DREMIO_DIALECT = createBuiltinSqlDialect(
  "dremio",
  "Dremio",
  DREMIO_SQL_RELATION_DIALECT,
);
const DUCKDB_DIALECT = createBuiltinSqlDialect(
  "duckdb",
  "DuckDB",
  DUCKDB_SQL_RELATION_DIALECT,
);
const POSTGRES_DIALECT = createBuiltinSqlDialect(
  "postgresql",
  "PostgreSQL",
  POSTGRESQL_SQL_RELATION_DIALECT,
);

/** Returns the package-owned BigQuery dialect handle. */
export function bigQueryDialect(): SqlDialect {
  return BIGQUERY_DIALECT;
}

/** Returns the package-owned Dremio dialect handle. */
export function dremioDialect(): SqlDialect {
  return DREMIO_DIALECT;
}

/** Returns the package-owned DuckDB dialect handle. */
export function duckdbDialect(): SqlDialect {
  return DUCKDB_DIALECT;
}

/** Returns the package-owned PostgreSQL dialect handle. */
export function postgresDialect(): SqlDialect {
  return POSTGRES_DIALECT;
}

function getSqlDialectRuntime(candidate: unknown): SqlDialectRuntime | null {
  if (typeof candidate !== "object" || candidate === null) {
    return null;
  }
  return sqlDialectRuntimes.get(candidate) ?? null;
}

export function getSqlRelationDialectRuntime(
  candidate: unknown,
): SqlRelationDialectRuntime | null {
  return getSqlDialectRuntime(candidate)?.relationDialect ?? null;
}

interface PendingContextValue {
  readonly depth: number;
  readonly value: unknown;
}

interface DataProperties {
  readonly keyLength: number;
  readonly values: readonly unknown[];
}

function getDataProperties(value: object): DataProperties {
  const values: unknown[] = [];
  const isArray = Array.isArray(value);
  const arrayLength = isArray
    ? readArrayLength(value, "invalid-context", "SQL document context array")
    : undefined;
  if (arrayLength !== undefined && arrayLength > MAX_CONTEXT_ARRAY_LENGTH) {
    throw new SqlSessionError(
      "invalid-context",
      "SQL document context arrays are too large",
    );
  }
  let keyLength = 0;
  for (const key of Reflect.ownKeys(value)) {
    if (isArray && key === "length") {
      continue;
    }
    if (typeof key !== "string") {
      throw new SqlSessionError(
        "invalid-context",
        "SQL document context cannot contain symbol keys",
      );
    }
    keyLength += key.length;
    if (
      arrayLength !== undefined &&
      (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= arrayLength)
    ) {
      throw new SqlSessionError(
        "invalid-context",
        "SQL document context arrays cannot contain custom properties",
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new SqlSessionError(
        "invalid-context",
        "SQL document context cannot contain accessors",
      );
    }
    if (!descriptor.enumerable) {
      throw new SqlSessionError(
        "invalid-context",
        "SQL document context cannot contain non-enumerable properties",
      );
    }
    values.push(descriptor.value);
  }
  return { keyLength, values };
}

function validatePlainData(root: unknown): void {
  const pending: PendingContextValue[] = [{ depth: 0, value: root }];
  const seen = new WeakSet<object>();
  let nodeCount = 0;
  let propertyCount = 0;
  let keyLength = 0;
  let stringLength = 0;

  for (const current of pending) {
    const value = current.value;
    if (
      value === null ||
      value === undefined ||
      typeof value === "boolean" ||
      typeof value === "bigint"
    ) {
      continue;
    }
    if (typeof value === "string") {
      stringLength += value.length;
      if (stringLength > MAX_CONTEXT_STRING_LENGTH) {
        throw new SqlSessionError(
          "invalid-context",
          "SQL document context contains too much string data",
        );
      }
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new SqlSessionError(
          "invalid-context",
          "SQL document context numbers must be finite",
        );
      }
      continue;
    }
    if (typeof value !== "object") {
      throw new SqlSessionError(
        "invalid-context",
        "SQL document context must contain only plain data",
      );
    }
    if (current.depth > MAX_CONTEXT_DEPTH) {
      throw new SqlSessionError(
        "invalid-context",
        "SQL document context is too deeply nested",
      );
    }
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    nodeCount += 1;
    if (nodeCount > MAX_CONTEXT_NODES) {
      throw new SqlSessionError(
        "invalid-context",
        "SQL document context contains too many objects",
      );
    }

    if (!Array.isArray(value)) {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new SqlSessionError(
          "invalid-context",
          "SQL document context must contain only plain objects",
        );
      }
    }

    const properties = getDataProperties(value);
    keyLength += properties.keyLength;
    if (keyLength > MAX_CONTEXT_KEY_LENGTH) {
      throw new SqlSessionError(
        "invalid-context",
        "SQL document context contains too much property-name data",
      );
    }
    propertyCount += properties.values.length;
    if (propertyCount > MAX_CONTEXT_PROPERTIES) {
      throw new SqlSessionError(
        "invalid-context",
        "SQL document context contains too many properties",
      );
    }
    for (const property of properties.values) {
      pending.push({ depth: current.depth + 1, value: property });
    }
  }
}

function deepFreeze<T extends object>(root: T): T {
  const pending: object[] = [root];
  const seen = new WeakSet<object>();
  for (const value of pending) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    for (const property of getDataProperties(value).values) {
      if (property !== null && typeof property === "object") {
        pending.push(property);
      }
    }
    Object.freeze(value);
  }
  return root;
}

function cloneContext<Context extends SqlDocumentContext>(context: Context): Context {
  try {
    if (
      context === null ||
      typeof context !== "object" ||
      Array.isArray(context)
    ) {
      throw new SqlSessionError(
        "invalid-context",
        "SQL document context must be a plain object",
      );
    }
    validatePlainData(context);
    const clone = structuredClone(context);
    validatePlainData(clone);
    return deepFreeze(clone);
  } catch (error) {
    if (error instanceof SqlSessionError) {
      throw error;
    }
    throw new SqlSessionError(
      "invalid-context",
      "SQL document context must be structured-cloneable plain data",
    );
  }
}

function resolveDialectRuntime(
  context: SqlDocumentContext,
  dialects: ReadonlyMap<string, SqlDialectRuntime>,
): SqlDialectRuntime {
  const dialect = readRequiredDataProperty(
    context,
    "dialect",
    "invalid-dialect",
    "SQL document context",
  );
  const runtime =
    typeof dialect === "string" ? dialects.get(dialect) : undefined;
  if (!runtime) {
    throw new SqlSessionError(
      "invalid-dialect",
      typeof dialect === "string"
        ? `Unknown SQL dialect: ${dialect}`
        : "SQL document context dialect must be a string",
    );
  }
  return runtime;
}

function resolveCatalogContext(
  context: SqlDocumentContext,
): ResolvedCatalogContext | null {
  const catalog = context.catalog;
  if (!catalog) return null;
  if (
    typeof catalog !== "object" ||
    typeof catalog.scope !== "string" ||
    catalog.scope.length === 0 ||
    catalog.scope.length > MAX_CATALOG_SCOPE_LENGTH
  ) {
    throw new SqlSessionError(
      "invalid-context",
      "SQL catalog context has an invalid scope",
    );
  }
  const candidatePaths = catalog.searchPath ?? [];
  if (
    !Array.isArray(candidatePaths) ||
    candidatePaths.length > MAX_CATALOG_SEARCH_PATHS
  ) {
    throw new SqlSessionError(
      "invalid-context",
      "SQL catalog search paths are invalid",
    );
  }
  for (const path of candidatePaths) {
    if (
      !Array.isArray(path) ||
      path.length === 0 ||
      path.length > MAX_CATALOG_SEARCH_PATH_COMPONENTS
    ) {
      throw new SqlSessionError(
        "invalid-context",
        "SQL catalog search path is invalid",
      );
    }
    for (const component of path) {
      if (
        !component ||
        typeof component !== "object" ||
        typeof component.value !== "string" ||
        component.value.length === 0 ||
        component.value.length > MAX_CATALOG_IDENTIFIER_LENGTH ||
        typeof component.quoted !== "boolean"
      ) {
        throw new SqlSessionError(
          "invalid-context",
          "SQL catalog search path component is invalid",
        );
      }
    }
  }
  return Object.freeze({
    scope: catalog.scope,
    searchPaths: candidatePaths,
  });
}

function unavailableCompletionReason(
  local: Exclude<SqlLocalRelationSiteResult, { status: "ready" }>,
): "inactive" | "unsupported-query-site" | "opaque-statement" |
  "ambiguous-query-site" | "resource-limit" {
  if (local.status === "inactive") return "inactive";
  switch (local.reason) {
    case "opaque-statement":
      return "opaque-statement";
    case "resource-limit":
      return "resource-limit";
    case "unsupported-query-site":
      return "unsupported-query-site";
    case "ambiguous-query-site":
      return "ambiguous-query-site";
  }
}

function completionCancellation(
  revision: SqlRevision,
  reason: "caller" | "disposed" | "superseded",
): SqlCompletionResult {
  return Object.freeze({ reason, revision, status: "cancelled" });
}

function completionCancellationReason(
  request: CompletionRequestState,
): "caller" | "disposed" | "superseded" {
  return request.cancelReason ?? "superseded";
}

function namespaceCompletionList(
  composition: SqlNamespaceCompletionComposition,
): SqlCompletionList {
  const items: readonly SqlCompletionItem[] =
    composition.value.items.map((item) =>
      Object.freeze({
        ...(item.detail === undefined ? {} : { detail: item.detail }),
        edit: item.edit,
        kind: "namespace" as const,
        label: item.label,
        provenance: item.provenance,
        role: item.role,
      })
    );
  const issues: readonly SqlCompletionIssue[] =
    composition.value.issues.map((reason) =>
      Object.freeze({ reason })
    );
  const first = issues[0];
  if (first === undefined) {
    return Object.freeze({
      isIncomplete: false,
      issues: Object.freeze([] as const),
      items: Object.freeze(items),
    });
  }
  const incompleteIssues: [
    SqlCompletionIssue,
    ...SqlCompletionIssue[],
  ] = [first, ...issues.slice(1)];
  return Object.freeze({
    isIncomplete: true,
    issues: Object.freeze(incompleteIssues),
    items: Object.freeze(items),
  });
}

function mergeCompletionLists(
  left: SqlCompletionList,
  right: SqlCompletionList,
): SqlCompletionList {
  const items = Object.freeze([...left.items, ...right.items]);
  const issues = Object.freeze([...left.issues, ...right.issues]);
  const first = issues[0];
  if (first === undefined) {
    return Object.freeze({
      isIncomplete: false,
      issues: Object.freeze([] as const),
      items,
    });
  }
  const incompleteIssues: [
    SqlCompletionIssue,
    ...SqlCompletionIssue[],
  ] = [first, ...issues.slice(1)];
  return Object.freeze({
    isIncomplete: true,
    issues: Object.freeze(incompleteIssues),
    items,
  });
}

interface MissingDataProperty {
  readonly found: false;
}

interface FoundDataProperty<Value> {
  readonly found: true;
  readonly value: Value;
}

type DataProperty<Value> = MissingDataProperty | FoundDataProperty<Value>;

function readOwnDataProperty<Value extends object, Key extends keyof Value>(
  value: Value,
  key: Key,
  code: SqlSessionError["code"],
  subject: string,
): DataProperty<Value[Key]>;
function readOwnDataProperty(
  value: object,
  key: PropertyKey,
  code: SqlSessionError["code"],
  subject: string,
): DataProperty<unknown>;
function readOwnDataProperty(
  value: object,
  key: PropertyKey,
  code: SqlSessionError["code"],
  subject: string,
): DataProperty<unknown> {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) {
    return { found: false };
  }
  if (!("value" in descriptor)) {
    throw new SqlSessionError(
      code,
      `${subject} property ${String(key)} cannot be an accessor`,
    );
  }
  return { found: true, value: descriptor.value };
}

function readRequiredDataProperty<Value extends object, Key extends keyof Value>(
  value: Value,
  key: Key,
  code: SqlSessionError["code"],
  subject: string,
): Value[Key];
function readRequiredDataProperty(
  value: object,
  key: PropertyKey,
  code: SqlSessionError["code"],
  subject: string,
): unknown;
function readRequiredDataProperty(
  value: object,
  key: PropertyKey,
  code: SqlSessionError["code"],
  subject: string,
): unknown {
  const property = readOwnDataProperty(value, key, code, subject);
  if (!property.found) {
    throw new SqlSessionError(
      code,
      `${subject} requires a data property named ${String(key)}`,
    );
  }
  return property.value;
}

function rejectOwnProperty(
  value: object,
  key: PropertyKey,
  code: SqlSessionError["code"],
  subject: string,
): void {
  if (readOwnDataProperty(value, key, code, subject).found) {
    throw new SqlSessionError(
      code,
      `${subject} cannot contain ${String(key)}`,
    );
  }
}

function validateDocumentLength(text: string): void {
  if (text.length > MAX_SQL_SOURCE_LENGTH) {
    throw new SqlSessionError(
      "invalid-document",
      `SQL documents cannot exceed ${MAX_SQL_SOURCE_LENGTH} UTF-16 code units`,
    );
  }
}

function readArrayLength(
  value: readonly unknown[],
  code: SqlSessionError["code"],
  subject: string,
): number {
  const length = readRequiredDataProperty(value, "length", code, subject);
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
    throw new SqlSessionError(code, `${subject} has an invalid length`);
  }
  return length;
}

function normalizeChanges(text: string, changes: readonly unknown[]): SqlTextChange[] {
  const changeCount = readArrayLength(
    changes,
    "invalid-change",
    "SQL document changes",
  );
  if (changeCount > MAX_CHANGES_PER_UPDATE) {
    throw new SqlSessionError(
      "invalid-change",
      `SQL document updates cannot contain more than ${MAX_CHANGES_PER_UPDATE} changes`,
    );
  }
  const normalized: SqlTextChange[] = [];
  let previousEnd = 0;
  let nextLength = text.length;

  for (let index = 0; index < changeCount; index += 1) {
    const change = readRequiredDataProperty(
      changes,
      index,
      "invalid-change",
      "SQL document changes",
    );
    if (change === null || typeof change !== "object") {
      throw new SqlSessionError(
        "invalid-change",
        `SQL change ${index} must be an object`,
      );
    }
    let range: SqlTextRange;
    try {
      range = normalizeSqlTextRange(
        change,
        text.length,
        `SQL change ${index}`,
      );
    } catch (error) {
      if (!isSqlSourceError(error)) {
        throw error;
      }
      throw new SqlSessionError(
        "invalid-change",
        `Invalid UTF-16 range in SQL change ${index}`,
      );
    }
    const insert = readRequiredDataProperty(
      change,
      "insert",
      "invalid-change",
      `SQL change ${index}`,
    );
    if (range.from < previousEnd) {
      throw new SqlSessionError(
        "invalid-change",
        "SQL document changes must be ordered and non-overlapping",
      );
    }
    if (typeof insert !== "string") {
      throw new SqlSessionError("invalid-change", "SQL change insert must be a string");
    }
    nextLength += insert.length - (range.to - range.from);
    if (nextLength > MAX_SQL_SOURCE_LENGTH) {
      throw new SqlSessionError(
        "invalid-document",
        `SQL documents cannot exceed ${MAX_SQL_SOURCE_LENGTH} UTF-16 code units`,
      );
    }
    normalized.push(
      Object.freeze({
        from: range.from,
        insert,
        to: range.to,
      }),
    );
    previousEnd = range.to;
  }

  return normalized;
}

function applyChanges(text: string, changes: readonly SqlTextChange[]): string {
  let cursor = 0;
  const output: string[] = [];
  for (const change of changes) {
    output.push(text.slice(cursor, change.from), change.insert);
    cursor = change.to;
  }
  output.push(text.slice(cursor));
  return output.join("");
}

function haveEqualEmbeddedRegions(
  left: SqlSourceSnapshot,
  right: SqlSourceSnapshot,
): boolean {
  if (left.embeddedRegions.length !== right.embeddedRegions.length) {
    return false;
  }
  for (let index = 0; index < left.embeddedRegions.length; index += 1) {
    const leftRegion = left.embeddedRegions[index];
    const rightRegion = right.embeddedRegions[index];
    if (
      !leftRegion ||
      !rightRegion ||
      leftRegion.from !== rightRegion.from ||
      leftRegion.to !== rightRegion.to ||
      leftRegion.language !== rightRegion.language
    ) {
      return false;
    }
  }
  return true;
}

interface SessionSnapshot<Context extends SqlDocumentContext> {
  readonly contextSequence: number;
  readonly context: Context;
  readonly dialect: SqlDialectRuntime;
  readonly documentSequence: number;
  readonly revision: SqlRevision;
  readonly sequence: number;
  readonly source: SqlSourceSnapshot;
  readonly sourceSequence: number;
}

interface StatementIndexCache {
  readonly index: SqlStatementIndex;
  readonly lexicalProfile: SqlLexicalProfile;
  readonly sourceSequence: number;
}

interface LocalRelationStatementCache {
  readonly dialect: SqlRelationDialectRuntime;
  readonly index: SqlStatementIndex;
  readonly preparation: SqlLocalRelationStatementPreparation;
  readonly slot: SqlStatementSlot;
  readonly sourceSequence: number;
}

function createCompletionTask(
  refreshToken: SqlCompletionRefreshToken,
  result: Promise<SqlCompletionResult>,
): SqlCompletionTask {
  return Object.freeze(Object.assign(result, { refreshToken }));
}

function invalidStatementBoundaryRequest(message: string): never {
  throw new SqlSessionError(
    "invalid-statement-boundary-request",
    message,
  );
}

function statementBoundaryRequest(
  request: unknown,
): SqlStatementBoundaryAtRequest {
  if (request === null || typeof request !== "object") {
    return invalidStatementBoundaryRequest(
      "SQL statement boundary request must be an object",
    );
  }
  let affinity: unknown;
  let position: unknown;
  try {
    affinity = readRequiredDataProperty(
      request,
      "affinity",
      "invalid-statement-boundary-request",
      "SQL statement boundary request",
    );
    position = readRequiredDataProperty(
      request,
      "position",
      "invalid-statement-boundary-request",
      "SQL statement boundary request",
    );
  } catch {
    return invalidStatementBoundaryRequest(
      "SQL statement boundary request requires own data properties",
    );
  }
  if (affinity !== "left" && affinity !== "right") {
    return invalidStatementBoundaryRequest(
      "SQL statement affinity must be left or right",
    );
  }
  if (
    typeof position !== "number" ||
    !Number.isSafeInteger(position) ||
    position < 0
  ) {
    return invalidStatementBoundaryRequest(
      "SQL statement position must be a non-negative safe integer",
    );
  }
  return Object.freeze({
    affinity,
    position,
  });
}

function statementIntersectionRequest(
  request: unknown,
): SqlStatementBoundariesIntersectingRequest {
  if (request === null || typeof request !== "object") {
    return invalidStatementBoundaryRequest(
      "SQL statement intersection request must be an object",
    );
  }
  let from: unknown;
  let to: unknown;
  try {
    from = readRequiredDataProperty(
      request,
      "from",
      "invalid-statement-boundary-request",
      "SQL statement intersection request",
    );
    to = readRequiredDataProperty(
      request,
      "to",
      "invalid-statement-boundary-request",
      "SQL statement intersection request",
    );
  } catch {
    return invalidStatementBoundaryRequest(
      "SQL statement intersection request requires own data properties",
    );
  }
  if (
    typeof from !== "number" ||
    typeof to !== "number" ||
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to < from
  ) {
    return invalidStatementBoundaryRequest(
      "SQL statement intersection range must be ordered safe integers",
    );
  }
  return Object.freeze({ from, to });
}

function statementRange(
  source: SqlSourceSnapshot,
  range: SqlTextRange,
): SqlTextRange {
  return mapAnalysisRangeToOriginal(source, range);
}

function statementBoundary(
  source: SqlSourceSnapshot,
  slot: SqlStatementSlot,
): SqlStatementBoundary {
  const extent = statementRange(source, slot.extent);
  if (slot.boundaryQuality === "opaque") {
    return Object.freeze({
      boundaryQuality: "opaque",
      extent,
      reason: slot.endState.reason,
    });
  }
  const endState: SqlStatementLexicalEnd =
    slot.endState.kind === "normal"
      ? Object.freeze({ kind: "normal" })
      : Object.freeze({
          construct: slot.endState.construct,
          from: statementRange(source, {
            from: slot.endState.from,
            to: slot.endState.from,
          }).from,
          kind: "unterminated",
        });
  const base = {
    boundaryQuality: "exact",
    endState,
    extent,
    source: statementRange(source, slot.source),
    terminator: slot.terminator === null
      ? null
      : statementRange(source, slot.terminator),
  } as const;
  return slot.code === null
    ? Object.freeze({
        ...base,
        code: null,
        hasCode: false,
      })
    : Object.freeze({
        ...base,
        code: statementRange(source, slot.code),
        hasCode: true,
      });
}

export class DefaultSqlDocumentSession<Context extends SqlDocumentContext>
  implements SqlDocumentSession<Context>
{
  readonly #catalogCoordinator: SqlCatalogSearchWorkCoordinator | null;
  readonly #catalogResponseBudgetMs: number;
  readonly #columnCoordinator: SqlColumnCatalogBatchCoordinator | null;
  readonly #namespaceCoordinator: SqlNamespaceCatalogCoordinator | null;
  readonly #dialects: ReadonlyMap<string, SqlDialectRuntime>;
  readonly #onDispose: () => void;
  readonly #listeners = new Set<SessionChangeSubscription>();
  #activeCompletion: CompletionRequestState | null = null;
  #catalogOwner: SqlCatalogSearchWorkOwner | null = null;
  #catalogOwnerDialect: SqlRelationDialectRuntime | null = null;
  #catalogOwnerScope: string | null = null;
  #columnOwner: SqlColumnCatalogBatchOwner | null = null;
  #columnOwnerDialect: SqlRelationDialectRuntime | null = null;
  #columnOwnerScope: string | null = null;
  #namespaceOwner: SqlNamespaceCatalogOwner | null = null;
  #namespaceOwnerDialect: SqlRelationDialectRuntime | null = null;
  #namespaceOwnerScope: string | null = null;
  #disposed = false;
  #localRelationStatementCache:
    | LocalRelationStatementCache
    | null = null;
  #refreshIntent: CompletionRequestState | null = null;
  #snapshot: SessionSnapshot<Context>;
  #softRefreshIntentTimer: SessionTimerCell | null = null;
  #statementIndexCache: StatementIndexCache | null = null;
  #terminalRefreshIntent: TerminalRefreshIntent | null = null;
  #updating = false;

  constructor(
    source: SqlSourceSnapshot,
    context: Context,
    dialects: ReadonlyMap<string, SqlDialectRuntime>,
    catalogCoordinator: SqlCatalogSearchWorkCoordinator | null,
    columnCoordinator: SqlColumnCatalogBatchCoordinator | null,
    namespaceCoordinator: SqlNamespaceCatalogCoordinator | null,
    completion: CompletionConfiguration,
    onDispose: () => void,
  ) {
    this.#catalogCoordinator = catalogCoordinator;
    this.#columnCoordinator = columnCoordinator;
    this.#namespaceCoordinator = namespaceCoordinator;
    this.#catalogResponseBudgetMs =
      completion.catalogResponseBudgetMs;
    this.#dialects = dialects;
    this.#onDispose = onDispose;
    const sequence = 0;
    const contextSequence = 0;
    const documentSequence = 0;
    const sourceSequence = 0;
    const dialect = resolveDialectRuntime(context, dialects);
    this.#snapshot = Object.freeze({
      contextSequence,
      context,
      dialect,
      documentSequence,
      revision: createSqlRevisionToken(),
      sequence,
      source,
      sourceSequence,
    });
    this.#replaceCatalogOwner();
    this.#replaceColumnOwner();
    this.#replaceNamespaceOwner();
  }

  get revision(): SqlRevision {
    return this.#snapshot.revision;
  }

  get snapshotForTesting(): SessionSnapshot<Context> {
    return this.#snapshot;
  }

  get cachedStatementIndexForTesting(): SqlStatementIndex | null {
    return this.#statementIndexCache?.index ?? null;
  }

  #getStatementIndex(): SqlStatementIndex {
    if (this.#disposed) {
      throw new SqlSessionError(
        "session-disposed",
        "SQL document session is disposed",
      );
    }
    const cached = this.#statementIndexCache;
    if (
      cached &&
      cached.sourceSequence === this.#snapshot.sourceSequence &&
      cached.lexicalProfile === this.#snapshot.dialect.lexicalProfile
    ) {
      return cached.index;
    }
    const index = buildSqlStatementIndex(
      this.#snapshot.source.analysisText,
      this.#snapshot.dialect.lexicalProfile,
    );
    this.#statementIndexCache = Object.freeze({
      index,
      lexicalProfile: this.#snapshot.dialect.lexicalProfile,
      sourceSequence: this.#snapshot.sourceSequence,
    });
    return index;
  }

  getStatementIndexForTesting(): SqlStatementIndex {
    return this.#getStatementIndex();
  }

  readonly statementBoundaryAt = (
    input: SqlStatementBoundaryAtRequest,
  ): SqlStatementBoundaryAtResult => {
    if (this.#disposed) {
      throw new SqlSessionError(
        "session-disposed",
        "SQL document session is disposed",
      );
    }
    const request = statementBoundaryRequest(input);
    const snapshot = this.#snapshot;
    if (request.position > snapshot.source.originalText.length) {
      return invalidStatementBoundaryRequest(
        "SQL statement position is outside the document",
      );
    }
    const slot = findSqlStatementSlot(
      this.#getStatementIndex(),
      request.position,
      request.affinity,
    );
    return Object.freeze({
      boundary: statementBoundary(snapshot.source, slot),
      revision: snapshot.revision,
    });
  };

  readonly statementBoundariesIntersecting = (
    input: SqlStatementBoundariesIntersectingRequest,
  ): SqlStatementBoundariesIntersectingResult => {
    if (this.#disposed) {
      throw new SqlSessionError(
        "session-disposed",
        "SQL document session is disposed",
      );
    }
    const request = statementIntersectionRequest(input);
    const snapshot = this.#snapshot;
    if (request.to > snapshot.source.originalText.length) {
      return invalidStatementBoundaryRequest(
        "SQL statement intersection range is outside the document",
      );
    }
    const slots = findSqlStatementSlotsIntersecting(
      this.#getStatementIndex(),
      request,
    );
    return Object.freeze({
      boundaries: Object.freeze(
        slots.map((slot) => statementBoundary(snapshot.source, slot)),
      ),
      revision: snapshot.revision,
    });
  };

  #clearTerminalIntent(): void {
    const intent = this.#terminalRefreshIntent;
    if (!intent) return;
    this.#terminalRefreshIntent = null;
    intent.timer.active = false;
    clearTimeout(intent.timer.handle);
  }

  #clearSoftRefreshIntentTimer(): void {
    const timer = this.#softRefreshIntentTimer;
    if (!timer) return;
    this.#softRefreshIntentTimer = null;
    timer.active = false;
    clearTimeout(timer.handle);
  }

  #dispatchChange(event: SqlSessionChangeEvent): void {
    if (
      this.#disposed ||
      event.revision !== this.#snapshot.revision
    ) {
      return;
    }
    for (const subscription of Array.from(this.#listeners)) {
      if (
        this.#disposed ||
        event.revision !== this.#snapshot.revision
      ) {
        return;
      }
      if (
        !subscription.active ||
        !this.#listeners.has(subscription)
      ) {
        continue;
      }
      try {
        Reflect.apply(subscription.listener, undefined, [event]);
      } catch {
        // Listener failures do not interrupt coordinator state changes.
      }
    }
  }

  #prepareServiceChange(
    change: ServiceChange,
  ): (() => undefined) | null {
    const expected =
      change.reason === "catalog-availability"
        ? change.expected
        : undefined;
    if (
      this.#disposed ||
      (expected !== undefined &&
        (this.#activeCompletion !== expected &&
          this.#refreshIntent !== expected ||
          expected.cancelReason !== null ||
          expected.revision !== this.#snapshot.revision))
    ) {
      return null;
    }
    const terminal = this.#terminalRefreshIntent;
    const soft = this.#refreshIntent;
    const activeIntent = this.#activeCompletion;
    const refreshToken =
      change.reason === "catalog-availability"
        ? change.expected.token
        : soft?.cancelReason === null
          ? soft.token
          : terminal?.timer.active === true
            ? terminal.token
            : activeIntent?.cancelReason === null
              ? activeIntent.token
              : null;
    const previous = this.#snapshot;
    const revision = createSqlRevisionToken();
    this.#snapshot = Object.freeze({
      ...previous,
      revision,
      sequence: previous.sequence + 1,
    });
    const event: SqlSessionChangeEvent =
      change.reason === "catalog-availability"
        ? Object.freeze({
            reason: change.reason,
            refreshToken: change.expected.token,
            revision,
          })
        : Object.freeze({
            reason: change.reason,
            refreshToken,
            revision,
          });
    const active = this.#activeCompletion;
    const intent = this.#refreshIntent;
    this.#activeCompletion = null;
    this.#refreshIntent = null;
    this.#clearSoftRefreshIntentTimer();
    this.#clearTerminalIntent();
    if (active && active.cancelReason === null) {
      active.cancelReason = "superseded";
    }
    if (intent && intent !== active) {
      if (intent.cancelReason === null) {
        intent.cancelReason = "superseded";
      }
    }
    return (): undefined => {
      active?.ticket?.cancel();
      if (intent !== active) intent?.ticket?.cancel();
      this.#dispatchChange(event);
      return undefined;
    };
  }

  #replaceCatalogOwner(): void {
    const catalog = resolveCatalogContext(this.#snapshot.context);
    const dialect = this.#snapshot.dialect.relationDialect;
    if (
      this.#catalogOwner &&
      catalog &&
      this.#catalogOwnerScope === catalog.scope &&
      this.#catalogOwnerDialect === dialect
    ) {
      return;
    }
    this.#catalogOwner?.dispose();
    this.#catalogOwner = null;
    this.#catalogOwnerDialect = null;
    this.#catalogOwnerScope = null;
    if (!catalog || !this.#catalogCoordinator || this.#disposed) {
      return;
    }
    const prepared = this.#catalogCoordinator.prepareOwner(
      catalog.scope,
      dialect,
      Object.freeze({
        prepareCatalogChange: (): (() => undefined) | null =>
          this.#prepareServiceChange({ reason: "catalog" }),
      }),
    );
    if (prepared.status !== "prepared") return;
    this.#catalogOwner = prepared.owner;
    this.#catalogOwnerDialect = dialect;
    this.#catalogOwnerScope = catalog.scope;
    const activation = prepared.owner.activate();
    if (activation.status !== "active") {
      prepared.owner.dispose();
      if (this.#catalogOwner === prepared.owner) {
        this.#catalogOwner = null;
        this.#catalogOwnerDialect = null;
        this.#catalogOwnerScope = null;
      }
    }
  }

  #replaceColumnOwner(): void {
    const catalog = resolveCatalogContext(this.#snapshot.context);
    const dialect = this.#snapshot.dialect.relationDialect;
    if (
      this.#columnOwner &&
      catalog &&
      this.#columnOwnerScope === catalog.scope &&
      this.#columnOwnerDialect === dialect
    ) {
      return;
    }
    this.#columnOwner?.dispose();
    this.#columnOwner = null;
    this.#columnOwnerDialect = null;
    this.#columnOwnerScope = null;
    if (!catalog || !this.#columnCoordinator || this.#disposed) {
      return;
    }
    const prepared = this.#columnCoordinator.prepareOwner({
      dialectId: dialect.id,
      scope: catalog.scope,
    });
    if (prepared.status !== "prepared") return;
    this.#columnOwner = prepared.owner;
    this.#columnOwnerDialect = dialect;
    this.#columnOwnerScope = catalog.scope;
  }

  #replaceNamespaceOwner(): void {
    const catalog = resolveCatalogContext(this.#snapshot.context);
    const dialect = this.#snapshot.dialect.relationDialect;
    if (
      this.#namespaceOwner &&
      catalog &&
      this.#namespaceOwnerScope === catalog.scope &&
      this.#namespaceOwnerDialect === dialect
    ) {
      return;
    }
    this.#namespaceOwner?.dispose();
    this.#namespaceOwner = null;
    this.#namespaceOwnerDialect = null;
    this.#namespaceOwnerScope = null;
    if (!catalog || !this.#namespaceCoordinator || this.#disposed) {
      return;
    }
    const prepared = this.#namespaceCoordinator.prepareOwner({
      dialectId: dialect.id,
      scope: catalog.scope,
    });
    if (prepared.status !== "prepared") return;
    this.#namespaceOwner = prepared.owner;
    this.#namespaceOwnerDialect = dialect;
    this.#namespaceOwnerScope = catalog.scope;
  }

  readonly onDidChange = (
    listener: (event: SqlSessionChangeEvent) => void,
  ): SqlDisposable => {
    if (this.#disposed) {
      throw new SqlSessionError(
        "session-disposed",
        "SQL document session is disposed",
      );
    }
    if (typeof listener !== "function") {
      throw new SqlSessionError(
        "invalid-completion-request",
        "SQL session change listener must be a function",
      );
    }
    const subscription: SessionChangeSubscription = {
      active: true,
      listener,
    };
    this.#listeners.add(subscription);
    return Object.freeze({
      dispose: (): void => {
        if (!subscription.active) return;
        subscription.active = false;
        this.#listeners.delete(subscription);
      },
    });
  };

  readonly complete = (
    request: SqlCompletionRequest,
  ): SqlCompletionTask => {
    const refreshToken = createSqlCompletionRefreshToken();
    const result = this.#runCompletion(request, refreshToken);
    return createCompletionTask(refreshToken, result);
  };

  async #runCompletion(
    request: SqlCompletionRequest,
    refreshToken: SqlCompletionRefreshToken,
  ): Promise<SqlCompletionResult> {
    const completionStartedAt = performance.now();
    if (this.#disposed) {
      throw new SqlSessionError(
        "session-disposed",
        "SQL document session is disposed",
      );
    }
    let position: number;
    let signal: AbortSignal | undefined;
    try {
      if (request === null || typeof request !== "object") {
        throw new Error();
      }
      position = readRequiredDataProperty(
        request,
        "position",
        "invalid-completion-request",
        "SQL completion request",
      );
      const trigger = readRequiredDataProperty(
        request,
        "trigger",
        "invalid-completion-request",
        "SQL completion request",
      );
      if (
        !Number.isSafeInteger(position) ||
        position < 0 ||
        position > this.#snapshot.source.originalText.length ||
        trigger === null ||
        typeof trigger !== "object"
      ) {
        throw new Error();
      }
      const triggerKind = readRequiredDataProperty(
        trigger,
        "kind",
        "invalid-completion-request",
        "SQL completion trigger",
      );
      if (
        triggerKind !== "invoked" &&
        triggerKind !== "trigger-character"
      ) {
        throw new Error();
      }
      if (triggerKind === "trigger-character") {
        const character = readRequiredDataProperty(
          trigger,
          "character",
          "invalid-completion-request",
          "SQL completion trigger",
        );
        if (
          typeof character !== "string" ||
          character.length === 0 ||
          character.length > 2 ||
          Array.from(character).length !== 1
        ) {
          throw new Error();
        }
      } else {
        rejectOwnProperty(
          trigger,
          "character",
          "invalid-completion-request",
          "SQL completion trigger",
        );
      }
      const signalProperty = readOwnDataProperty(
        request,
        "signal",
        "invalid-completion-request",
        "SQL completion request",
      );
      if (
        signalProperty.found &&
        signalProperty.value !== undefined
      ) {
        if (!(signalProperty.value instanceof AbortSignal)) {
          throw new Error();
        }
        signal = signalProperty.value;
      }
    } catch (error) {
      if (
        error instanceof SqlSessionError &&
        error.code === "invalid-completion-request"
      ) {
        throw error;
      }
      throw new SqlSessionError(
        "invalid-completion-request",
        "SQL completion request is invalid",
      );
    }

    const previousActive = this.#activeCompletion;
    const previousIntent = this.#refreshIntent;
    if (
      previousActive &&
      previousActive.cancelReason === null
    ) {
      previousActive.cancelReason = "superseded";
    }
    if (
      previousIntent &&
      previousIntent !== previousActive &&
      previousIntent.cancelReason === null
    ) {
      previousIntent.cancelReason = "superseded";
    }
    const cancelPrevious = (): void => {
      previousActive?.ticket?.cancel();
      if (previousIntent !== previousActive) {
        previousIntent?.ticket?.cancel();
      }
      if (this.#refreshIntent === previousIntent) {
        this.#refreshIntent = null;
      }
      this.#clearSoftRefreshIntentTimer();
    };
    this.#clearSoftRefreshIntentTimer();
    this.#clearTerminalIntent();
    const snapshot = this.#snapshot;
    const active: CompletionRequestState = {
      cancelReason: null,
      revision: snapshot.revision,
      ticket: null,
      token: refreshToken,
    };
    this.#activeCompletion = active;
    const cancellationIfNotCurrent =
      (): SqlCompletionResult | null => {
        if (
          this.#activeCompletion === active &&
          active.cancelReason === null &&
          snapshot.revision === this.#snapshot.revision
        ) {
          return null;
        }
        cancelPrevious();
        return completionCancellation(
          snapshot.revision,
          completionCancellationReason(active),
        );
      };
    await Promise.resolve();
    const publicationCancellation = cancellationIfNotCurrent();
    if (publicationCancellation) return publicationCancellation;
    const onAbort = (): void => {
      if (
        this.#activeCompletion === active &&
        active.cancelReason === null
      ) {
        active.cancelReason = "caller";
        active.ticket?.cancel();
      }
    };
    const makeInvocationInert = (): void => {
      if (this.#activeCompletion === active) {
        this.#activeCompletion = null;
      }
      if (active.cancelReason === null) {
        active.cancelReason = "superseded";
      }
      cancelPrevious();
    };
    const readSignalAborted = (
      currentSignal: AbortSignal,
    ): boolean => {
      try {
        return currentSignal.aborted;
      } catch (error) {
        makeInvocationInert();
        throw error;
      }
    };
    let signalRegistrationAttempted = false;
    try {
      if (signal) {
        const abortedBeforeRegistration =
          readSignalAborted(signal);
        const readCancellation = cancellationIfNotCurrent();
        if (readCancellation) return readCancellation;
        if (abortedBeforeRegistration) {
          active.cancelReason = "caller";
          this.#activeCompletion = null;
          cancelPrevious();
          return completionCancellation(
            snapshot.revision,
            "caller",
          );
        }
        signalRegistrationAttempted = true;
        try {
          signal.addEventListener("abort", onAbort, { once: true });
        } catch (error) {
          makeInvocationInert();
          throw error;
        }
        const registrationCancellation =
          cancellationIfNotCurrent();
        if (registrationCancellation) {
          return registrationCancellation;
        }
        const abortedAfterRegistration =
          readSignalAborted(signal);
        const rereadCancellation = cancellationIfNotCurrent();
        if (rereadCancellation) return rereadCancellation;
        if (abortedAfterRegistration) {
          onAbort();
          cancelPrevious();
          return completionCancellation(
            snapshot.revision,
            "caller",
          );
        }
      }
      const index = this.#getStatementIndex();
      const slot = findSqlStatementSlot(index, position, "left");
      const cachedLocal = this.#localRelationStatementCache;
      const prepared =
        cachedLocal &&
        cachedLocal.sourceSequence === snapshot.sourceSequence &&
        cachedLocal.index === index &&
        cachedLocal.slot === slot &&
        cachedLocal.dialect === snapshot.dialect.relationDialect
          ? cachedLocal.preparation
          : prepareSqlLocalRelationStatement(
              snapshot.source,
              index,
              slot,
              snapshot.dialect.relationDialect,
            );
      if (cachedLocal?.preparation !== prepared) {
        this.#localRelationStatementCache = Object.freeze({
          dialect: snapshot.dialect.relationDialect,
          index,
          preparation: prepared,
          slot,
          sourceSequence: snapshot.sourceSequence,
        });
      }
      if (prepared.status !== "ready") {
        cancelPrevious();
        return Object.freeze({
          reason: unavailableCompletionReason(prepared),
          retryable: false,
          revision: snapshot.revision,
          status: "unavailable",
        });
      }
      const localSite = analyzeSqlLocalRelationSite(
        prepared.statement,
        position,
      );
      if (localSite.status !== "ready") {
        const columnSite = analyzeSqlLocalColumnSite(
          prepared.statement,
          position,
        );
        if (
          localSite.status === "inactive" &&
          columnSite.status === "ready"
        ) {
          const catalog = resolveCatalogContext(snapshot.context);
          const columnOwner = this.#columnOwner;
          const columnCoordinator = this.#columnCoordinator;
          const preparedRelations = prepareSqlColumnCatalogRelations(
            columnSite,
            snapshot.dialect.relationDialect,
          );
          if (preparedRelations.references.length === 0) {
            cancelPrevious();
            return Object.freeze({
              reason: unavailableCompletionReason(localSite),
              retryable: false,
              revision: snapshot.revision,
              status: "unavailable",
            });
          }
          if (!catalog || !columnOwner || !columnCoordinator) {
            cancelPrevious();
            return Object.freeze({
              reason: "unsupported-query-site",
              retryable: false,
              revision: snapshot.revision,
              status: "unavailable",
            });
          }
          if (
            this.#activeCompletion !== active ||
            active.cancelReason !== null ||
            snapshot.revision !== this.#snapshot.revision
          ) {
            return completionCancellation(
              snapshot.revision,
              completionCancellationReason(active),
            );
          }
          const ticket = columnOwner.request({
            expectedEpoch: null,
            relations: preparedRelations.references,
            searchPaths: catalog.searchPaths,
          });
          active.ticket = ticket;
          let responseTimer:
            | ReturnType<typeof setTimeout>
            | undefined;
          const raced = await Promise.race([
            ticket.result.then((outcome) =>
              Object.freeze({
                kind: "outcome" as const,
                outcome,
              }),
            ),
            new Promise<{ readonly kind: "timeout" }>((resolve) => {
              responseTimer = setTimeout(
                () => resolve(Object.freeze({ kind: "timeout" })),
                this.#catalogResponseBudgetMs,
              );
            }),
          ]);
          clearTimeout(responseTimer);
          if (
            this.#activeCompletion !== active ||
            active.cancelReason !== null ||
            snapshot.revision !== this.#snapshot.revision
          ) {
            ticket.cancel();
            return completionCancellation(
              snapshot.revision,
              completionCancellationReason(active),
            );
          }
          if (raced.kind === "timeout") {
            ticket.cancel();
            return Object.freeze({
              refreshToken: null,
              revision: snapshot.revision,
              sources: Object.freeze([Object.freeze({
                feature: "column-catalog" as const,
                outcome: "loading" as const,
                providerId: columnCoordinator.providerId,
              })]),
              status: "ready",
              value: Object.freeze({
                isIncomplete: true,
                issues: Object.freeze([Object.freeze({
                  reason: "column-catalog-loading" as const,
                })] as const),
                items: Object.freeze([]),
              }),
            });
          }
          const composition = composeSqlColumnCompletion({
            dialect: snapshot.dialect.relationDialect,
            outcome: raced.outcome,
            prepared: preparedRelations,
            providerId: columnCoordinator.providerId,
            site: columnSite,
          });
          if (!composition) {
            return completionCancellation(
              snapshot.revision,
              completionCancellationReason(active),
            );
          }
          return Object.freeze({
            refreshToken: null,
            revision: snapshot.revision,
            sources: composition.sources,
            status: "ready",
            value: composition.value,
          });
        }
        cancelPrevious();
        return Object.freeze({
          reason: unavailableCompletionReason(localSite),
          retryable: false,
          revision: snapshot.revision,
          status: "unavailable",
        });
      }
      if (
        this.#activeCompletion !== active ||
        active.cancelReason !== null ||
        snapshot.revision !== this.#snapshot.revision
      ) {
        return completionCancellation(
          snapshot.revision,
          completionCancellationReason(active),
        );
      }

      const querySite = localSite.querySite;
      const statementOffset =
        slot.boundaryQuality === "exact" ? slot.source.from : 0;
      const replacementRange = Object.freeze({
        from: statementOffset + querySite.typedPathRange.from,
        to: statementOffset + querySite.typedPathRange.to,
      });
      const catalog = resolveCatalogContext(snapshot.context);
      let catalogOutcome: SqlComposableCatalogOutcome = null;
      let remainingIntentLeaseMs = 0;
      const owner = this.#catalogOwner;

      if (catalog && this.#catalogCoordinator) {
        if (!owner) {
          cancelPrevious();
          catalogOutcome = Object.freeze({
            reason: "overloaded",
            status: "unavailable",
          });
        } else {
          if (
            this.#activeCompletion !== active ||
            active.cancelReason !== null ||
            snapshot.revision !== this.#snapshot.revision
          ) {
            cancelPrevious();
            return completionCancellation(
              snapshot.revision,
              completionCancellationReason(active),
            );
          }
          const ticket = owner.request({
            continuationToken: null,
            limit: MAX_RELATION_COMPLETION_RESULTS,
            prefix: querySite.prefix,
            qualifier: querySite.qualifier,
            searchPaths: catalog.searchPaths,
          });
          if (this.#refreshIntent === previousIntent) {
            this.#refreshIntent = null;
          }
          active.ticket = ticket;
          const elapsed = Math.max(
            0,
            performance.now() - completionStartedAt,
          );
          const remaining = Math.max(
            0,
            this.#catalogResponseBudgetMs - elapsed,
          );
          let responseTimer:
            | ReturnType<typeof setTimeout>
            | undefined;
          const raced = await Promise.race([
            ticket.result.then((outcome) =>
              Object.freeze({
                kind: "outcome" as const,
                outcome,
              }),
            ),
            new Promise<{ readonly kind: "timeout" }>((resolve) => {
              responseTimer = setTimeout(
                () => resolve(Object.freeze({ kind: "timeout" })),
                remaining,
              );
            }),
          ]);
          clearTimeout(responseTimer);
          if (
            this.#activeCompletion !== active ||
            active.cancelReason !== null ||
            snapshot.revision !== this.#snapshot.revision
          ) {
            ticket.cancel();
            return completionCancellation(
              snapshot.revision,
              completionCancellationReason(active),
            );
          }
          let providerOutcome: SqlCatalogSearchWorkOutcome | null =
            raced.kind === "outcome" ? raced.outcome : null;
          if (raced.kind === "timeout") {
            const retained = ticket.retainForRefresh(
              (): (() => undefined) | null =>
                this.#prepareServiceChange(
                  {
                    expected: active,
                    reason: "catalog-availability",
                  },
                ),
            );
            if (retained.status === "retained") {
              remainingIntentLeaseMs = retained.remainingLeaseMs;
              this.#refreshIntent = active;
              const cell: SessionTimerCell = {
                active: true,
                handle: undefined,
              };
              this.#softRefreshIntentTimer = cell;
              const handle = setTimeout(() => {
                if (
                  !cell.active ||
                  this.#softRefreshIntentTimer !== cell
                ) {
                  return;
                }
                cell.active = false;
                this.#softRefreshIntentTimer = null;
                this.#refreshIntent = null;
                ticket.cancel();
              }, remainingIntentLeaseMs);
              cell.handle = handle;
              if (
                !cell.active ||
                this.#softRefreshIntentTimer !== cell
              ) {
                clearTimeout(handle);
              }
              if (this.#refreshIntent !== active) {
                remainingIntentLeaseMs = 0;
              }
              catalogOutcome = Object.freeze({
                status: "loading",
              });
            } else if (
              retained.reason === "not-retainable"
            ) {
              providerOutcome = await ticket.result;
            } else {
              catalogOutcome = Object.freeze({
                reason: "execution-timeout",
                status: "unavailable",
              });
            }
          }
          if (providerOutcome) {
            const outcome = providerOutcome;
            if (
              outcome.status === "cancelled" ||
              outcome.status === "superseded"
            ) {
              return completionCancellation(
                snapshot.revision,
                active.cancelReason ??
                  (outcome.status === "cancelled"
                    ? "caller"
                    : "superseded"),
              );
            }
            if (outcome.status === "unavailable") {
              if (
                outcome.reason === "disposed" ||
                outcome.reason === "inactive"
              ) {
                return completionCancellation(
                  snapshot.revision,
                  this.#disposed ? "disposed" : "superseded",
                );
              }
              switch (outcome.reason) {
                case "invalid-request":
                  catalogOutcome = Object.freeze({
                    reason: "provider-failed",
                    status: "unavailable",
                  });
                  break;
                case "execution-timeout":
                case "malformed-response":
                case "overloaded":
                case "provider-failed":
                case "queue-timeout":
                  catalogOutcome = Object.freeze({
                    reason: outcome.reason,
                    status: "unavailable",
                  });
                  break;
              }
            } else {
              catalogOutcome = outcome;
              if (outcome.response.status === "loading") {
                remainingIntentLeaseMs =
                  TERMINAL_LOADING_INTENT_LEASE_MS;
                const cell: SessionTimerCell = {
                  active: true,
                  handle: undefined,
                };
                const intent: TerminalRefreshIntent = {
                  timer: cell,
                  token: active.token,
                };
                this.#terminalRefreshIntent = intent;
                const handle = setTimeout(() => {
                  if (!cell.active) return;
                  cell.active = false;
                  if (this.#terminalRefreshIntent === intent) {
                    this.#terminalRefreshIntent = null;
                  }
                }, remainingIntentLeaseMs);
                cell.handle = handle;
                if (
                  !cell.active ||
                  this.#terminalRefreshIntent !== intent
                ) {
                  clearTimeout(handle);
                }
                if (this.#terminalRefreshIntent !== intent) {
                  remainingIntentLeaseMs = 0;
                }
              }
            }
          }
        }
      } else {
        cancelPrevious();
      }

      let namespaceComposition: SqlNamespaceCompletionComposition | null =
        null;
      const namespaceOwner = this.#namespaceOwner;
      const namespaceCoordinator = this.#namespaceCoordinator;
      if (catalog && namespaceOwner && namespaceCoordinator) {
        const ticket = namespaceOwner.request(
          prepareSqlNamespaceCatalogSearch(
            {
              prefix: querySite.prefix,
              qualifier: querySite.qualifier,
              replacementRange,
            },
            null,
            catalog.searchPaths,
            MAX_NAMESPACE_RESULTS,
          ),
        );
        active.ticket = ticket;
        const elapsed = Math.max(
          0,
          performance.now() - completionStartedAt,
        );
        const remaining = Math.max(
          0,
          this.#catalogResponseBudgetMs - elapsed,
        );
        let responseTimer:
          | ReturnType<typeof setTimeout>
          | undefined;
        const raced = await Promise.race([
          ticket.result.then((outcome) =>
            Object.freeze({
              kind: "outcome" as const,
              outcome,
            }),
          ),
          new Promise<{ readonly kind: "timeout" }>((resolve) => {
            responseTimer = setTimeout(
              () => resolve(Object.freeze({ kind: "timeout" })),
              remaining,
            );
          }),
        ]);
        clearTimeout(responseTimer);
        if (
          this.#activeCompletion !== active ||
          active.cancelReason !== null ||
          snapshot.revision !== this.#snapshot.revision
        ) {
          ticket.cancel();
          return completionCancellation(
            snapshot.revision,
            completionCancellationReason(active),
          );
        }
        if (raced.kind === "timeout") {
          ticket.cancel();
          namespaceComposition = Object.freeze({
            source: Object.freeze({
              feature: "namespace-catalog",
              outcome: "loading",
              providerId: namespaceCoordinator.providerId,
            }),
            value: Object.freeze({
              isIncomplete: true,
              issues: Object.freeze([
                "namespace-catalog-loading" as const,
              ] as const),
              items: Object.freeze([]),
            }),
          });
        } else {
          const outcome: SqlNamespaceCatalogSearchOutcome =
            raced.outcome;
          namespaceComposition = composeSqlNamespaceCompletion({
            matchPrefix:
              snapshot.dialect.relationDialect.completion
                .cteIdentifierMatchesPrefix,
            outcome,
            prefix: querySite.prefix,
            providerId: namespaceCoordinator.providerId,
            replacementRange,
          });
          if (!namespaceComposition) {
            return completionCancellation(
              snapshot.revision,
              completionCancellationReason(active),
            );
          }
        }
      }

      const composition = composeSqlRelationCompletion({
        catalogOutcome,
        dialect: snapshot.dialect.relationDialect,
        localSite,
        providerId:
          catalog && this.#catalogCoordinator
            ? this.#catalogCoordinator.providerId
            : null,
        remainingIntentLeaseMs,
        replacementRange,
        statementOffset,
      });
      if (
        this.#activeCompletion !== active ||
        active.cancelReason !== null ||
        snapshot.revision !== this.#snapshot.revision
      ) {
        return completionCancellation(
          snapshot.revision,
          completionCancellationReason(active),
        );
      }
      const value = namespaceComposition
        ? mergeCompletionLists(
            composition.value,
            namespaceCompletionList(namespaceComposition),
          )
        : composition.value;
      const sources = namespaceComposition
        ? Object.freeze([
            ...composition.sources,
            namespaceComposition.source,
          ])
        : composition.sources;
      return Object.freeze({
        refreshToken:
          (catalogOutcome?.status === "loading" ||
            (catalogOutcome?.status === "usable" &&
              catalogOutcome.response.status === "loading")) &&
          (this.#refreshIntent === active ||
            this.#terminalRefreshIntent?.token === active.token)
            ? active.token
            : null,
        revision: snapshot.revision,
        sources,
        status: "ready",
        value,
      });
    } finally {
      if (this.#activeCompletion === active) {
        this.#activeCompletion = null;
      }
      if (signal && signalRegistrationAttempted) {
        try {
          signal.removeEventListener("abort", onAbort);
        } catch {
          // Signal cleanup cannot retain or fail the completion.
        }
      }
    }
  }

  readonly update = (update: SqlDocumentUpdate<Context>): SqlRevision => {
    if (this.#disposed) {
      throw new SqlSessionError("session-disposed", "SQL document session is disposed");
    }
    if (this.#updating) {
      throw new SqlSessionError(
        "reentrant-update",
        "SQL document updates cannot be reentrant",
      );
    }
    this.#updating = true;
    try {
      return this.#applyUpdate(update);
    } catch (error) {
      if (this.#disposed) {
        throw new SqlSessionError(
          "session-disposed",
          "SQL document session was disposed during the update",
        );
      }
      if (error instanceof SqlSessionError) {
        throw error;
      }
      throw new SqlSessionError(
        "invalid-update",
        "SQL document update could not be inspected safely",
      );
    } finally {
      this.#updating = false;
    }
  };

  #applyUpdate(update: SqlDocumentUpdate<Context>): SqlRevision {
    if (update === null || typeof update !== "object") {
      throw new SqlSessionError(
        "invalid-update",
        "SQL document update must be an object",
      );
    }
    const baseRevision = readRequiredDataProperty(
      update,
      "baseRevision",
      "invalid-update",
      "SQL document update",
    );
    if (baseRevision !== this.#snapshot.revision) {
      throw new SqlSessionError("stale-revision", "SQL document revision is stale");
    }
    rejectOwnProperty(
      update,
      "kind",
      "invalid-update",
      "SQL document update",
    );

    const document = readOwnDataProperty(
      update,
      "document",
      "invalid-update",
      "SQL document update",
    );
    const context = readOwnDataProperty(
      update,
      "context",
      "invalid-update",
      "SQL document update",
    );
    const embeddedRegions = readOwnDataProperty(
      update,
      "embeddedRegions",
      "invalid-update",
      "SQL document update",
    );
    const hasDocument = document.found && document.value !== undefined;
    const hasContext = context.found && context.value !== undefined;
    const hasEmbeddedRegions =
      embeddedRegions.found && embeddedRegions.value !== undefined;
    if (!hasDocument && !hasContext && !hasEmbeddedRegions) {
      throw new SqlSessionError(
        "invalid-update",
        "SQL document update must change document, context, or embedded regions",
      );
    }
    if (hasDocument && !hasEmbeddedRegions) {
      throw new SqlSessionError(
        "invalid-update",
        "SQL document mutations require the complete resulting embedded regions",
      );
    }

    let nextContextSequence = this.#snapshot.contextSequence;
    let nextContext = this.#snapshot.context;
    let nextDocumentSequence = this.#snapshot.documentSequence;
    let nextSourceSequence = this.#snapshot.sourceSequence;
    let nextSource = this.#snapshot.source;
    let documentMutation: "changes" | "none" | "replace" = "none";
    let trustedAnalysisChanges: readonly SqlTextChange[] | null = null;

    let nextText = this.#snapshot.source.originalText;
    if (hasDocument) {
      if (document.value === null || typeof document.value !== "object") {
        throw new SqlSessionError(
          "invalid-update",
          "SQL document mutation must be an object",
        );
      }
      const documentKind = readRequiredDataProperty(
        document.value,
        "kind",
        "invalid-update",
        "SQL document mutation",
      );
      if (documentKind === "replace") {
        rejectOwnProperty(
          document.value,
          "changes",
          "invalid-update",
          "SQL document replacement",
        );
        const text = readRequiredDataProperty(
          document.value,
          "text",
          "invalid-update",
          "SQL document replacement",
        );
        if (typeof text !== "string") {
          throw new SqlSessionError(
            "invalid-update",
            "SQL replacement text must be a string",
          );
        }
        validateDocumentLength(text);
        nextText = text;
        documentMutation = "replace";
      } else if (documentKind === "changes") {
        rejectOwnProperty(
          document.value,
          "text",
          "invalid-update",
          "SQL document changes",
        );
        const changes = readRequiredDataProperty(
          document.value,
          "changes",
          "invalid-update",
          "SQL document changes",
        );
        if (!Array.isArray(changes)) {
          throw new SqlSessionError(
            "invalid-update",
            "SQL document changes must be an array",
          );
        }
        const normalizedChanges = normalizeChanges(
          this.#snapshot.source.originalText,
          changes,
        );
        trustedAnalysisChanges = normalizedChanges;
        nextText = applyChanges(
          this.#snapshot.source.originalText,
          normalizedChanges,
        );
        documentMutation = "changes";
      } else {
        throw new SqlSessionError(
          "invalid-update",
          "SQL document mutation kind must be replace or changes",
        );
      }
      nextDocumentSequence += 1;
    }

    if (hasEmbeddedRegions) {
      const candidateSource = createMaskedSqlSource(
        nextText,
        embeddedRegions.value,
      );
      if (
        candidateSource.originalText === this.#snapshot.source.originalText &&
        haveEqualEmbeddedRegions(candidateSource, this.#snapshot.source)
      ) {
        nextSource = this.#snapshot.source;
      } else {
        nextSource = candidateSource;
      }
      nextSourceSequence += 1;
      if (
        documentMutation !== "changes" ||
        this.#snapshot.source.embeddedRegions.length !== 0 ||
        nextSource.embeddedRegions.length !== 0
      ) {
        trustedAnalysisChanges = null;
      }
    }

    if (hasContext) {
      nextContext = cloneContext<Context>(context.value);
      nextContextSequence += 1;
    }

    const nextDialect = resolveDialectRuntime(
      nextContext,
      this.#dialects,
    );
    const nextCatalog = resolveCatalogContext(nextContext);
    if (
      nextCatalog &&
      !this.#catalogCoordinator &&
      !this.#columnCoordinator &&
      !this.#namespaceCoordinator
    ) {
      throw new SqlSessionError(
        "invalid-context",
        "SQL catalog context requires a configured catalog provider",
      );
    }
    const nextLexicalProfile = nextDialect.lexicalProfile;
    if (this.#disposed) {
      throw new SqlSessionError(
        "session-disposed",
        "SQL document session was disposed during the update",
      );
    }
    const sequence = this.#snapshot.sequence + 1;
    const revision = createSqlRevisionToken();
    const nextSnapshot = Object.freeze({
      contextSequence: nextContextSequence,
      context: nextContext,
      dialect: nextDialect,
      documentSequence: nextDocumentSequence,
      revision,
      sequence,
      source: nextSource,
      sourceSequence: nextSourceSequence,
    });
    let nextStatementIndexCache = this.#statementIndexCache;
    if (
      nextStatementIndexCache &&
      nextLexicalProfile !== this.#snapshot.dialect.lexicalProfile
    ) {
      nextStatementIndexCache = null;
    } else if (
      nextStatementIndexCache &&
      nextSourceSequence !== this.#snapshot.sourceSequence
    ) {
      let nextIndex: SqlStatementIndex | null = null;
      if (
        nextSource.analysisText === this.#snapshot.source.analysisText
      ) {
        nextIndex = nextStatementIndexCache.index;
      } else if (
        documentMutation === "changes" &&
        trustedAnalysisChanges
      ) {
        nextIndex = updateSqlStatementIndex(
          nextStatementIndexCache.index,
          nextSource.analysisText,
          trustedAnalysisChanges,
          nextLexicalProfile,
        );
      }
      nextStatementIndexCache = nextIndex
        ? Object.freeze({
            index: nextIndex,
            lexicalProfile: nextLexicalProfile,
            sourceSequence: nextSourceSequence,
          })
        : null;
    }
    const activeCompletion = this.#activeCompletion;
    const refreshIntent = this.#refreshIntent;
    const invalidatesLocalRelationCache =
      nextSourceSequence !== this.#snapshot.sourceSequence ||
      nextDialect.relationDialect !==
        this.#snapshot.dialect.relationDialect;
    this.#snapshot = nextSnapshot;
    this.#statementIndexCache = nextStatementIndexCache;
    if (invalidatesLocalRelationCache) {
      this.#localRelationStatementCache = null;
    }
    this.#activeCompletion = null;
    this.#refreshIntent = null;
    this.#clearSoftRefreshIntentTimer();
    this.#clearTerminalIntent();
    if (
      activeCompletion &&
      activeCompletion.cancelReason === null
    ) {
      activeCompletion.cancelReason = "superseded";
    }
    if (
      refreshIntent &&
      refreshIntent !== activeCompletion &&
      refreshIntent.cancelReason === null
    ) {
      refreshIntent.cancelReason = "superseded";
    }
    activeCompletion?.ticket?.cancel();
    if (refreshIntent !== activeCompletion) {
      refreshIntent?.ticket?.cancel();
    }
    this.#replaceCatalogOwner();
    this.#replaceColumnOwner();
    this.#replaceNamespaceOwner();
    return this.#snapshot.revision;
  }

  readonly isCurrent = (revision: SqlRevision): boolean => {
    return !this.#disposed && revision === this.#snapshot.revision;
  };

  readonly dispose = (): void => {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    const activeCompletion = this.#activeCompletion;
    const refreshIntent = this.#refreshIntent;
    const catalogOwner = this.#catalogOwner;
    const columnOwner = this.#columnOwner;
    const namespaceOwner = this.#namespaceOwner;
    this.#activeCompletion = null;
    this.#refreshIntent = null;
    this.#catalogOwner = null;
    this.#columnOwner = null;
    this.#namespaceOwner = null;
    this.#clearSoftRefreshIntentTimer();
    this.#clearTerminalIntent();
    this.#listeners.clear();
    this.#localRelationStatementCache = null;
    this.#statementIndexCache = null;
    if (
      activeCompletion &&
      activeCompletion.cancelReason === null
    ) {
      activeCompletion.cancelReason = "disposed";
    }
    if (
      refreshIntent &&
      refreshIntent !== activeCompletion &&
      refreshIntent.cancelReason === null
    ) {
      refreshIntent.cancelReason = "disposed";
    }
    activeCompletion?.ticket?.cancel();
    if (refreshIntent !== activeCompletion) {
      refreshIntent?.ticket?.cancel();
    }
    catalogOwner?.dispose();
    columnOwner?.dispose();
    namespaceOwner?.dispose();
    this.#onDispose();
  };
}

export class DefaultSqlLanguageService<Context extends SqlDocumentContext>
  implements SqlLanguageService<Context>
{
  readonly #catalogCoordinator: SqlCatalogSearchWorkCoordinator | null;
  readonly #columnCoordinator: SqlColumnCatalogBatchCoordinator | null;
  readonly #namespaceCoordinator: SqlNamespaceCatalogCoordinator | null;
  readonly #completion: CompletionConfiguration;
  readonly #dialects: ReadonlyMap<string, SqlDialectRuntime>;
  readonly #sessions = new Set<DefaultSqlDocumentSession<Context>>();
  #disposed = false;

  constructor(options: SqlLanguageServiceOptions) {
    try {
      if (options === null || typeof options !== "object") {
        throw new SqlSessionError(
          "invalid-service-options",
          "SQL language service options must be an object",
        );
      }
      const configuredDialects = readRequiredDataProperty(
        options,
        "dialects",
        "invalid-service-options",
        "SQL language service options",
      );
      if (!Array.isArray(configuredDialects)) {
        throw new SqlSessionError(
          "invalid-service-options",
          "SQL language service dialects must be an array",
        );
      }
      const dialectCount = readArrayLength(
        configuredDialects,
        "invalid-service-options",
        "SQL language service dialects",
      );
      if (dialectCount === 0 || dialectCount > MAX_DIALECTS) {
        throw new SqlSessionError(
          "invalid-service-options",
          `SQL language service requires between 1 and ${MAX_DIALECTS} dialects`,
        );
      }

      const dialects = new Map<string, SqlDialectRuntime>();
      for (let index = 0; index < dialectCount; index += 1) {
        const dialect = readRequiredDataProperty(
          configuredDialects,
          index,
          "invalid-service-options",
          "SQL language service dialects",
        );
        const runtime = getSqlDialectRuntime(dialect);
        if (!runtime) {
          throw new SqlSessionError(
            "invalid-dialect",
            "SQL dialects must be created by a built-in dialect factory from this package instance",
          );
        }
        if (dialects.has(runtime.dialect.id)) {
          throw new SqlSessionError(
            "duplicate-dialect",
            `Duplicate SQL dialect: ${runtime.dialect.id}`,
          );
        }
        dialects.set(runtime.dialect.id, runtime);
      }
      this.#dialects = dialects;

      let catalogResponseBudgetMs =
        DEFAULT_CATALOG_RESPONSE_BUDGET_MS;
      const completion = readOwnDataProperty(
        options,
        "completion",
        "invalid-service-options",
        "SQL language service options",
      );
      if (completion.found && completion.value !== undefined) {
        if (
          completion.value === null ||
          typeof completion.value !== "object"
        ) {
          throw new SqlSessionError(
            "invalid-service-options",
            "SQL completion options must be an object",
          );
        }
        const budget = readOwnDataProperty(
          completion.value,
          "catalogResponseBudgetMs",
          "invalid-service-options",
          "SQL completion options",
        );
        if (budget.found && budget.value !== undefined) {
          if (
            typeof budget.value !== "number" ||
            !Number.isFinite(budget.value) ||
            budget.value < 0 ||
            budget.value > MAX_CATALOG_RESPONSE_BUDGET_MS
          ) {
            throw new SqlSessionError(
              "invalid-service-options",
              `Catalog response budget must be between 0 and ${MAX_CATALOG_RESPONSE_BUDGET_MS} milliseconds`,
            );
          }
          catalogResponseBudgetMs = budget.value;
        }
      }
      this.#completion = Object.freeze({
        catalogResponseBudgetMs,
      });

      const catalog = readOwnDataProperty(
        options,
        "catalog",
        "invalid-service-options",
        "SQL language service options",
      );
      if (!catalog.found || catalog.value === undefined) {
        this.#catalogCoordinator = null;
      } else {
        const captured = captureSqlRelationCatalogProvider(
          catalog.value,
        );
        if (captured.status !== "accepted") {
          throw new SqlSessionError(
            "invalid-service-options",
            "SQL relation catalog provider is invalid",
          );
        }
        const coordinator =
          createSqlCatalogSearchWorkCoordinator(captured.value);
        if (coordinator.status !== "created") {
          throw new SqlSessionError(
            "invalid-service-options",
            "SQL relation catalog coordinator could not be created",
          );
        }
        this.#catalogCoordinator = coordinator.coordinator;
      }

      const columns = readOwnDataProperty(
        options,
        "columns",
        "invalid-service-options",
        "SQL language service options",
      );
      if (!columns.found || columns.value === undefined) {
        this.#columnCoordinator = null;
      } else {
        const coordinator = createSqlColumnCatalogBatchCoordinator({
          provider: columns.value,
        });
        if (coordinator.status !== "created") {
          throw new SqlSessionError(
            "invalid-service-options",
            "SQL column catalog provider is invalid",
          );
        }
        this.#columnCoordinator = coordinator.coordinator;
      }

      const namespaces = readOwnDataProperty(
        options,
        "namespaces",
        "invalid-service-options",
        "SQL language service options",
      );
      if (!namespaces.found || namespaces.value === undefined) {
        this.#namespaceCoordinator = null;
      } else {
        const coordinator = createSqlNamespaceCatalogCoordinator({
          provider: namespaces.value,
        });
        if (coordinator.status !== "created") {
          throw new SqlSessionError(
            "invalid-service-options",
            "SQL namespace catalog provider is invalid",
          );
        }
        this.#namespaceCoordinator = coordinator.coordinator;
      }
    } catch (error) {
      if (error instanceof SqlSessionError) {
        throw error;
      }
      throw new SqlSessionError(
        "invalid-service-options",
        "SQL language service options could not be inspected safely",
      );
    }
  }

  readonly openDocument = (
    input: OpenSqlDocument<Context>,
  ): DefaultSqlDocumentSession<Context> => {
    if (this.#disposed) {
      throw new SqlSessionError("service-disposed", "SQL language service is disposed");
    }

    try {
      if (input === null || typeof input !== "object") {
        throw new SqlSessionError(
          "invalid-document",
          "Open SQL document input must be an object",
        );
      }
      const text = readRequiredDataProperty(
        input,
        "text",
        "invalid-document",
        "Open SQL document input",
      );
      if (typeof text !== "string") {
        throw new SqlSessionError(
          "invalid-document",
          "SQL document text must be a string",
        );
      }
      validateDocumentLength(text);
      const embeddedRegions = readOwnDataProperty(
        input,
        "embeddedRegions",
        "invalid-document",
        "Open SQL document input",
      );
      const source = embeddedRegions.found && embeddedRegions.value !== undefined
        ? createMaskedSqlSource(text, embeddedRegions.value)
        : createIdentitySqlSource(text);
      const candidateContext = readRequiredDataProperty(
        input,
        "context",
        "invalid-document",
        "Open SQL document input",
      );
      if (candidateContext === undefined) {
        throw new SqlSessionError(
          "invalid-document",
          "Open SQL document input requires a context value",
        );
      }
      const context = cloneContext<Context>(candidateContext);
      resolveDialectRuntime(context, this.#dialects);
      const catalogContext = resolveCatalogContext(context);
      if (
        catalogContext &&
        !this.#catalogCoordinator &&
        !this.#columnCoordinator &&
        !this.#namespaceCoordinator
      ) {
        throw new SqlSessionError(
          "invalid-context",
          "SQL catalog context requires a configured catalog provider",
        );
      }

      let session: DefaultSqlDocumentSession<Context>;
      session = new DefaultSqlDocumentSession(
        source,
        context,
        this.#dialects,
        this.#catalogCoordinator,
        this.#columnCoordinator,
        this.#namespaceCoordinator,
        this.#completion,
        () => {
          this.#sessions.delete(session);
        },
      );
      if (this.#disposed) {
        session.dispose();
        throw new SqlSessionError(
          "service-disposed",
          "SQL language service was disposed while opening the document",
        );
      }
      this.#sessions.add(session);
      return session;
    } catch (error) {
      if (this.#disposed) {
        throw new SqlSessionError(
          "service-disposed",
          "SQL language service was disposed while opening the document",
        );
      }
      if (error instanceof SqlSessionError) {
        throw error;
      }
      throw new SqlSessionError(
        "invalid-document",
        "Open SQL document input could not be inspected safely",
      );
    }
  };

  readonly dispose = (): void => {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const session of this.#sessions) {
      session.dispose();
    }
    this.#sessions.clear();
    this.#catalogCoordinator?.dispose();
    this.#columnCoordinator?.dispose();
    this.#namespaceCoordinator?.dispose();
  };
}

/** Creates a framework-independent SQL service with an immutable dialect registry. */
export function createSqlLanguageService<
  Context extends SqlDocumentContext = SqlDocumentContext,
>(options: SqlLanguageServiceOptions): SqlLanguageService<Context> {
  return new DefaultSqlLanguageService<Context>(options);
}
