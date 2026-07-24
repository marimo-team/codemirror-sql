import type { SqlEmbeddedRegion } from "./source.js";
import type {
  SqlContextInput,
  SqlDocumentContext,
  SqlDocumentEdit,
  SqlIdentifierComponent,
  SqlIdentifierPath,
  SqlRevision,
  SqlTextChange,
} from "./types.js";

// Provisional package-private declarations until the vertical slice is proven.
export interface SqlDisposable {
  readonly dispose: () => void;
}

export type SqlCatalogContainerRole =
  | "catalog"
  | "schema"
  | "project"
  | "dataset";

export interface SqlCatalogContainerComponent
  extends SqlIdentifierComponent {
  readonly role: SqlCatalogContainerRole;
}

export interface SqlCatalogRelationComponent
  extends SqlIdentifierComponent {
  readonly role: "relation";
}

export type SqlCanonicalRelationPath = readonly [
  ...containers: SqlCatalogContainerComponent[],
  relation: SqlCatalogRelationComponent,
];

export interface SqlCatalogEpoch {
  readonly generation: number;
  readonly token: string;
}

export type SqlCatalogRelationKind =
  | "temporary-table"
  | "table"
  | "view"
  | "materialized-view"
  | "external-relation";

export type SqlCatalogMatchQuality = "exact" | "equivalent";

export interface SqlCatalogRelation {
  readonly entityId: string;
  readonly relationKind: SqlCatalogRelationKind;
  readonly canonicalPath: SqlCanonicalRelationPath;
  readonly completionPathStart: number;
  readonly matchQuality: SqlCatalogMatchQuality;
  readonly detail?: string;
}

export interface SqlCatalogSearchRequest {
  readonly scope: string;
  readonly searchPaths: readonly SqlIdentifierPath[];
  readonly dialectId: string;
  readonly qualifier: SqlIdentifierPath;
  readonly prefix: SqlIdentifierComponent;
  readonly limit: number;
  readonly expectedEpoch: SqlCatalogEpoch | null;
  readonly continuationToken: string | null;
}

export type SqlCatalogReadyCoverage =
  | {
      readonly kind: "complete";
    }
  | {
      readonly kind: "partial";
    }
  | {
      readonly kind: "paginated";
      readonly continuationToken: string;
    };

export type SqlCatalogFailureCode =
  | "authentication"
  | "authorization"
  | "invalid-configuration"
  | "rate-limited"
  | "unavailable"
  | "unknown";

export type SqlCatalogRetryPolicy =
  | "never"
  | "next-request"
  | "after-invalidation";

export type SqlCatalogSearchResponse =
  | {
      readonly status: "ready";
      readonly epoch: SqlCatalogEpoch;
      readonly coverage: SqlCatalogReadyCoverage;
      readonly relations: readonly SqlCatalogRelation[];
    }
  | {
      readonly status: "loading";
      readonly epoch: SqlCatalogEpoch;
    }
  | {
      readonly status: "failed";
      readonly epoch: SqlCatalogEpoch;
      readonly code: SqlCatalogFailureCode;
      readonly retry: SqlCatalogRetryPolicy;
    };

export interface SqlCatalogInvalidation {
  readonly epoch: SqlCatalogEpoch;
}

export interface SqlRelationCatalogProvider {
  readonly id: string;
  readonly search: (
    request: SqlCatalogSearchRequest,
    signal: AbortSignal,
  ) => Promise<SqlCatalogSearchResponse>;
  readonly subscribe?: (
    scope: string,
    onInvalidation: (event: SqlCatalogInvalidation) => void,
  ) => SqlDisposable;
}

export type SqlIdentifierDecodeResult =
  | {
      readonly status: "decoded";
      readonly component: SqlIdentifierComponent;
      readonly quality: "exact" | "recovered";
    }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "invalid-identifier"
        | "unsupported-quote"
        | "undecodable-identifier";
    };

export type SqlRenderedRelationPath =
  | {
      readonly status: "rendered";
      readonly text: string;
    }
  | {
      readonly status: "unsupported";
      readonly reason: "illegal-role-sequence";
    };

export interface SqlRelationCompletionDialectRuntime {
  readonly decodeIdentifier: (
    token: string,
    mode: "complete" | "completion-prefix",
  ) => SqlIdentifierDecodeResult;
  readonly renderRelationPath: (
    path: SqlCanonicalRelationPath,
  ) => SqlRenderedRelationPath;
  readonly cteIdentifiersEqual: (
    left: SqlIdentifierComponent,
    right: SqlIdentifierComponent,
  ) => boolean;
}

export interface SqlRelationCompletionOpenDocument<
  Context extends SqlDocumentContext,
> {
  readonly text: string;
  readonly context: SqlContextInput<Context>;
  readonly embeddedRegions?: readonly SqlEmbeddedRegion[];
}

interface SqlRelationCompletionUpdateBase {
  readonly baseRevision: SqlRevision;
}

type SqlRelationCompletionDocumentUpdate<
  Context extends SqlDocumentContext,
> = SqlRelationCompletionUpdateBase & {
  readonly document: SqlDocumentEdit;
  readonly embeddedRegions: readonly SqlEmbeddedRegion[];
  readonly context?: SqlContextInput<Context>;
};

type SqlRelationCompletionContextUpdate<
  Context extends SqlDocumentContext,
> = SqlRelationCompletionUpdateBase & {
  readonly document?: never;
  readonly context: SqlContextInput<Context>;
  readonly embeddedRegions?: readonly SqlEmbeddedRegion[];
};

type SqlRelationCompletionRegionUpdate =
  SqlRelationCompletionUpdateBase & {
    readonly document?: never;
    readonly context?: never;
    readonly embeddedRegions: readonly SqlEmbeddedRegion[];
  };

export type SqlRelationCompletionDocumentTransaction<
  Context extends SqlDocumentContext,
> =
  | SqlRelationCompletionDocumentUpdate<Context>
  | SqlRelationCompletionContextUpdate<Context>
  | SqlRelationCompletionRegionUpdate;

export type SqlSessionChangeReason =
  | "catalog"
  | "catalog-availability"
  | "provider-configuration";

export interface SqlSessionChangeEvent {
  readonly revision: SqlRevision;
  readonly reason: SqlSessionChangeReason;
}

export type SqlCompletionTrigger =
  | {
      readonly kind: "invoked";
    }
  | {
      readonly kind: "trigger-character";
      readonly character: string;
    };

export interface SqlCompletionRequest {
  readonly position: number;
  readonly trigger: SqlCompletionTrigger;
  readonly signal?: AbortSignal;
}

export interface SqlCteCompletionProvenance {
  readonly kind: "cte";
  readonly declarationPosition: number;
}

export interface SqlCatalogCompletionProvenance {
  readonly kind: "catalog";
  readonly providerId: string;
  readonly entityId: string;
}

interface SqlCompletionItemBase {
  readonly label: string;
  readonly edit: SqlTextChange;
  readonly detail?: string;
}

export type SqlRelationCompletionItem =
  | (SqlCompletionItemBase & {
      readonly relationKind: "cte";
      readonly provenance: SqlCteCompletionProvenance;
    })
  | (SqlCompletionItemBase & {
      readonly relationKind: SqlCatalogRelationKind;
      readonly provenance: SqlCatalogCompletionProvenance;
    });

export type SqlCompletionIssue =
  | {
      readonly reason: "catalog-loading";
      readonly remainingIntentLeaseMs: number;
    }
  | {
      readonly reason:
        | "catalog-partial"
        | "catalog-paginated"
        | "catalog-failed"
        | "catalog-malformed"
        | "catalog-overloaded"
        | "catalog-queue-timeout"
        | "catalog-timeout"
        | "query-site-recovery"
        | "opaque-template-context"
        | "recursive-cte-uncertainty"
        | "result-limit";
    };

export type SqlRelationCompletionList =
  | {
      readonly items: readonly SqlRelationCompletionItem[];
      readonly isIncomplete: false;
      readonly issues: readonly [];
    }
  | {
      readonly items: readonly SqlRelationCompletionItem[];
      readonly isIncomplete: true;
      readonly issues: readonly [
        SqlCompletionIssue,
        ...SqlCompletionIssue[],
      ];
    };

export type SqlCompletionUnavailableReason =
  | "inactive"
  | "unsupported-query-site"
  | "opaque-statement"
  | "ambiguous-query-site"
  | "resource-limit";

export type SqlCompletionCancellationReason =
  | "caller"
  | "superseded"
  | "disposed";

export type SqlCatalogProviderUnavailableReason =
  | "queue-overloaded"
  | "queue-timeout"
  | "execution-timeout"
  | "synchronous-timeout"
  | "provider-rejected"
  | "malformed-response";

interface SqlCatalogProviderReportBase {
  readonly feature: "relation-catalog";
  readonly providerId: string;
}

export type SqlCatalogProviderReport =
  | (SqlCatalogProviderReportBase & {
      readonly outcome: "ready";
      readonly coverage: SqlCatalogReadyCoverage["kind"];
    })
  | (SqlCatalogProviderReportBase & {
      readonly outcome: "loading";
    })
  | (SqlCatalogProviderReportBase & {
      readonly outcome: "failed";
      readonly code: SqlCatalogFailureCode;
      readonly retry: SqlCatalogRetryPolicy;
    })
  | (SqlCatalogProviderReportBase & {
      readonly outcome: "unavailable";
      readonly reason: SqlCatalogProviderUnavailableReason;
    });

export interface SqlServiceFailure {
  readonly code: "internal";
  readonly retryable: boolean;
}

export type SqlRelationCompletionResult =
  | {
      readonly status: "ready";
      readonly revision: SqlRevision;
      readonly value: SqlRelationCompletionList;
      readonly sources: readonly SqlCatalogProviderReport[];
    }
  | {
      readonly status: "unavailable";
      readonly revision: SqlRevision;
      readonly reason: SqlCompletionUnavailableReason;
      readonly retryable: boolean;
    }
  | {
      readonly status: "cancelled";
      readonly revision: SqlRevision;
      readonly reason: SqlCompletionCancellationReason;
    }
  | {
      readonly status: "failed";
      readonly revision: SqlRevision;
      readonly failure: SqlServiceFailure;
    };

export interface SqlRelationCompletionSession<
  Context extends SqlDocumentContext,
> {
  readonly revision: SqlRevision;
  readonly update: (
    transaction: SqlRelationCompletionDocumentTransaction<Context>,
  ) => SqlRevision;
  readonly complete: (
    request: SqlCompletionRequest,
  ) => Promise<SqlRelationCompletionResult>;
  readonly onDidChange: (
    listener: (event: SqlSessionChangeEvent) => void,
  ) => SqlDisposable;
  readonly isCurrent: (revision: SqlRevision) => boolean;
  readonly dispose: () => void;
}
