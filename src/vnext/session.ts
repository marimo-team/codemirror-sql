import type {
  OpenSqlDocument,
  SqlDocumentContext,
  SqlDocumentSession,
  SqlDocumentUpdate,
  SqlLanguageService,
  SqlLanguageServiceOptions,
  SqlRevision,
  SqlTextChange,
  SqlTextRange,
} from "./types.js";
import {
  BIGQUERY_SQL_LEXICAL_PROFILE,
  buildSqlStatementIndex,
  DREMIO_SQL_LEXICAL_PROFILE,
  DUCKDB_SQL_LEXICAL_PROFILE,
  POSTGRESQL_SQL_LEXICAL_PROFILE,
  type SqlLexicalProfile,
  type SqlStatementIndex,
  updateSqlStatementIndex,
} from "./statement-index.js";
import {
  createIdentitySqlSource,
  createMaskedSqlSource,
  isSqlSourceError,
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

const MAX_CONTEXT_DEPTH = 100;
const MAX_CONTEXT_NODES = 10_000;
const MAX_CONTEXT_PROPERTIES = 50_000;
const MAX_CONTEXT_KEY_LENGTH = 1_000_000;
const MAX_CONTEXT_STRING_LENGTH = 1_000_000;
const MAX_CONTEXT_ARRAY_LENGTH = 50_000;
const MAX_CHANGES_PER_UPDATE = 10_000;
const MAX_DIALECTS = 1_000;

interface SqlDialectRuntime {
  readonly dialect: SqlDialect;
  readonly lexicalProfile: SqlLexicalProfile;
}

const sqlDialectRuntimes = new WeakMap<object, SqlDialectRuntime>();

function createBuiltinSqlDialect(
  id: string,
  displayName: string,
  lexicalProfile: SqlLexicalProfile,
): SqlDialect {
  const dialect = createSqlDialect(id, displayName);
  sqlDialectRuntimes.set(
    dialect,
    Object.freeze({ dialect, lexicalProfile }),
  );
  return dialect;
}

const BIGQUERY_DIALECT = createBuiltinSqlDialect(
  "bigquery",
  "BigQuery",
  BIGQUERY_SQL_LEXICAL_PROFILE,
);
const DREMIO_DIALECT = createBuiltinSqlDialect(
  "dremio",
  "Dremio",
  DREMIO_SQL_LEXICAL_PROFILE,
);
const DUCKDB_DIALECT = createBuiltinSqlDialect(
  "duckdb",
  "DuckDB",
  DUCKDB_SQL_LEXICAL_PROFILE,
);
const POSTGRES_DIALECT = createBuiltinSqlDialect(
  "postgresql",
  "PostgreSQL",
  POSTGRESQL_SQL_LEXICAL_PROFILE,
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
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new SqlSessionError(
        "invalid-context",
        "SQL document context cannot contain accessors",
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

export class DefaultSqlDocumentSession<Context extends SqlDocumentContext>
  implements SqlDocumentSession<Context>
{
  readonly #dialects: ReadonlyMap<string, SqlDialectRuntime>;
  readonly #onDispose: () => void;
  #disposed = false;
  #snapshot: SessionSnapshot<Context>;
  #statementIndexCache: StatementIndexCache | null = null;
  #updating = false;

  constructor(
    source: SqlSourceSnapshot,
    context: Context,
    dialects: ReadonlyMap<string, SqlDialectRuntime>,
    onDispose: () => void,
  ) {
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

  getStatementIndexForTesting(): SqlStatementIndex {
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
    if (!document.found && !context.found && !embeddedRegions.found) {
      throw new SqlSessionError(
        "invalid-update",
        "SQL document update must change document, context, or embedded regions",
      );
    }
    if (document.found && !embeddedRegions.found) {
      throw new SqlSessionError(
        "invalid-update",
        "SQL document mutations require the complete resulting embedded regions",
      );
    }
    if (
      (document.found && document.value === undefined) ||
      (context.found && context.value === undefined) ||
      (embeddedRegions.found && embeddedRegions.value === undefined)
    ) {
      throw new SqlSessionError(
        "invalid-update",
        "SQL document update values cannot be undefined",
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
    if (document.found) {
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

    if (embeddedRegions.found) {
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

    if (context.found) {
      if (context.value === undefined) {
        throw new SqlSessionError(
          "invalid-update",
          "SQL document update context cannot be undefined",
        );
      }
      nextContext = cloneContext<Context>(context.value);
      nextContextSequence += 1;
    }

    const nextDialect = resolveDialectRuntime(
      nextContext,
      this.#dialects,
    );
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
    this.#snapshot = nextSnapshot;
    this.#statementIndexCache = nextStatementIndexCache;
    return revision;
  }

  readonly isCurrent = (revision: SqlRevision): boolean => {
    return !this.#disposed && revision === this.#snapshot.revision;
  };

  readonly dispose = (): void => {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#statementIndexCache = null;
    this.#onDispose();
  };
}

export class DefaultSqlLanguageService<Context extends SqlDocumentContext>
  implements SqlLanguageService<Context>
{
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
      if (embeddedRegions.found && embeddedRegions.value === undefined) {
        throw new SqlSessionError(
          "invalid-document",
          "Open SQL document embedded regions cannot be undefined",
        );
      }
      const source = embeddedRegions.found
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

      let session: DefaultSqlDocumentSession<Context>;
      session = new DefaultSqlDocumentSession(
        source,
        context,
        this.#dialects,
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
  };
}

/** Creates a framework-independent SQL service with an immutable dialect registry. */
export function createSqlLanguageService<
  Context extends SqlDocumentContext = SqlDocumentContext,
>(options: SqlLanguageServiceOptions): SqlLanguageService<Context> {
  return new DefaultSqlLanguageService<Context>(options);
}
