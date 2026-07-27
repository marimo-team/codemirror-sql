import { describe, expect, it } from "vitest";
import {
  analyzeSqlLocalColumnSite,
  analyzeSqlLocalRelationSite,
  applySqlQueryOutputAliases,
  prepareSqlLocalRelationStatement,
  type SqlLocalRelationSiteResult,
} from "../local-relation-site.js";
import {
  BIGQUERY_SQL_RELATION_DIALECT,
  DREMIO_SQL_RELATION_DIALECT,
  DUCKDB_SQL_RELATION_DIALECT,
  POSTGRESQL_SQL_RELATION_DIALECT,
  type SqlRelationDialectRuntime,
} from "../relation-dialect.js";
import {
  createIdentitySqlSource,
  type SqlSourceSnapshot,
} from "../source.js";
import {
  buildSqlStatementIndex,
  findSqlStatementSlot,
  type SqlStatementIndex,
  type SqlStatementSlot,
} from "../statement-index.js";

it("retains bounded alias evidence when an underlying output is unavailable", () => {
  expect(
    applySqlQueryOutputAliases(
      { reason: "unsupported-query", status: "unavailable" },
      {
        columns: [{
          definition: { from: 0, to: 4 },
          identifier: { quoted: false, value: "name" },
          insertText: "name",
        }],
        coverage: "complete",
      },
    ),
  ).toMatchObject({
    columns: [{ identifier: { value: "name" } }],
    coverage: "partial",
    status: "ready",
  });
});

const RUNTIMES = [
  {
    dialect: POSTGRESQL_SQL_RELATION_DIALECT,
    name: "PostgreSQL",
  },
  { dialect: DUCKDB_SQL_RELATION_DIALECT, name: "DuckDB" },
  { dialect: BIGQUERY_SQL_RELATION_DIALECT, name: "BigQuery" },
  { dialect: DREMIO_SQL_RELATION_DIALECT, name: "Dremio" },
] as const;

function markedText(marked: string): {
  readonly position: number;
  readonly text: string;
} {
  const position = marked.indexOf("|");
  if (position < 0 || marked.indexOf("|", position + 1) >= 0) {
    throw new Error("Fixture requires exactly one cursor marker");
  }
  return {
    position,
    text: `${marked.slice(0, position)}${marked.slice(position + 1)}`,
  };
}

function hostileProxy<Value extends object>(
  target: Value,
  onInvoke: () => void,
): Value {
  return new Proxy(target, {
    get() {
      onInvoke();
      throw new Error("hostile");
    },
    getOwnPropertyDescriptor() {
      onInvoke();
      throw new Error("hostile");
    },
    ownKeys() {
      onInvoke();
      throw new Error("hostile");
    },
  });
}

function analyzeMarked(
  marked: string,
  dialect: SqlRelationDialectRuntime =
    POSTGRESQL_SQL_RELATION_DIALECT,
): {
  readonly index: SqlStatementIndex;
  readonly position: number;
  readonly result: SqlLocalRelationSiteResult;
  readonly slot: SqlStatementSlot;
  readonly source: SqlSourceSnapshot;
} {
  const { position, text } = markedText(marked);
  const source = createIdentitySqlSource(text);
  const index = buildSqlStatementIndex(
    source.analysisText,
    dialect.querySite.lexicalProfile,
  );
  const slot = findSqlStatementSlot(index, position, "left");
  const preparation = prepareSqlLocalRelationStatement(
    source,
    index,
    slot,
    dialect,
  );
  if (preparation.status === "unavailable") {
    return {
      index,
      position,
      result: preparation,
      slot,
      source,
    };
  }
  return {
    index,
    position,
    result: analyzeSqlLocalRelationSite(
      preparation.statement,
      position,
    ),
    slot,
    source,
  };
}

function expectReady(
  result: SqlLocalRelationSiteResult,
): Extract<SqlLocalRelationSiteResult, { readonly status: "ready" }> {
  expect(result.status).toBe("ready");
  if (result.status !== "ready") {
    throw new Error("Expected a ready local relation site");
  }
  return result;
}

function visibleNames(
  result: SqlLocalRelationSiteResult,
): string[] {
  const ready = expectReady(result);
  expect(ready.local.kind).toBe("unqualified");
  if (ready.local.kind !== "unqualified") {
    throw new Error("Expected unqualified local evidence");
  }
  return ready.local.cteVisibility.ctes.map(
    (cte) => cte.sourceSpelling,
  );
}

describe("local relation statement preparation", () => {
  it("fails closed for mixed runtime and source/index/slot evidence", () => {
    const source = createIdentitySqlSource("SELECT * FROM ");
    const index = buildSqlStatementIndex(
      source.analysisText,
      POSTGRESQL_SQL_RELATION_DIALECT.querySite.lexicalProfile,
    );
    const slot = findSqlStatementSlot(
      index,
      source.analysisText.length,
      "left",
    );
    const mixedRuntime: SqlRelationDialectRuntime = {
      ...POSTGRESQL_SQL_RELATION_DIALECT,
      querySite: DUCKDB_SQL_RELATION_DIALECT.querySite,
    };
    expect(
      prepareSqlLocalRelationStatement(
        source,
        index,
        slot,
        mixedRuntime,
      ).status,
    ).toBe("unavailable");
    expect(
      prepareSqlLocalRelationStatement(
        { ...source },
        index,
        slot,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ).status,
    ).toBe("unavailable");
    expect(
      prepareSqlLocalRelationStatement(
        source,
        { ...index },
        slot,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ).status,
    ).toBe("unavailable");
    expect(
      prepareSqlLocalRelationStatement(
        source,
        index,
        { ...slot },
        POSTGRESQL_SQL_RELATION_DIALECT,
      ).status,
    ).toBe("unavailable");

    const otherSource = createIdentitySqlSource(source.analysisText);
    const otherIndex = buildSqlStatementIndex(
      otherSource.analysisText,
      POSTGRESQL_SQL_RELATION_DIALECT.querySite.lexicalProfile,
    );
    const otherSlot = findSqlStatementSlot(
      otherIndex,
      otherSource.analysisText.length,
      "left",
    );
    expect(
      prepareSqlLocalRelationStatement(
        source,
        otherIndex,
        slot,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ).status,
    ).toBe("unavailable");
    expect(
      prepareSqlLocalRelationStatement(
        source,
        index,
        otherSlot,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ).status,
    ).toBe("unavailable");
  });

  it("rejects hostile proxies without invoking traps", () => {
    const source = createIdentitySqlSource("SELECT * FROM ");
    const index = buildSqlStatementIndex(
      source.analysisText,
      POSTGRESQL_SQL_RELATION_DIALECT.querySite.lexicalProfile,
    );
    const slot = findSqlStatementSlot(
      index,
      source.analysisText.length,
      "left",
    );
    let invoked = false;
    const onInvoke = () => {
      invoked = true;
    };
    expect(
      prepareSqlLocalRelationStatement(
        hostileProxy(source, onInvoke),
        index,
        slot,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ).status,
    ).toBe("unavailable");
    expect(
      prepareSqlLocalRelationStatement(
        source,
        hostileProxy(index, onInvoke),
        slot,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ).status,
    ).toBe("unavailable");
    expect(
      prepareSqlLocalRelationStatement(
        source,
        index,
        hostileProxy(slot, onInvoke),
        POSTGRESQL_SQL_RELATION_DIALECT,
      ).status,
    ).toBe("unavailable");
    expect(
      prepareSqlLocalRelationStatement(
        source,
        index,
        slot,
        hostileProxy(
          POSTGRESQL_SQL_RELATION_DIALECT,
          onInvoke,
        ),
      ).status,
    ).toBe("unavailable");
    expect(invoked).toBe(false);
  });

  it("preserves explicit opaque and resource failures", () => {
    const opaqueSource = createIdentitySqlSource("DELIMITER $$");
    const opaqueIndex = buildSqlStatementIndex(
      opaqueSource.analysisText,
      POSTGRESQL_SQL_RELATION_DIALECT.querySite.lexicalProfile,
    );
    const opaqueSlot = findSqlStatementSlot(
      opaqueIndex,
      opaqueSource.analysisText.length,
      "left",
    );
    expect(
      prepareSqlLocalRelationStatement(
        opaqueSource,
        opaqueIndex,
        opaqueSlot,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    ).toEqual({
      reason: "opaque-statement",
      status: "unavailable",
    });

    const longSource = createIdentitySqlSource(
      `SELECT * FROM ${" ".repeat(65_537)}`,
    );
    const longIndex = buildSqlStatementIndex(
      longSource.analysisText,
      POSTGRESQL_SQL_RELATION_DIALECT.querySite.lexicalProfile,
    );
    const longSlot = findSqlStatementSlot(
      longIndex,
      longSource.analysisText.length,
      "left",
    );
    expect(
      prepareSqlLocalRelationStatement(
        longSource,
        longIndex,
        longSlot,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    ).toEqual({
      reason: "resource-limit",
      resource: "active-statement",
      status: "unavailable",
    });
  });
});

describe("local relation-site evidence", () => {
  it.each(RUNTIMES)(
    "projects visible main-query CTEs for $name",
    ({ dialect }) => {
      const declarations =
        dialect === DREMIO_SQL_RELATION_DIALECT
          ? "first(id) AS (SELECT 1)"
          : "first AS (SELECT 1), second AS (SELECT 2)";
      const result = analyzeMarked(
        `WITH ${declarations} SELECT * FROM |`,
        dialect,
      ).result;
      expect(visibleNames(result)).toEqual(
        dialect === DREMIO_SQL_RELATION_DIALECT
          ? ["first"]
          : ["first", "second"],
      );
      const ready = expectReady(result);
      if (ready.local.kind !== "unqualified") {
        throw new Error("Expected unqualified local evidence");
      }
      expect(ready.querySite.recognition.quality).toBe("exact");
      expect(ready.local.cteVisibility).toMatchObject({
        issues: [],
        quality: "exact",
        shadowing: { coverage: "complete" },
      });
    },
  );

  it.each(RUNTIMES)(
    "keeps ordinary $name sites locally empty",
    ({ dialect }) => {
      const result = analyzeMarked(
        "SELECT * FROM |",
        dialect,
      ).result;
      expect(visibleNames(result)).toEqual([]);
    },
  );

  it("projects non-recursive sibling visibility", () => {
    expect(
      visibleNames(
        analyzeMarked(
          "WITH first AS (SELECT * FROM |), second AS (SELECT 2) SELECT 1",
        ).result,
      ),
    ).toEqual([]);
    expect(
      visibleNames(
        analyzeMarked(
          "WITH first AS (SELECT 1), second AS (SELECT * FROM |) SELECT 1",
        ).result,
      ),
    ).toEqual(["first"]);
  });

  it("preserves recursive uncertainty without inventing candidates", () => {
    const ready = expectReady(
      analyzeMarked(
        "WITH RECURSIVE first AS (SELECT * FROM |) SELECT 1",
      ).result,
    );
    if (ready.local.kind !== "unqualified") {
      throw new Error("Expected unqualified local evidence");
    }
    expect(ready.local.cteVisibility).toMatchObject({
      ctes: [],
      issues: ["recursive-cte-position"],
      quality: "recovered",
      shadowing: { coverage: "complete" },
    });
  });

  it("uses statement-relative coordinates in later statements", () => {
    const fixture = analyzeMarked(
      "SELECT 0; WITH later_cte AS (SELECT 1) SELECT * FROM |",
    );
    const ready = expectReady(fixture.result);
    if (
      ready.local.kind !== "unqualified" ||
      fixture.slot.boundaryQuality === "opaque"
    ) {
      throw new Error("Expected exact unqualified later-statement evidence");
    }
    const cte = ready.local.cteVisibility.ctes[0];
    expect(cte?.sourceSpelling).toBe("later_cte");
    expect(cte?.declarationPosition).toBe(
      fixture.source.analysisText.indexOf("later_cte") -
        fixture.slot.source.from,
    );
    expect(ready.querySite.finalSegmentRange.from).toBe(
      fixture.position - fixture.slot.source.from,
    );
  });

  it("fails column analysis closed outside the prepared statement", () => {
    const text =
      "SELECT x FROM first_table WHERE ; SELECT y FROM second_table";
    const source = createIdentitySqlSource(text);
    const index = buildSqlStatementIndex(
      text,
      POSTGRESQL_SQL_RELATION_DIALECT.querySite.lexicalProfile,
    );
    const first = findSqlStatementSlot(index, 0, "right");
    const preparation = prepareSqlLocalRelationStatement(
      source,
      index,
      first,
      POSTGRESQL_SQL_RELATION_DIALECT,
    );
    if (preparation.status !== "ready") {
      throw new Error("Expected exact first-statement preparation");
    }

    expect(analyzeSqlLocalColumnSite(
      preparation.statement,
      text.indexOf("y FROM"),
    )).toEqual({
      reason: "not-column-position",
      status: "inactive",
    });
  });

  it("separates qualified sites from irrelevant CTE uncertainty", () => {
    const ready = expectReady(
      analyzeMarked(
        "WITH RECURSIVE first AS (SELECT 1) SELECT * FROM schema.|",
      ).result,
    );
    expect(ready.local).toEqual({ kind: "qualified" });
    expect(ready.querySite.qualifier).toEqual([
      { quoted: false, value: "schema" },
    ]);
  });

  it("passes inactive query-site states through without local evidence", () => {
    expect(analyzeMarked("SELECT |").result).toEqual({
      reason: "not-relation-position",
      status: "inactive",
    });
    expect(analyzeMarked("SELECT * FROM '|'").result).toEqual({
      reason: "cursor-in-string",
      status: "inactive",
    });
  });

  it("rejects copied and proxied prepared statements without traps", () => {
    const fixture = markedText("SELECT * FROM |");
    const source = createIdentitySqlSource(fixture.text);
    const index = buildSqlStatementIndex(
      source.analysisText,
      POSTGRESQL_SQL_RELATION_DIALECT.querySite.lexicalProfile,
    );
    const slot = findSqlStatementSlot(
      index,
      fixture.position,
      "left",
    );
    const preparation = prepareSqlLocalRelationStatement(
      source,
      index,
      slot,
      POSTGRESQL_SQL_RELATION_DIALECT,
    );
    if (preparation.status === "unavailable") {
      throw new Error("Prepared statement fixture must be ready");
    }
    expect(
      analyzeSqlLocalRelationSite(
        { ...preparation.statement },
        fixture.position,
      ),
    ).toEqual({
      reason: "ambiguous-query-site",
      status: "unavailable",
    });
    let invoked = false;
    const proxied = new Proxy(preparation.statement, {
      get() {
        invoked = true;
        throw new Error("hostile");
      },
      getOwnPropertyDescriptor() {
        invoked = true;
        throw new Error("hostile");
      },
      ownKeys() {
        invoked = true;
        throw new Error("hostile");
      },
    });
    expect(
      analyzeSqlLocalRelationSite(proxied, fixture.position),
    ).toEqual({
      reason: "ambiguous-query-site",
      status: "unavailable",
    });
    expect(invoked).toBe(false);
    expect(
      Reflect.apply(analyzeSqlLocalRelationSite, undefined, [
        null,
        fixture.position,
      ]),
    ).toEqual({
      reason: "ambiguous-query-site",
      status: "unavailable",
    });
    expect(
      Reflect.apply(analyzeSqlLocalColumnSite, undefined, [
        null,
        fixture.position,
      ]),
    ).toEqual({
      reason: "ambiguous-query-site",
      status: "unavailable",
    });
    expect(
      analyzeSqlLocalColumnSite(
        { ...preparation.statement },
        fixture.position,
      ),
    ).toEqual({
      reason: "ambiguous-query-site",
      status: "unavailable",
    });
  });

  it("is deterministic and freezes every exposed wrapper", () => {
    const fixture = markedText(
      "WITH first AS (SELECT 1) SELECT * FROM |",
    );
    const source = createIdentitySqlSource(fixture.text);
    const index = buildSqlStatementIndex(
      source.analysisText,
      POSTGRESQL_SQL_RELATION_DIALECT.querySite.lexicalProfile,
    );
    const slot = findSqlStatementSlot(
      index,
      fixture.position,
      "left",
    );
    const preparation = prepareSqlLocalRelationStatement(
      source,
      index,
      slot,
      POSTGRESQL_SQL_RELATION_DIALECT,
    );
    if (preparation.status === "unavailable") {
      throw new Error("Prepared statement fixture must be ready");
    }
    const first = analyzeSqlLocalRelationSite(
      preparation.statement,
      fixture.position,
    );
    const second = analyzeSqlLocalRelationSite(
      preparation.statement,
      fixture.position,
    );
    expect(first).toEqual(second);
    expect(Object.isFrozen(preparation)).toBe(true);
    expect(Object.isFrozen(preparation.statement)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    const ready = expectReady(first);
    expect(Object.isFrozen(ready.local)).toBe(true);
    expect(Object.isFrozen(ready.querySite)).toBe(true);
    if (ready.local.kind === "unqualified") {
      expect(Object.isFrozen(ready.local.cteVisibility)).toBe(true);
      expect(Object.isFrozen(ready.local.cteVisibility.ctes)).toBe(true);
    }
  });
});
