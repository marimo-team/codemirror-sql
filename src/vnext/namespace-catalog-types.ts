import type { SqlCatalogEpoch } from "./relation-completion-types.js";
import type {
  SqlIdentifierComponent,
  SqlIdentifierPath,
  SqlTextRange,
} from "./types.js";

export type SqlNamespaceContainerRole =
  | "catalog"
  | "schema"
  | "project"
  | "dataset";

export interface SqlNamespacePathComponent
  extends SqlIdentifierComponent {
  readonly role: SqlNamespaceContainerRole;
}

export type SqlCanonicalNamespacePath =
  readonly [
    SqlNamespacePathComponent,
    ...SqlNamespacePathComponent[],
  ];

export interface SqlNamespaceCatalogSearchRequest {
  readonly dialectId: string;
  readonly expectedEpoch: SqlCatalogEpoch | null;
  readonly limit: number;
  readonly prefix: SqlIdentifierComponent;
  readonly qualifier: SqlIdentifierPath;
  readonly scope: string;
  readonly searchPaths: readonly SqlIdentifierPath[];
}

export interface SqlNamespaceCatalogContainer {
  readonly canonicalPath: SqlCanonicalNamespacePath;
  readonly containerEntityId: string;
  readonly detail?: string;
  readonly insertText: string;
  readonly matchQuality: "equivalent" | "exact";
}

export type SqlNamespaceCatalogSearchResponse =
  | {
      readonly containers:
        readonly SqlNamespaceCatalogResolvedContainer[];
      readonly coverage: "complete" | "partial";
      readonly epoch: SqlCatalogEpoch;
      readonly status: "ready";
    }
  | {
      readonly epoch: SqlCatalogEpoch;
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
      readonly epoch: SqlCatalogEpoch;
      readonly retry:
        | "after-invalidation"
        | "never"
        | "next-request";
      readonly status: "failed";
    };

export interface SqlNamespaceCatalogProvenance {
  readonly containerEntityId: string;
  readonly epoch: SqlCatalogEpoch;
  readonly providerId: string;
  readonly scope: string;
}

export interface SqlNamespaceCatalogResolvedContainer
  extends SqlNamespaceCatalogContainer {
  readonly provenance: SqlNamespaceCatalogProvenance;
}

export interface SqlNamespaceCatalogProvider {
  readonly id: string;
  readonly search: (
    this: void,
    request: SqlNamespaceCatalogSearchRequest,
    signal: AbortSignal,
  ) => Promise<unknown>;
}

export interface SqlNamespaceQuerySite {
  readonly prefix: SqlIdentifierComponent;
  readonly qualifier: SqlIdentifierPath;
  readonly replacementRange: SqlTextRange;
}
