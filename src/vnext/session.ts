import type {
  OpenSqlDocument,
  SqlDialectDefinition,
  SqlDocumentContext,
  SqlDocumentSession,
  SqlDocumentUpdate,
  SqlLanguageService,
  SqlLanguageServiceOptions,
  SqlRevision,
  SqlTextChange,
} from "./types.js";
import { createSqlRevisionToken, SqlSessionError } from "./types.js";

const MAX_CONTEXT_DEPTH = 100;
const MAX_CONTEXT_NODES = 10_000;
const MAX_CONTEXT_PROPERTIES = 50_000;
const MAX_CONTEXT_KEY_LENGTH = 1_000_000;
const MAX_CONTEXT_STRING_LENGTH = 1_000_000;
const MAX_CONTEXT_ARRAY_LENGTH = 50_000;
const MAX_DOCUMENT_LENGTH = 16 * 1024 * 1024;
const MAX_CHANGES_PER_UPDATE = 10_000;
const MAX_DIALECTS = 1_000;
const MAX_DIALECT_ID_LENGTH = 256;
const MAX_DIALECT_DISPLAY_NAME_LENGTH = 1_024;

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
    if (context === null || typeof context !== "object") {
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

function validateDialect(
  context: SqlDocumentContext,
  dialects: ReadonlySet<string>,
): void {
  if (!dialects.has(context.dialect)) {
    throw new SqlSessionError(
      "invalid-dialect",
      `Unknown SQL dialect: ${context.dialect}`,
    );
  }
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

function validateDocumentLength(text: string): void {
  if (text.length > MAX_DOCUMENT_LENGTH) {
    throw new SqlSessionError(
      "invalid-document",
      `SQL documents cannot exceed ${MAX_DOCUMENT_LENGTH} UTF-16 code units`,
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
    const from = readRequiredDataProperty(
      change,
      "from",
      "invalid-change",
      `SQL change ${index}`,
    );
    const to = readRequiredDataProperty(
      change,
      "to",
      "invalid-change",
      `SQL change ${index}`,
    );
    const insert = readRequiredDataProperty(
      change,
      "insert",
      "invalid-change",
      `SQL change ${index}`,
    );
    if (
      typeof from !== "number" ||
      typeof to !== "number" ||
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < 0 ||
      from > to ||
      to > text.length
    ) {
      throw new SqlSessionError(
        "invalid-change",
        `Invalid UTF-16 range in SQL change ${index}`,
      );
    }
    if (from < previousEnd) {
      throw new SqlSessionError(
        "invalid-change",
        "SQL document changes must be ordered and non-overlapping",
      );
    }
    if (typeof insert !== "string") {
      throw new SqlSessionError("invalid-change", "SQL change insert must be a string");
    }
    nextLength += insert.length - (to - from);
    if (nextLength > MAX_DOCUMENT_LENGTH) {
      throw new SqlSessionError(
        "invalid-document",
        `SQL documents cannot exceed ${MAX_DOCUMENT_LENGTH} UTF-16 code units`,
      );
    }
    normalized.push(
      Object.freeze({
        from,
        insert,
        to,
      }),
    );
    previousEnd = to;
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

interface SessionSnapshot<Context extends SqlDocumentContext> {
  readonly contextSequence: number;
  readonly context: Context;
  readonly documentSequence: number;
  readonly revision: SqlRevision;
  readonly sequence: number;
  readonly text: string;
}

export class DefaultSqlDocumentSession<Context extends SqlDocumentContext>
  implements SqlDocumentSession<Context>
{
  readonly #dialects: ReadonlySet<string>;
  readonly #onDispose: () => void;
  readonly #sessionId = Symbol("SqlDocumentSession");
  #disposed = false;
  #snapshot: SessionSnapshot<Context>;
  #updating = false;

  constructor(
    text: string,
    context: Context,
    dialects: ReadonlySet<string>,
    onDispose: () => void,
  ) {
    this.#dialects = dialects;
    this.#onDispose = onDispose;
    const sequence = 0;
    const contextSequence = 0;
    const documentSequence = 0;
    this.#snapshot = Object.freeze({
      contextSequence,
      context,
      documentSequence,
      revision: createSqlRevisionToken({
        contextSequence,
        documentSequence,
        environmentEpoch: 0,
        sequence,
        sessionId: this.#sessionId,
      }),
      sequence,
      text,
    });
  }

  get revision(): SqlRevision {
    return this.#snapshot.revision;
  }

  get snapshotForTesting(): SessionSnapshot<Context> {
    return this.#snapshot;
  }

  update(update: SqlDocumentUpdate<Context>): SqlRevision {
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
  }

  #applyUpdate(update: SqlDocumentUpdate<Context>): SqlRevision {
    if (update === null || typeof update !== "object") {
      throw new SqlSessionError(
        "invalid-update",
        "SQL document update must be an object",
      );
    }
    const kind = readRequiredDataProperty(
      update,
      "kind",
      "invalid-update",
      "SQL document update",
    );
    const baseRevision = readRequiredDataProperty(
      update,
      "baseRevision",
      "invalid-update",
      "SQL document update",
    );
    if (baseRevision !== this.#snapshot.revision) {
      throw new SqlSessionError("stale-revision", "SQL document revision is stale");
    }
    if (kind !== "document" && kind !== "context") {
      throw new SqlSessionError(
        "invalid-update",
        "SQL document update kind must be document or context",
      );
    }

    let nextContextSequence = this.#snapshot.contextSequence;
    let nextContext = this.#snapshot.context;
    let nextDocumentSequence = this.#snapshot.documentSequence;
    let nextText = this.#snapshot.text;

    if (kind === "context") {
      if (
        readOwnDataProperty(
          update,
          "document",
          "invalid-update",
          "SQL context update",
        ).found
      ) {
        throw new SqlSessionError(
          "invalid-update",
          "SQL context update cannot contain a document mutation",
        );
      }
      const context = readRequiredDataProperty(
        update,
        "context",
        "invalid-update",
        "SQL context update",
      );
      if (context === undefined) {
        throw new SqlSessionError(
          "invalid-update",
          "SQL context update requires a context value",
        );
      }
      nextContext = cloneContext(context);
      nextContextSequence += 1;
    } else {
      const document = readRequiredDataProperty(
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
      if (context.found) {
        if (context.value === undefined) {
          throw new SqlSessionError(
            "invalid-update",
            "SQL document update context cannot be undefined",
          );
        }
        nextContext = cloneContext(context.value);
        nextContextSequence += 1;
      }
      if (document === null || typeof document !== "object") {
        throw new SqlSessionError(
          "invalid-update",
          "SQL document mutation must be an object",
        );
      }
      const documentKind = readRequiredDataProperty(
        document,
        "kind",
        "invalid-update",
        "SQL document mutation",
      );
      if (documentKind === "replace") {
        if (
          readOwnDataProperty(
            document,
            "changes",
            "invalid-update",
            "SQL document replacement",
          ).found
        ) {
          throw new SqlSessionError(
            "invalid-update",
            "SQL document replacement cannot also contain changes",
          );
        }
        const text = readRequiredDataProperty(
          document,
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
      } else if (documentKind === "changes") {
        if (
          readOwnDataProperty(
            document,
            "text",
            "invalid-update",
            "SQL document changes",
          ).found
        ) {
          throw new SqlSessionError(
            "invalid-update",
            "SQL document changes cannot also contain replacement text",
          );
        }
        const changes = readRequiredDataProperty(
          document,
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
        const normalizedChanges = normalizeChanges(nextText, changes);
        nextText = applyChanges(nextText, normalizedChanges);
      } else {
        throw new SqlSessionError(
          "invalid-update",
          "SQL document mutation kind must be replace or changes",
        );
      }
      nextDocumentSequence += 1;
    }

    validateDialect(nextContext, this.#dialects);
    if (this.#disposed) {
      throw new SqlSessionError(
        "session-disposed",
        "SQL document session was disposed during the update",
      );
    }
    const sequence = this.#snapshot.sequence + 1;
    const revision = createSqlRevisionToken({
      contextSequence: nextContextSequence,
      documentSequence: nextDocumentSequence,
      environmentEpoch: 0,
      sequence,
      sessionId: this.#sessionId,
    });
    this.#snapshot = Object.freeze({
      contextSequence: nextContextSequence,
      context: nextContext,
      documentSequence: nextDocumentSequence,
      revision,
      sequence,
      text: nextText,
    });
    return revision;
  }

  isCurrent(revision: SqlRevision): boolean {
    return !this.#disposed && revision === this.#snapshot.revision;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#onDispose();
  }
}

export class DefaultSqlLanguageService<Context extends SqlDocumentContext>
  implements SqlLanguageService<Context>
{
  readonly #dialects: ReadonlySet<string>;
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

      const dialects = new Set<string>();
      for (let index = 0; index < dialectCount; index += 1) {
        const dialect = readRequiredDataProperty(
          configuredDialects,
          index,
          "invalid-service-options",
          "SQL language service dialects",
        );
        const definition = defineSqlDialect(dialect);
        if (dialects.has(definition.id)) {
          throw new SqlSessionError(
            "duplicate-dialect",
            `Duplicate SQL dialect: ${definition.id}`,
          );
        }
        dialects.add(definition.id);
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

  openDocument(input: OpenSqlDocument<Context>): DefaultSqlDocumentSession<Context> {
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
      const context = cloneContext(candidateContext);
      validateDialect(context, this.#dialects);

      let session: DefaultSqlDocumentSession<Context>;
      session = new DefaultSqlDocumentSession(
        text,
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
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const session of this.#sessions) {
      session.dispose();
    }
    this.#sessions.clear();
  }
}

/** Validates and normalizes one immutable dialect registration. */
export function defineSqlDialect(
  definition: SqlDialectDefinition,
): SqlDialectDefinition {
  try {
    if (definition === null || typeof definition !== "object") {
      throw new SqlSessionError(
        "invalid-dialect",
        "SQL dialect definition must be an object",
      );
    }
    const id = readRequiredDataProperty(
      definition,
      "id",
      "invalid-dialect",
      "SQL dialect definition",
    );
    const displayName = readRequiredDataProperty(
      definition,
      "displayName",
      "invalid-dialect",
      "SQL dialect definition",
    );
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > MAX_DIALECT_ID_LENGTH ||
      id.trim().length === 0
    ) {
      throw new SqlSessionError(
        "invalid-dialect",
        `SQL dialect id must contain 1 to ${MAX_DIALECT_ID_LENGTH} code units`,
      );
    }
    if (
      typeof displayName !== "string" ||
      displayName.length === 0 ||
      displayName.length > MAX_DIALECT_DISPLAY_NAME_LENGTH ||
      displayName.trim().length === 0
    ) {
      throw new SqlSessionError(
        "invalid-dialect",
        `SQL dialect display name must contain 1 to ${MAX_DIALECT_DISPLAY_NAME_LENGTH} code units`,
      );
    }
    return Object.freeze({ displayName, id });
  } catch (error) {
    if (error instanceof SqlSessionError) {
      throw error;
    }
    throw new SqlSessionError(
      "invalid-dialect",
      "SQL dialect definition could not be inspected safely",
    );
  }
}

/** Creates a framework-independent SQL service with an immutable dialect registry. */
export function createSqlLanguageService<
  Context extends SqlDocumentContext = SqlDocumentContext,
>(options: SqlLanguageServiceOptions): SqlLanguageService<Context> {
  return new DefaultSqlLanguageService<Context>(options);
}
