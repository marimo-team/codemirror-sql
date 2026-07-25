import type {
  SqlCatalogProviderReport,
  SqlCompletionIssue,
  SqlCompletionItem,
  SqlCompletionList,
} from "./relation-completion-types.js";
import type {
  SqlCatalogSearchWorkOutcome,
} from "./relation-catalog-search-work.js";
import type {
  SqlRelationDialectRuntime,
} from "./relation-dialect.js";
import type {
  SqlLocalRelationSiteResult,
} from "./local-relation-site.js";
import type {
  SqlIdentifierComponent,
  SqlTextRange,
} from "./types.js";

export const MAX_RELATION_COMPLETION_RESULTS = 100;

type SqlReadyLocalRelationSite = Extract<
  SqlLocalRelationSiteResult,
  { readonly status: "ready" }
>;

type SqlComposableCatalogUnavailableReason =
  | "execution-timeout"
  | "malformed-response"
  | "overloaded"
  | "provider-failed"
  | "queue-timeout";

export type SqlComposableCatalogOutcome =
  | Extract<
      SqlCatalogSearchWorkOutcome,
      { readonly status: "usable" }
    >
  | {
      readonly status: "loading";
    }
  | {
      readonly status: "unavailable";
      readonly reason: SqlComposableCatalogUnavailableReason;
    }
  | null;

export interface SqlRelationCompletionCompositionInput {
  readonly catalogOutcome: SqlComposableCatalogOutcome;
  readonly dialect: SqlRelationDialectRuntime;
  readonly localSite: SqlReadyLocalRelationSite;
  readonly providerId: string | null;
  readonly remainingIntentLeaseMs: number;
  readonly replacementRange: SqlTextRange;
  readonly statementOffset: number;
}

export interface SqlRelationCompletionComposition {
  readonly sources: readonly SqlCatalogProviderReport[];
  readonly value: SqlCompletionList;
}

interface RankedCteItem {
  readonly item: Extract<
    SqlCompletionItem,
    { readonly relationKind: "cte" }
  >;
  readonly path: string;
}

interface RankedCatalogItem {
  readonly completionPathLength: number;
  readonly item: Exclude<
    SqlCompletionItem,
    { readonly relationKind: "cte" }
  >;
  readonly label: string;
  readonly matchQuality: "exact" | "equivalent";
  readonly path: string;
}

const CATALOG_KIND_ORDER = Object.freeze({
  "temporary-table": 0,
  table: 1,
  view: 2,
  "materialized-view": 3,
  "external-relation": 4,
} as const);

const ISSUE_ORDER = Object.freeze([
  "query-site-recovery",
  "opaque-template-context",
  "cte-scope-uncertainty",
  "recursive-cte-uncertainty",
  "catalog-loading",
  "catalog-partial",
  "catalog-paginated",
  "catalog-failed",
  "catalog-malformed",
  "catalog-overloaded",
  "catalog-queue-timeout",
  "catalog-timeout",
  "result-limit",
] as const);

type OrderedIssueReason = (typeof ISSUE_ORDER)[number];

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCteItems(
  left: RankedCteItem,
  right: RankedCteItem,
): number {
  return (
    compareCodeUnits(left.item.label, right.item.label) ||
    compareCodeUnits(left.path, right.path) ||
    left.item.provenance.declarationPosition -
      right.item.provenance.declarationPosition
  );
}

function compareCatalogItems(
  left: RankedCatalogItem,
  right: RankedCatalogItem,
): number {
  return (
    (left.matchQuality === right.matchQuality
      ? 0
      : left.matchQuality === "exact"
        ? -1
        : 1) ||
    left.completionPathLength - right.completionPathLength ||
    CATALOG_KIND_ORDER[left.item.relationKind] -
      CATALOG_KIND_ORDER[right.item.relationKind] ||
    compareCodeUnits(left.label, right.label) ||
    compareCodeUnits(left.path, right.path) ||
    compareCodeUnits(
      left.item.provenance.entityId,
      right.item.provenance.entityId,
    )
  );
}

function addLocalIssues(
  input: SqlRelationCompletionCompositionInput,
  issues: Set<OrderedIssueReason>,
): void {
  const { localSite } = input;
  if (localSite.querySite.recognition.quality === "recovered") {
    issues.add("query-site-recovery");
  }
  if (
    localSite.querySite.recognition.issues.some(
      (issue) => issue === "opaque-template-context",
    )
  ) {
    issues.add("opaque-template-context");
  }
  if (localSite.local.kind !== "unqualified") return;
  const visibility = localSite.local.cteVisibility;
  if (
    visibility.quality === "recovered" ||
    visibility.shadowing.coverage === "unknown" ||
    visibility.issues.length > 0
  ) {
    issues.add("cte-scope-uncertainty");
  }
  if (
    visibility.issues.includes("opaque-template-context")
  ) {
    issues.add("opaque-template-context");
  }
  if (
    visibility.issues.includes("recursive-cte-position")
  ) {
    issues.add("recursive-cte-uncertainty");
  }
}

function createCteItems(
  input: SqlRelationCompletionCompositionInput,
  issues: Set<OrderedIssueReason>,
): RankedCteItem[] {
  if (input.localSite.local.kind !== "unqualified") {
    return [];
  }
  const items: RankedCteItem[] = [];
  const prefix = input.localSite.querySite.prefix;
  for (const cte of input.localSite.local.cteVisibility.ctes) {
    let match: ReturnType<
      SqlRelationDialectRuntime["completion"]["cteIdentifierMatchesPrefix"]
    >;
    try {
      match =
        input.dialect.completion.cteIdentifierMatchesPrefix(
          cte.name,
          prefix,
        );
    } catch {
      match = "unknown";
    }
    if (match === "unknown") {
      issues.add("cte-scope-uncertainty");
      continue;
    }
    if (match === "no-match") continue;
    const declarationPosition =
      input.statementOffset + cte.declarationPosition;
    const item = Object.freeze({
      edit: Object.freeze({
        from: input.replacementRange.from,
        insert: cte.sourceSpelling,
        to: input.replacementRange.to,
      }),
      label: cte.name.value,
      kind: "relation" as const,
      provenance: Object.freeze({
        declarationPosition,
        kind: "cte" as const,
      }),
      relationKind: "cte" as const,
    });
    items.push({ item, path: cte.sourceSpelling });
  }
  items.sort(compareCteItems);
  return items;
}

function cteShadowsCatalogRelation(
  input: SqlRelationCompletionCompositionInput,
  relationName: SqlIdentifierComponent,
  issues: Set<OrderedIssueReason>,
): boolean {
  if (input.localSite.local.kind !== "unqualified") {
    return false;
  }
  const shadowing =
    input.localSite.local.cteVisibility.shadowing;
  if (shadowing.coverage === "unknown") {
    issues.add("cte-scope-uncertainty");
    return false;
  }
  for (const name of shadowing.names) {
    let comparison: ReturnType<
      SqlRelationDialectRuntime["completion"]["compareCteIdentifiers"]
    >;
    try {
      comparison =
        input.dialect.completion.compareCteIdentifiers(
          name,
          relationName,
        );
    } catch {
      comparison = "unknown";
    }
    if (comparison === "equal") return true;
    if (comparison === "unknown") {
      issues.add("cte-scope-uncertainty");
    }
  }
  return false;
}

function createCatalogItems(
  input: SqlRelationCompletionCompositionInput,
  issues: Set<OrderedIssueReason>,
): RankedCatalogItem[] {
  const outcome = input.catalogOutcome;
  if (
    outcome === null ||
    outcome.status !== "usable" ||
    outcome.response.status !== "ready" ||
    input.providerId === null
  ) {
    return [];
  }
  const items: RankedCatalogItem[] = [];
  for (const relation of outcome.response.relations) {
    const relationName =
      relation.canonicalPath[
        relation.canonicalPath.length - 1
      ];
    if (!relationName || relationName.role !== "relation") continue;
    if (
      relation.completionPath.length === 1 &&
      cteShadowsCatalogRelation(
        input,
        relationName,
        issues,
      )
    ) {
      continue;
    }
    const base = {
      edit: Object.freeze({
        from: input.replacementRange.from,
        insert: relation.completionText,
        to: input.replacementRange.to,
      }),
      label: relationName.value,
      kind: "relation" as const,
      provenance: Object.freeze({
        entityId: relation.entityId,
        kind: "catalog" as const,
        providerId: input.providerId,
      }),
      relationKind: relation.relationKind,
    };
    const item = Object.freeze(
      relation.detail === undefined
        ? base
        : { ...base, detail: relation.detail },
    );
    const renderedLabel =
      input.dialect.completion.renderRelationPath(
        Object.freeze([relationName]),
      );
    items.push({
      completionPathLength: relation.completionPath.length,
      item,
      label:
        renderedLabel.status === "rendered"
          ? renderedLabel.text
          : relationName.value,
      matchQuality: relation.matchQuality,
      path: relation.completionText,
    });
  }
  items.sort(compareCatalogItems);
  return items;
}

function unavailableIssue(
  reason: SqlComposableCatalogUnavailableReason,
): OrderedIssueReason {
  switch (reason) {
    case "execution-timeout":
      return "catalog-timeout";
    case "malformed-response":
      return "catalog-malformed";
    case "overloaded":
      return "catalog-overloaded";
    case "provider-failed":
      return "catalog-failed";
    case "queue-timeout":
      return "catalog-queue-timeout";
  }
}

function unavailableReportReason(
  reason: SqlComposableCatalogUnavailableReason,
): Extract<
  SqlCatalogProviderReport,
  { readonly outcome: "unavailable" }
>["reason"] {
  switch (reason) {
    case "execution-timeout":
      return "execution-timeout";
    case "malformed-response":
      return "malformed-response";
    case "overloaded":
      return "queue-overloaded";
    case "provider-failed":
      return "provider-rejected";
    case "queue-timeout":
      return "queue-timeout";
  }
}

function addCatalogEvidence(
  input: SqlRelationCompletionCompositionInput,
  issues: Set<OrderedIssueReason>,
): readonly SqlCatalogProviderReport[] {
  const outcome = input.catalogOutcome;
  const providerId = input.providerId;
  if (outcome === null || providerId === null) return Object.freeze([]);
  if (outcome.status === "loading") {
    issues.add("catalog-loading");
    return Object.freeze([
      Object.freeze({
        feature: "relation-catalog" as const,
        outcome: "loading" as const,
        providerId,
      }),
    ]);
  }
  if (outcome.status === "unavailable") {
    issues.add(unavailableIssue(outcome.reason));
    return Object.freeze([
      Object.freeze({
        feature: "relation-catalog" as const,
        outcome: "unavailable" as const,
        providerId,
        reason: unavailableReportReason(outcome.reason),
      }),
    ]);
  }
  const response = outcome.response;
  if (response.status === "loading") {
    issues.add("catalog-loading");
    return Object.freeze([
      Object.freeze({
        feature: "relation-catalog" as const,
        outcome: "loading" as const,
        providerId,
      }),
    ]);
  }
  if (response.status === "failed") {
    issues.add("catalog-failed");
    return Object.freeze([
      Object.freeze({
        code: response.code,
        feature: "relation-catalog" as const,
        outcome: "failed" as const,
        providerId,
        retry: response.retry,
      }),
    ]);
  }
  if (response.coverage.kind === "partial") {
    issues.add("catalog-partial");
  } else if (response.coverage.kind === "paginated") {
    issues.add("catalog-paginated");
  }
  return Object.freeze([
    Object.freeze({
      coverage: response.coverage.kind,
      feature: "relation-catalog" as const,
      outcome: "ready" as const,
      providerId,
    }),
  ]);
}

function freezeIssues(
  reasons: ReadonlySet<OrderedIssueReason>,
  remainingIntentLeaseMs: number,
): readonly SqlCompletionIssue[] {
  const issues: SqlCompletionIssue[] = [];
  for (const reason of ISSUE_ORDER) {
    if (!reasons.has(reason)) continue;
    issues.push(
      reason === "catalog-loading"
        ? Object.freeze({
            reason,
            remainingIntentLeaseMs,
          })
        : Object.freeze({ reason }),
    );
  }
  return Object.freeze(issues);
}

function completeList(
  items: readonly SqlCompletionItem[],
): Extract<
  SqlCompletionList,
  { readonly isIncomplete: false }
> {
  const noIssues: readonly [] = Object.freeze([]);
  return Object.freeze({
    isIncomplete: false,
    issues: noIssues,
    items,
  });
}

function incompleteList(
  items: readonly SqlCompletionItem[],
  firstIssue: SqlCompletionIssue,
  remainingIssues: readonly SqlCompletionIssue[],
): Extract<
  SqlCompletionList,
  { readonly isIncomplete: true }
> {
  const issues: readonly [
    SqlCompletionIssue,
    ...SqlCompletionIssue[],
  ] = Object.freeze([firstIssue, ...remainingIssues]);
  return Object.freeze({
    isIncomplete: true,
    issues,
    items,
  });
}

export function composeSqlRelationCompletion(
  input: SqlRelationCompletionCompositionInput,
): SqlRelationCompletionComposition {
  const issues = new Set<OrderedIssueReason>();
  addLocalIssues(input, issues);
  const ctes = createCteItems(input, issues);
  const catalog = createCatalogItems(input, issues);
  const ranked = [
    ...ctes.map(({ item }) => item),
    ...catalog.map(({ item }) => item),
  ];
  if (ranked.length > MAX_RELATION_COMPLETION_RESULTS) {
    ranked.length = MAX_RELATION_COMPLETION_RESULTS;
    issues.add("result-limit");
  }
  const sources = addCatalogEvidence(input, issues);
  const frozenItems = Object.freeze(ranked);
  const frozenIssues = freezeIssues(
    issues,
    input.remainingIntentLeaseMs,
  );
  const firstIssue = frozenIssues[0];
  const value =
    firstIssue === undefined
      ? completeList(frozenItems)
      : incompleteList(
          frozenItems,
          firstIssue,
          frozenIssues.slice(1),
        );
  return Object.freeze({ sources, value });
}
