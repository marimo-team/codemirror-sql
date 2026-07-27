import { describe, expect, it } from "vitest";
import {
  analyzeSqlCteLayout,
  MAX_CTE_DECLARATIONS,
  MAX_CTE_DEPTH,
  MAX_CTE_FRAMES,
  MAX_CTE_IDENTIFIER_LENGTH,
  MAX_CTE_QUOTED_IDENTIFIER_LENGTH,
  MAX_CTE_STATEMENT_LENGTH,
  resolveAuthenticatedSqlCteEntrypoints,
  type SqlCteLayout,
  type SqlCteLayoutDialect,
  type SqlCteLayoutIssue,
  type SqlCteIdentifierResult,
  visibleSqlCtesAt,
} from "../cte-layout.js";
import {
  BIGQUERY_SQL_RELATION_DIALECT,
  DREMIO_SQL_RELATION_DIALECT,
  DUCKDB_SQL_RELATION_DIALECT,
  POSTGRESQL_SQL_RELATION_DIALECT,
} from "../relation-dialect.js";
import {
  createIdentitySqlSource,
  createMaskedSqlSource,
} from "../source.js";
import {
  buildSqlStatementIndex,
  findSqlStatementSlot,
  type ExactSqlStatementSlot,
} from "../statement-index.js";
import { MAX_QUERY_OUTPUT_COLUMNS } from "../query-output.js";

const postgres = POSTGRESQL_SQL_RELATION_DIALECT.cteLayout;
const duckdb = DUCKDB_SQL_RELATION_DIALECT.cteLayout;
const bigquery = BIGQUERY_SQL_RELATION_DIALECT.cteLayout;
const dremio = DREMIO_SQL_RELATION_DIALECT.cteLayout;

function analyze(
  text: string,
  dialect: SqlCteLayoutDialect = postgres,
  regions: readonly {
    readonly from: number;
    readonly language: string;
    readonly to: number;
  }[] = [],
): Exclude<SqlCteLayout, { status: "unavailable" }> {
  const source =
    regions.length === 0
      ? createIdentitySqlSource(text)
      : createMaskedSqlSource(text, regions);
  const index = buildSqlStatementIndex(
    source.analysisText,
    dialect.lexicalProfile,
  );
  const slot = index.slots[0];
  expect(slot?.boundaryQuality).toBe("exact");
  const result = analyzeSqlCteLayout(
    source,
    index,
    slot as ExactSqlStatementSlot,
    dialect,
  );
  expect(result.status).not.toBe("unavailable");
  return result as Exclude<
    SqlCteLayout,
    { status: "unavailable" }
  >;
}

function analyzeRaw(
  text: string,
  dialect: SqlCteLayoutDialect = postgres,
  indexDialect: SqlCteLayoutDialect = dialect,
): SqlCteLayout {
  const source = createIdentitySqlSource(text);
  const index = buildSqlStatementIndex(
    source.analysisText,
    indexDialect.lexicalProfile,
  );
  const slot = index.slots[0];
  expect(slot?.boundaryQuality).toBe("exact");
  return analyzeSqlCteLayout(
    source,
    index,
    slot as ExactSqlStatementSlot,
    dialect,
  );
}

function expectPartial(
  text: string,
  issue: SqlCteLayoutIssue,
  dialect: SqlCteLayoutDialect = postgres,
): void {
  const layout = analyze(text, dialect);
  expect(layout.status).toBe("partial");
  expect(layout.issues).toContain(issue);
}

function names(
  layout: Exclude<SqlCteLayout, { status: "unavailable" }>,
  position: number,
): readonly string[] {
  return visibleSqlCtesAt(layout, position).ctes.map(
    (cte) => cte.name.value,
  );
}

describe("bounded CTE layout", () => {
  it("proves nonrecursive declaration order and main visibility", () => {
    const text =
      "WITH a AS (SELECT * FROM base), " +
      "b AS (SELECT * FROM a) SELECT * FROM b";
    const layout = analyze(text);
    expect(layout.status).toBe("ready");
    expect(layout.mainQueryEntrypoints).toEqual([
      {
        depth: 0,
        frameIndex: 0,
        from: text.lastIndexOf("SELECT"),
      },
    ]);
    expect(names(layout, text.indexOf("base"))).toEqual([]);
    expect(
      names(layout, text.indexOf("FROM a") + "FROM ".length),
    ).toEqual(["a"]);
    expect(
      names(layout, text.lastIndexOf("FROM b") + "FROM ".length),
    ).toEqual(["a", "b"]);
  });

  it("keeps nested shadowing inside the nested query block", () => {
    const text =
      "WITH x AS (SELECT * FROM base) SELECT * FROM (" +
      "WITH x AS (SELECT * FROM x) SELECT * FROM x) q, x";
    const layout = analyze(text);
    const innerBody = text.indexOf("FROM x");
    const innerMain = text.indexOf("FROM x", innerBody + 1);
    expect(names(layout, innerBody + 5)).toEqual(["x"]);
    expect(names(layout, innerMain + 5)).toEqual(["x"]);
    expect(
      visibleSqlCtesAt(layout, innerBody + 5).ctes[0]
        ?.declarationPosition,
    ).toBe(text.indexOf("x"));
    expect(
      visibleSqlCtesAt(layout, innerMain + 5).ctes[0]
        ?.declarationPosition,
    ).toBe(text.indexOf("x", text.indexOf("(WITH") + 1));
    expect(names(layout, text.lastIndexOf(", x") + 2)).toEqual([
      "x",
    ]);
  });

  it("treats cursor positions at closing delimiters as inside", () => {
    const text =
      "WITH x AS (SELECT 1) SELECT * FROM (" +
      "WITH y AS (SELECT 2) SELECT * FROM y) q";
    const layout = analyze(text);
    const close = text.lastIndexOf(")");
    expect(names(layout, close)).toEqual(["x", "y"]);
    expect(names(layout, close + 1)).toEqual(["x"]);
  });

  it("keeps nested frame issues local to their proven scope", () => {
    const text =
      "WITH outer_cte AS (SELECT 1) SELECT * FROM (" +
      "WITH x AS (SELECT 1), X AS (SELECT 2) SELECT * FROM x" +
      ") q, outer_cte";
    const layout = analyze(text);
    const nested = visibleSqlCtesAt(
      layout,
      text.indexOf("FROM x") + 5,
    );
    expect(nested.quality).toBe("recovered");
    expect(nested.issues).toContain("duplicate-cte-name");

    const outer = visibleSqlCtesAt(
      layout,
      text.lastIndexOf("outer_cte"),
    );
    expect(outer).toMatchObject({
      issues: [],
      quality: "exact",
    });
    expect(outer.ctes.map((cte) => cte.name.value)).toEqual([
      "outer_cte",
    ]);

    const trailingText =
      "WITH outer_cte AS (SELECT 1) SELECT * FROM (" +
      "WITH x AS (SELECT 1), X AS (SELECT 2) SELECT * FROM x" +
      ") q,";
    expect(
      visibleSqlCtesAt(analyze(trailingText), trailingText.length),
    ).toMatchObject({
      ctes: [
        {
          name: { quoted: false, value: "outer_cte" },
        },
      ],
      issues: [],
      quality: "exact",
      shadowing: {
        coverage: "complete",
        names: [{ quoted: false, value: "outer_cte" }],
      },
    });
  });

  it("withholds recursive self and forward candidates but shadows them", () => {
    const text =
      "WITH RECURSIVE r AS (SELECT * FROM r), " +
      "s AS (SELECT * FROM r) SELECT * FROM s";
    const layout = analyze(text);
    const firstBody = visibleSqlCtesAt(
      layout,
      text.indexOf("FROM r") + 5,
    );
    expect(firstBody.ctes).toEqual([]);
    expect(firstBody.issues).toContain("recursive-cte-position");
    expect(firstBody.shadowing).toEqual({
      coverage: "complete",
      names: [
        { quoted: false, value: "r" },
        { quoted: false, value: "s" },
      ],
    });
    const secondBody = visibleSqlCtesAt(
      layout,
      text.lastIndexOf("FROM r") + 5,
    );
    expect(secondBody.ctes.map((cte) => cte.name.value)).toEqual([
      "r",
    ]);
    expect(names(layout, text.lastIndexOf("FROM s") + 5)).toEqual([
      "r",
      "s",
    ]);

    const unfinishedText =
      "WITH RECURSIVE a AS (SELECT * FROM target), ";
    expect(
      visibleSqlCtesAt(
        analyze(unfinishedText),
        unfinishedText.indexOf("target"),
      ),
    ).toMatchObject({
      ctes: [],
      quality: "recovered",
      shadowing: { coverage: "unknown" },
    });
  });

  it("retains fail-closed visibility evidence for unfinished bodies", () => {
    const text =
      "WITH a AS (SELECT 1), b AS (SELECT * FROM target";
    const layout = analyze(text);
    const visibility = visibleSqlCtesAt(
      layout,
      text.indexOf("target"),
    );
    expect(layout.status).toBe("partial");
    expect(visibility).toMatchObject({
      issues: ["ambiguous-cte-header"],
      quality: "recovered",
      shadowing: {
        coverage: "complete",
        names: [{ quoted: false, value: "a" }],
      },
    });
    expect(visibility.ctes.map((cte) => cte.name.value)).toEqual([
      "a",
    ]);
    expect(
      visibleSqlCtesAt(layout, text.length).ctes.map(
        (cte) => cte.name.value,
      ),
    ).toEqual(["a"]);

    const recursiveText =
      "WITH x AS (SELECT 1) SELECT * FROM (" +
      "WITH RECURSIVE x AS (SELECT * FROM target";
    const recursiveLayout = analyze(recursiveText);
    const recursiveVisibility = visibleSqlCtesAt(
      recursiveLayout,
      recursiveText.indexOf("target"),
    );
    expect(recursiveVisibility.ctes).toEqual([]);
    expect(recursiveVisibility.issues).toEqual([
      "ambiguous-cte-header",
      "recursive-cte-position",
    ]);
    expect(recursiveVisibility.shadowing).toEqual({
      coverage: "unknown",
    });

    const nonrecursiveText =
      "WITH x AS (SELECT 1) SELECT * FROM (" +
      "WITH x AS (SELECT * FROM target";
    const nonrecursiveLayout = analyze(nonrecursiveText);
    const fallback = visibleSqlCtesAt(
      nonrecursiveLayout,
      nonrecursiveText.indexOf("target"),
    );
    expect(fallback.ctes.map((cte) => cte.declarationPosition)).toEqual([
      nonrecursiveText.indexOf("x"),
    ]);
    expect(fallback.quality).toBe("recovered");
  });

  it("blocks duplicate equivalence classes instead of choosing a winner", () => {
    const text =
      "WITH a AS (SELECT 1), A AS (SELECT 2) SELECT * FROM a";
    const layout = analyze(text);
    expect(layout.status).toBe("partial");
    const visibility = visibleSqlCtesAt(
      layout,
      text.lastIndexOf("FROM a") + 5,
    );
    expect(visibility.ctes).toEqual([]);
    expect(visibility.issues).toContain("duplicate-cte-name");
    expect(visibility.shadowing).toEqual({
      coverage: "complete",
      names: [{ quoted: false, value: "A" }],
    });
    expect(visibleSqlCtesAt(layout, text.length)).toMatchObject({
      ctes: [],
      issues: ["duplicate-cte-name"],
      quality: "recovered",
      shadowing: {
        coverage: "complete",
        names: [{ quoted: false, value: "A" }],
      },
    });
  });

  it("preserves decoded labels and exact quoted insertion spelling", () => {
    const text =
      'WITH "a""b" AS MATERIALIZED (SELECT 1) ' +
      'SELECT * FROM "a""b"';
    const layout = analyze(text);
    const cte = visibleSqlCtesAt(
      layout,
      text.lastIndexOf("FROM") + 5,
    ).ctes[0];
    expect(cte).toEqual({
      declarationPosition: text.indexOf('"a""b"'),
      name: { quoted: true, value: 'a"b' },
      sourceSpelling: '"a""b"',
    });
  });

  it("uses dialect-owned quoted equality without generic folding", () => {
    const duplicateCases = [
      {
        dialect: postgres,
        text:
          'WITH foo AS (SELECT 1), "foo" AS (SELECT 2) ' +
          "SELECT 1",
      },
      {
        dialect: duckdb,
        text:
          'WITH foo AS (SELECT 1), "FOO" AS (SELECT 2) ' +
          "SELECT 1",
      },
      {
        dialect: bigquery,
        text:
          "WITH foo AS (SELECT 1), `FOO` AS (SELECT 2) " +
          "SELECT 1",
      },
    ];
    for (const duplicate of duplicateCases) {
      expect(analyze(duplicate.text, duplicate.dialect).issues).toContain(
        "duplicate-cte-name",
      );
    }

    const distinctText =
      'WITH foo AS (SELECT 1), "Foo" AS (SELECT 2) ' +
      "SELECT * FROM foo";
    expect(
      names(analyze(distinctText), distinctText.lastIndexOf("foo")),
    ).toEqual(["foo", "Foo"]);
  });

  it("keeps every stored range statement-relative", () => {
    const text =
      "SELECT 0;\n  WITH a AS (SELECT 1) SELECT * FROM a";
    const source = createIdentitySqlSource(text);
    const index = buildSqlStatementIndex(
      source.analysisText,
      postgres.lexicalProfile,
    );
    const absolutePosition = text.lastIndexOf("FROM a") + 5;
    const slot = findSqlStatementSlot(
      index,
      absolutePosition,
      "left",
    );
    expect(slot.boundaryQuality).toBe("exact");
    if (slot.boundaryQuality !== "exact") {
      throw new Error("Expected an exact second statement");
    }
    const layout = analyzeSqlCteLayout(
      source,
      index,
      slot,
      postgres,
    );
    expect(layout.status).toBe("ready");
    if (layout.status !== "ready") {
      throw new Error("Expected an exact second-statement layout");
    }
    expect(layout.frames[0]?.withStart).toBe(
      text.indexOf("WITH") - slot.source.from,
    );
    expect(layout.declarations[0]?.nameRange).toMatchObject({
      from: text.indexOf("a AS") - slot.source.from,
      to: text.indexOf("a AS") - slot.source.from + 1,
    });
    expect(
      names(layout, absolutePosition - slot.source.from),
    ).toEqual(["a"]);
  });

  it("uses the closed dialect grammar matrix", () => {
    expect(
      analyze(
        "WITH a(x) AS NOT MATERIALIZED (SELECT 1) SELECT * FROM a",
        duckdb,
      ).status,
    ).toBe("ready");
    expect(
      analyze(
        "WITH a(x) AS (SELECT 1) SELECT * FROM a",
        bigquery,
      ).issues,
    ).toContain("unsupported-cte-extension");
    expect(
      analyze(
        "WITH a(x) AS (SELECT 1) SELECT * FROM a",
        dremio,
      ).status,
    ).toBe("ready");
    expect(
      analyze(
        "WITH a AS (SELECT 1), b AS (SELECT 2) SELECT 1",
        dremio,
      ).issues,
    ).toContain("unsupported-cte-extension");
  });

  it("balances bodies through dialect strings and comments", () => {
    const text =
      "WITH /* lead */ a /* name */ (x) AS NOT /* hint */ " +
      "MATERIALIZED (SELECT '(' AS x /* ) , WITH */), " +
      "b AS (SELECT ')' AS y -- )\n) SELECT * FROM b";
    const layout = analyze(text);
    expect(layout.status).toBe("ready");
    expect(
      names(layout, text.lastIndexOf("FROM b") + 5),
    ).toEqual(["a", "b"]);
  });

  it.each([
    ["WITH", "ambiguous-cte-header"],
    ["WITH RECURSIVE", "ambiguous-cte-header"],
    ["WITH SELECT", "ambiguous-cte-header"],
    ["WITH a", "ambiguous-cte-header"],
    ["WITH a nope", "ambiguous-cte-header"],
    ["WITH a() AS (SELECT 1) SELECT 1", "ambiguous-cte-header"],
    [
      "WITH a(x,) AS (SELECT 1) SELECT 1",
      "ambiguous-cte-header",
    ],
    [
      "WITH a(x y) AS (SELECT 1) SELECT 1",
      "ambiguous-cte-header",
    ],
    ["WITH a(x) nope (SELECT 1)", "ambiguous-cte-header"],
    ["WITH a AS nope", "ambiguous-cte-header"],
    ["WITH a AS () SELECT 1", "ambiguous-cte-header"],
    ["WITH a AS NOT nope", "ambiguous-cte-header"],
    [
      "WITH a AS MATERIALIZED nope",
      "ambiguous-cte-header",
    ],
    ["WITH a AS (VALUES (1)) SELECT 1", "unsupported-cte-extension"],
    ["WITH a AS ('SELECT 1') SELECT 1", "unsupported-cte-extension"],
    [
      "WITH a AS (WITH b AS (SELECT 1)) SELECT 1",
      "ambiguous-cte-header",
    ],
    ["WITH a AS (WITH) SELECT 1", "ambiguous-cte-header"],
    ["WITH a AS (SELECT 1),", "ambiguous-cte-header"],
    ["WITH a AS (SELECT 1) + SELECT 1", "unsupported-cte-extension"],
    [
      "WITH a AS (SELECT 1), SELECT",
      "ambiguous-cte-header",
    ],
    [
      "WITH a(SELECT) AS (SELECT 1) SELECT 1",
      "ambiguous-cte-header",
    ],
  ] as const)(
    "fails closed for malformed or unsupported CTE syntax %#",
    (text, issue) => {
      expectPartial(text, issue);
    },
  );

  it("rejects unsupported recursive and materialization modifiers", () => {
    expectPartial(
      "WITH RECURSIVE a AS (SELECT 1) SELECT 1",
      "unsupported-cte-extension",
      dremio,
    );
    expectPartial(
      "WITH a AS NOT MATERIALIZED (SELECT 1) SELECT 1",
      "unsupported-cte-extension",
      bigquery,
    );
    expectPartial(
      "WITH a AS MATERIALIZED (SELECT 1) SELECT 1",
      "unsupported-cte-extension",
      bigquery,
    );
  });

  it("keeps structural coverage around an embedded query expression", () => {
    const text =
      "WITH a AS (SELECT {value}), b AS (SELECT 2) " +
      "SELECT * FROM b";
    const from = text.indexOf("{value}");
    const layout = analyze(text, postgres, [
      { from, language: "python", to: from + "{value}".length },
    ]);
    expect(layout.status).toBe("partial");
    expect(layout.exactThrough).toBe(from);
    expect(layout.declarations.map((item) => item.name.value)).toEqual([
      "a",
      "b",
    ]);
    expect(layout.draftDeclarations).toEqual([]);
    expect(layout.issues).toContain("opaque-template-context");
    expect(
      visibleSqlCtesAt(layout, text.lastIndexOf("FROM b") + 5),
    ).toMatchObject({
      ctes: [
        { name: { value: "a" } },
        { name: { value: "b" } },
      ],
      quality: "recovered",
      shadowing: { coverage: "unknown" },
    });
    expect(visibleSqlCtesAt(layout, from)).toMatchObject({
      ctes: [],
      quality: "recovered",
      shadowing: { coverage: "unknown" },
    });

    const repeatedBarrierText =
      "WITH a AS (SELECT {first} AS x, {second} AS y) SELECT 1";
    const firstBarrier = repeatedBarrierText.indexOf("{first}");
    const secondBarrier = repeatedBarrierText.indexOf("{second}");
    expect(
      analyze(repeatedBarrierText, postgres, [
        {
          from: firstBarrier,
          language: "python",
          to: firstBarrier + "{first}".length,
        },
        {
          from: secondBarrier,
          language: "python",
          to: secondBarrier + "{second}".length,
        },
      ]),
    ).toMatchObject({
      exactThrough: firstBarrier,
      status: "partial",
    });

    const laterBarrierText =
      "WITH a AS (SELECT 1), b AS (SELECT * FROM target {value}) " +
      "SELECT * FROM b";
    const laterFrom = laterBarrierText.indexOf("{value}");
    const laterLayout = analyze(laterBarrierText, postgres, [
      {
        from: laterFrom,
        language: "python",
        to: laterFrom + "{value}".length,
      },
    ]);
    const beforeBarrier = visibleSqlCtesAt(
      laterLayout,
      laterBarrierText.indexOf("target"),
    );
    expect(beforeBarrier.ctes.map((cte) => cte.name.value)).toEqual([
      "a",
    ]);
    expect(beforeBarrier.quality).toBe("recovered");
  });

  it("ignores deceptive WITH text in comments and strings", () => {
    const layout = analyze(
      "SELECT 'WITH a AS (SELECT 1)' /* WITH b */ FROM t",
    );
    expect(layout).toMatchObject({
      declarations: [],
      frames: [],
      mainQueryEntrypoints: [],
      status: "ready",
    });
  });

  it("validates classifier results without invoking accessors", () => {
    let accessorInvoked = false;
    const accessorDialect: SqlCteLayoutDialect = {
      ...postgres,
      classifyIdentifierToken: () => ({
        get status(): "identifier" {
          accessorInvoked = true;
          return "identifier";
        },
        value: {
          component: { quoted: false, value: "a" },
        },
      }),
    };
    expectPartial(
      "WITH a AS (SELECT 1) SELECT 1",
      "ambiguous-cte-header",
      accessorDialect,
    );
    expect(accessorInvoked).toBe(false);

    const malformedResults: readonly SqlCteIdentifierResult[] = [
      { status: "unsupported" },
      {
        status: "identifier",
        value: {
          component: { quoted: true, value: "a" },
        },
      },
      {
        status: "identifier",
        value: new Proxy(
          {
            component: { quoted: false, value: "a" },
          },
          {
            getOwnPropertyDescriptor() {
              return undefined;
            },
          },
        ),
      },
      {
        status: "identifier",
        value: {
          component: { quoted: false, value: "" },
        },
      },
      {
        status: "identifier",
        value: {
          component: {
            quoted: false,
            value: "a".repeat(MAX_CTE_IDENTIFIER_LENGTH + 1),
          },
        },
      },
    ];
    for (const result of malformedResults) {
      expectPartial(
        "WITH a AS (SELECT 1) SELECT 1",
        "ambiguous-cte-header",
        { ...postgres, classifyIdentifierToken: () => result },
      );
    }
    expectPartial(
      'WITH "a" AS (SELECT 1) SELECT 1',
      "ambiguous-cte-header",
      {
        ...postgres,
        classifyIdentifierToken: () => ({
          status: "identifier",
          value: {
            component: { quoted: false, value: "a" },
          },
        }),
      },
    );
    expectPartial(
      "WITH a AS (SELECT 1) SELECT 1",
      "ambiguous-cte-header",
      {
        ...postgres,
        classifyIdentifierToken: () => {
          throw new Error("hostile");
        },
      },
    );
  });

  it("bounds raw and decoded identifier work before retention", () => {
    let calls = 0;
    const countingDialect: SqlCteLayoutDialect = {
      ...postgres,
      classifyIdentifierToken: (...arguments_) => {
        calls += 1;
        return postgres.classifyIdentifierToken(...arguments_);
      },
    };
    const accepted = "a".repeat(MAX_CTE_IDENTIFIER_LENGTH);
    expect(
      analyze(
        `WITH ${accepted} AS (SELECT 1) SELECT 1`,
        countingDialect,
      ).status,
    ).toBe("ready");
    expect(calls).toBe(1);
    calls = 0;

    const oversized = "a".repeat(MAX_CTE_IDENTIFIER_LENGTH + 1);
    expectPartial(
      `WITH ${oversized} AS (SELECT 1) SELECT 1`,
      "ambiguous-cte-header",
      countingDialect,
    );
    expect(calls).toBe(0);

    const oversizedQuoted = `"${"a".repeat(
      MAX_CTE_QUOTED_IDENTIFIER_LENGTH,
    )}"`;
    expectPartial(
      `WITH ${oversizedQuoted} AS (SELECT 1) SELECT 1`,
      "ambiguous-cte-header",
      countingDialect,
    );
    expect(calls).toBe(0);
  });

  it("fails closed on hostile identifier comparators", () => {
    const text =
      "WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a";
    const hostileComparators = [
      () => {
        throw new Error("hostile");
      },
      () => "invalid",
      (left: { value: string }, right: { value: string }) =>
        left.value <= right.value ? "equal" : "distinct",
      (left: { value: string }, right: { value: string }) =>
        left.value === right.value ||
        (left.value === "a" && right.value === "b") ||
        (left.value === "b" && right.value === "a") ||
        (left.value === "b" && right.value === "c") ||
        (left.value === "c" && right.value === "b")
          ? "equal"
          : "distinct",
    ] as const;
    for (const compareCteIdentifiers of hostileComparators) {
      const candidateText =
        compareCteIdentifiers === hostileComparators.at(-1)
          ? "WITH a AS (SELECT 1), b AS (SELECT 2), " +
            "c AS (SELECT 3) SELECT * FROM c"
          : text;
      const layout = analyze(candidateText, {
        ...postgres,
        compareCteIdentifiers:
          compareCteIdentifiers as SqlCteLayoutDialect["compareCteIdentifiers"],
      });
      expect(layout.issues).toContain(
        "unknown-cte-identifier-equivalence",
      );
      expect(
        visibleSqlCtesAt(
          layout,
          candidateText.lastIndexOf("FROM") + 5,
        ),
      ).toMatchObject({
        quality: "recovered",
        shadowing: { coverage: "unknown" },
      });
    }
  });

  it("keeps exact non-ASCII identity but fails closed on unknown pairs", () => {
    const text = "WITH café AS (SELECT 1) SELECT * FROM café";
    const layout = analyze(text);
    const visibility = visibleSqlCtesAt(
      layout,
      text.lastIndexOf("café"),
    );
    expect(visibility).toMatchObject({
      quality: "exact",
      shadowing: { coverage: "complete" },
    });
    expect(visibility.ctes.map((cte) => cte.name.value)).toEqual([
      "café",
    ]);

    const uncertainText =
      "WITH café AS (SELECT 1), CAFÉ AS (SELECT 2) " +
      "SELECT * FROM café";
    const uncertainLayout = analyze(uncertainText);
    const uncertainVisibility = visibleSqlCtesAt(
      uncertainLayout,
      uncertainText.lastIndexOf("café"),
    );
    expect(uncertainVisibility).toMatchObject({
      ctes: [],
      quality: "recovered",
      shadowing: { coverage: "unknown" },
    });
    expect(uncertainVisibility.issues).toContain(
      "unknown-cte-identifier-equivalence",
    );

    const recursiveText =
      "WITH RECURSIVE café AS (SELECT * FROM café) " +
      "SELECT * FROM café";
    const recursiveLayout = analyze(recursiveText);
    expect(
      visibleSqlCtesAt(
        recursiveLayout,
        recursiveText.indexOf("FROM café") + 5,
      ),
    ).toMatchObject({
      ctes: [],
      quality: "recovered",
      shadowing: { coverage: "complete" },
    });

    const recursiveShadowCases = [
      "WITH café AS (SELECT 1) SELECT * FROM (" +
        "WITH RECURSIVE CAFÉ AS (SELECT * FROM target) " +
        "SELECT * FROM CAFÉ) q",
      "WITH café AS (SELECT 1) SELECT * FROM (" +
        "WITH RECURSIVE b AS (SELECT * FROM target), " +
        "CAFÉ AS (SELECT 2) SELECT * FROM b) q",
    ];
    for (const recursiveShadowText of recursiveShadowCases) {
      expect(
        visibleSqlCtesAt(
          analyze(recursiveShadowText),
          recursiveShadowText.indexOf("target"),
        ),
      ).toMatchObject({
        ctes: [],
        quality: "recovered",
        shadowing: { coverage: "unknown" },
      });
    }
  });

  it("fails partial at exact resource boundaries plus one", () => {
    const nested =
      "(".repeat(MAX_CTE_DEPTH + 1) +
      "SELECT 1" +
      ")".repeat(MAX_CTE_DEPTH + 1);
    const depthLayout = analyze(nested);
    expect(depthLayout.status).toBe("partial");
    expect(depthLayout).toMatchObject({
      resource: "parenthesis-depth",
    });

    const declarations = Array.from(
      { length: MAX_CTE_DECLARATIONS + 1 },
      (_, index) => `c${index} AS (SELECT ${index})`,
    ).join(", ");
    const declarationLayout = analyze(
      `WITH ${declarations} SELECT 1`,
    );
    expect(declarationLayout.status).toBe("partial");
    expect(declarationLayout).toMatchObject({
      resource: "cte-declaration",
    });

    const columns = Array.from(
      { length: MAX_QUERY_OUTPUT_COLUMNS + 1 },
      (_, index) => `column_${index}`,
    ).join(", ");
    const columnLayout = analyze(
      `WITH c(${columns}) AS (SELECT 1) SELECT 1`,
    );
    expect(columnLayout).toMatchObject({
      declarations: [{
        declaredColumns: { length: MAX_QUERY_OUTPUT_COLUMNS },
      }],
      resource: "cte-column",
      status: "partial",
    });

    const acceptedDeclarations = Array.from(
      { length: MAX_CTE_DECLARATIONS },
      (_, index) => `c${index} AS (SELECT ${index})`,
    ).join(", ");
    expect(
      analyze(`WITH ${acceptedDeclarations} SELECT 1`).status,
    ).toBe("ready");

    const acceptedDepth =
      "(".repeat(MAX_CTE_DEPTH) +
      "SELECT 1" +
      ")".repeat(MAX_CTE_DEPTH);
    expect(analyzeRaw(acceptedDepth).status).toBe("ready");

    expect(
      analyzeRaw(" ".repeat(MAX_CTE_STATEMENT_LENGTH)).status,
    ).toBe("ready");

    expect(
      analyzeRaw("x".repeat(MAX_CTE_STATEMENT_LENGTH + 1)),
    ).toEqual({
      reason: "resource-limit",
      resource: "active-statement",
      status: "unavailable",
    });

    const manyTokens = Array.from(
      { length: 8_193 },
      () => "x",
    ).join(" ");
    expect(analyzeRaw(`SELECT ${manyTokens.replaceAll(" ", ",")}`)).toMatchObject({
      resource: "lexical-token",
      status: "partial",
    });

    const provenPrefix =
      "WITH a AS (SELECT 1) SELECT * FROM a ";
    const exhaustedSuffix = Array.from(
      { length: 8_193 },
      () => "x",
    ).join(",");
    const prefixLayout = analyzeRaw(
      `${provenPrefix}${exhaustedSuffix}`,
    );
    expect(prefixLayout).toMatchObject({
      resource: "lexical-token",
      status: "partial",
    });
    if (prefixLayout.status === "unavailable") {
      throw new Error("Expected a partial prefix layout");
    }
    const prefixVisibility = visibleSqlCtesAt(
      prefixLayout,
      provenPrefix.indexOf("FROM a") + 5,
    );
    expect(prefixVisibility).toMatchObject({
      issues: [],
      quality: "exact",
    });
    expect(
      prefixVisibility.ctes.map((cte) => cte.name.value),
    ).toEqual(["a"]);

    const nestedPrefix = `SELECT ${"(".repeat(MAX_CTE_DEPTH)}`;
    expect(
      analyzeRaw(
        `${nestedPrefix}WITH a(x) AS (SELECT 1) SELECT 1`,
      ),
    ).toMatchObject({
      resource: "parenthesis-depth",
      status: "partial",
    });
    expect(
      analyzeRaw(`${nestedPrefix}WITH a AS (SELECT 1) SELECT 1`),
    ).toMatchObject({
      resource: "parenthesis-depth",
      status: "partial",
    });
    expect(
      analyzeRaw(
        `${nestedPrefix}WITH a AS MATERIALIZED (SELECT 1) SELECT 1`,
      ),
    ).toMatchObject({
      resource: "parenthesis-depth",
      status: "partial",
    });

    const manyFrames = Array.from(
      { length: MAX_CTE_DECLARATIONS + 1 },
      (_, index) =>
        `(WITH f${index} AS (SELECT 1) SELECT 1)`,
    ).join(",");
    expect(analyzeRaw(`SELECT ${manyFrames}`)).toMatchObject({
      resource: "cte-frame",
      status: "partial",
    });

    const acceptedBareFrames = Array.from(
      { length: MAX_CTE_FRAMES },
      () => "(WITH)",
    ).join(",");
    const acceptedFrameLayout = analyzeRaw(
      `SELECT ${acceptedBareFrames}`,
    );
    expect(acceptedFrameLayout).toMatchObject({
      status: "partial",
    });
    expect(acceptedFrameLayout).not.toHaveProperty("resource");
    if (acceptedFrameLayout.status === "unavailable") {
      throw new Error("Expected a bounded partial frame layout");
    }
    expect(acceptedFrameLayout.frames).toHaveLength(MAX_CTE_FRAMES);

    const rejectedBareFrames = `${acceptedBareFrames},(WITH)`;
    expect(analyzeRaw(`SELECT ${rejectedBareFrames}`)).toMatchObject({
      resource: "cte-frame",
      status: "partial",
    });
  });

  it("rejects malformed dialect grammar without scanning", () => {
    const result = analyzeRaw("SELECT 1", {
      ...postgres,
      grammar: {
        ...postgres.grammar,
        maximumDeclarationsPerFrame: 0,
      },
    });
    expect(result).toEqual({
      reason: "resource-limit",
      status: "unavailable",
    });

    const throwingDialect: SqlCteLayoutDialect = {
      ...postgres,
      get grammar(): SqlCteLayoutDialect["grammar"] {
        throw new Error("hostile");
      },
    };
    expect(analyzeRaw("SELECT 1", throwingDialect)).toEqual({
      reason: "resource-limit",
      status: "unavailable",
    });

    let getterInvoked = false;
    const getterGrammar = {
      ...postgres,
      grammar: {
        ...postgres.grammar,
        get recursive(): boolean {
          getterInvoked = true;
          return true;
        },
      },
    };
    expect(analyzeRaw("SELECT 1", getterGrammar)).toEqual({
      reason: "resource-limit",
      status: "unavailable",
    });
    expect(getterInvoked).toBe(false);

    const getterLexicalProfile = {
      ...postgres,
      lexicalProfile: {
        ...postgres.lexicalProfile,
        get nestedBlockComments(): boolean {
          getterInvoked = true;
          return true;
        },
      },
    };
    expect(
      analyzeRaw("SELECT 1", getterLexicalProfile, postgres),
    ).toEqual({
      reason: "resource-limit",
      status: "unavailable",
    });
    expect(getterInvoked).toBe(false);
  });

  it("never reads a raw dialect after validating its data descriptors", () => {
    const text = "WITH local AS (SELECT 1) SELECT * FROM local";
    const source = createIdentitySqlSource(text);
    const index = buildSqlStatementIndex(
      source.analysisText,
      postgres.lexicalProfile,
    );
    const slot = index.slots[0];
    expect(slot?.boundaryQuality).toBe("exact");
    if (!slot || slot.boundaryQuality !== "exact") {
      throw new Error("Expected one exact statement slot");
    }

    let rawRead = false;
    const descriptorOnlyDialect = new Proxy(postgres, {
      get(target, property, receiver) {
        if (property === "lexicalProfile") {
          rawRead = true;
          throw new Error("hostile");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const layout = analyzeSqlCteLayout(
      source,
      index,
      slot,
      descriptorOnlyDialect,
    );

    expect(layout.status).toBe("ready");
    if (layout.status === "unavailable") {
      throw new Error("Expected an authenticated CTE layout");
    }
    expect(
      resolveAuthenticatedSqlCteEntrypoints(
        layout,
        source,
        slot,
        descriptorOnlyDialect,
      ),
    ).toEqual(layout.mainQueryEntrypoints);
    expect(rawRead).toBe(false);
  });

  it("projects only proven frame phases and validates positions", () => {
    const text =
      "WITH a AS (SELECT 1) SELECT * FROM a";
    const layout = analyze(text);
    expect(visibleSqlCtesAt(layout, 1)).toMatchObject({
      ctes: [],
      issues: [],
      quality: "exact",
    });
    expect(names(layout, text.length)).toEqual(["a"]);

    const partial = analyze("WITH a AS (");
    expect(visibleSqlCtesAt(partial, partial.exactThrough)).toMatchObject({
      ctes: [],
      issues: ["ambiguous-cte-header"],
      quality: "recovered",
      shadowing: { coverage: "complete", names: [] },
    });
    for (const incompleteHeader of [
      "WITH",
      "WITH /* trailing comment */",
      "WITH a",
      "WITH a AS",
      "WITH a(x)",
      "WITH a AS NOT",
    ]) {
      expect(
        visibleSqlCtesAt(
          analyze(incompleteHeader),
          incompleteHeader.length,
        ),
      ).toMatchObject({
        ctes: [],
        issues: ["ambiguous-cte-header"],
        quality: "recovered",
        shadowing: { coverage: "unknown" },
      });
    }

    const nestedBareWith =
      "WITH outer_cte AS (SELECT 1) SELECT * FROM (WITH) q,";
    const nestedLayout = analyze(nestedBareWith);
    const nestedClose = nestedBareWith.lastIndexOf(")");
    expect(visibleSqlCtesAt(nestedLayout, nestedClose)).toMatchObject({
      ctes: [
        {
          name: { quoted: false, value: "outer_cte" },
        },
      ],
      issues: ["ambiguous-cte-header"],
      quality: "recovered",
      shadowing: { coverage: "unknown" },
    });
    expect(
      visibleSqlCtesAt(nestedLayout, nestedBareWith.length),
    ).toMatchObject({
      ctes: [
        {
          name: { quoted: false, value: "outer_cte" },
        },
      ],
      issues: [],
      quality: "exact",
      shadowing: {
        coverage: "complete",
        names: [{ quoted: false, value: "outer_cte" }],
      },
    });
    for (const position of [
      -1,
      0.5,
      text.length - 0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      text.length + 1,
    ]) {
      expect(visibleSqlCtesAt(layout, position)).toMatchObject({
        ctes: [],
        issues: [],
        quality: "recovered",
        shadowing: { coverage: "unknown" },
      });
    }
  });
});
