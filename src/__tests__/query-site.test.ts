import { describe, expect, it } from "vitest";
import {
  analyzeSqlCteLayout,
  type SqlCteLayout,
} from "../cte-layout.js";
import {
  MAX_QUERY_SITE_DEPTH,
  MAX_QUERY_SITE_IDENTIFIER_LENGTH,
  MAX_QUERY_SITE_LEXEMES,
  MAX_QUERY_SITE_PATH_COMPONENTS,
  MAX_QUERY_SITE_STATEMENT_LENGTH,
  recognizeSqlRelationQuerySite,
  type SqlDecodedQueryPath,
  type SqlQuerySiteDialect,
  type SqlQuerySiteResult,
} from "../query-site.js";
import {
  recognizeSqlRelationQuerySiteWithCteLayout,
} from "../relation-query-site.js";
import {
  BIGQUERY_SQL_RELATION_DIALECT,
  DREMIO_SQL_RELATION_DIALECT,
  DUCKDB_SQL_RELATION_DIALECT,
  POSTGRESQL_SQL_RELATION_DIALECT,
  type SqlRelationDialectRuntime,
} from "../relation-dialect.js";
import {
  createIdentitySqlSource,
  createMaskedSqlSource,
  type SqlSourceSnapshot,
} from "../source.js";
import {
  buildSqlStatementIndex,
  findSqlStatementSlot,
  POSTGRESQL_SQL_LEXICAL_PROFILE,
  type ExactSqlStatementSlot,
  updateSqlStatementIndex,
} from "../statement-index.js";

const postgresDialect = POSTGRESQL_SQL_RELATION_DIALECT.querySite;
const duckdbDialect = DUCKDB_SQL_RELATION_DIALECT.querySite;
const bigQueryDialect = BIGQUERY_SQL_RELATION_DIALECT.querySite;
const classifyIdentifierToken =
  postgresDialect.classifyIdentifierToken;

function markedSource(marked: string): {
  readonly position: number;
  readonly text: string;
} {
  const position = marked.indexOf("|");
  if (position < 0 || marked.indexOf("|", position + 1) >= 0) {
    throw new Error("Query fixture requires exactly one cursor marker");
  }
  return {
    position,
    text: marked.slice(0, position) + marked.slice(position + 1),
  };
}

function recognize(
  marked: string,
  options: {
    readonly dialect?: SqlQuerySiteDialect;
    readonly regions?: readonly {
      readonly from: number;
      readonly language: string;
      readonly to: number;
    }[];
  } = {},
): SqlQuerySiteResult {
  const { position, text } = markedSource(marked);
  const source: SqlSourceSnapshot = options.regions
    ? createMaskedSqlSource(text, options.regions)
    : createIdentitySqlSource(text);
  const dialect = options.dialect ?? postgresDialect;
  const index = buildSqlStatementIndex(
    source.analysisText,
    dialect.lexicalProfile,
  );
  const slot = findSqlStatementSlot(
    index,
    position,
    position === 0 ? "right" : "left",
  );
  return recognizeSqlRelationQuerySite(source, slot, position, dialect);
}

function expectReady(
  result: SqlQuerySiteResult,
): Extract<SqlQuerySiteResult, { readonly status: "ready" }> {
  expect(result.status).toBe("ready");
  if (result.status !== "ready") {
    throw new Error(`Expected ready, received ${result.status}`);
  }
  return result;
}

function cteFixture(
  marked: string,
  dialect: SqlRelationDialectRuntime =
    POSTGRESQL_SQL_RELATION_DIALECT,
): {
  readonly layout: Exclude<
    SqlCteLayout,
    { readonly status: "unavailable" }
  >;
  readonly position: number;
  readonly result: SqlQuerySiteResult;
  readonly slot: ExactSqlStatementSlot;
  readonly source: SqlSourceSnapshot;
} {
  const { position, text } = markedSource(marked);
  const source = createIdentitySqlSource(text);
  const index = buildSqlStatementIndex(
    source.analysisText,
    dialect.querySite.lexicalProfile,
  );
  const slot = findSqlStatementSlot(index, position, "left");
  if (slot.boundaryQuality === "opaque") {
    throw new Error("CTE query fixture requires an exact statement");
  }
  const layout = analyzeSqlCteLayout(
    source,
    index,
    slot,
    dialect.cteLayout,
  );
  if (layout.status === "unavailable") {
    throw new Error("CTE query fixture requires an available layout");
  }
  return {
    layout,
    position,
    result: recognizeSqlRelationQuerySiteWithCteLayout(
      source,
      slot,
      position,
      dialect,
      layout,
    ),
    slot,
    source,
  };
}

describe("partial SELECT relation query sites", () => {
  it.each([
    ["SELECT * FROM |", "from"],
    ["SELECT * FROM users u JOIN |", "join"],
    ["SELECT * FROM users LEFT OUTER JOIN |", "join"],
    ["SELECT * FROM users, |", "comma"],
    ["SELECT * FROM |, other", "from"],
    ["SELECT * FROM a, |, b", "comma"],
    ["SELECT * FROM a JOIN |, b", "join"],
    ["SELECT * FROM a JOIN b USING(id), |", "comma"],
    ["SELECT * FROM a JOIN b USING(id) LEFT JOIN |", "join"],
    ['SELECT * FROM a JOIN b USING("id", other) JOIN |', "join"],
    [
      "SELECT * FROM a JOIN b USING(id) WHERE EXISTS (SELECT * FROM |)",
      "from",
    ],
    ["SELECT (SELECT * FROM |)", "from"],
    ["SELECT * FROM (SELECT * FROM |) q", "from"],
    ["SELECT * FROM /* closed */ |", "from"],
  ] as const)("recognizes %s", (marked, anchor) => {
    const result = expectReady(recognize(marked));
    expect(result.anchor).toBe(anchor);
    expect(result.prefix).toEqual({ quoted: false, value: "" });
    expect(result.recognition).toEqual({ issues: [], quality: "exact" });
  });

  it("returns decoded paths and statement-relative replacement ranges", () => {
    const result = expectReady(recognize("  SELECT * FROM schema.us|"));
    expect(result.qualifier).toEqual([{ quoted: false, value: "schema" }]);
    expect(result.prefix).toEqual({ quoted: false, value: "us" });
    expect(result.typedPathRange).toMatchObject({ from: 16, to: 25 });
    expect(result.finalSegmentRange).toMatchObject({ from: 23, to: 25 });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.qualifier)).toBe(true);
    expect(Object.isFrozen(result.prefix)).toBe(true);
  });

  it("authenticates the complete token when the cursor is mid-prefix", () => {
    const result = expectReady(recognize("SELECT * FROM schema.us|ers"));
    expect(result.prefix.value).toBe("us");
    expect(result.typedPathRange).toMatchObject({ from: 14, to: 26 });
    expect(result.finalSegmentRange).toMatchObject({ from: 21, to: 26 });
  });

  it("authenticates the complete path before returning a replacement", () => {
    expect(recognize("SELECT * FROM sch|ema.users").status).toBe(
      "unavailable",
    );
    expect(recognize("SELECT * FROM schema|.users").status).toBe(
      "unavailable",
    );
    const result = expectReady(recognize("SELECT * FROM schema.|users"));
    expect(result.prefix).toEqual({ quoted: false, value: "" });
    expect(result.typedPathRange).toMatchObject({ from: 14, to: 26 });
  });

  it("recognizes a trailing-dot empty prefix", () => {
    const result = expectReady(recognize("SELECT * FROM schema.|"));
    expect(result.qualifier).toEqual([{ quoted: false, value: "schema" }]);
    expect(result.prefix).toEqual({ quoted: false, value: "" });
  });

  it.each([
    "SELECT * FROM schema.| JOIN other ON true",
    "SELECT * FROM schema.| WHERE true",
    "SELECT * FROM schema.| /*c*/ JOIN other ON true",
    "SELECT * FROM schema.|)",
    "SELECT * FROM schema.|, other",
  ])("recognizes a trailing-dot site before an authenticated suffix in %s", (marked) => {
    const result = expectReady(recognize(marked));
    expect(result.qualifier).toEqual([{ quoted: false, value: "schema" }]);
    expect(result.prefix).toEqual({ quoted: false, value: "" });
  });

  it("recovers an incomplete quoted final identifier", () => {
    const result = expectReady(
      recognize("SELECT * FROM \"schema\".\"us|", {
        dialect: postgresDialect,
      }),
    );
    expect(result.qualifier).toEqual([{ quoted: true, value: "schema" }]);
    expect(result.prefix).toEqual({ quoted: true, value: "us" });
    expect(result.recognition).toEqual({
      issues: ["incomplete-identifier"],
      quality: "recovered",
    });
  });

  it("delegates whole-path BigQuery quotes to the dialect", () => {
    const result = expectReady(
      recognize("SELECT * FROM `project.dataset.us|", {
        dialect: bigQueryDialect,
      }),
    );
    expect(result.qualifier).toEqual([
      { quoted: true, value: "project" },
      { quoted: true, value: "dataset" },
    ]);
    expect(result.prefix).toEqual({ quoted: true, value: "us" });
    expect(result.recognition.quality).toBe("recovered");
    expect(
      recognize("SELECT * FROM `project.|dataset.us`", {
        dialect: bigQueryDialect,
      }).status,
    ).toBe("unavailable");
    expect(
      recognize("SELECT * FROM `project.dataset.us`|", {
        dialect: bigQueryDialect,
      }).status,
    ).toBe("ready");
  });

  it("supports DuckDB independently of parser compatibility", () => {
    expect(expectReady(recognize("SELECT * FROM main.us|", {
      dialect: duckdbDialect,
    })).prefix.value).toBe("us");
  });

  it("applies each built-in identifier and path policy", () => {
    expect(
      expectReady(recognize("SELECT * FROM foo$use|r")).prefix.value,
    ).toBe("foo$use");
    expect(
      expectReady(
        recognize("SELECT * FROM my-project.dataset.ta|", {
          dialect: bigQueryDialect,
        }),
      ).qualifier,
    ).toEqual([
      { quoted: false, value: "my-project" },
      { quoted: false, value: "dataset" },
    ]);
    expect(
      recognize("SELECT * FROM memory.main.users|", {
        dialect: duckdbDialect,
      }).status,
    ).toBe("ready");
    expect(
      recognize("SELECT * FROM a.b.c.d|", {
        dialect: duckdbDialect,
      }),
    ).toEqual({
      reason: "resource-limit",
      resource: "identifier-path",
      status: "unavailable",
    });
  });

  it.each([
    "SELECT -- FROM is trivia\n * FROM |",
    "SELECT /* nested /* FROM */ comment */ * FROM |",
    "SELECT $tag$FROM$tag$ FROM |",
  ])("shares PostgreSQL lexical handling for %s", (marked) => {
    expect(recognize(marked).status).toBe("ready");
  });

  it.each([
    "SELECT # FROM is trivia\n * FROM |",
    "SELECT 'FROM' FROM |",
    "SELECT r'FROM' FROM |",
    "SELECT 'one''two' FROM |",
    "SELECT '''FROM''' FROM |",
    "SELECT \"\"\"FROM\"\"\" FROM |",
  ])("shares BigQuery lexical handling for %s", (marked) => {
    expect(recognize(marked, { dialect: bigQueryDialect }).status).toBe(
      "ready",
    );
  });

  it.each([
    "SELECT * FROM users AS u JOIN |",
    "SELECT * FROM users AS \"u\" JOIN |",
    "SELECT * FROM users AS \"LEFT\" JOIN |",
    "SELECT * FROM users \"u\" JOIN |",
    "SELECT * FROM users INNER JOIN |",
    "SELECT * FROM users CROSS JOIN |",
    "SELECT * FROM users NATURAL JOIN |",
    "SELECT * FROM users NATURAL INNER JOIN |",
    "SELECT * FROM users NATURAL LEFT JOIN |",
    "SELECT * FROM users NATURAL LEFT OUTER JOIN |",
    "SELECT * FROM users NATURAL RIGHT JOIN |",
    "SELECT * FROM users NATURAL RIGHT OUTER JOIN |",
    "SELECT * FROM users NATURAL FULL JOIN |",
    "SELECT * FROM users NATURAL FULL OUTER JOIN |",
    "SELECT * FROM users RIGHT OUTER JOIN |",
    "SELECT * FROM users FULL OUTER JOIN |",
  ])("supports explicit join transitions in %s", (marked) => {
    expect(expectReady(recognize(marked)).anchor).toBe("join");
  });

  it("keeps NATURAL JOIN support dialect-owned", () => {
    expect(
      recognize("SELECT * FROM users NATURAL LEFT OUTER JOIN |", {
        dialect: duckdbDialect,
      }).status,
    ).toBe("ready");
    for (const marked of [
      "SELECT * FROM users NATURAL JOIN |",
      "SELECT * FROM users NATURAL INNER JOIN |",
      "SELECT * FROM users NATURAL LEFT OUTER JOIN |",
      "SELECT * FROM users NATURAL RIGHT JOIN |",
      "SELECT * FROM users NATURAL FULL JOIN |",
    ]) {
      expect(
        recognize(marked, { dialect: bigQueryDialect }).status,
      ).toBe("unavailable");
    }

    const malformedDialect: SqlQuerySiteDialect = {
      ...postgresDialect,
    };
    Object.defineProperty(malformedDialect, "supportsNaturalJoin", {
      value: "yes",
    });
    expect(
      recognize("SELECT * FROM users JOIN |", {
        dialect: malformedDialect,
      }).status,
    ).toBe("unavailable");
  });
});

describe("authenticated CTE main-query entrypoints", () => {
  it.each([
    [
      "WITH cte_name AS (SELECT 1) SELECT * FROM |",
      POSTGRESQL_SQL_RELATION_DIALECT,
    ],
    [
      "WITH cte_name AS (SELECT 1) SELECT * FROM |",
      DUCKDB_SQL_RELATION_DIALECT,
    ],
    [
      "WITH cte_name AS (SELECT 1) SELECT * FROM |",
      BIGQUERY_SQL_RELATION_DIALECT,
    ],
    [
      "WITH cte_name(id) AS (SELECT 1) SELECT * FROM |",
      DREMIO_SQL_RELATION_DIALECT,
    ],
  ] as const)("recognizes a built-in main query in %s", (marked, dialect) => {
    const result = expectReady(cteFixture(marked, dialect).result);
    expect(result.anchor).toBe("from");
    expect(result.recognition).toEqual({
      issues: [],
      quality: "exact",
    });
  });

  it("recognizes nested CTE main queries by exact offset and depth", () => {
    const result = expectReady(
      cteFixture(
        "WITH outer_cte AS (WITH inner_cte AS (SELECT 1) SELECT * FROM |) SELECT 1",
      ).result,
    );
    expect(result.anchor).toBe("from");
  });

  it("returns to the enclosing entrypoint after a nested CTE closes", () => {
    const result = expectReady(
      cteFixture(
        "WITH outer_cte AS (WITH inner_cte AS (SELECT 1) SELECT * FROM inner_cte) SELECT * FROM |",
      ).result,
    );
    expect(result.anchor).toBe("from");
    expect(result.recognition.quality).toBe("exact");
  });

  it("keeps ordinary CTE body recognition independent of entrypoints", () => {
    const marked =
      "WITH local AS (SELECT * FROM |) SELECT * FROM local";
    expect(recognize(marked).status).toBe("ready");
    expect(cteFixture(marked).result.status).toBe("ready");
  });

  it("translates statement-relative entrypoints for later statements", () => {
    const result = expectReady(
      cteFixture(
        "SELECT 1; WITH local AS (SELECT 1) SELECT * FROM schema.ta|",
      ).result,
    );
    expect(result.prefix).toEqual({ quoted: false, value: "ta" });
    expect(result.typedPathRange).toMatchObject({
      from: 40,
      to: 49,
    });
  });

  it("rejects copied, proxied, raw, cross-source, and cross-dialect evidence", () => {
    const fixture = cteFixture(
      "WITH local AS (SELECT 1) SELECT * FROM |",
    );
    const copied = { ...fixture.layout } as SqlCteLayout;
    expect(
      recognizeSqlRelationQuerySiteWithCteLayout(
        fixture.source,
        fixture.slot,
        fixture.position,
        POSTGRESQL_SQL_RELATION_DIALECT,
        copied,
      ),
    ).toEqual({
      reason: "ambiguous-query-site",
      status: "unavailable",
    });

    let invoked = false;
    const proxied = new Proxy(fixture.layout, {
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
      recognizeSqlRelationQuerySiteWithCteLayout(
        fixture.source,
        fixture.slot,
        fixture.position,
        POSTGRESQL_SQL_RELATION_DIALECT,
        proxied,
      ).status,
    ).toBe("unavailable");
    expect(invoked).toBe(false);

    expect(
      recognizeSqlRelationQuerySiteWithCteLayout(
        fixture.source,
        fixture.slot,
        fixture.position,
        POSTGRESQL_SQL_RELATION_DIALECT,
        fixture.layout.mainQueryEntrypoints as never,
      ).status,
    ).toBe("unavailable");

    const secondSource = createIdentitySqlSource(
      fixture.source.originalText,
    );
    const secondIndex = buildSqlStatementIndex(
      secondSource.analysisText,
      POSTGRESQL_SQL_RELATION_DIALECT.querySite.lexicalProfile,
    );
    const secondSlot = findSqlStatementSlot(
      secondIndex,
      fixture.position,
      "left",
    );
    expect(
      recognizeSqlRelationQuerySiteWithCteLayout(
        secondSource,
        secondSlot,
        fixture.position,
        POSTGRESQL_SQL_RELATION_DIALECT,
        fixture.layout,
      ).status,
    ).toBe("unavailable");

    const mixedRuntime: SqlRelationDialectRuntime = {
      ...POSTGRESQL_SQL_RELATION_DIALECT,
      querySite: DUCKDB_SQL_RELATION_DIALECT.querySite,
    };
    expect(
      recognizeSqlRelationQuerySiteWithCteLayout(
        fixture.source,
        fixture.slot,
        fixture.position,
        mixedRuntime,
        fixture.layout,
      ).status,
    ).toBe("unavailable");

    let runtimeInvoked = false;
    const proxiedRuntime = new Proxy(
      POSTGRESQL_SQL_RELATION_DIALECT,
      {
        get() {
          runtimeInvoked = true;
          throw new Error("hostile");
        },
        getOwnPropertyDescriptor() {
          runtimeInvoked = true;
          throw new Error("hostile");
        },
        ownKeys() {
          runtimeInvoked = true;
          throw new Error("hostile");
        },
      },
    );
    expect(
      recognizeSqlRelationQuerySiteWithCteLayout(
        fixture.source,
        fixture.slot,
        fixture.position,
        proxiedRuntime,
        fixture.layout,
      ).status,
    ).toBe("unavailable");
    expect(runtimeInvoked).toBe(false);

    let slotInvoked = false;
    const proxiedSlot = new Proxy(fixture.slot, {
      get() {
        slotInvoked = true;
        throw new Error("hostile");
      },
      getOwnPropertyDescriptor() {
        slotInvoked = true;
        throw new Error("hostile");
      },
      ownKeys() {
        slotInvoked = true;
        throw new Error("hostile");
      },
    });
    expect(
      recognizeSqlRelationQuerySiteWithCteLayout(
        fixture.source,
        proxiedSlot,
        fixture.position,
        POSTGRESQL_SQL_RELATION_DIALECT,
        fixture.layout,
      ).status,
    ).toBe("unavailable");
    expect(slotInvoked).toBe(false);

    const rebuiltIndex = buildSqlStatementIndex(
      fixture.source.analysisText,
      POSTGRESQL_SQL_RELATION_DIALECT.querySite.lexicalProfile,
    );
    const rebuiltSlot = findSqlStatementSlot(
      rebuiltIndex,
      fixture.position,
      "left",
    );
    expect(
      recognizeSqlRelationQuerySiteWithCteLayout(
        fixture.source,
        rebuiltSlot,
        fixture.position,
        POSTGRESQL_SQL_RELATION_DIALECT,
        fixture.layout,
      ).status,
    ).toBe("unavailable");
    const mismatchedLayout = analyzeSqlCteLayout(
      fixture.source,
      rebuiltIndex,
      fixture.slot,
      POSTGRESQL_SQL_RELATION_DIALECT.cteLayout,
    );
    expect(
      recognizeSqlRelationQuerySiteWithCteLayout(
        fixture.source,
        fixture.slot,
        fixture.position,
        POSTGRESQL_SQL_RELATION_DIALECT,
        mismatchedLayout,
      ).status,
    ).toBe("unavailable");

    expect(
      recognizeSqlRelationQuerySiteWithCteLayout(
        fixture.source,
        fixture.slot,
        fixture.position,
        POSTGRESQL_SQL_RELATION_DIALECT,
        null as never,
      ).status,
    ).toBe("unavailable");

    expect(
      recognizeSqlRelationQuerySiteWithCteLayout(
        fixture.source,
        fixture.slot,
        fixture.position,
        DUCKDB_SQL_RELATION_DIALECT,
        fixture.layout,
      ).status,
    ).toBe("unavailable");
  });

  it("does not authenticate mutable statement slots", () => {
    const first =
      "WITH cte_name AS (SELECT 1) SELECT * FROM target";
    const second =
      "XXXX cte_name AS (SELECT 1) SELECT * FROM target";
    const source = createIdentitySqlSource(`${first};${second}`);
    const index = buildSqlStatementIndex(
      source.analysisText,
      POSTGRESQL_SQL_RELATION_DIALECT.querySite.lexicalProfile,
    );
    const firstSlot = findSqlStatementSlot(index, first.length, "left");
    const secondSlot = findSqlStatementSlot(
      index,
      source.analysisText.length,
      "left",
    );
    if (
      firstSlot.boundaryQuality === "opaque" ||
      secondSlot.boundaryQuality === "opaque"
    ) {
      throw new Error("Mutable slot fixture requires exact statements");
    }
    const mutableSlot: ExactSqlStatementSlot = {
      ...firstSlot,
      extent: { ...firstSlot.extent },
      source: { ...firstSlot.source },
      terminator: firstSlot.terminator
        ? { ...firstSlot.terminator }
        : null,
    };
    const layout = analyzeSqlCteLayout(
      source,
      index,
      mutableSlot,
      POSTGRESQL_SQL_RELATION_DIALECT.cteLayout,
    );
    Object.assign(mutableSlot, {
      endState: secondSlot.endState,
      extent: { ...secondSlot.extent },
      hasCode: secondSlot.hasCode,
      source: { ...secondSlot.source },
      terminator: secondSlot.terminator,
    });
    expect(
      recognizeSqlRelationQuerySiteWithCteLayout(
        source,
        mutableSlot,
        source.analysisText.length,
        POSTGRESQL_SQL_RELATION_DIALECT,
        layout,
      ),
    ).toEqual({
      reason: "ambiguous-query-site",
      status: "unavailable",
    });
  });

  it("binds authentic slots to their analysis text", () => {
    const source = createIdentitySqlSource(
      "DELIMITER $$;SELECT * FROM ",
    );
    const foreignText = "xxxxxxxxxxxx;SELECT * FROM ";
    expect(foreignText.length).toBe(source.analysisText.length);
    const foreignIndex = buildSqlStatementIndex(
      foreignText,
      POSTGRESQL_SQL_RELATION_DIALECT.querySite.lexicalProfile,
    );
    const foreignSlot = findSqlStatementSlot(
      foreignIndex,
      foreignText.length,
      "left",
    );
    if (foreignSlot.boundaryQuality === "opaque") {
      throw new Error("Foreign slot fixture requires an exact statement");
    }
    const layout = analyzeSqlCteLayout(
      source,
      foreignIndex,
      foreignSlot,
      POSTGRESQL_SQL_RELATION_DIALECT.cteLayout,
    );
    expect(
      recognizeSqlRelationQuerySiteWithCteLayout(
        source,
        foreignSlot,
        source.analysisText.length,
        POSTGRESQL_SQL_RELATION_DIALECT,
        layout,
      ),
    ).toEqual({
      reason: "ambiguous-query-site",
      status: "unavailable",
    });
  });

  it("binds authentic slots to their lexical profile", () => {
    const source = createIdentitySqlSource("SELECT * FROM ");
    const index = buildSqlStatementIndex(
      source.analysisText,
      DUCKDB_SQL_RELATION_DIALECT.querySite.lexicalProfile,
    );
    const slot = findSqlStatementSlot(
      index,
      source.analysisText.length,
      "left",
    );
    if (slot.boundaryQuality === "opaque") {
      throw new Error("Wrong-profile fixture requires an exact statement");
    }
    const layout = analyzeSqlCteLayout(
      source,
      index,
      slot,
      POSTGRESQL_SQL_RELATION_DIALECT.cteLayout,
    );
    expect(
      recognizeSqlRelationQuerySiteWithCteLayout(
        source,
        slot,
        source.analysisText.length,
        POSTGRESQL_SQL_RELATION_DIALECT,
        layout,
      ),
    ).toEqual({
      reason: "ambiguous-query-site",
      status: "unavailable",
    });
  });

  it("keeps old and new incremental statement contexts valid", () => {
    const first =
      "WITH cte_name AS (SELECT 1) SELECT * FROM target";
    const oldText = `${first}; SELECT 2; SELECT 3`;
    const oldSource = createIdentitySqlSource(oldText);
    const profile =
      POSTGRESQL_SQL_RELATION_DIALECT.querySite.lexicalProfile;
    const oldIndex = buildSqlStatementIndex(oldText, profile);
    const oldSlot = findSqlStatementSlot(
      oldIndex,
      first.length,
      "left",
    );
    if (oldSlot.boundaryQuality === "opaque") {
      throw new Error("Incremental fixture requires exact statements");
    }
    const oldLayout = analyzeSqlCteLayout(
      oldSource,
      oldIndex,
      oldSlot,
      POSTGRESQL_SQL_RELATION_DIALECT.cteLayout,
    );
    const editFrom = oldText.indexOf("SELECT 2") + "SELECT ".length;
    const newText = `${oldText.slice(0, editFrom)}4${oldText.slice(
      editFrom + 1,
    )}`;
    const newIndex = updateSqlStatementIndex(
      oldIndex,
      newText,
      [{ from: editFrom, insert: "4", to: editFrom + 1 }],
      profile,
    );
    const newSource = createIdentitySqlSource(newText);
    const newSlot = findSqlStatementSlot(
      newIndex,
      first.length,
      "left",
    );
    if (newSlot.boundaryQuality === "opaque") {
      throw new Error("Incremental fixture requires exact statements");
    }
    expect(newSlot).toBe(oldSlot);
    const newLayout = analyzeSqlCteLayout(
      newSource,
      newIndex,
      newSlot,
      POSTGRESQL_SQL_RELATION_DIALECT.cteLayout,
    );
    expect(
      recognizeSqlRelationQuerySiteWithCteLayout(
        oldSource,
        oldSlot,
        first.length,
        POSTGRESQL_SQL_RELATION_DIALECT,
        oldLayout,
      ).status,
    ).toBe("ready");
    expect(
      recognizeSqlRelationQuerySiteWithCteLayout(
        newSource,
        newSlot,
        first.length,
        POSTGRESQL_SQL_RELATION_DIALECT,
        newLayout,
      ).status,
    ).toBe("ready");
  });

  it("preserves opaque statement failures for authentic slots", () => {
    const source = createIdentitySqlSource("DELIMITER $$");
    const index = buildSqlStatementIndex(
      source.analysisText,
      POSTGRESQL_SQL_RELATION_DIALECT.querySite.lexicalProfile,
    );
    const slot = findSqlStatementSlot(
      index,
      source.analysisText.length,
      "left",
    );
    const fixture = cteFixture(
      "WITH local AS (SELECT 1) SELECT * FROM |",
    );
    expect(slot.boundaryQuality).toBe("opaque");
    expect(
      recognizeSqlRelationQuerySiteWithCteLayout(
        source,
        slot,
        source.analysisText.length,
        POSTGRESQL_SQL_RELATION_DIALECT,
        fixture.layout,
      ),
    ).toEqual({
      reason: "opaque-statement",
      status: "unavailable",
    });
  });

  it("preserves authenticated CTE resource failures", () => {
    const source = createIdentitySqlSource(
      `SELECT * FROM ${" ".repeat(65_537)}`,
    );
    const index = buildSqlStatementIndex(
      source.analysisText,
      POSTGRESQL_SQL_RELATION_DIALECT.querySite.lexicalProfile,
    );
    const slot = findSqlStatementSlot(
      index,
      source.analysisText.length,
      "left",
    );
    if (slot.boundaryQuality === "opaque") {
      throw new Error("Resource fixture requires an exact statement");
    }
    const layout = analyzeSqlCteLayout(
      source,
      index,
      slot,
      POSTGRESQL_SQL_RELATION_DIALECT.cteLayout,
    );
    expect(
      recognizeSqlRelationQuerySiteWithCteLayout(
        source,
        slot,
        source.analysisText.length,
        POSTGRESQL_SQL_RELATION_DIALECT,
        layout,
      ),
    ).toEqual({
      reason: "resource-limit",
      resource: "active-statement",
      status: "unavailable",
    });
  });

  it.each([
    ["invalid-header", "header"],
    ["skipped", "skipped"],
    ["wrong-depth", "depth"],
    ["wrong-token", "token"],
  ] as const)(
    "fails closed when authenticated source evidence becomes %s",
    (_, mutation) => {
      const text =
        "WITH cte_name AS (SELECT 1) SELECT * FROM target";
      const mutableSource: SqlSourceSnapshot = {
        ...createIdentitySqlSource(text),
      };
      const position = text.length;
      const index = buildSqlStatementIndex(
        mutableSource.analysisText,
        POSTGRESQL_SQL_RELATION_DIALECT.querySite.lexicalProfile,
      );
      const slot = findSqlStatementSlot(index, position, "left");
      if (slot.boundaryQuality === "opaque") {
        throw new Error("Mutable fixture requires an exact statement");
      }
      const layout = analyzeSqlCteLayout(
        mutableSource,
        index,
        slot,
        POSTGRESQL_SQL_RELATION_DIALECT.cteLayout,
      );
      const mainQueryStart = text.lastIndexOf("SELECT");
      const nextAnalysisText =
        mutation === "header"
          ? `XXXX${text.slice(4)}`
          : mutation === "depth"
          ? `${text.slice(0, mainQueryStart - 2)} ${text.slice(
              mainQueryStart - 1,
            )}`
          : `${text.slice(0, mainQueryStart)}${
              mutation === "skipped" ? "/*x*/ " : "DELETE"
            }${text.slice(mainQueryStart + 6)}`;
      (mutableSource as { analysisText: string }).analysisText =
        nextAnalysisText;
      expect(
        recognizeSqlRelationQuerySiteWithCteLayout(
          mutableSource,
          slot,
          position,
          POSTGRESQL_SQL_RELATION_DIALECT,
          layout,
        ),
      ).toEqual({
        reason: "ambiguous-query-site",
        status: "unavailable",
      });
    },
  );

  it("does not make raw WITH statements query candidates", () => {
    const marked =
      "WITH local AS (SELECT 1) SELECT * FROM |";
    expect(recognize(marked)).toEqual({
      reason: "not-relation-position",
      status: "inactive",
    });
  });

  it("does not invent entrypoints for incomplete CTE headers", () => {
    const fixture = cteFixture(
      "WITH cte_name AS (SELECT 1), SELECT * FROM |",
    );
    expect(fixture.layout.status).toBe("partial");
    expect(fixture.layout.mainQueryEntrypoints).toEqual([]);
    expect(fixture.result.status).not.toBe("ready");
  });
});

describe("fail-closed query-site behavior", () => {
  it.each([
    ["SELECT x IS DISTINCT FROM |", "inactive"],
    ["SELECT substring(x FROM |)", "inactive"],
    ["SELECT extract(YEAR FROM |)", "inactive"],
    ["\"prefix\" SELECT * FROM |", "inactive"],
    [". SELECT * FROM |", "inactive"],
    [", SELECT * FROM |", "inactive"],
    ["(SELECT 1) SELECT * FROM |", "inactive"],
    ["((SELECT 1)) SELECT * FROM |", "inactive"],
    ["COPY x FROM |", "inactive"],
    ["SELECT * FROM users alias |", "inactive"],
    ["SELECT * FROM|", "inactive"],
    ["SELECT * FROM users JOIN|", "inactive"],
    ["SELECT * FROM (|", "unavailable"],
    ["SELECT * FROM fn(|", "unavailable"],
    ["SELECT * FROM fn|()", "unavailable"],
    ["SELECT * FROM fn| ()", "unavailable"],
    ["SELECT * FROM users| (x)", "unavailable"],
    ["SELECT * FROM sch|ema . users", "unavailable"],
    ["SELECT * FROM sch|ema /*c*/ . users", "unavailable"],
    ["SELECT * FROM LATERAL users JOIN |", "unavailable"],
    ["SELECT * FROM users LATERAL JOIN |", "unavailable"],
    ["SELECT * FROM users ON true JOIN |", "unavailable"],
    [
      "SELECT * FROM a JOIN b ON a.id = b.id JOIN |",
      "unavailable",
    ],
    [
      "SELECT * FROM a JOIN b ON (SELECT true) JOIN |",
      "unavailable",
    ],
    [
      "SELECT * FROM a JOIN b ON true WHERE EXISTS (SELECT * FROM |)",
      "unavailable",
    ],
    ["SELECT * FROM a CROSS JOIN b ON true JOIN |", "unavailable"],
    ["SELECT * FROM a NATURAL JOIN b USING(x) JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON x ON y JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b USING(x) USING(y) JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON LEFT JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON () JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON + JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON true + JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON true AND JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON a = JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON (a =) JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON (JOIN) JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON END JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON DISTINCT JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON DEFAULT JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON a IS DISTINCT JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON a NOT DISTINCT JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON a SIMILAR TO JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON a COLLATE JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON a AT JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON a LIKE 'x' ESCAPE JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON COLLATE x JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON DISTINCT x JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON ESCAPE x JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON TO x JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON ZONE x JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON AT x JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON BETWEEN x JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON AND x JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON IS x JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON WHEN x JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON THEN x JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON ELSE x JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON (AND x) JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON = x JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON true LEFT() JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON WHERE JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b USING WHERE JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b USING id JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b USING() JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b USING(id,) JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b USING(, id) JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b USING(id.name) JOIN |", "unavailable"],
    [
      "SELECT * FROM a JOIN b USING((SELECT * FROM |))",
      "unavailable",
    ],
    ["SELECT * FROM a JOIN b USING('id') JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b USING(JOIN) JOIN |", "unavailable"],
    ['SELECT * FROM a JOIN b USING("") JOIN |', "unavailable"],
    ["SELECT * FROM a JOIN b USING(id other) JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b USING(id) other JOIN |", "unavailable"],
    ['SELECT * FROM a JOIN b USING(id) "other" JOIN |', "unavailable"],
    ["SELECT * FROM a JOIN b USING(id) + JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b USING(id) LEFT(1) JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b USING(id) LEFT, |", "unavailable"],
    ["SELECT * FROM a JOIN b USING 'id' JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b USING FETCH JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b USING GROUP JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b USING HAVING JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b USING LIMIT JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b USING OFFSET JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b USING ORDER JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b USING LEFT(id) JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b USING RIGHT(id) JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b USING FULL(id) JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b USING INNER(id) JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b USING CROSS(id) JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b USING NATURAL(id) JOIN |", "unavailable"],
    [
      "SELECT * FROM a JOIN b USING LEFT OUTER(id) JOIN |",
      "unavailable",
    ],
    ["SELECT * FROM a JOIN b LEFT USING(id) JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b RIGHT USING(id) JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b FULL USING(id) JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b INNER USING(id) JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b CROSS USING(id) JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b NATURAL USING(id) JOIN |", "unavailable"],
    [
      "SELECT * FROM a JOIN b LEFT OUTER USING(id) JOIN |",
      "unavailable",
    ],
    [
      "SELECT * FROM a JOIN b ON true CROSS JOIN c ON true JOIN |",
      "unavailable",
    ],
    [
      "SELECT * FROM a JOIN b ON true NATURAL JOIN c USING(x) JOIN |",
      "unavailable",
    ],
    ["SELECT * FROM a JOIN b ON true LEFT, |", "unavailable"],
    ["SELECT * FROM a JOIN b ON true NATURAL, |", "unavailable"],
    ["SELECT * FROM a JOIN b ON true OUTER JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON true LEFT RIGHT JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON true LEFT potato JOIN |", "unavailable"],
    ["SELECT * FROM a LEFT, |", "unavailable"],
    ["SELECT * FROM a NATURAL, |", "unavailable"],
    ["SELECT * FROM a NATURAL CROSS JOIN |", "unavailable"],
    ["SELECT * FROM a LEFT NATURAL JOIN |", "unavailable"],
    ["SELECT * FROM a NATURAL OUTER JOIN |", "unavailable"],
    [
      "SELECT * FROM a NATURAL LEFT JOIN b ON true JOIN |",
      "unavailable",
    ],
    ["SELECT * FROM a LEFT /*x*/, |", "unavailable"],
    [
      "SELECT * FROM a LEFT WHERE EXISTS (SELECT * FROM |)",
      "unavailable",
    ],
    [
      "SELECT * FROM a JOIN b USING(id) LEFT WHERE EXISTS (SELECT * FROM |)",
      "unavailable",
    ],
    [
      "SELECT * FROM a JOIN b USING(id) NATURAL GROUP BY (SELECT * FROM |)",
      "unavailable",
    ],
    ["SELECT * FROM users + JOIN |", "unavailable"],
    ["SELECT * FROM users 'garbage' JOIN |", "unavailable"],
    ["SELECT * FROM users . junk JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON [x, y], |", "unavailable"],
    ["SELECT * FROM users TABLESAMPLE JOIN |", "unavailable"],
    ["SELECT * FROM users AS TABLESAMPLE JOIN |", "unavailable"],
    ["SELECT * FROM users AS LEFT JOIN |", "unavailable"],
    ["SELECT * FROM users AS CROSS JOIN |", "unavailable"],
    ["SELECT * FROM users AS NATURAL JOIN |", "unavailable"],
    ["SELECT * FROM users AS INNER JOIN |", "unavailable"],
    ["SELECT * FROM 'not a relation' JOIN |", "unavailable"],
    ["SELECT * FROM , |", "unavailable"],
    ["SELECT * FROM schema..|", "unavailable"],
    ["SELECT * FROM a QUALIFY x JOIN |", "unavailable"],
  ] as const)("does not invent a site for %s", (marked, status) => {
    expect(recognize(marked).status).toBe(status);
  });

  it("rejects a BigQuery quoted prefix before SELECT", () => {
    expect(
      recognize("`prefix` SELECT * FROM |", {
        dialect: bigQueryDialect,
      }).status,
    ).toBe("inactive");
  });

  it.each([
    "SELECT * FROM users ASSERT_ROWS_MODIFIED JOIN |",
    "SELECT * FROM users AS ASSERT_ROWS_MODIFIED JOIN |",
    "SELECT * FROM users PIVOT JOIN |",
    "SELECT * FROM users UNPIVOT JOIN |",
    "SELECT * FROM users FOR JOIN |",
    "SELECT * FROM users MATCH_RECOGNIZE JOIN |",
  ])("fails closed for a BigQuery relation continuation in %s", (marked) => {
    expect(
      recognize(marked, { dialect: bigQueryDialect }).status,
    ).toBe("unavailable");
  });

  it("fails closed when dialect continuation policy is malformed", () => {
    const throwingDialect: SqlQuerySiteDialect = {
      ...postgresDialect,
      classifyIdentifierToken: () => {
        throw new Error("classification failed");
      },
    };
    expect(
      recognize("SELECT * FROM users alias |", {
        dialect: throwingDialect,
      }).status,
    ).toBe("unavailable");

    const malformedDialect: SqlQuerySiteDialect = {
      ...postgresDialect,
    };
    Object.defineProperty(malformedDialect, "classifyIdentifierToken", {
      value: () => "bogus",
    });
    expect(
      recognize("SELECT * FROM users alias |", {
        dialect: malformedDialect,
      }).status,
    ).toBe("unavailable");

    const inherited = Object.create({
      status: "identifier",
      value: "alias",
    });
    const accessor = Object.create(null);
    Object.defineProperties(accessor, {
      status: { get: () => "identifier" },
      value: { get: () => "alias" },
    });
    const throwingProxy = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error("prototype unavailable");
        },
      },
    );
    for (const result of [inherited, accessor, throwingProxy]) {
      const invalidShapeDialect: SqlQuerySiteDialect = {
        ...postgresDialect,
      };
      Object.defineProperty(
        invalidShapeDialect,
        "classifyIdentifierToken",
        {
          value: () => result,
        },
      );
      expect(
        recognize("SELECT * FROM users alias JOIN |", {
          dialect: invalidShapeDialect,
        }).status,
      ).toBe("unavailable");
    }

    for (const value of [
      "",
      "x".repeat(MAX_QUERY_SITE_IDENTIFIER_LENGTH + 1),
    ]) {
      const invalidDecodedDialect: SqlQuerySiteDialect = {
        ...postgresDialect,
        classifyIdentifierToken: () => ({
          status: "identifier",
          value,
        }),
      };
      expect(
        recognize("SELECT * FROM users alias JOIN |", {
          dialect: invalidDecodedDialect,
        }).status,
      ).toBe("unavailable");
    }
  });

  it("routes quoted aliases through the dialect policy with their role", () => {
    const calls: {
      rawAlias: string;
      quoted: boolean;
      role:
        | "explicit-alias"
        | "implicit-alias"
        | "using-column";
    }[] = [];
    const dialect: SqlQuerySiteDialect = {
      ...postgresDialect,
      classifyIdentifierToken: (rawIdentifier, quoted, role) => {
        calls.push({ quoted, rawAlias: rawIdentifier, role });
        return rawIdentifier === '"blocked"'
          ? { status: "unsupported" }
          : {
              status: "identifier",
              value: rawIdentifier.toLowerCase(),
            };
      },
    };
    expect(
      recognize("SELECT * FROM users CamelAlias JOIN |", {
        dialect,
      }).status,
    ).toBe("ready");
    expect(
      recognize('SELECT * FROM users "blocked" JOIN |', {
        dialect,
      }).status,
    ).toBe("unavailable");
    expect(
      recognize('SELECT * FROM users AS "blocked" JOIN |', {
        dialect,
      }).status,
    ).toBe("unavailable");
    expect(
      recognize("SELECT * FROM users JOIN other USING(CamelColumn) JOIN |", {
        dialect,
      }).status,
    ).toBe("ready");
    expect(calls).toEqual([
      {
        quoted: false,
        rawAlias: "CamelAlias",
        role: "implicit-alias",
      },
      {
        quoted: true,
        rawAlias: '"blocked"',
        role: "implicit-alias",
      },
      {
        quoted: true,
        rawAlias: '"blocked"',
        role: "explicit-alias",
      },
      {
        quoted: false,
        rawAlias: "CamelColumn",
        role: "using-column",
      },
    ]);
  });

  it("never substitutes an empty word for an oversized alias token", () => {
    const alias = "x".repeat(MAX_QUERY_SITE_IDENTIFIER_LENGTH + 1);
    expect(
      recognize(`SELECT * FROM users ${alias} JOIN |`).status,
    ).toBe("unavailable");
    expect(
      recognize(`SELECT * FROM users AS ${alias} JOIN |`).status,
    ).toBe("unavailable");
  });

  it("enforces the bare identifier ceiling before dialect code for every role", () => {
    const maximumIdentifier = "x".repeat(
      MAX_QUERY_SITE_IDENTIFIER_LENGTH,
    );
    const oversizedIdentifier = "x".repeat(
      MAX_QUERY_SITE_IDENTIFIER_LENGTH + 1,
    );
    const roles: (
      | "explicit-alias"
      | "implicit-alias"
      | "using-column"
    )[] = [];
    const dialect: SqlQuerySiteDialect = {
      ...postgresDialect,
      classifyIdentifierToken: (_rawIdentifier, _quoted, role) => {
        roles.push(role);
        return { status: "identifier", value: "decoded" };
      },
    };
    for (const marked of [
      `SELECT * FROM users ${maximumIdentifier} JOIN |`,
      `SELECT * FROM users AS ${maximumIdentifier} JOIN |`,
      `SELECT * FROM a JOIN b USING(${maximumIdentifier}) JOIN |`,
    ]) {
      expect(recognize(marked, { dialect }).status).toBe("ready");
    }
    expect(roles).toEqual([
      "implicit-alias",
      "explicit-alias",
      "using-column",
    ]);
    for (const marked of [
      `SELECT * FROM users ${oversizedIdentifier} JOIN |`,
      `SELECT * FROM users AS ${oversizedIdentifier} JOIN |`,
      `SELECT * FROM a JOIN b USING(${oversizedIdentifier}) JOIN |`,
    ]) {
      expect(recognize(marked, { dialect }).status).toBe("unavailable");
    }
    expect(roles).toHaveLength(3);
  });

  it.each([
    'SELECT * FROM users "" JOIN |',
    'SELECT * FROM users AS "" JOIN |',
  ])("rejects an empty PostgreSQL quoted alias in %s", (marked) => {
    expect(recognize(marked).status).toBe("unavailable");
  });

  it.each([
    "SELECT * FROM users `` JOIN |",
    "SELECT * FROM users AS `` JOIN |",
  ])("rejects an empty BigQuery quoted alias in %s", (marked) => {
    expect(
      recognize(marked, { dialect: bigQueryDialect }).status,
    ).toBe("unavailable");
  });

  it("bounds explicit and implicit quoted aliases", () => {
    const alias = `"${"x".repeat(
      MAX_QUERY_SITE_IDENTIFIER_LENGTH + 1,
    )}"`;
    expect(
      recognize(`SELECT * FROM users ${alias} JOIN |`).status,
    ).toBe("unavailable");
    expect(
      recognize(`SELECT * FROM users AS ${alias} JOIN |`).status,
    ).toBe("unavailable");
  });

  it("bounds the decoded alias instead of its escaped source token", () => {
    const alias = `"${'""'.repeat(
      MAX_QUERY_SITE_IDENTIFIER_LENGTH,
    )}"`;
    expect(alias.length).toBe(
      MAX_QUERY_SITE_IDENTIFIER_LENGTH * 2 + 2,
    );
    expect(
      recognize(`SELECT * FROM users ${alias} JOIN |`).status,
    ).toBe("ready");
    expect(
      recognize(`SELECT * FROM users AS ${alias} JOIN |`).status,
    ).toBe("ready");
  });

  it.each([
    'SELECT * FROM users LEFT "alias" JOIN |',
    'SELECT * FROM users NATURAL "alias" JOIN |',
    'SELECT * FROM a JOIN b ON true LEFT "alias" JOIN |',
    "SELECT * FROM a JOIN b ON true LEFT . JOIN |",
    "SELECT * FROM a JOIN b ON true LEFT 'x' JOIN |",
    "SELECT * FROM a JOIN b ON true NATURAL 'x' JOIN |",
    "SELECT * FROM a JOIN b ON true LEFT + JOIN |",
  ])("does not launder a pending join modifier through %s", (marked) => {
    expect(recognize(marked).status).toBe("unavailable");
  });

  it.each([
    "SELECT * FROM users alias(garbage +) JOIN |",
    "SELECT * FROM users MATCH_RECOGNIZE(garbage) JOIN |",
  ])("does not launder a parenthesized relation suffix in %s", (marked) => {
    expect(recognize(marked).status).toBe("unavailable");
  });

  it.each([
    "SELECT * FROM users AS + alias JOIN |",
    "SELECT * FROM users AS . alias JOIN |",
    "SELECT * FROM users AS , alias JOIN |",
    "SELECT * FROM users AS 'junk' alias JOIN |",
  ])("does not skip invalid explicit-alias grammar in %s", (marked) => {
    expect(recognize(marked).status).toBe("unavailable");
  });

  it.each([
    "SELECT * FROM users AS WHERE JOIN |",
    "SELECT * FROM users AS FROM JOIN |",
    "SELECT * FROM users AS AS JOIN |",
    "SELECT * FROM users AS SELECT JOIN |",
    "SELECT * FROM users AS OFFSET JOIN |",
    "SELECT * FROM users AS UNION JOIN |",
    "SELECT * FROM users AS LATERAL JOIN |",
  ])("classifies a structural word in explicit-alias state for %s", (marked) => {
    expect(recognize(marked).status).toBe("unavailable");
  });

  it("accepts a dialect-unreserved structural word after AS", () => {
    expect(
      recognize("SELECT * FROM users AS QUALIFY JOIN |").status,
    ).toBe("ready");
    expect(
      recognize("SELECT * FROM users PIVOT JOIN |").status,
    ).toBe("ready");
  });

  it.each([
    "SELECT 'on|e''two' FROM users",
    "SELECT 'one''tw|o' FROM users",
  ])("keeps adjacent BigQuery strings opaque at %s", (marked) => {
    expect(recognize(marked, { dialect: bigQueryDialect })).toEqual({
      reason: "cursor-in-string",
      status: "inactive",
    });
  });

  it("fails closed when an embedded region is adjacent to a path", () => {
    const marked = "SELECT * FROM u|s{x}";
    const regionFrom = marked.indexOf("{x}");
    expect(
      recognize(marked, {
        regions: [
          { from: regionFrom - 1, language: "template", to: regionFrom + 2 },
        ],
      }).status,
    ).toBe("unavailable");
  });

  it.each([
    ["SELECT -- {x} FROM |", postgresDialect, "inactive"],
    ["SELECT # {x} FROM |", bigQueryDialect, "inactive"],
    ["SELECT \"ab{x} FROM |", postgresDialect, "unavailable"],
    ["SELECT `ab{x} FROM |", bigQueryDialect, "unavailable"],
  ] as const)(
    "preserves lexical state across a masked region in %s",
    (marked, dialect, status) => {
      const regionFrom = marked.indexOf("{x}");
      expect(
        recognize(marked, {
          dialect,
          regions: [
            { from: regionFrom, language: "template", to: regionFrom + 3 },
          ],
        }).status,
      ).toBe(status);
    },
  );

  it.each([
    "SELECT (SELECT {x}) FROM |",
    "{x} (SELECT * FROM |)",
  ])("retains embedded-region evidence across nested frames in %s", (marked) => {
    const regionFrom = marked.indexOf("{x}");
    const result = expectReady(
      recognize(marked, {
        regions: [
          { from: regionFrom, language: "template", to: regionFrom + 3 },
        ],
      }),
    );
    expect(result.recognition).toEqual({
      issues: ["opaque-template-context"],
      quality: "recovered",
    });
  });

  it("distinguishes cursors inside comments and strings", () => {
    expect(recognize("SELECT * FROM /* he|re */ users")).toEqual({
      reason: "cursor-in-comment",
      status: "inactive",
    });
    expect(recognize("SELECT '|FROM users'")).toEqual({
      reason: "cursor-in-string",
      status: "inactive",
    });
    expect(recognize("SELECT /* unclosed|")).toEqual({
      reason: "ambiguous-query-site",
      status: "unavailable",
    });
    expect(recognize("SELECT 'unclosed|")).toEqual({
      reason: "ambiguous-query-site",
      status: "unavailable",
    });
    expect(recognize("SELECT * FROM -- comment|")).toEqual({
      reason: "cursor-in-comment",
      status: "inactive",
    });
    expect(recognize("SELECT * FROM -- comment|\n")).toEqual({
      reason: "cursor-in-comment",
      status: "inactive",
    });
    expect(recognize("SELECT * FROM -- comment\n|").status).toBe("ready");
    expect(recognize("SELECT * FROM /* comment */|").status).toBe(
      "ready",
    );
    expect(
      recognize("SELECT * FROM # comment|", {
        dialect: bigQueryDialect,
      }),
    ).toEqual({
      reason: "cursor-in-comment",
      status: "inactive",
    });
  });

  it.each([
    "SELECT * FROM users WHERE value JOIN |",
    "SELECT * FROM users GROUP BY value JOIN |",
    "SELECT * FROM users HAVING value JOIN |",
    "SELECT * FROM users ORDER BY value JOIN |",
    "SELECT * FROM users LIMIT value JOIN |",
    "SELECT * FROM users OFFSET value JOIN |",
    "SELECT * FROM users FETCH value JOIN |",
  ])("closes supported relation state after a later clause in %s", (marked) => {
    expect(recognize(marked).status).toBe("inactive");
  });

  it.each([
    "SELECT * FROM users OUTER JOIN |",
    "SELECT * FROM users LEFT RIGHT JOIN |",
    "SELECT * FROM users LEFT potato JOIN |",
    "SELECT * FROM users a b JOIN |",
    "SELECT * FROM users WINDOW value JOIN |",
    "SELECT * FROM users alias . JOIN |",
    "SELECT * FROM users alias + JOIN |",
    "SELECT * FROM users \"one\" \"two\" JOIN |",
  ])("makes ambiguous transitions unavailable in %s", (marked) => {
    expect(recognize(marked).status).toBe("unavailable");
  });

  it.each([
    "SELECT * FROM users UNION SELECT * FROM |",
    "SELECT * FROM users UNION ALL SELECT * FROM |",
    "SELECT * FROM users UNION DISTINCT SELECT * FROM |",
    "SELECT * FROM users INTERSECT SELECT * FROM |",
    "SELECT * FROM users EXCEPT SELECT * FROM |",
  ])("recognizes a relation site in each set-operation arm for %s", (marked) => {
    expect(recognize(marked)).toMatchObject({
      anchor: "from",
      prefix: { quoted: false, value: "" },
      qualifier: [],
      status: "ready",
    });
  });

  it.each([
    ["INSERT INTO |", "from"],
    ["UPDATE app.us| SET name = 'x'", "from"],
    ["DELETE FROM | WHERE true", "from"],
    ["MERGE INTO target USING | ON true", "join"],
    ["/* leading */ UPDATE |", "from"],
  ] as const)("recognizes the DML relation site in %s", (marked, anchor) => {
    expect(recognize(marked)).toMatchObject({
      anchor,
      status: "ready",
    });
  });

  it.each([
    "INSERT target|",
    "MERGE target| USING source ON true",
  ])("recognizes optional BigQuery INTO in %s", (marked) => {
    expect(recognize(marked, {
      dialect: bigQueryDialect,
    })).toMatchObject({
      anchor: "from",
      status: "ready",
    });
  });

  it.each([
    "INSERT INTO target SELECT * FROM |",
    "UPDATE target SET value = (SELECT value FROM |)",
    "DELETE FROM target WHERE EXISTS (SELECT 1 FROM |)",
    "MERGE INTO target USING source ON EXISTS (SELECT 1 FROM |)",
  ])("continues into nested SELECT relation sites for %s", (marked) => {
    expect(recognize(marked).status).toBe("ready");
  });

  it.each([
    "INSERT |",
    "INSERT target |",
    "DELETE |",
    "DELETE target |",
    "MERGE USING |",
    "MERGE target |",
    "UPDATE (SELECT 1) |",
    "UPDATE 'target' |",
  ])("fails malformed DML relation transitions closed in %s", (marked) => {
    expect(recognize(marked).status).not.toBe("ready");
  });

  it("keeps completed DML targets outside relation completion", () => {
    expect(recognize("UPDATE target SET value = 1|")).toEqual({
      reason: "not-select-query",
      status: "inactive",
    });
    expect(recognize("MERGE INTO target USING source ON true|")).toEqual({
      reason: "not-select-query",
      status: "inactive",
    });
  });

  it("classifies DML cursor barriers without inventing targets", () => {
    expect(recognize("UP|DATE users").status).toBe("inactive");
    expect(recognize("UPDATE /* tar|get */").status).toBe("inactive");
    expect(recognize("UPDATE 'tar|get'").status).toBe("inactive");
    const marked = "UPDATE {py|thon}";
    const { position, text } = markedSource(marked);
    const from = text.indexOf("{python}");
    expect(recognize(marked, {
      regions: [{
        from,
        language: "python",
        to: from + "{python}".length,
      }],
    })).toEqual({
      reason: "cursor-in-embedded-region",
      status: "inactive",
    });
    expect(position).toBeGreaterThan(from);
  });

  it("fails closed when an embedded region precedes a DML target", () => {
    const marked = "UPDATE {python} |";
    const { text } = markedSource(marked);
    const from = text.indexOf("{python}");
    expect(recognize(marked, {
      regions: [{
        from,
        language: "python",
        to: from + "{python}".length,
      }],
    })).toEqual({
      reason: "ambiguous-query-site",
      status: "unavailable",
    });
  });

  it("does not interpret non-USING MERGE suffixes as source relations", () => {
    expect(recognize("MERGE INTO target ON |")).toEqual({
      reason: "not-relation-position",
      status: "inactive",
    });
  });

  it("suppresses the three-word IS NOT DISTINCT FROM expression", () => {
    expect(recognize("SELECT x IS NOT DISTINCT FROM |").status).toBe(
      "inactive",
    );
  });

  it("handles cursor and range input boundaries explicitly", () => {
    const source = createIdentitySqlSource("SELECT * FROM ");
    const index = buildSqlStatementIndex(
      source.analysisText,
      postgresDialect.lexicalProfile,
    );
    const slot = index.slots[0]!;
    expect(
      recognizeSqlRelationQuerySite(
        source,
        slot,
        Number.NaN,
        postgresDialect,
      ),
    ).toEqual({
      reason: "not-relation-position",
      status: "inactive",
    });
    expect(
      recognizeSqlRelationQuerySite(source, slot, -1, postgresDialect),
    ).toEqual({
      reason: "not-relation-position",
      status: "inactive",
    });
    expect(recognize("SELECT|")).toEqual({
      reason: "not-relation-position",
      status: "inactive",
    });
    expect(recognize("(|x) SELECT * FROM ")).toEqual({
      reason: "not-select-query",
      status: "inactive",
    });
    expect(recognize("(+ x) |")).toEqual({
      reason: "not-select-query",
      status: "inactive",
    });
    expect(recognize("((SELECT * FROM x)) |")).toEqual({
      reason: "not-relation-position",
      status: "inactive",
    });
    expect(recognize("an_identifier_longer_than_sixteen|")).toEqual({
      reason: "not-select-query",
      status: "inactive",
    });
  });

  it("validates every dialect-decoder result before branding ranges", () => {
    const dialectWith = (
      decodeRelationPath: SqlQuerySiteDialect["decodeRelationPath"],
    ): SqlQuerySiteDialect => ({
      classifyIdentifierToken,
      decodeRelationPath,
      lexicalProfile: POSTGRESQL_SQL_LEXICAL_PROFILE,
      maximumPathDepth: 4,
      supportsNaturalJoin: true,
    });
    expect(
      recognize("SELECT * FROM x|", {
        dialect: dialectWith(() => ({
          reason: "undecodable-identifier",
          status: "unavailable",
        })),
      }),
    ).toEqual({
      reason: "ambiguous-query-site",
      status: "unavailable",
    });
    expect(
      recognize("SELECT * FROM x|", {
        dialect: dialectWith(() => ({
          finalSegment: { from: 0, to: 1 },
          prefix: { quoted: false, value: "x" },
          qualifier: Array.from({ length: 4 }, () => ({
            quoted: false,
            value: "q",
          })),
          quality: "exact",
          status: "decoded",
        })),
      }),
    ).toEqual({
      reason: "resource-limit",
      resource: "identifier-path",
      status: "unavailable",
    });
    expect(
      recognize("SELECT * FROM x|", {
        dialect: dialectWith(() => ({
          finalSegment: { from: -1, to: 1 },
          prefix: { quoted: false, value: "x" },
          qualifier: [],
          quality: "exact",
          status: "decoded",
        })),
      }),
    ).toEqual({
      reason: "ambiguous-query-site",
      status: "unavailable",
    });

    const validDecoded = (): Extract<
      SqlDecodedQueryPath,
      { readonly status: "decoded" }
    > => ({
      finalSegment: { from: 0, to: 1 },
      prefix: { quoted: false, value: "x" },
      qualifier: [],
      quality: "exact",
      status: "decoded",
    });
    const malformedResults: SqlQuerySiteDialect["decodeRelationPath"][] = [
      () => {
        throw new Error("decoder failed");
      },
      () => {
        const decoded = validDecoded();
        Object.setPrototypeOf(decoded, []);
        return decoded;
      },
      () => {
        const decoded = validDecoded();
        Object.defineProperty(decoded, "status", { value: "bogus" });
        return decoded;
      },
      () => {
        const decoded = validDecoded();
        Object.defineProperties(decoded, {
          reason: { value: "bogus" },
          status: { value: "unavailable" },
        });
        return decoded;
      },
      () => {
        const decoded = validDecoded();
        Object.defineProperty(decoded, "quality", { value: "bogus" });
        return decoded;
      },
      () => {
        const decoded = validDecoded();
        Object.defineProperty(decoded, "qualifier", { value: { length: 0 } });
        return decoded;
      },
      () => {
        const decoded = validDecoded();
        const qualifier = [{ quoted: false, value: "schema" }];
        Reflect.deleteProperty(qualifier, "0");
        Object.defineProperty(decoded, "qualifier", { value: qualifier });
        return decoded;
      },
      () => {
        const decoded = validDecoded();
        const component = { quoted: false, value: "schema" };
        Object.defineProperty(component, "quoted", { value: "false" });
        Object.defineProperty(decoded, "qualifier", {
          value: [component],
        });
        return decoded;
      },
      () => {
        const decoded = validDecoded();
        Object.defineProperty(decoded, "prefix", { value: null });
        return decoded;
      },
      () => {
        const decoded = validDecoded();
        Object.setPrototypeOf(decoded.finalSegment, []);
        return decoded;
      },
      () => {
        const decoded = validDecoded();
        Object.defineProperty(decoded.finalSegment, "to", { value: "1" });
        return decoded;
      },
      () => {
        const decoded = validDecoded();
        Object.defineProperty(decoded.finalSegment, "from", {
          get: () => {
            throw new Error("accessed decoder getter");
          },
        });
        return decoded;
      },
    ];
    for (const decodeRelationPath of malformedResults) {
      expect(
        recognize("SELECT * FROM x|", {
          dialect: dialectWith(decodeRelationPath),
        }),
      ).toEqual({
        reason: "ambiguous-query-site",
        status: "unavailable",
      });
    }

    expect(
      recognize("SELECT * FROM x|", {
        dialect: dialectWith(() => ({
          ...validDecoded(),
          qualifier: [
            {
              quoted: false,
              value: "x".repeat(MAX_QUERY_SITE_IDENTIFIER_LENGTH + 1),
            },
          ],
        })),
      }),
    ).toEqual({
      reason: "resource-limit",
      resource: "identifier-segment",
      status: "unavailable",
    });
  });

  it("reports opaque statement boundaries", () => {
    const { position, text } = markedSource("DELIMITER // SELECT * FROM |");
    const source = createIdentitySqlSource(text);
    const index = buildSqlStatementIndex(
      source.analysisText,
      POSTGRESQL_SQL_LEXICAL_PROFILE,
    );
    const result = recognizeSqlRelationQuerySite(
      source,
      findSqlStatementSlot(index, position, "left"),
      position,
      postgresDialect,
    );
    expect(result).toEqual({
      reason: "opaque-statement",
      status: "unavailable",
    });
  });
});

describe("embedded-region barriers", () => {
  it("leaves completion inside a region to the host language", () => {
    expect(
      recognize("SELECT * FROM {d|f}", {
        regions: [{ from: 14, language: "python", to: 18 }],
      }),
    ).toEqual({
      reason: "cursor-in-embedded-region",
      status: "inactive",
    });
  });

  it("recovers only after a visible supported anchor", () => {
    const joined = expectReady(
      recognize("SELECT * FROM {df} JOIN |", {
        regions: [{ from: 14, language: "python", to: 18 }],
      }),
    );
    expect(joined.recognition).toEqual({
      issues: ["opaque-template-context"],
      quality: "recovered",
    });

    const selected = expectReady(
      recognize("SELECT {expr} FROM |", {
        regions: [{ from: 7, language: "python", to: 13 }],
      }),
    );
    expect(selected.recognition.quality).toBe("recovered");

    const prefixed = expectReady(
      recognize("SELECT {expr} FROM us|", {
        regions: [{ from: 7, language: "python", to: 13 }],
      }),
    );
    expect(prefixed.recognition).toEqual({
      issues: ["opaque-template-context"],
      quality: "recovered",
    });
  });

  it("fails closed when a barrier occupies an alias position", () => {
    expect(
      recognize("SELECT * FROM users AS {x} JOIN |", {
        regions: [{ from: 23, language: "python", to: 26 }],
      }).status,
    ).toBe("unavailable");
    expect(
      recognize("{x} SELECT * FROM |", {
        regions: [{ from: 0, language: "python", to: 3 }],
      }).status,
    ).toBe("inactive");
  });

  it("keeps unsupported derived-relation continuations unavailable", () => {
    expect(
      recognize("SELECT * FROM users (x) JOIN |").status,
    ).toBe("unavailable");
  });

  it("never authenticates a path across a barrier", () => {
    expect(
      recognize("SELECT * FROM sch{x}.us|", {
        regions: [{ from: 17, language: "python", to: 20 }],
      }).status,
    ).not.toBe("ready");
  });
});

describe("query-site resource limits", () => {
  it("bounds the active statement", () => {
    const exact = `SELECT * FROM ${" ".repeat(
      MAX_QUERY_SITE_STATEMENT_LENGTH - "SELECT * FROM ".length,
    )}|`;
    expect(recognize(exact).status).toBe("ready");
    const marked = `SELECT * FROM ${"x".repeat(
      MAX_QUERY_SITE_STATEMENT_LENGTH,
    )}|`;
    expect(recognize(marked)).toEqual({
      reason: "resource-limit",
      resource: "active-statement",
      status: "unavailable",
    });
  });

  it("bounds lexical work and parenthesis depth", () => {
    const exactTokens = `SELECT ${"x+".repeat(
      MAX_QUERY_SITE_LEXEMES / 2 - 1,
    )} FROM |`;
    expect(recognize(exactTokens).status).toBe("ready");
    const tokens = `SELECT ${"x+".repeat(MAX_QUERY_SITE_LEXEMES / 2 + 1)} FROM |`;
    expect(recognize(tokens)).toEqual({
      reason: "resource-limit",
      resource: "lexical-token",
      status: "unavailable",
    });
    const nested = `${"(".repeat(MAX_QUERY_SITE_DEPTH + 1)}SELECT * FROM |`;
    expect(recognize(nested)).toEqual({
      reason: "resource-limit",
      resource: "parenthesis-depth",
      status: "unavailable",
    });
    expect(
      recognize(`${"(".repeat(MAX_QUERY_SITE_DEPTH)}SELECT * FROM |`).status,
    ).toBe("ready");
  });

  it("keeps authenticated USING-list work linear and bounded", () => {
    let usingColumnCalls = 0;
    const dialect: SqlQuerySiteDialect = {
      ...postgresDialect,
      classifyIdentifierToken: (rawIdentifier, quoted, role) => {
        if (role === "using-column") {
          usingColumnCalls += 1;
        }
        return classifyIdentifierToken(rawIdentifier, quoted, role);
      },
    };
    const columns = Array.from(
      { length: 1_000 },
      (_, index) => `column_${index}`,
    ).join(", ");
    expect(
      recognize(
        `SELECT * FROM a JOIN b USING(${columns}) JOIN |`,
        { dialect },
      ).status,
    ).toBe("ready");
    expect(usingColumnCalls).toBe(1_000);
  });

  it("bounds path depth and decoded identifier length", () => {
    expect(recognize("SELECT * FROM public.users|").status).toBe(
      "ready",
    );
    expect(recognize("SELECT * FROM a.b.c|")).toEqual({
      reason: "resource-limit",
      resource: "identifier-path",
      status: "unavailable",
    });
    expect(
      recognize(`SELECT * FROM ${"x".repeat(
        MAX_QUERY_SITE_IDENTIFIER_LENGTH,
      )}|`).status,
    ).toBe("ready");
    expect(
      recognize(`SELECT * FROM ${"x".repeat(
        MAX_QUERY_SITE_IDENTIFIER_LENGTH + 1,
      )}|`),
    ).toEqual({
      reason: "ambiguous-query-site",
      status: "unavailable",
    });

    const globalPath = Array.from(
      { length: MAX_QUERY_SITE_PATH_COMPONENTS },
      () => "a",
    ).join(".");
    const globalDialect: SqlQuerySiteDialect = {
      ...postgresDialect,
      decodeRelationPath: (rawPath, cursorOffset) => {
        if (cursorOffset !== rawPath.length) {
          return {
            reason: "invalid-identifier",
            status: "unavailable",
          };
        }
        const parts = rawPath.split(".");
        const prefix = parts.at(-1) ?? "";
        return {
          finalSegment: {
            from: rawPath.length - prefix.length,
            to: rawPath.length,
          },
          prefix: { quoted: false, value: prefix },
          qualifier: parts
            .slice(0, -1)
            .map((value) => ({ quoted: false, value })),
          quality: "exact",
          status: "decoded",
        };
      },
      maximumPathDepth: MAX_QUERY_SITE_PATH_COMPONENTS,
    };
    expect(
      recognize(`SELECT * FROM ${globalPath}|`, {
        dialect: globalDialect,
      }).status,
    ).toBe("ready");
    expect(
      recognize("SELECT * FROM a|", {
        dialect: {
          ...globalDialect,
          maximumPathDepth: MAX_QUERY_SITE_PATH_COMPONENTS + 1,
        },
      }).status,
    ).toBe("unavailable");
  });
});

describe("query-site invariants", () => {
  it("does not split astral or lone-surrogate cursor ranges", () => {
    expect(recognize("SELECT * FROM \ud801|\udc00name").status).toBe(
      "unavailable",
    );
    const astral = expectReady(recognize("SELECT * FROM \ud801\udc00na|me"));
    expect(astral.typedPathRange).toMatchObject({ from: 14, to: 20 });
    expect(recognize("SELECT * FROM \ud801|name").status).toBe(
      "unavailable",
    );
  });

  it("remains bounded with the maximum embedded-region count", () => {
    const body = "x ".repeat(10_000);
    const marked = `SELECT ${body}FROM |`;
    const regions = Array.from({ length: 10_000 }, (_, index) => ({
      from: "SELECT ".length + index * 2,
      language: "template",
      to: "SELECT ".length + index * 2 + 1,
    }));
    const result = expectReady(recognize(marked, { regions }));
    expect(result.recognition).toEqual({
      issues: ["opaque-template-context"],
      quality: "recovered",
    });
  });

  it("keeps every ready range inside its exact statement under fuzzed input", () => {
    let state = 0x5eed1234;
    const random = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    const alphabet = [
      " ",
      "\n",
      "'",
      "\"",
      "$",
      "(",
      ")",
      ",",
      ".",
      "/",
      "-",
      "*",
      "_",
      "a",
      "F",
      "0",
      "😀",
    ];

    for (let fixture = 0; fixture < 200; fixture += 1) {
      let text = "";
      const length = 32 + (random() % 160);
      for (let index = 0; index < length; index += 1) {
        text += alphabet[random() % alphabet.length];
      }
      const source = createIdentitySqlSource(text);
      const index = buildSqlStatementIndex(
        source.analysisText,
        postgresDialect.lexicalProfile,
      );
      for (let sample = 0; sample < 3; sample += 1) {
        const position = random() % (text.length + 1);
        const slot = findSqlStatementSlot(
          index,
          position,
          position === 0 ? "right" : "left",
        );
        const result = recognizeSqlRelationQuerySite(
          source,
          slot,
          position,
          postgresDialect,
        );
        if (result.status !== "ready" || slot.boundaryQuality !== "exact") {
          continue;
        }
        const statementLength = slot.source.to - slot.source.from;
        expect(result.typedPathRange.from).toBeGreaterThanOrEqual(0);
        expect(result.typedPathRange.to).toBeLessThanOrEqual(statementLength);
        expect(result.finalSegmentRange.from).toBeGreaterThanOrEqual(
          result.typedPathRange.from,
        );
        expect(result.finalSegmentRange.to).toBeLessThanOrEqual(
          result.typedPathRange.to,
        );
        expect(Object.isFrozen(result.recognition.issues)).toBe(true);
      }
    }
  });

  it("is invariant to supported keyword casing and closed leading trivia", () => {
    const variants = [
      "SELECT * FROM schema.us|",
      "select * from schema.us|",
      "SeLeCt * FrOm schema.us|",
      "-- lead\nSELECT /* select */ * FROM schema.us|",
    ];
    const results = variants.map((variant) => expectReady(recognize(variant)));
    for (const result of results) {
      expect(result.qualifier).toEqual([{ quoted: false, value: "schema" }]);
      expect(result.prefix).toEqual({ quoted: false, value: "us" });
      expect(result.recognition.quality).toBe("exact");
    }
  });
});
