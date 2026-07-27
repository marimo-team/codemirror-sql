import {
  analyzeSqlCteLayout,
  type SqlCteLayoutResource,
  type SqlCteVisibility,
  visibleSqlCtesAt,
} from "./cte-layout.js";
import {
  recognizeSqlColumnQuerySite,
  type SqlColumnQueryRelation,
  type SqlColumnQuerySiteResult,
} from "./column-query-site.js";
import {
  inferSqlQueryOutput,
  MAX_QUERY_OUTPUT_COLUMNS,
  type SqlQueryOutput,
} from "./query-output.js";
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
import type { SqlTextRange } from "./types.js";

const localRelationStatementBrand: unique symbol = Symbol(
  "SqlLocalRelationStatement",
);

export function applySqlQueryOutputAliases(
  output: SqlQueryOutput,
  aliases: NonNullable<SqlColumnQueryRelation["columnAliases"]>,
): SqlQueryOutput {
  if (output.status !== "ready") {
    return Object.freeze({
      columns: aliases.columns,
      coverage: "partial" as const,
      status: "ready" as const,
    });
  }
  const columns = output.columns.map((column, index) =>
    aliases.columns[index] ?? column
  );
  if (aliases.columns.length > columns.length) {
    columns.push(...aliases.columns.slice(columns.length));
  }
  return Object.freeze({
    columns: Object.freeze(
      columns.slice(0, MAX_QUERY_OUTPUT_COLUMNS),
    ),
    coverage:
      aliases.coverage === "partial" ||
        output.coverage === "partial" ||
        columns.length > MAX_QUERY_OUTPUT_COLUMNS ||
        aliases.columns.length > output.columns.length
        ? "partial" as const
        : "complete" as const,
    status: "ready" as const,
  });
}

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
  const outputCache = new Map<string, SqlQueryOutput>();
  const inferOutput = (range: SqlTextRange): SqlQueryOutput => {
    const key = `${range.from}:${range.to}`;
    const cached = outputCache.get(key);
    if (cached) return cached;
    const output = inferSqlQueryOutput(
      context.source,
      range,
      context.dialect,
    );
    outputCache.set(key, output);
    return output;
  };
  const applyAliases = (
    output: SqlQueryOutput,
    relation: SqlColumnQueryRelation,
  ): SqlQueryOutput => {
    const aliases = relation.columnAliases;
    if (!aliases) return output;
    return applySqlQueryOutputAliases(output, aliases);
  };
  const relations: SqlColumnQueryRelation[] = result.relations.map(
    (relation) => {
      if (relation.local?.kind === "derived") {
        return Object.freeze({
          ...relation,
          local: Object.freeze({
            ...relation.local,
            output: applyAliases(
              inferOutput(relation.local.queryRange),
              relation,
            ),
          }),
        });
      }
      const name = relation.path.length === 1
        ? relation.path[0]
        : undefined;
      const visible = name === undefined
        ? undefined
        : visibility.ctes.find((cte) =>
            context.dialect.completion.compareCteIdentifiers(
              name,
              cte.name,
            ) === "equal"
          );
      if (!visible) return relation;
      const declaration = context.layout.declarations.find((candidate) =>
        candidate.nameRange.from === visible.declarationPosition
      );
      if (!declaration) return relation;
      const queryRange = Object.freeze({
        from: context.slot.source.from + declaration.bodyRange.from,
        to: context.slot.source.from + declaration.bodyRange.to,
      });
      const inferredOutput = inferOutput(queryRange);
      const output = declaration.declaredColumns.length === 0
        ? inferredOutput
        : Object.freeze({
            columns: Object.freeze(
              declaration.declaredColumns.map((column) => {
                const definition = Object.freeze({
                  from: context.slot.source.from + column.range.from,
                  to: context.slot.source.from + column.range.to,
                });
                return Object.freeze({
                  definition,
                  identifier: column.name,
                  insertText: context.source.originalText.slice(
                    definition.from,
                    definition.to,
                  ),
                });
              }),
            ),
            coverage:
              context.layout.status === "partial"
                ? "partial" as const
                : "complete" as const,
            status: "ready" as const,
          });
      return Object.freeze({
        ...relation,
        local: Object.freeze({
          kind: "cte" as const,
          output: applyAliases(output, relation),
          queryRange,
        }),
      });
    },
  );
  const localPartial = relations.some((relation) =>
    relation.local !== undefined &&
    (
      relation.local.output?.status !== "ready" ||
      relation.local.output.coverage === "partial"
    )
  ) || visibility.shadowing.coverage === "unknown";
  const issues = localPartial &&
      !result.issues.includes("local-output-partial")
    ? Object.freeze([
        ...result.issues,
        "local-output-partial" as const,
      ].sort())
    : result.issues;
  return Object.freeze({
    ...result,
    coverage:
      result.coverage === "partial" || localPartial ? "partial" : "complete",
    issues,
    relations: Object.freeze(relations),
  });
}
