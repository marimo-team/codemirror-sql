import type {
  SqlIdentifierComponent,
  SqlIdentifierPath,
  SqlRevision,
  SqlTextChange,
} from "./types.js";

// Provisional package-private declarations until the vertical slice is proven.
export interface SqlDisposable {
  readonly dispose: (this: void) => void;
}

export type SqlCatalogSubscriptionCleanup = (
  this: void,
) => undefined;

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
    this: void,
    request: SqlCatalogSearchRequest,
    signal: AbortSignal,
  ) => Promise<SqlCatalogSearchResponse>;
  readonly subscribe?: (
    this: void,
    scope: string,
    onInvalidation: (event: SqlCatalogInvalidation) => void,
  ) => SqlCatalogSubscriptionCleanup;
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

export type SqlCteIdentifierComparison =
  | "distinct"
  | "equal"
  | "unknown";

export type SqlCteIdentifierPrefixMatch =
  | "match"
  | "no-match"
  | "unknown";

export interface SqlRelationCompletionDialectRuntime {
  readonly decodeIdentifier: (
    token: string,
    mode: "complete" | "completion-prefix",
  ) => SqlIdentifierDecodeResult;
  readonly renderRelationPath: (
    path: SqlCanonicalRelationPath,
  ) => SqlRenderedRelationPath;
  readonly compareCteIdentifiers: (
    left: SqlIdentifierComponent,
    right: SqlIdentifierComponent,
  ) => SqlCteIdentifierComparison;
  readonly cteIdentifierMatchesPrefix: (
    candidate: SqlIdentifierComponent,
    prefix: SqlIdentifierComponent,
  ) => SqlCteIdentifierPrefixMatch;
}

export type SqlSessionChangeReason =
  | "catalog"
  | "catalog-availability"
  | "provider-configuration";

const completionRefreshTokenBrand: unique symbol = Symbol(
  "SqlCompletionRefreshToken",
);

/** Opaque, in-process identity for one completion refresh intent. */
export interface SqlCompletionRefreshToken {
  readonly [completionRefreshTokenBrand]: "SqlCompletionRefreshToken";
}

/** @internal */
export function createSqlCompletionRefreshToken(): SqlCompletionRefreshToken {
  const token: SqlCompletionRefreshToken = {
    [completionRefreshTokenBrand]: "SqlCompletionRefreshToken",
  };
  Object.freeze(token);
  return token;
}

export type SqlSessionChangeEvent =
  | {
      readonly revision: SqlRevision;
      readonly reason: "catalog-availability";
      readonly refreshToken: SqlCompletionRefreshToken;
    }
  | {
      readonly revision: SqlRevision;
      readonly reason: "catalog";
      readonly refreshToken: SqlCompletionRefreshToken | null;
    }
  | {
      readonly revision: SqlRevision;
      readonly reason: "provider-configuration";
      readonly refreshToken: null;
    };

export type SqlCompletionTrigger =
  | {
      readonly character?: never;
      readonly kind: "invoked";
    }
  | {
      readonly kind: "trigger-character";
      readonly character: string;
    };

export interface SqlCompletionRequest {
  readonly position: number;
  readonly trigger: SqlCompletionTrigger;
  readonly signal?: AbortSignal | undefined;
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

export interface SqlColumnCompletionProvenance {
  readonly kind: "column-catalog";
  readonly providerId: string;
  readonly scope: string;
  readonly epoch: SqlCatalogEpoch;
  readonly relationEntityId: string;
  readonly columnEntityId: string;
}

export interface SqlNamespaceCompletionProvenance {
  readonly containerEntityId: string;
  readonly epoch: SqlCatalogEpoch;
  readonly kind: "namespace-catalog";
  readonly providerId: string;
  readonly scope: string;
}

interface SqlCompletionItemBase {
  readonly label: string;
  readonly edit: SqlTextChange;
  readonly detail?: string;
}

export type SqlCompletionItem =
  | (SqlCompletionItemBase & {
      readonly kind: "relation";
      readonly relationKind: "cte";
      readonly provenance: SqlCteCompletionProvenance;
    })
  | (SqlCompletionItemBase & {
      readonly kind: "relation";
      readonly relationKind: SqlCatalogRelationKind;
      readonly provenance: SqlCatalogCompletionProvenance;
    })
  | (SqlCompletionItemBase & {
      readonly dataType?: string;
      readonly kind: "column";
      readonly provenance: SqlColumnCompletionProvenance;
      readonly relationRequestKey: string;
    })
  | (SqlCompletionItemBase & {
      readonly kind: "namespace";
      readonly provenance: SqlNamespaceCompletionProvenance;
      readonly role: SqlCatalogContainerRole;
    });

export type SqlCompletionIssue =
  | {
      readonly reason: "catalog-loading";
      readonly remainingIntentLeaseMs: number;
    }
  | {
      readonly reason:
        | "column-catalog-loading"
        | "namespace-catalog-loading";
      readonly remainingIntentLeaseMs?: number;
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
        | "column-catalog-failed"
        | "column-catalog-malformed"
        | "column-catalog-partial"
        | "cte-scope-uncertainty"
        | "namespace-catalog-failed"
        | "namespace-catalog-malformed"
        | "namespace-catalog-partial"
        | "namespace-prefix-uncertain"
        | "query-binding-partial"
        | "query-site-recovery"
        | "opaque-template-context"
        | "recursive-cte-uncertainty"
        | "result-limit";
    };

export type SqlCompletionList =
  | {
      readonly items: readonly SqlCompletionItem[];
      readonly isIncomplete: false;
      readonly issues: readonly [];
    }
  | {
      readonly items: readonly SqlCompletionItem[];
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

export type SqlColumnCatalogProviderReport =
  | {
      readonly feature: "column-catalog";
      readonly outcome: "ready";
      readonly providerId: string;
      readonly coverage: "complete" | "partial";
      readonly failures: readonly SqlColumnCatalogFailure[];
    }
  | {
      readonly feature: "column-catalog";
      readonly outcome: "loading";
      readonly providerId: string;
      readonly failures: readonly SqlColumnCatalogFailure[];
    }
  | {
      readonly feature: "column-catalog";
      readonly outcome: "failed";
      readonly providerId: string;
      readonly failures: readonly [
        SqlColumnCatalogFailure,
        ...SqlColumnCatalogFailure[],
      ];
    }
  | {
      readonly feature: "column-catalog";
      readonly outcome: "unavailable";
      readonly providerId: string;
      readonly reason:
        | "disposed"
        | "invalid-request"
        | "malformed-response"
        | "provider-failed";
    };

export interface SqlColumnCatalogFailure {
  readonly code: SqlCatalogFailureCode;
  readonly requestKey: string;
  readonly retry: SqlCatalogRetryPolicy;
}

export type SqlNamespaceCatalogProviderReport =
  | {
      readonly coverage: "complete" | "partial";
      readonly feature: "namespace-catalog";
      readonly outcome: "ready";
      readonly providerId: string;
    }
  | {
      readonly feature: "namespace-catalog";
      readonly outcome: "loading";
      readonly providerId: string;
    }
  | {
      readonly feature: "namespace-catalog";
      readonly outcome: "failed";
      readonly providerId: string;
      readonly code: SqlCatalogFailureCode;
      readonly retry: SqlCatalogRetryPolicy;
    }
  | {
      readonly feature: "namespace-catalog";
      readonly outcome: "unavailable";
      readonly providerId: string;
      readonly reason:
        | "disposed"
        | "invalid-request"
        | "malformed-response"
        | "provider-failed";
    };

export type SqlCompletionProviderReport =
  | SqlCatalogProviderReport
  | SqlColumnCatalogProviderReport
  | SqlNamespaceCatalogProviderReport;

export interface SqlServiceFailure {
  readonly code: "internal";
  readonly retryable: boolean;
}

export type SqlCompletionResult =
  | {
      readonly status: "ready";
      readonly revision: SqlRevision;
      readonly refreshToken: SqlCompletionRefreshToken | null;
      readonly value: SqlCompletionList;
      readonly sources: readonly SqlCompletionProviderReport[];
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

/**
 * A completion invocation whose identity is available before provider work
 * starts.
 */
export interface SqlCompletionTask
  extends Promise<SqlCompletionResult> {
  readonly refreshToken: SqlCompletionRefreshToken;
}
