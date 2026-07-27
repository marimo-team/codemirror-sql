import type {
  SqlLanguageFeatureMethods,
  SqlLanguageFeatureProvider,
} from "./language-features.js";

const revisionBrand: unique symbol = Symbol("SqlRevision");

export function isDataArray(
  value: unknown,
): value is readonly unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

/** Immutable identity issued by a document session. */
export interface SqlRevision {
  readonly [revisionBrand]: "SqlRevision";
}

export function createSqlRevisionToken(): SqlRevision {
  const revision: SqlRevision = {
    [revisionBrand]: "SqlRevision",
  };
  Object.freeze(revision);
  return revision;
}

export interface SqlIdentifierComponent {
  readonly value: string;
  readonly quoted: boolean;
}

export type SqlIdentifierPath = readonly SqlIdentifierComponent[];

export interface SqlCatalogContext {
  readonly scope: string;
  readonly searchPath?: readonly SqlIdentifierPath[];
}

export interface SqlDocumentContext {
  readonly dialect: string;
  readonly catalog?: SqlCatalogContext;
}

/** Recursively maps a type to the plain-data values accepted at runtime. */
export type SqlPlainData<Value> =
  Value extends null | undefined | string | number | boolean | bigint
    ? Value
    : Value extends (...arguments_: never[]) => unknown
      ? never
    : Value extends readonly unknown[]
      ? { readonly [Key in keyof Value]: SqlPlainData<Value[Key]> }
      : Value extends object
        ? {
            readonly [Key in keyof Value]: Key extends string
              ? SqlPlainData<Value[Key]>
              : never;
          }
        : never;

export type SqlContextInput<Context extends SqlDocumentContext> =
  Context & SqlPlainData<Context>;

const sqlDialectBrand: unique symbol = Symbol("SqlDialect");

/** Opaque in-process configuration for one built-in SQL dialect. */
export interface SqlDialect {
  readonly [sqlDialectBrand]: "SqlDialect";
  readonly id: string;
  readonly displayName: string;
}

export function createSqlDialect(
  id: string,
  displayName: string,
): SqlDialect {
  const dialect: SqlDialect = {
    [sqlDialectBrand]: "SqlDialect",
    displayName,
    id,
  };
  Object.defineProperty(dialect, sqlDialectBrand, {
    enumerable: false,
  });
  return Object.freeze(dialect);
}

/** One half-open UTF-16 range in document coordinates. */
export interface SqlTextRange {
  readonly from: number;
  readonly to: number;
}

/** One half-open UTF-16 edit in pre-update document coordinates. */
export interface SqlTextChange extends SqlTextRange {
  readonly insert: string;
}

export interface SqlDocumentReplacement {
  readonly changes?: never;
  readonly kind: "replace";
  readonly text: string;
}

export interface SqlDocumentChanges {
  readonly kind: "changes";
  readonly changes: readonly SqlTextChange[];
  readonly text?: never;
}

export type SqlDocumentEdit = SqlDocumentReplacement | SqlDocumentChanges;

export interface SqlEmbeddedRegion extends SqlTextRange {
  readonly language: string;
}

interface SqlDocumentUpdateBase {
  readonly baseRevision: SqlRevision;
  readonly kind?: never;
}

type SqlSourceUpdate<Context extends SqlDocumentContext> =
  SqlDocumentUpdateBase & {
    readonly document?: SqlDocumentEdit | undefined;
    readonly embeddedRegions: readonly SqlEmbeddedRegion[];
    readonly context?: SqlContextInput<Context> | undefined;
  };

type SqlContextUpdate<Context extends SqlDocumentContext> =
  SqlDocumentUpdateBase & {
    readonly document?: undefined;
    readonly context: SqlContextInput<Context>;
    readonly embeddedRegions?: readonly SqlEmbeddedRegion[] | undefined;
  };

/** An atomic transaction changing any non-empty subset of session inputs. */
export type SqlDocumentUpdate<Context extends SqlDocumentContext> =
  | SqlSourceUpdate<Context>
  | SqlContextUpdate<Context>;

export interface OpenSqlDocument<Context extends SqlDocumentContext> {
  readonly text: string;
  readonly context: SqlContextInput<Context>;
  readonly embeddedRegions?: readonly SqlEmbeddedRegion[] | undefined;
}

/** Owns all mutable state for one open SQL document. */
export interface SqlDocumentSession<Context extends SqlDocumentContext>
  extends SqlLanguageFeatureMethods
{
  readonly revision: SqlRevision;
  /** Invalidates relation, column, and namespace catalog observations. */
  readonly invalidateCatalog: () => SqlRevision;
  readonly statementBoundaryAt: (
    request: SqlStatementBoundaryAtRequest,
  ) => SqlStatementBoundaryAtResult;
  readonly statementBoundariesIntersecting: (
    request: SqlStatementBoundariesIntersectingRequest,
  ) => SqlStatementBoundariesIntersectingResult;
  readonly update: (update: SqlDocumentUpdate<Context>) => SqlRevision;
  readonly complete: (
    request: SqlCompletionRequest,
  ) => SqlCompletionTask;
  readonly onDidChange: (
    listener: (event: SqlSessionChangeEvent) => void,
  ) => SqlDisposable;
  readonly isCurrent: (revision: SqlRevision) => boolean;
  readonly dispose: () => void;
}

/** Shareable service configuration and lifecycle for multiple documents. */
export interface SqlLanguageService<Context extends SqlDocumentContext> {
  readonly openDocument: (
    input: OpenSqlDocument<Context>,
  ) => SqlDocumentSession<Context>;
  readonly dispose: () => void;
}

export interface SqlLanguageServiceOptions<
  Context extends SqlDocumentContext = SqlDocumentContext,
> {
  readonly catalog?: SqlRelationCatalogProvider | undefined;
  readonly columns?: SqlColumnCatalogProvider | undefined;
  readonly completion?: {
    readonly catalogResponseBudgetMs?: number | undefined;
  } | undefined;
  readonly dialects: readonly SqlDialect[];
  readonly featureProviderBudgetMs?: number | undefined;
  readonly featureProviders?:
    | readonly SqlLanguageFeatureProvider<Context>[]
    | undefined;
  readonly namespaces?: SqlNamespaceCatalogProvider | undefined;
}

export type SqlSessionErrorCode =
  | "duplicate-dialect"
  | "invalid-change"
  | "invalid-context"
  | "invalid-completion-request"
  | "invalid-dialect"
  | "invalid-document"
  | "invalid-feature-request"
  | "invalid-service-options"
  | "invalid-statement-boundary-request"
  | "invalid-update"
  | "reentrant-update"
  | "service-disposed"
  | "session-disposed"
  | "stale-revision";

export class SqlSessionError extends Error {
  readonly code: SqlSessionErrorCode;

  constructor(code: SqlSessionErrorCode, message: string) {
    super(message);
    this.name = "SqlSessionError";
    this.code = code;
  }
}
import type {
  SqlColumnCatalogProvider,
} from "./column-catalog-types.js";
import type {
  SqlNamespaceCatalogProvider,
} from "./namespace-catalog-types.js";
import type {
  SqlCompletionRequest,
  SqlCompletionTask,
  SqlDisposable,
  SqlRelationCatalogProvider,
  SqlSessionChangeEvent,
} from "./relation-completion-types.js";
import type {
  SqlStatementBoundariesIntersectingRequest,
  SqlStatementBoundariesIntersectingResult,
  SqlStatementBoundaryAtRequest,
  SqlStatementBoundaryAtResult,
} from "./statement-boundary-types.js";
