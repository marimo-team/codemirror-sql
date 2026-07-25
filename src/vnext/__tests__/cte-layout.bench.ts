import { bench, describe } from "vitest";
import {
  analyzeSqlCteLayout,
  MAX_CTE_DECLARATIONS,
  MAX_CTE_DEPTH,
  MAX_CTE_FRAMES,
  visibleSqlCtesAt,
} from "../cte-layout.js";
import { DUCKDB_SQL_RELATION_DIALECT } from "../relation-dialect.js";
import { createIdentitySqlSource } from "../source.js";
import {
  buildSqlStatementIndex,
  type ExactSqlStatementSlot,
} from "../statement-index.js";

const dialect = DUCKDB_SQL_RELATION_DIALECT.cteLayout;

function fixture(text: string): {
  readonly source: ReturnType<typeof createIdentitySqlSource>;
  readonly index: ReturnType<typeof buildSqlStatementIndex>;
  readonly slot: ExactSqlStatementSlot;
} {
  const source = createIdentitySqlSource(text);
  const index = buildSqlStatementIndex(
    source.analysisText,
    dialect.lexicalProfile,
  );
  const slot = index.slots[0];
  if (!slot || slot.boundaryQuality !== "exact") {
    throw new Error("CTE benchmark fixture requires an exact statement");
  }
  return { index, slot, source };
}

const tenKibibytes = 10 * 1_024;
const ordinaryPrefix = "SELECT ";
const ordinary = `${ordinaryPrefix}${"x,".repeat(
  Math.floor((tenKibibytes - ordinaryPrefix.length - 1) / 2),
)}x`;
const ordinaryText = `${ordinary}${" ".repeat(
  tenKibibytes - ordinary.length,
)}`;
const ordinaryFixture = fixture(ordinaryText);

const declarationHeavyText = `WITH ${Array.from(
  { length: MAX_CTE_DECLARATIONS },
  (_, index) => `c${index} AS (SELECT ${index})`,
).join(", ")} SELECT * FROM c255`;
const declarationHeavyFixture = fixture(declarationHeavyText);

const depthHeavyText = Array.from(
  { length: MAX_CTE_DEPTH },
  (_, index) => index,
).reduce(
  (body, index) =>
    `WITH c${index} AS (${body}) SELECT * FROM c${index}`,
  "SELECT 1",
);
const depthHeavyFixture = fixture(depthHeavyText);
const bareFrameHeavyText = `SELECT ${Array.from(
  { length: MAX_CTE_FRAMES },
  () => "(WITH)",
).join(",")}`;
const bareFrameHeavyFixture = fixture(bareFrameHeavyText);
const depthLayout = analyzeSqlCteLayout(
  depthHeavyFixture.source,
  depthHeavyFixture.index,
  depthHeavyFixture.slot,
  dialect,
);
if (depthLayout.status !== "ready") {
  throw new Error("Depth benchmark requires a ready CTE layout");
}
const projectedLayout = analyzeSqlCteLayout(
  declarationHeavyFixture.source,
  declarationHeavyFixture.index,
  declarationHeavyFixture.slot,
  dialect,
);
if (projectedLayout.status === "unavailable") {
  throw new Error("CTE projection benchmark requires a layout");
}

describe("CTE layout", () => {
  bench("ordinary 10 KiB statement", () => {
    analyzeSqlCteLayout(
      ordinaryFixture.source,
      ordinaryFixture.index,
      ordinaryFixture.slot,
      dialect,
    );
  });

  bench("256 declarations", () => {
    analyzeSqlCteLayout(
      declarationHeavyFixture.source,
      declarationHeavyFixture.index,
      declarationHeavyFixture.slot,
      dialect,
    );
  });

  bench("128-depth nested CTE", () => {
    analyzeSqlCteLayout(
      depthHeavyFixture.source,
      depthHeavyFixture.index,
      depthHeavyFixture.slot,
      dialect,
    );
  });

  bench("256 sequential incomplete frames", () => {
    analyzeSqlCteLayout(
      bareFrameHeavyFixture.source,
      bareFrameHeavyFixture.index,
      bareFrameHeavyFixture.slot,
      dialect,
    );
  });

  bench("cached 256-declaration projection", () => {
    visibleSqlCtesAt(
      projectedLayout,
      declarationHeavyText.length - 1,
    );
  });
});
