import type { SqlCatalogEpoch } from "./relation-completion-types.js";
import type {
  SqlIdentifierComponent,
  SqlIdentifierPath,
} from "./types.js";

export type SqlColumnCatalogCoverage = "complete" | "partial";

export interface SqlColumnCatalogRelationReference {
  readonly path: SqlIdentifierPath;
  readonly requestKey: string;
}

export interface SqlColumnCatalogBatchRequest {
  readonly dialectId: string;
  readonly expectedEpoch: SqlCatalogEpoch | null;
  readonly relations: readonly SqlColumnCatalogRelationReference[];
  readonly searchPaths: readonly SqlIdentifierPath[];
  readonly scope: string;
}

export interface SqlColumnCatalogColumn {
  readonly columnEntityId: string;
  readonly dataType?: string;
  readonly detail?: string;
  readonly identifier: SqlIdentifierComponent;
  readonly insertText: string;
  readonly ordinal: number;
}

export interface SqlColumnCatalogProvenance {
  readonly columnEntityId: string;
  readonly epoch: SqlCatalogEpoch;
  readonly providerId: string;
  readonly relationEntityId: string;
  readonly scope: string;
}

export interface SqlColumnCatalogResolvedColumn
  extends SqlColumnCatalogColumn {
  readonly provenance: SqlColumnCatalogProvenance;
}

export type SqlColumnCatalogRelationResult =
  | {
      readonly columns: readonly SqlColumnCatalogResolvedColumn[];
      readonly coverage: SqlColumnCatalogCoverage;
      readonly relationEntityId: string;
      readonly requestKey: string;
      readonly status: "ready";
    }
  | {
      readonly requestKey: string;
      readonly status: "loading";
    }
  | {
      readonly code:
        | "authentication"
        | "authorization"
        | "invalid-configuration"
        | "rate-limited"
        | "unavailable"
        | "unknown";
      readonly requestKey: string;
      readonly retry: "after-invalidation" | "never" | "next-request";
      readonly status: "failed";
    };

export interface SqlColumnCatalogBatchResponse {
  readonly epoch: SqlCatalogEpoch;
  readonly relations: readonly SqlColumnCatalogRelationResult[];
}

export type SqlColumnCatalogProviderRelationResult =
  | {
      readonly columns: readonly SqlColumnCatalogColumn[];
      readonly coverage: SqlColumnCatalogCoverage;
      readonly relationEntityId: string;
      readonly requestKey: string;
      readonly status: "ready";
    }
  | Extract<
      SqlColumnCatalogRelationResult,
      { readonly status: "loading" | "failed" }
    >;

export interface SqlColumnCatalogProviderResponse {
  readonly epoch: SqlCatalogEpoch;
  readonly relations:
    readonly SqlColumnCatalogProviderRelationResult[];
}

export interface SqlColumnCatalogProvider {
  readonly id: string;
  readonly loadColumns: (
    this: void,
    request: SqlColumnCatalogBatchRequest,
    signal: AbortSignal,
  ) => Promise<SqlColumnCatalogProviderResponse>;
}
