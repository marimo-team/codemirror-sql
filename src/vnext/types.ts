const revisionBrand: unique symbol = Symbol("SqlRevision");

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

type SqlDocumentMutationUpdate<Context extends SqlDocumentContext> =
  SqlDocumentUpdateBase & {
    readonly document: SqlDocumentEdit;
    readonly embeddedRegions: readonly SqlEmbeddedRegion[];
    readonly context?: SqlContextInput<Context>;
  };

type SqlContextUpdate<Context extends SqlDocumentContext> =
  SqlDocumentUpdateBase & {
    readonly document?: never;
    readonly context: SqlContextInput<Context>;
    readonly embeddedRegions?: readonly SqlEmbeddedRegion[];
  };

type SqlEmbeddedRegionUpdate =
  SqlDocumentUpdateBase & {
    readonly document?: never;
    readonly context?: never;
    readonly embeddedRegions: readonly SqlEmbeddedRegion[];
  };

/** An atomic transaction changing any non-empty subset of session inputs. */
export type SqlDocumentUpdate<Context extends SqlDocumentContext> =
  | SqlDocumentMutationUpdate<Context>
  | SqlContextUpdate<Context>
  | SqlEmbeddedRegionUpdate;

export interface OpenSqlDocument<Context extends SqlDocumentContext> {
  readonly text: string;
  readonly context: SqlContextInput<Context>;
  readonly embeddedRegions?: readonly SqlEmbeddedRegion[];
}

/** Owns all mutable state for one open SQL document. */
export interface SqlDocumentSession<Context extends SqlDocumentContext> {
  readonly revision: SqlRevision;
  readonly update: (update: SqlDocumentUpdate<Context>) => SqlRevision;
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

export interface SqlLanguageServiceOptions {
  readonly dialects: readonly SqlDialect[];
}

export type SqlSessionErrorCode =
  | "duplicate-dialect"
  | "invalid-change"
  | "invalid-context"
  | "invalid-dialect"
  | "invalid-document"
  | "invalid-service-options"
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
