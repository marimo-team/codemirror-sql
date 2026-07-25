import type {
  SqlNamespaceCatalogSearchInput,
  SqlNamespaceCatalogSearchOutcome,
} from "./namespace-catalog-coordinator.js";
import type {
  SqlNamespaceCatalogResolvedContainer,
  SqlNamespaceContainerRole,
  SqlNamespaceQuerySite,
} from "./namespace-catalog-types.js";
import type {
  SqlCatalogEpoch,
} from "./relation-completion-types.js";
import type {
  SqlIdentifierComponent,
  SqlIdentifierPath,
  SqlTextRange,
} from "./types.js";

export interface SqlNamespaceCompletionProvenance {
  readonly containerEntityId: string;
  readonly epoch: SqlCatalogEpoch;
  readonly kind: "namespace-catalog";
  readonly providerId: string;
  readonly scope: string;
}

export interface SqlNamespaceCompletionItem {
  readonly detail?: string;
  readonly edit: {
    readonly from: number;
    readonly insert: string;
    readonly to: number;
  };
  readonly label: string;
  readonly role: SqlNamespaceContainerRole;
  readonly provenance: SqlNamespaceCompletionProvenance;
}

export type SqlNamespaceCompletionIssue =
  | "namespace-catalog-failed"
  | "namespace-catalog-loading"
  | "namespace-catalog-malformed"
  | "namespace-catalog-partial"
  | "namespace-prefix-uncertain"
  | "result-limit";

export interface SqlNamespaceCompletionList {
  readonly isIncomplete: boolean;
  readonly issues: readonly SqlNamespaceCompletionIssue[];
  readonly items: readonly SqlNamespaceCompletionItem[];
}

export type SqlNamespaceCatalogProviderReport =
  | {
      readonly coverage: "complete" | "partial";
      readonly outcome: "ready";
      readonly providerId: string;
    }
  | {
      readonly outcome: "loading";
      readonly providerId: string;
    }
  | {
      readonly outcome: "failed";
      readonly providerId: string;
    }
  | {
      readonly outcome: "unavailable";
      readonly providerId: string;
      readonly reason:
        | "disposed"
        | "invalid-request"
        | "malformed-response"
        | "provider-failed";
    };

export interface SqlNamespaceCompletionComposition {
  readonly source: SqlNamespaceCatalogProviderReport;
  readonly value: SqlNamespaceCompletionList;
}

export type SqlNamespacePrefixMatcher = (
  this: void,
  candidate: SqlIdentifierComponent,
  prefix: SqlIdentifierComponent,
) => "match" | "no-match" | "unknown";

const ROLE_ORDER: Readonly<Record<SqlNamespaceContainerRole, number>> =
  Object.freeze({
    catalog: 0,
    project: 1,
    schema: 2,
    dataset: 3,
  });

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function last<Value>(values: readonly Value[]): Value | null {
  return values[values.length - 1] ?? null;
}

function pathText(
  container: SqlNamespaceCatalogResolvedContainer,
): string {
  return container.canonicalPath.map((component) =>
    `${component.role}:${component.quoted ? "q" : "u"}:${component.value}`
  ).join("\u0000");
}

function compareContainers(
  left: SqlNamespaceCatalogResolvedContainer,
  right: SqlNamespaceCatalogResolvedContainer,
): number {
  const leftLast = last(left.canonicalPath);
  const rightLast = last(right.canonicalPath);
  return (
    (left.matchQuality === right.matchQuality
      ? 0
      : left.matchQuality === "exact"
        ? -1
        : 1) ||
    left.canonicalPath.length - right.canonicalPath.length ||
    (
      leftLast && rightLast
        ? ROLE_ORDER[leftLast.role] - ROLE_ORDER[rightLast.role]
        : 0
    ) ||
    compareText(leftLast?.value ?? "", rightLast?.value ?? "") ||
    compareText(pathText(left), pathText(right)) ||
    compareText(
      left.provenance.containerEntityId,
      right.provenance.containerEntityId,
    )
  );
}

function list(
  items: readonly SqlNamespaceCompletionItem[],
  issues: readonly SqlNamespaceCompletionIssue[],
): SqlNamespaceCompletionList {
  return Object.freeze({
    isIncomplete: issues.length > 0,
    issues: Object.freeze(issues),
    items: Object.freeze(items),
  });
}

export function prepareSqlNamespaceCatalogSearch(
  site: SqlNamespaceQuerySite,
  expectedEpoch: SqlCatalogEpoch | null,
  searchPaths: readonly SqlIdentifierPath[],
  limit: number,
): SqlNamespaceCatalogSearchInput {
  return Object.freeze({
    expectedEpoch,
    limit,
    prefix: site.prefix,
    qualifier: site.qualifier,
    searchPaths,
  });
}

function unavailable(
  providerId: string,
  reason: Extract<
    SqlNamespaceCatalogSearchOutcome,
    { readonly status: "unavailable" }
  >["reason"],
): SqlNamespaceCompletionComposition {
  return Object.freeze({
    source: Object.freeze({
      outcome: "unavailable",
      providerId,
      reason,
    }),
    value: list(
      [],
      [reason === "malformed-response"
        ? "namespace-catalog-malformed"
        : "namespace-catalog-failed"],
    ),
  });
}

function item(
  container: SqlNamespaceCatalogResolvedContainer,
  replacementRange: SqlTextRange,
): SqlNamespaceCompletionItem | null {
  const component = last(container.canonicalPath);
  if (!component) return null;
  return Object.freeze({
    ...(container.detail === undefined
      ? {}
      : { detail: container.detail }),
    edit: Object.freeze({
      from: replacementRange.from,
      insert: container.insertText,
      to: replacementRange.to,
    }),
    label: component.value,
    provenance: Object.freeze({
      containerEntityId: container.provenance.containerEntityId,
      epoch: container.provenance.epoch,
      kind: "namespace-catalog",
      providerId: container.provenance.providerId,
      scope: container.provenance.scope,
    }),
    role: component.role,
  });
}

export function composeSqlNamespaceCompletion(
  input: {
    readonly matchPrefix: SqlNamespacePrefixMatcher;
    readonly outcome: SqlNamespaceCatalogSearchOutcome;
    readonly prefix: SqlIdentifierComponent;
    readonly providerId: string;
    readonly replacementRange: SqlTextRange;
  },
): SqlNamespaceCompletionComposition | null {
  if (
    input.outcome.status === "cancelled" ||
    input.outcome.status === "superseded"
  ) {
    return null;
  }
  if (input.outcome.status === "unavailable") {
    return unavailable(input.providerId, input.outcome.reason);
  }
  const response = input.outcome.response;
  if (response.status === "loading") {
    return Object.freeze({
      source: Object.freeze({
        outcome: "loading",
        providerId: input.outcome.providerId,
      }),
      value: list([], ["namespace-catalog-loading"]),
    });
  }
  if (response.status === "failed") {
    return Object.freeze({
      source: Object.freeze({
        outcome: "failed",
        providerId: input.outcome.providerId,
      }),
      value: list([], ["namespace-catalog-failed"]),
    });
  }
  const issues = new Set<SqlNamespaceCompletionIssue>();
  if (response.coverage === "partial") {
    issues.add("namespace-catalog-partial");
  }
  const seen = new Set<string>();
  const containers: SqlNamespaceCatalogResolvedContainer[] = [];
  for (const container of response.containers) {
    const component = last(container.canonicalPath);
    if (!component) continue;
    let match: ReturnType<SqlNamespacePrefixMatcher>;
    try {
      match = input.matchPrefix(component, input.prefix);
    } catch {
      match = "unknown";
    }
    if (match === "unknown") {
      issues.add("namespace-prefix-uncertain");
      continue;
    }
    if (match === "no-match") continue;
    const identity = [
      container.provenance.providerId,
      container.provenance.scope,
      container.provenance.containerEntityId,
    ].join("\u0000");
    if (seen.has(identity)) continue;
    seen.add(identity);
    containers.push(container);
  }
  containers.sort(compareContainers);
  const items = containers.flatMap((container) => {
    const value = item(container, input.replacementRange);
    return value ? [value] : [];
  });
  return Object.freeze({
    source: Object.freeze({
      coverage: response.coverage,
      outcome: "ready",
      providerId: input.outcome.providerId,
    }),
    value: list(items, [...issues]),
  });
}
