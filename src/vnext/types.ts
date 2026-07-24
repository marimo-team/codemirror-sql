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

export interface SqlCatalogContext {
  readonly scope: string;
  readonly searchPath?: readonly string[];
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

export interface SqlDialectDefinition {
  readonly id: string;
  readonly displayName: string;
}

/** One half-open UTF-16 edit in pre-update document coordinates. */
export interface SqlTextChange {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

export interface SqlDocumentReplacement {
  readonly kind: "replace";
  readonly text: string;
}

export interface SqlDocumentChanges {
  readonly kind: "changes";
  readonly changes: readonly SqlTextChange[];
}

export type SqlDocumentEdit = SqlDocumentReplacement | SqlDocumentChanges;

/** An atomic document or context transaction against one base revision. */
export type SqlDocumentUpdate<Context extends SqlDocumentContext> =
  | {
      readonly kind: "document";
      readonly baseRevision: SqlRevision;
      readonly document: SqlDocumentEdit;
      readonly context?: SqlContextInput<Context>;
    }
  | {
      readonly kind: "context";
      readonly baseRevision: SqlRevision;
      readonly context: SqlContextInput<Context>;
    };

export interface OpenSqlDocument<Context extends SqlDocumentContext> {
  readonly text: string;
  readonly context: SqlContextInput<Context>;
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
  readonly dialects: readonly SqlDialectDefinition[];
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
