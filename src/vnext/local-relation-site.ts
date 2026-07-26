import {
  analyzeSqlCteLayout,
  type SqlCteLayoutResource,
  type SqlCteVisibility,
  visibleSqlCtesAt,
} from "./cte-layout.js";
import {
  recognizeSqlColumnQuerySite,
  type SqlColumnQuerySiteResult,
} from "./column-query-site.js";
import {
  recognizeSqlRelationQuerySiteWithEntrypoints,
  type SqlQuerySiteResult,
} from "./query-site.js";
import type { SqlRelationDialectRuntime } from "./relation-dialect.js";
import { isSqlRelationDialectRuntime } from "./relation-runtime-auth.js";
import {
  isSqlSourceSnapshot,
  type SqlSourceSnapshot,
} from "./source.js";
import {
  isSqlStatementSlotSnapshotFor,
  type ExactSqlStatementSlot,
  type SqlStatementIndex,
  type SqlStatementSlot,
} from "./statement-index.js";

const localRelationStatementBrand: unique symbol = Symbol(
  "SqlLocalRelationStatement",
);

export interface SqlLocalRelationStatement {
  readonly [localRelationStatementBrand]: "SqlLocalRelationStatement";
}

export type SqlLocalRelationStatementPreparation =
  | {
      readonly status: "ready";
      readonly statement: SqlLocalRelationStatement;
    }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "ambiguous-query-site"
        | "opaque-statement"
        | "resource-limit";
      readonly resource?: SqlCteLayoutResource;
    };

type SqlReadyQuerySite = Extract<
  SqlQuerySiteResult,
  { readonly status: "ready" }
>;

export type SqlLocalRelationSiteResult =
  | Exclude<SqlQuerySiteResult, { readonly status: "ready" }>
  | Extract<
      SqlLocalRelationStatementPreparation,
      { readonly status: "unavailable" }
    >
  | {
      readonly status: "ready";
      readonly querySite: SqlReadyQuerySite;
      readonly local:
        | {
            readonly kind: "qualified";
          }
        | {
            readonly kind: "unqualified";
            readonly cteVisibility: SqlCteVisibility;
          };
    };

interface SqlLocalRelationStatementContext {
  readonly dialect: SqlRelationDialectRuntime;
  readonly layout: Exclude<
    ReturnType<typeof analyzeSqlCteLayout>,
    { readonly status: "unavailable" }
  >;
  readonly slot: ExactSqlStatementSlot;
  readonly source: SqlSourceSnapshot;
}

const localRelationStatements = new WeakMap<
  object,
  SqlLocalRelationStatementContext
>();

const QUALIFIED_LOCAL = Object.freeze({
  kind: "qualified" as const,
});

function unavailablePreparation(
  reason: Extract<
    SqlLocalRelationStatementPreparation,
    { readonly status: "unavailable" }
  >["reason"],
  resource?: SqlCteLayoutResource,
): SqlLocalRelationStatementPreparation {
  return Object.freeze(
    resource === undefined
      ? { reason, status: "unavailable" }
      : { reason, resource, status: "unavailable" },
  );
}

function unavailableSite(): SqlLocalRelationSiteResult {
  return Object.freeze({
    reason: "ambiguous-query-site",
    status: "unavailable",
  });
}

export function prepareSqlLocalRelationStatement(
  source: SqlSourceSnapshot,
  index: SqlStatementIndex,
  slot: SqlStatementSlot,
  dialect: SqlRelationDialectRuntime,
): SqlLocalRelationStatementPreparation {
  if (
    !isSqlRelationDialectRuntime(dialect) ||
    !isSqlSourceSnapshot(source) ||
    !isSqlStatementSlotSnapshotFor(
      index,
      slot,
      source.analysisText,
      dialect.querySite.lexicalProfile,
    )
  ) {
    return unavailablePreparation("ambiguous-query-site");
  }
  if (slot.boundaryQuality === "opaque") {
    return unavailablePreparation("opaque-statement");
  }
  const layout = analyzeSqlCteLayout(
    source,
    index,
    slot,
    dialect.cteLayout,
  );
  if (layout.status === "unavailable") {
    return unavailablePreparation(layout.reason, layout.resource);
  }
  const statement: SqlLocalRelationStatement = Object.freeze({
    [localRelationStatementBrand]: "SqlLocalRelationStatement" as const,
  });
  localRelationStatements.set(
    statement,
    Object.freeze({ dialect, layout, slot, source }),
  );
  return Object.freeze({ statement, status: "ready" });
}

export function analyzeSqlLocalRelationSite(
  statement: SqlLocalRelationStatement,
  position: number,
): SqlLocalRelationSiteResult {
  if (
    statement === null ||
    typeof statement !== "object"
  ) {
    return unavailableSite();
  }
  const context = localRelationStatements.get(statement);
  if (!context) {
    return unavailableSite();
  }
  const querySite = recognizeSqlRelationQuerySiteWithEntrypoints(
    context.source,
    context.slot,
    position,
    context.dialect.querySite,
    context.layout.mainQueryEntrypoints,
  );
  if (querySite.status !== "ready") {
    return querySite;
  }
  if (querySite.qualifier.length > 0) {
    return Object.freeze({
      local: QUALIFIED_LOCAL,
      querySite,
      status: "ready",
    });
  }
  const relativePosition = position - context.slot.source.from;
  return Object.freeze({
    local: Object.freeze({
      cteVisibility: visibleSqlCtesAt(
        context.layout,
        relativePosition,
      ),
      kind: "unqualified" as const,
    }),
    querySite,
    status: "ready",
  });
}

export function analyzeSqlLocalColumnSite(
  statement: SqlLocalRelationStatement,
  position: number,
): SqlColumnQuerySiteResult {
  if (
    statement === null ||
    typeof statement !== "object"
  ) {
    return Object.freeze({
      reason: "ambiguous-query-site",
      status: "unavailable",
    });
  }
  const context = localRelationStatements.get(statement);
  if (!context) {
    return Object.freeze({
      reason: "ambiguous-query-site",
      status: "unavailable",
    });
  }
  const result = recognizeSqlColumnQuerySite(
    context.source,
    context.slot,
    position,
    context.dialect,
  );
  if (result.status !== "ready") return result;
  const visibility = visibleSqlCtesAt(
    context.layout,
    position - context.slot.source.from,
  );
  const relations = result.relations.filter((relation) => {
    const name = relation.path.length === 1
      ? relation.path[0]
      : undefined;
    return name === undefined ||
      !visibility.ctes.some((cte) =>
        context.dialect.completion.compareCteIdentifiers(
          name,
          cte.name,
        ) === "equal"
      );
  });
  return relations.length === result.relations.length
    ? result
    : Object.freeze({
        ...result,
        relations: Object.freeze(relations),
      });
}
