import type {
  SqlColumnCatalogBatchOutcome,
} from "./column-catalog-batch-coordinator.js";
import type {
  SqlColumnCatalogRelationReference,
  SqlColumnCatalogRelationResult,
} from "./column-catalog-types.js";
import type {
  SqlColumnQueryRelation,
  SqlColumnQuerySiteResult,
} from "./column-query-site.js";
import type {
  SqlColumnCatalogProviderReport,
  SqlCompletionIssue,
  SqlCompletionItem,
  SqlCompletionList,
} from "./relation-completion-types.js";
import type { SqlRelationDialectRuntime } from "./relation-dialect.js";
import type {
  SqlIdentifierComponent,
  SqlIdentifierPath,
} from "./types.js";

type ReadyColumnSite = Extract<
  SqlColumnQuerySiteResult,
  { readonly status: "ready" }
>;

export interface SqlPreparedColumnCatalogRelations {
  readonly references: readonly SqlColumnCatalogRelationReference[];
  readonly relationsByRequestKey: ReadonlyMap<
    string,
    SqlColumnQueryRelation
  >;
}

export interface SqlColumnCompletionComposition {
  readonly sources: readonly SqlColumnCatalogProviderReport[];
  readonly value: SqlCompletionList;
}

function sameIdentifier(
  dialect: SqlRelationDialectRuntime,
  left: SqlIdentifierComponent,
  right: SqlIdentifierComponent,
): boolean {
  return dialect.completion.compareCteIdentifiers(left, right) === "equal";
}

function pathEndsWith(
  dialect: SqlRelationDialectRuntime,
  path: SqlIdentifierPath,
  suffix: SqlIdentifierPath,
): boolean {
  if (suffix.length === 0 || suffix.length > path.length) return false;
  const offset = path.length - suffix.length;
  return suffix.every((component, index) => {
    const candidate = path[offset + index];
    return candidate !== undefined &&
      sameIdentifier(dialect, candidate, component);
  });
}

function relationMatchesQualifier(
  dialect: SqlRelationDialectRuntime,
  relation: SqlColumnQueryRelation,
  qualifier: SqlIdentifierPath,
): boolean {
  if (qualifier.length === 0) return true;
  if (
    qualifier.length === 1 &&
    relation.alias !== null &&
    qualifier[0] !== undefined &&
    sameIdentifier(dialect, relation.alias, qualifier[0])
  ) {
    return true;
  }
  return relation.alias === null &&
    pathEndsWith(dialect, relation.path, qualifier);
}

export function prepareSqlColumnCatalogRelations(
  site: ReadyColumnSite,
  dialect: SqlRelationDialectRuntime,
): SqlPreparedColumnCatalogRelations {
  const references: SqlColumnCatalogRelationReference[] = [];
  const relationsByRequestKey = new Map<
    string,
    SqlColumnQueryRelation
  >();
  for (let index = 0; index < site.relations.length; index += 1) {
    const relation = site.relations[index];
    if (
      relation === undefined ||
      !relationMatchesQualifier(
        dialect,
        relation,
        site.qualifier,
      )
    ) {
      continue;
    }
    const requestKey = `binding:${index}`;
    references.push(Object.freeze({
      path: relation.path,
      requestKey,
    }));
    relationsByRequestKey.set(requestKey, relation);
  }
  return Object.freeze({
    references: Object.freeze(references),
    relationsByRequestKey,
  });
}

function relationLabel(relation: SqlColumnQueryRelation): string {
  return relation.alias?.value ??
    relation.path.map((component) => component.value).join(".");
}

function issue(
  reason: Exclude<SqlCompletionIssue["reason"], "catalog-loading">,
): SqlCompletionIssue {
  return Object.freeze({ reason });
}

function resultIssues(
  relation: SqlColumnCatalogRelationResult,
): readonly SqlCompletionIssue[] {
  if (relation.status === "loading") {
    return Object.freeze([issue("column-catalog-loading")]);
  }
  if (relation.status === "failed") {
    return Object.freeze([issue("column-catalog-failed")]);
  }
  return relation.coverage === "partial"
    ? Object.freeze([issue("column-catalog-partial")])
    : Object.freeze([]);
}

function list(
  items: readonly SqlCompletionItem[],
  issues: readonly SqlCompletionIssue[],
): SqlCompletionList {
  const first = issues[0];
  if (first === undefined) {
    return Object.freeze({
      isIncomplete: false,
      issues: Object.freeze([] as const),
      items: Object.freeze(items),
    });
  }
  const incompleteIssues: [
    SqlCompletionIssue,
    ...SqlCompletionIssue[],
  ] = [first, ...issues.slice(1)];
  return Object.freeze({
    isIncomplete: true,
    issues: Object.freeze(incompleteIssues),
    items: Object.freeze(items),
  });
}

function unavailableComposition(
  providerId: string,
  reason: Extract<
    SqlColumnCatalogBatchOutcome,
    { readonly status: "unavailable" }
  >["reason"],
): SqlColumnCompletionComposition {
  return Object.freeze({
    sources: Object.freeze([Object.freeze({
      feature: "column-catalog",
      outcome: "unavailable",
      providerId,
      reason,
    })]),
    value: list([], [issue(
      reason === "malformed-response"
        ? "column-catalog-malformed"
        : "column-catalog-failed",
    )]),
  });
}

function compareItems(
  left: SqlCompletionItem,
  right: SqlCompletionItem,
): number {
  return left.label.localeCompare(right.label) ||
    (left.detail ?? "").localeCompare(right.detail ?? "") ||
    left.edit.insert.localeCompare(right.edit.insert) ||
    left.edit.from - right.edit.from ||
    left.edit.to - right.edit.to;
}

export function composeSqlColumnCompletion(
  input: {
    readonly dialect: SqlRelationDialectRuntime;
    readonly outcome: SqlColumnCatalogBatchOutcome;
    readonly prepared: SqlPreparedColumnCatalogRelations;
    readonly providerId: string;
    readonly site: ReadyColumnSite;
  },
): SqlColumnCompletionComposition | null {
  if (
    input.outcome.status === "cancelled" ||
    input.outcome.status === "superseded"
  ) {
    return null;
  }
  if (input.outcome.status === "unavailable") {
    return unavailableComposition(
      input.providerId,
      input.outcome.reason,
    );
  }
  const items: SqlCompletionItem[] = [];
  const issues: SqlCompletionIssue[] = [];
  if (input.site.coverage === "partial") {
    issues.push(issue("query-binding-partial"));
  }
  let hasLoading = false;
  let hasFailure = false;
  let hasPartial = input.site.coverage === "partial";
  const seen = new Set<string>();
  for (const result of input.outcome.relations) {
    issues.push(...resultIssues(result));
    if (result.status === "loading") {
      hasLoading = true;
      continue;
    }
    if (result.status === "failed") {
      hasFailure = true;
      continue;
    }
    if (result.coverage === "partial") hasPartial = true;
    const relation = input.prepared.relationsByRequestKey.get(
      result.requestKey,
    );
    if (!relation) {
      issues.push(issue("column-catalog-malformed"));
      continue;
    }
    for (const column of result.columns) {
      if (
        input.dialect.completion.cteIdentifierMatchesPrefix(
          column.identifier,
          input.site.prefix,
        ) !== "match"
      ) {
        continue;
      }
      const identity = [
        column.provenance.providerId,
        column.provenance.scope,
        column.provenance.relationEntityId,
        column.provenance.columnEntityId,
        column.insertText,
      ].join("\u0000");
      if (seen.has(identity)) continue;
      seen.add(identity);
      const relationName = relationLabel(relation);
      const metadata = column.detail ?? column.dataType;
      items.push(Object.freeze({
        ...(column.dataType === undefined
          ? {}
          : { dataType: column.dataType }),
        detail: metadata === undefined
          ? relationName
          : `${metadata} — ${relationName}`,
        edit: Object.freeze({
          from: input.site.replacementRange.from,
          insert: column.insertText,
          to: input.site.replacementRange.to,
        }),
        kind: "column",
        label: column.identifier.value,
        provenance: Object.freeze({
          columnEntityId: column.provenance.columnEntityId,
          epoch: column.provenance.epoch,
          kind: "column-catalog",
          providerId: column.provenance.providerId,
          relationEntityId: column.provenance.relationEntityId,
          scope: column.provenance.scope,
        }),
        relationRequestKey: result.requestKey,
      }));
    }
  }
  const deduplicatedIssues = Array.from(
    new Map(issues.map((item) => [item.reason, item])).values(),
  );
  const coverage = hasPartial || hasFailure ? "partial" : "complete";
  const source: SqlColumnCatalogProviderReport = hasLoading
    ? {
        feature: "column-catalog",
        outcome: "loading",
        providerId: input.outcome.providerId,
      }
    : hasFailure && items.length === 0
      ? {
          feature: "column-catalog",
          outcome: "failed",
          providerId: input.outcome.providerId,
        }
      : {
          coverage,
          feature: "column-catalog",
          outcome: "ready",
          providerId: input.outcome.providerId,
        };
  return Object.freeze({
    sources: Object.freeze([Object.freeze(source)]),
    value: list(
      Object.freeze(items.sort(compareItems)),
      Object.freeze(deduplicatedIssues),
    ),
  });
}
