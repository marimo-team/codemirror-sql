import {
  resolveAuthenticatedSqlCteLayout,
  type SqlCteLayout,
} from "./cte-layout.js";
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
  isSqlStatementSlotSnapshot,
  type SqlStatementSlot,
} from "./statement-index.js";

function unavailable(
  reason:
    | "ambiguous-query-site"
    | "opaque-statement"
    | "resource-limit",
  resource?: "active-statement",
): SqlQuerySiteResult {
  return Object.freeze(
    resource === undefined
      ? { reason, status: "unavailable" }
      : { reason, resource, status: "unavailable" },
  );
}

export function recognizeSqlRelationQuerySiteWithCteLayout(
  source: SqlSourceSnapshot,
  slot: SqlStatementSlot,
  position: number,
  dialect: SqlRelationDialectRuntime,
  layout: SqlCteLayout,
): SqlQuerySiteResult {
  if (
    !isSqlRelationDialectRuntime(dialect) ||
    !isSqlSourceSnapshot(source) ||
    !isSqlStatementSlotSnapshot(slot)
  ) {
    return unavailable("ambiguous-query-site");
  }
  if (slot.boundaryQuality === "opaque") {
    return unavailable("opaque-statement");
  }
  const authenticatedLayout = resolveAuthenticatedSqlCteLayout(
    layout,
    source,
    slot,
    dialect.cteLayout,
  );
  if (!authenticatedLayout) {
    return unavailable("ambiguous-query-site");
  }
  if (authenticatedLayout.status === "unavailable") {
    return unavailable(
      authenticatedLayout.reason,
      authenticatedLayout.resource,
    );
  }
  return recognizeSqlRelationQuerySiteWithEntrypoints(
    source,
    slot,
    position,
    dialect.querySite,
    authenticatedLayout.mainQueryEntrypoints,
  );
}
