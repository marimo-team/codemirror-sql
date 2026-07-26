import { bench, describe } from "vitest";
import {
  createSqlLanguageService,
  duckdbDialect,
} from "../index.js";
import type {
  SqlCatalogRelation,
} from "../relation-completion-types.js";
import type {
  SqlDocumentContext,
  SqlDocumentSession,
  SqlLanguageService,
} from "../types.js";

interface BenchmarkContext extends SqlDocumentContext {
  readonly engine: "benchmark";
}

const dialect = duckdbDialect();
const tenKibibytes = 10 * 1_024;
const prefix = "WITH local_cte AS (SELECT 1) SELECT ";
const suffix = " FROM local";
const projectionLength =
  tenKibibytes - prefix.length - suffix.length;
const projection = `${"x,".repeat(
  Math.floor((projectionLength - 1) / 2),
)}x`;
const tenKibibyteText = `${prefix}${projection}${" ".repeat(
  projectionLength - projection.length,
)}${suffix}`;
if (tenKibibyteText.length !== tenKibibytes) {
  throw new Error("Session completion benchmark must be exactly 10 KiB");
}

function openLocalSession(
  service: SqlLanguageService<BenchmarkContext>,
): SqlDocumentSession<BenchmarkContext> {
  return service.openDocument({
    context: { dialect: "duckdb", engine: "benchmark" },
    text: tenKibibyteText,
  });
}

const localService =
  createSqlLanguageService<BenchmarkContext>({
    dialects: [dialect],
  });
const warmLocalSession = openLocalSession(localService);
const warmPreflight = await warmLocalSession.complete({
  position: tenKibibyteText.length,
  trigger: { kind: "invoked" },
});
if (
  warmPreflight.status !== "ready" ||
  warmPreflight.value.items.length !== 1
) {
  throw new Error("Warm session benchmark preflight failed");
}

const catalogRelations = Array.from(
  { length: 100 },
  (_, index): SqlCatalogRelation => ({
    canonicalPath: [
      {
        quoted: false,
        role: "relation" as const,
        value: `relation_${index}`,
      },
    ],
    completionPathStart: 0,
    entityId: `relation-${index}`,
    matchQuality: "exact" as const,
    relationKind: "table" as const,
  }),
);

function createCatalogService(): SqlLanguageService<BenchmarkContext> {
  return createSqlLanguageService<BenchmarkContext>({
    catalog: {
      id: "benchmark-catalog",
      search: async () => ({
        coverage: { kind: "complete" },
        epoch: { generation: 0, token: "initial" },
        relations: catalogRelations,
        status: "ready",
      }),
    },
    dialects: [dialect],
  });
}

const cachedCatalogService = createCatalogService();
const cachedCatalogSession = cachedCatalogService.openDocument({
  context: {
    catalog: { scope: "benchmark:cached" },
    dialect: "duckdb",
    engine: "benchmark",
  },
  text: "SELECT * FROM relation_",
});
const cachedPreflight = await cachedCatalogSession.complete({
  position: 23,
  trigger: { kind: "invoked" },
});
if (
  cachedPreflight.status !== "ready" ||
  cachedPreflight.value.items.length !== 100
) {
  throw new Error("Cached catalog benchmark preflight failed");
}

describe("session completion", () => {
  bench("cold 10 KiB local completion", async () => {
    const session = openLocalSession(localService);
    await session.complete({
      position: tenKibibyteText.length,
      trigger: { kind: "invoked" },
    });
    session.dispose();
  });

  bench("warm 10 KiB local completion", async () => {
    await warmLocalSession.complete({
      position: tenKibibyteText.length,
      trigger: { kind: "invoked" },
    });
  });

  bench("cached 100-candidate catalog completion", async () => {
    await cachedCatalogSession.complete({
      position: 23,
      trigger: { kind: "invoked" },
    });
  });

  bench("cold 100-candidate catalog completion", async () => {
    const service = createCatalogService();
    const session = service.openDocument({
      context: {
        catalog: { scope: "benchmark:cold" },
        dialect: "duckdb",
        engine: "benchmark",
      },
      text: "SELECT * FROM relation_",
    });
    await session.complete({
      position: 23,
      trigger: { kind: "invoked" },
    });
    service.dispose();
  });
});
