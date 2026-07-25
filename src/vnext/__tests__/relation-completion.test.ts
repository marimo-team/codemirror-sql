import { describe, expect, it } from "vitest";
import type {
  SqlValidatedCatalogRelation,
  SqlValidatedCatalogSearchResponse,
} from "../relation-catalog-boundary.js";
import {
  composeSqlRelationCompletion,
  MAX_RELATION_COMPLETION_RESULTS,
  type SqlComposableCatalogOutcome,
} from "../relation-completion.js";
import {
  analyzeSqlLocalRelationSite,
  prepareSqlLocalRelationStatement,
  type SqlLocalRelationSiteResult,
} from "../local-relation-site.js";
import {
  POSTGRESQL_SQL_RELATION_DIALECT,
} from "../relation-dialect.js";
import {
  createIdentitySqlSource,
} from "../source.js";
import {
  buildSqlStatementIndex,
  findSqlStatementSlot,
} from "../statement-index.js";
import type {
  SqlCanonicalRelationPath,
  SqlCatalogRelationKind,
  SqlCatalogReadyCoverage,
  SqlRelationCompletionList,
} from "../relation-completion-types.js";
import type {
  SqlTextRange,
} from "../types.js";

interface MarkedLocalSite {
  readonly localSite: Extract<
    SqlLocalRelationSiteResult,
    { readonly status: "ready" }
  >;
  readonly replacementRange: SqlTextRange;
  readonly statementOffset: number;
}

function markedLocalSite(marked: string): MarkedLocalSite {
  const position = marked.indexOf("|");
  if (
    position < 0 ||
    marked.indexOf("|", position + 1) >= 0
  ) {
    throw new Error("Expected exactly one cursor marker");
  }
  const text =
    marked.slice(0, position) + marked.slice(position + 1);
  const source = createIdentitySqlSource(text);
  const index = buildSqlStatementIndex(
    source.analysisText,
    POSTGRESQL_SQL_RELATION_DIALECT.querySite.lexicalProfile,
  );
  const slot = findSqlStatementSlot(index, position, "left");
  const prepared = prepareSqlLocalRelationStatement(
    source,
    index,
    slot,
    POSTGRESQL_SQL_RELATION_DIALECT,
  );
  if (prepared.status !== "ready") {
    throw new Error(`Local statement unavailable: ${prepared.reason}`);
  }
  const localSite = analyzeSqlLocalRelationSite(
    prepared.statement,
    position,
  );
  if (localSite.status !== "ready") {
    throw new Error(`Local site unavailable: ${localSite.status}`);
  }
  if (slot.boundaryQuality !== "exact") {
    throw new Error("Ready local relation site requires an exact slot");
  }
  return {
    localSite,
    replacementRange: Object.freeze({
      from:
        slot.source.from + localSite.querySite.typedPathRange.from,
      to:
        slot.source.from + localSite.querySite.typedPathRange.to,
    }),
    statementOffset: slot.source.from,
  };
}

function relationPath(
  containers: readonly string[],
  name: string,
): SqlCanonicalRelationPath {
  return Object.freeze([
    ...containers.map((value) =>
      Object.freeze({
        quoted: false,
        role: "schema" as const,
        value,
      }),
    ),
    Object.freeze({
      quoted: false,
      role: "relation" as const,
      value: name,
    }),
  ]);
}

function catalogRelation(input: {
  readonly completionPathStart?: number;
  readonly containers?: readonly string[];
  readonly entityId: string;
  readonly kind?: SqlCatalogRelationKind;
  readonly match?: "equivalent" | "exact";
  readonly name: string;
}): SqlValidatedCatalogRelation {
  const path = relationPath(
    input.containers ?? [],
    input.name,
  );
  const completionPathStart =
    input.completionPathStart ?? 0;
  if (
    completionPathStart !== 0 &&
    completionPathStart !== path.length - 1
  ) {
    throw new Error("Test helper supports full or relation-only completion");
  }
  const completionPath =
    completionPathStart === 0
      ? path
      : relationPath([], input.name);
  return Object.freeze({
    canonicalPath: path,
    completionPath,
    completionPathStart,
    completionText: completionPath
      .map((component) => component.value)
      .join("."),
    entityId: input.entityId,
    matchQuality: input.match ?? "exact",
    relationKind: input.kind ?? "table",
  });
}

function readyResponse(
  relations: readonly SqlValidatedCatalogRelation[],
  coverage: SqlCatalogReadyCoverage = Object.freeze({
    kind: "complete",
  }),
): Extract<
  SqlValidatedCatalogSearchResponse,
  { readonly status: "ready" }
> {
  return Object.freeze({
    coverage,
    epoch: Object.freeze({ generation: 1, token: "one" }),
    relations: Object.freeze([...relations]),
    status: "ready",
  });
}

function usable(
  response: SqlValidatedCatalogSearchResponse,
): SqlComposableCatalogOutcome {
  return Object.freeze({
    observation: "equal",
    response,
    status: "usable",
  });
}

function compose(
  marked: string,
  catalogOutcome: SqlComposableCatalogOutcome,
): SqlRelationCompletionList {
  const local = markedLocalSite(marked);
  return composeSqlRelationCompletion({
    catalogOutcome,
    dialect: POSTGRESQL_SQL_RELATION_DIALECT,
    localSite: local.localSite,
    providerId:
      catalogOutcome === null ? null : "catalog",
    remainingIntentLeaseMs: 25,
    replacementRange: local.replacementRange,
    statementOffset: local.statementOffset,
  }).value;
}

describe("relation completion composition", () => {
  it("ranks CTEs before deterministic catalog tiers and shadows only unqualified insertions", () => {
    const relations = [
      catalogRelation({
        entityId: "equivalent",
        match: "equivalent",
        name: "aardvark",
      }),
      catalogRelation({
        completionPathStart: 0,
        containers: ["public"],
        entityId: "qualified-users",
        name: "users",
      }),
      catalogRelation({
        entityId: "view",
        kind: "view",
        name: "beta",
      }),
      catalogRelation({
        entityId: "shadowed-users",
        name: "users",
      }),
      catalogRelation({
        entityId: "table",
        name: "alpha",
      }),
    ];
    const value = compose(
      "WITH zed AS (SELECT 1), users AS (SELECT 1) SELECT * FROM |",
      usable(readyResponse(relations)),
    );

    expect(
      value.items.map((item) => [
        item.relationKind,
        item.label,
        item.edit.insert,
      ]),
    ).toEqual([
      ["cte", "users", "users"],
      ["cte", "zed", "zed"],
      ["table", "alpha", "alpha"],
      ["view", "beta", "beta"],
      ["table", "users", "public.users"],
      ["table", "aardvark", "aardvark"],
    ]);
    expect(
      value.items.some(
        (item) =>
          item.provenance.kind === "catalog" &&
          item.provenance.entityId === "shadowed-users",
      ),
    ).toBe(false);
    expect(value.isIncomplete).toBe(false);
  });

  it("uses the mapped whole-path replacement range and preserves qualified catalog candidates", () => {
    const local = markedLocalSite(
      "WITH users AS (SELECT 1) SELECT * FROM public.us|",
    );
    const result = composeSqlRelationCompletion({
      catalogOutcome: usable(
        readyResponse([
          catalogRelation({
            completionPathStart: 1,
            containers: ["public"],
            entityId: "users",
            name: "users",
          }),
        ]),
      ),
      dialect: POSTGRESQL_SQL_RELATION_DIALECT,
      localSite: local.localSite,
      providerId: "catalog",
      remainingIntentLeaseMs: 0,
      replacementRange: local.replacementRange,
      statementOffset: local.statementOffset,
    });

    expect(result.value.items).toHaveLength(1);
    expect(result.value.items[0]?.edit).toEqual({
      from: local.replacementRange.from,
      insert: "users",
      to: local.replacementRange.to,
    });
  });

  it("reports soft loading, terminal catalog evidence, and coverage in a stable issue order", () => {
    const loading = compose(
      "SELECT * FROM |",
      Object.freeze({ status: "loading" }),
    );
    expect(loading).toMatchObject({
      isIncomplete: true,
      issues: [
        {
          reason: "catalog-loading",
          remainingIntentLeaseMs: 25,
        },
      ],
    });

    const partial = compose(
      'SELECT * FROM "unterminated|',
      usable(
        readyResponse(
          [],
          Object.freeze({ kind: "partial" }),
        ),
      ),
    );
    expect(partial.issues.map((issue) => issue.reason)).toEqual([
      "query-site-recovery",
      "catalog-partial",
    ]);

    const paginated = compose(
      "SELECT * FROM |",
      usable(
        readyResponse(
          [],
          Object.freeze({
            continuationToken: "secret",
            kind: "paginated",
          }),
        ),
      ),
    );
    expect(paginated.issues).toEqual([
      { reason: "catalog-paginated" },
    ]);
    expect(JSON.stringify(paginated)).not.toContain("secret");
  });

  it.each([
    ["execution-timeout", "catalog-timeout", "execution-timeout"],
    ["malformed-response", "catalog-malformed", "malformed-response"],
    ["overloaded", "catalog-overloaded", "queue-overloaded"],
    ["provider-failed", "catalog-failed", "provider-rejected"],
    ["queue-timeout", "catalog-queue-timeout", "queue-timeout"],
  ] as const)(
    "maps %s without discarding local evidence",
    (reason, issue, reportReason) => {
      const local = markedLocalSite(
        "WITH local_table AS (SELECT 1) SELECT * FROM |",
      );
      const result = composeSqlRelationCompletion({
        catalogOutcome: Object.freeze({
          reason,
          status: "unavailable",
        }),
        dialect: POSTGRESQL_SQL_RELATION_DIALECT,
        localSite: local.localSite,
        providerId: "catalog",
        remainingIntentLeaseMs: 0,
        replacementRange: local.replacementRange,
        statementOffset: local.statementOffset,
      });

      expect(result.value.items[0]?.label).toBe("local_table");
      expect(result.value.issues).toContainEqual({ reason: issue });
      expect(result.sources).toEqual([
        {
          feature: "relation-catalog",
          outcome: "unavailable",
          providerId: "catalog",
          reason: reportReason,
        },
      ]);
    },
  );

  it("applies the result cap after ranking and returns deeply frozen output", () => {
    const declarations = Array.from(
      { length: MAX_RELATION_COMPLETION_RESULTS + 1 },
      (_, index) => `cte_${String(index).padStart(3, "0")} AS (SELECT 1)`,
    ).join(", ");
    const value = compose(
      `WITH ${declarations} SELECT * FROM |`,
      null,
    );

    expect(value.items).toHaveLength(
      MAX_RELATION_COMPLETION_RESULTS,
    );
    expect(value.items[0]?.label).toBe("cte_000");
    expect(value.items.at(-1)?.label).toBe("cte_099");
    expect(value.issues).toContainEqual({ reason: "result-limit" });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.items)).toBe(true);
    expect(Object.isFrozen(value.items[0]?.edit)).toBe(true);
    expect(Object.isFrozen(value.items[0]?.provenance)).toBe(true);
  });
});
