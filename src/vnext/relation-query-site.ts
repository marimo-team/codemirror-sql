import {
  resolveAuthenticatedSqlCteEntrypoints,
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
  reason: "ambiguous-query-site" | "opaque-statement",
): SqlQuerySiteResult {
  return Object.freeze({ reason, status: "unavailable" });
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
  const entrypoints = resolveAuthenticatedSqlCteEntrypoints(
    layout,
    source,
    slot,
    dialect.cteLayout,
  );
  if (!entrypoints) {
    return unavailable("ambiguous-query-site");
  }
  return recognizeSqlRelationQuerySiteWithEntrypoints(
    source,
    slot,
    position,
    dialect.querySite,
    entrypoints,
  );
}
