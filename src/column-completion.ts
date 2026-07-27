import type {
  SqlColumnCatalogBatchOutcome,
} from "./column-catalog-batch-coordinator.js";
import {
  MAX_COLUMN_BATCH_RELATIONS,
  MAX_COLUMNS_PER_BATCH,
} from "./column-catalog-boundary.js";
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
  SqlColumnCatalogFailure,
  SqlCompletionIssue,
  SqlCompletionItem,
  SqlCompletionList,
  SqlCompletionProviderReport,
  SqlQueryOutputProviderReport,
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
  readonly coverage: "complete" | "partial";
  readonly references: readonly SqlColumnCatalogRelationReference[];
  readonly relationsByRequestKey: ReadonlyMap<
    string,
    SqlColumnQueryRelation
  >;
}

export interface SqlColumnCompletionComposition {
  readonly sources: readonly SqlCompletionProviderReport[];
  readonly value: SqlCompletionList;
}

const completionIdentifiers = new WeakMap<
  SqlCompletionItem,
  SqlIdentifierComponent
>();

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
  let coverage: "complete" | "partial" = "complete";
  const firstRelation =
    site.context === "using"
      ? Math.max(0, site.relations.length - 2)
      : 0;
  for (let index = firstRelation; index < site.relations.length; index += 1) {
    const relation = site.relations[index];
    if (
      relation === undefined ||
      relation.local !== undefined ||
      !relationMatchesQualifier(
        dialect,
        relation,
        site.qualifier,
      )
    ) {
      continue;
    }
    if (references.length === MAX_COLUMN_BATCH_RELATIONS) {
      coverage = "partial";
      break;
    }
    const requestKey = `binding:${index}`;
    references.push(Object.freeze({
      path: relation.path,
      requestKey,
    }));
    relationsByRequestKey.set(requestKey, relation);
  }
  return Object.freeze({
    coverage,
    references: Object.freeze(references),
    relationsByRequestKey,
  });
}

function relationLabel(relation: SqlColumnQueryRelation): string {
  return relation.alias?.value ??
    relation.path.map((component) => component.value).join(".");
}

export function composeSqlLocalQueryOutputCompletion(
  site: ReadyColumnSite,
  dialect: SqlRelationDialectRuntime,
): SqlColumnCompletionComposition | null {
  const items: SqlCompletionItem[] = [];
  const seen = new Set<string>();
  let found = false;
  let partial = site.coverage === "partial";
  const firstRelation = site.context === "using"
    ? Math.max(0, site.relations.length - 2)
    : 0;
  relations: for (
    let index = firstRelation;
    index < site.relations.length;
    index += 1
  ) {
    const relation = site.relations[index];
    if (
      !relation?.local ||
      !relationMatchesQualifier(dialect, relation, site.qualifier)
    ) {
      continue;
    }
    found = true;
    const output = relation.local.output;
    if (!output || output.status !== "ready") {
      partial = true;
      continue;
    }
    if (output.coverage === "partial") partial = true;
    for (const column of output.columns) {
      if (
        dialect.completion.cteIdentifierMatchesPrefix(
          column.identifier,
          site.prefix,
        ) !== "match"
      ) {
        continue;
      }
      const identity = [
        relation.range.from,
        relation.range.to,
        column.identifier.quoted,
        column.identifier.value,
        column.definition.from,
        column.definition.to,
      ].join("\u0000");
      if (seen.has(identity)) continue;
      seen.add(identity);
      if (items.length === MAX_COLUMNS_PER_BATCH) {
        partial = true;
        break relations;
      }
      const item = Object.freeze({
        detail: relationLabel(relation),
        edit: Object.freeze({
          from: site.replacementRange.from,
          insert: column.insertText,
          to: site.replacementRange.to,
        }),
        kind: "column",
        label: column.identifier.value,
        provenance: Object.freeze({
          definition: column.definition,
          kind: "query-output",
          relation: relation.range,
        }),
        relationRequestKey: `local:${index}`,
      });
      completionIdentifiers.set(item, column.identifier);
      items.push(item);
    }
  }
  if (!found) return null;
  const source: SqlQueryOutputProviderReport = Object.freeze({
    coverage: partial ? "partial" : "complete",
    feature: "query-output",
    outcome: "ready",
  });
  return Object.freeze({
    sources: Object.freeze([source]),
    value: list(
      Object.freeze(items.sort(compareItems)),
      partial ? Object.freeze([issue("query-binding-partial")]) : Object.freeze([]),
    ),
  });
}

export function filterSqlUsingCompletionList(
  value: SqlCompletionList,
  site: ReadyColumnSite,
  dialect: SqlRelationDialectRuntime,
): SqlCompletionList {
  if (site.context !== "using" || site.relations.length < 2) return value;
  const leftIndex = site.relations.length - 2;
  const rightIndex = site.relations.length - 1;
  const left = site.relations[leftIndex];
  const right = site.relations[rightIndex];
  if (!left || !right) return value;
  const leftKey = left.local ? `local:${leftIndex}` : `binding:${leftIndex}`;
  const rightKey = right.local
    ? `local:${rightIndex}`
    : `binding:${rightIndex}`;
  const rightIdentifiers = value.items.flatMap((item) => {
    if (
      item.kind !== "column" ||
      item.relationRequestKey !== rightKey
    ) {
      return [];
    }
    const identifier = completionIdentifiers.get(item);
    return identifier ? [identifier] : [];
  });
  const items = value.items.filter((item) => {
    if (
      item.kind !== "column" ||
      item.relationRequestKey !== leftKey
    ) {
      return false;
    }
    const candidate = completionIdentifiers.get(item);
    return candidate !== undefined &&
      rightIdentifiers.some((identifier) =>
        sameIdentifier(dialect, candidate, identifier)
      );
  });
  return list(Object.freeze(items), value.issues);
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
  return compareText(left.label, right.label) ||
    compareText(left.detail ?? "", right.detail ?? "") ||
    compareText(left.edit.insert, right.edit.insert) ||
    left.edit.from - right.edit.from ||
    left.edit.to - right.edit.to;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
  let hasPartial =
    input.site.coverage === "partial" ||
    input.prepared.coverage === "partial";
  if (hasPartial) issues.push(issue("query-binding-partial"));
  let hasLoading = false;
  let hasFailure = false;
  const seen = new Set<string>();
  const usingIdentifiers = new Map<string, SqlIdentifierComponent[]>();
  const failures: SqlColumnCatalogFailure[] = [];
  for (const result of input.outcome.relations) {
    issues.push(...resultIssues(result));
    if (result.status === "loading") {
      hasLoading = true;
      continue;
    }
    if (result.status === "failed") {
      hasFailure = true;
      failures.push(Object.freeze({
        code: result.code,
        requestKey: result.requestKey,
        retry: result.retry,
      }));
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
    if (
      relation.columnAliases?.coverage === "partial" ||
      (relation.columnAliases?.columns.length ?? 0) >
        result.columns.length
    ) {
      hasPartial = true;
      issues.push(issue("query-binding-partial"));
    }
    for (
      let columnIndex = 0;
      columnIndex < result.columns.length;
      columnIndex += 1
    ) {
      const column = result.columns[columnIndex]!;
      const alias = relation.columnAliases?.columns[columnIndex];
      const completionIdentifier = alias?.identifier ?? column.identifier;
      const insertText = alias?.insertText ?? column.insertText;
      if (
        input.dialect.completion.cteIdentifierMatchesPrefix(
          completionIdentifier,
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
        insertText,
      ].join("\u0000");
      const identifiers = usingIdentifiers.get(result.requestKey) ?? [];
      identifiers.push(completionIdentifier);
      usingIdentifiers.set(result.requestKey, identifiers);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const relationName = relationLabel(relation);
      const metadata = column.detail ?? column.dataType;
      const item = Object.freeze({
        ...(column.dataType === undefined
          ? {}
          : { dataType: column.dataType }),
        detail: metadata === undefined
          ? relationName
          : `${metadata} — ${relationName}`,
        edit: Object.freeze({
          from: input.site.replacementRange.from,
          insert: insertText,
          to: input.site.replacementRange.to,
        }),
        kind: "column",
        label: completionIdentifier.value,
        provenance: Object.freeze({
          columnEntityId: column.provenance.columnEntityId,
          epoch: column.provenance.epoch,
          kind: "column-catalog",
          providerId: column.provenance.providerId,
          relationEntityId: column.provenance.relationEntityId,
          scope: column.provenance.scope,
        }),
        relationRequestKey: result.requestKey,
      });
      completionIdentifiers.set(item, completionIdentifier);
      items.push(item);
    }
  }
  if (
    input.site.context === "using" &&
    input.prepared.references.length === 2
  ) {
    const leftKey = input.prepared.references[0]?.requestKey;
    const rightKey = input.prepared.references[1]?.requestKey;
    if (leftKey && rightKey) {
      const rightIdentifiers = usingIdentifiers.get(rightKey) ?? [];
      const shared = items.filter((item) => {
        if (
          item.kind !== "column" ||
          item.relationRequestKey !== leftKey
        ) {
          return false;
        }
        const left = completionIdentifiers.get(item);
        return left !== undefined &&
          rightIdentifiers.some((right) =>
            sameIdentifier(input.dialect, left, right)
          );
      });
      items.splice(0, items.length, ...shared);
    }
  }
  const deduplicatedIssues = Array.from(
    new Map(issues.map((item) => [item.reason, item])).values(),
  );
  const coverage = hasPartial || hasFailure ? "partial" : "complete";
  const frozenFailures = Object.freeze(failures);
  const firstFailure = failures[0];
  const source: SqlColumnCatalogProviderReport = hasLoading
    ? {
        feature: "column-catalog",
        failures: frozenFailures,
        outcome: "loading",
        providerId: input.outcome.providerId,
      }
    : hasFailure && items.length === 0 &&
        firstFailure !== undefined
      ? {
          feature: "column-catalog",
          failures: Object.freeze([
            firstFailure,
            ...failures.slice(1),
          ]),
          outcome: "failed",
          providerId: input.outcome.providerId,
        }
      : {
          coverage,
          feature: "column-catalog",
          failures: frozenFailures,
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
