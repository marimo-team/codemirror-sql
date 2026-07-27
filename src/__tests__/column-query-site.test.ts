import { describe, expect, it } from "vitest";
import { MAX_BOUNDED_SQL_LEXEMES } from "../bounded-sql-lexer.js";
import {
  MAX_COLUMN_QUERY_RELATIONS,
  recognizeSqlColumnQuerySite,
  type SqlColumnQuerySiteResult,
} from "../column-query-site.js";
import {
  BIGQUERY_SQL_RELATION_DIALECT,
  DUCKDB_SQL_RELATION_DIALECT,
  POSTGRESQL_SQL_RELATION_DIALECT,
  type SqlRelationDialectRuntime,
} from "../relation-dialect.js";
import {
  createIdentitySqlSource,
  createMaskedSqlSource,
} from "../source.js";
import {
  buildSqlStatementIndex,
  findSqlStatementSlot,
} from "../statement-index.js";

function analyze(
  marked: string,
  options: {
    readonly dialect?: SqlRelationDialectRuntime;
    readonly regions?: readonly {
      readonly from: number;
      readonly language: string;
      readonly to: number;
    }[];
  } = {},
): SqlColumnQuerySiteResult {
  const position = marked.indexOf("|");
  if (position < 0 || marked.indexOf("|", position + 1) >= 0) {
    throw new Error("Fixture requires exactly one cursor marker");
  }
  const text = marked.slice(0, position) + marked.slice(position + 1);
  const dialect = options.dialect ?? POSTGRESQL_SQL_RELATION_DIALECT;
  const source = options.regions
    ? createMaskedSqlSource(text, options.regions)
    : createIdentitySqlSource(text);
  const index = buildSqlStatementIndex(
    source.analysisText,
    dialect.querySite.lexicalProfile,
  );
  const slot = findSqlStatementSlot(index, position, "left");
  return recognizeSqlColumnQuerySite(
    source,
    slot,
    position,
    dialect,
  );
}

function ready(
  result: SqlColumnQuerySiteResult,
): Extract<SqlColumnQuerySiteResult, { status: "ready" }> {
  if (result.status !== "ready") {
    throw new Error(`Expected ready, received ${JSON.stringify(result)}`);
  }
  expect(result.status).toBe("ready");
  return result;
}

describe("recognizeSqlColumnQuerySite", () => {
  it("finds a qualified SELECT-list site and its aliased relation", () => {
    const result = ready(
      analyze("SELECT u.na| FROM app.users AS u"),
    );

    expect(result).toMatchObject({
      coverage: "complete",
      prefix: { quoted: false, value: "na" },
      qualifier: [{ quoted: false, value: "u" }],
      replacementRange: { from: 9, to: 11 },
    });
    expect(result.relations).toEqual([{
      alias: { quoted: false, value: "u" },
      path: [
        { quoted: false, value: "app" },
        { quoted: false, value: "users" },
      ],
      range: { from: 17, to: 26 },
    }]);
  });

  it("collects comma and join relations for expression clauses", () => {
    const result = ready(
      analyze(
        "SELECT * FROM users u, ignored i JOIN orders AS o ON o.id = u.id WHERE cr|",
      ),
    );

    expect(result.prefix.value).toBe("cr");
    expect(result.qualifier).toEqual([]);
    expect(result.relations.map((relation) => relation.alias?.value))
      .toEqual(["u", "i", "o"]);
  });

  it("includes correlated outer-query relations", () => {
    const result = ready(
      analyze(
        "SELECT * FROM outer_table o WHERE EXISTS (SELECT i.na| FROM inner_table i)",
      ),
    );

    expect(result.qualifier[0]?.value).toBe("i");
    expect(result.coverage).toBe("partial");
    expect(result.relations.map((relation) =>
      relation.path.at(-1)?.value
    )).toEqual(["inner_table", "outer_table"]);
  });

  it("does not correlate an ordinary derived table", () => {
    const result = ready(
      analyze(
        "SELECT * FROM (SELECT i.na| FROM inner_table i) d JOIN outer_table o ON true",
      ),
    );

    expect(result.relations.map((relation) =>
      relation.path.at(-1)?.value
    )).toEqual(["inner_table"]);
  });

  it("correlates LATERAL tables only to preceding relations", () => {
    for (
      const dialect of [
        POSTGRESQL_SQL_RELATION_DIALECT,
        DUCKDB_SQL_RELATION_DIALECT,
      ]
    ) {
      for (const expression of ["u.na|", "na|"]) {
        const result = ready(
          analyze(
            `SELECT * FROM users u, LATERAL (SELECT ${expression} FROM orders o) x, secrets s`,
            { dialect },
          ),
        );

        expect(result.relations.map((relation) =>
          relation.alias?.value
        )).toEqual(["o", "u"]);
      }
    }
  });

  it("limits correlation in a JOIN condition to prior relations", () => {
    const result = ready(
      analyze(
        "SELECT * FROM users u JOIN orders o ON EXISTS (SELECT u.|) JOIN secrets s ON true",
      ),
    );

    expect(result.relations.map((relation) =>
      relation.alias?.value
    )).toEqual(["u", "o"]);
  });

  it("walks nested correlation without adopting a closed sibling", () => {
    const nested = ready(
      analyze(
        "SELECT * FROM root_table r WHERE EXISTS (SELECT * FROM mid_table m WHERE EXISTS (SELECT r.|))",
      ),
    );
    expect(nested.relations.map((relation) =>
      relation.alias?.value
    )).toEqual(["m", "r"]);

    const sibling = ready(
      analyze(
        "SELECT * FROM root_table r WHERE EXISTS (SELECT 1) AND EXISTS (SELECT r.|)",
      ),
    );
    expect(sibling.relations.map((relation) =>
      relation.alias?.value
    )).toEqual(["r"]);
  });

  it("allows a parenthesized top-level query without an outer scope", () => {
    const result = ready(analyze("(SELECT | FROM inner_table)"));
    expect(result.relations.map((relation) =>
      relation.path.at(-1)?.value
    )).toEqual(["inner_table"]);
  });

  it("keeps set-operation arms and JOIN visibility isolated", () => {
    const firstArm = ready(
      analyze("SELECT | FROM users UNION SELECT x FROM secrets"),
    );
    expect(firstArm.relations.map((relation) =>
      relation.path.at(-1)?.value
    )).toEqual(["users"]);

    const secondArm = ready(
      analyze("SELECT x FROM users UNION SELECT | FROM secrets"),
    );
    expect(secondArm.relations.map((relation) =>
      relation.path.at(-1)?.value
    )).toEqual(["secrets"]);

    const joinCondition = ready(
      analyze(
        "SELECT * FROM users u JOIN orders o ON o.user_id = u.| JOIN payments p ON true",
      ),
    );
    expect(joinCondition.relations.map((relation) =>
      relation.alias?.value
    )).toEqual(["u", "o"]);
  });

  it("supports BigQuery quoted multipart bindings", () => {
    const result = ready(
      analyze("SELECT t.| FROM `project.dataset.table` AS t", {
        dialect: BIGQUERY_SQL_RELATION_DIALECT,
      }),
    );

    expect(result.relations[0]).toMatchObject({
      alias: { quoted: false, value: "t" },
      path: [
        { quoted: true, value: "project" },
        { quoted: true, value: "dataset" },
        { quoted: true, value: "table" },
      ],
    });
  });

  it.each([
    ["SELECT * FROM us|", "not-column-position"],
    ["INSERT INTO users VALUES (|)", "not-select-query"],
    ["SELECT 'abc|' FROM users", "cursor-in-string"],
    ["SELECT /* abc| */ 1 FROM users", "cursor-in-comment"],
  ] as const)("fails closed for %s", (marked, reason) => {
    expect(analyze(marked)).toMatchObject({ reason, status: "inactive" });
  });

  it("fails closed inside an embedded region", () => {
    const marked = "SELECT {value|} FROM users";
    const position = marked.indexOf("|");
    expect(
      analyze(marked, {
        regions: [{
          from: marked.indexOf("{"),
          language: "python",
          to: marked.indexOf("}") + 1,
        }],
      }),
    ).toMatchObject({
      reason: "cursor-in-embedded-region",
      status: "inactive",
    });
    expect(position).toBeGreaterThan(0);
  });

  it("represents derived relations and marks table functions partial", () => {
    expect(
      ready(
        analyze(
          "SELECT x.| FROM (SELECT 1) x JOIN UNNEST(items) AS item ON true",
        ),
      ),
    ).toMatchObject({
      coverage: "partial",
      issues: ["table-function"],
    });
  });

  it("keeps a bounded derived query source and its explicit alias", () => {
    const result = ready(
      analyze(
        "SELECT d.i| FROM (SELECT id FROM users) AS d",
      ),
    );
    expect(result.relations).toMatchObject([{
      alias: { value: "d" },
      local: {
        kind: "derived",
        queryRange: {
          from: "SELECT d.i FROM (".length,
          to: "SELECT d.i FROM (SELECT id FROM users".length,
        },
      },
      path: [],
    }]);
  });

  it("preserves authoritative relation-alias column lists", () => {
    const result = ready(
      analyze(
        'SELECT d.| FROM (SELECT original, other) AS d("Renamed", second)',
      ),
    );
    expect(result.relations).toMatchObject([{
      alias: { value: "d" },
      columnAliases: {
        columns: [
          {
            identifier: { quoted: true, value: "Renamed" },
            insertText: '"Renamed"',
          },
          {
            identifier: { quoted: false, value: "second" },
            insertText: "second",
          },
        ],
        coverage: "complete",
      },
      local: { kind: "derived" },
    }]);
  });

  it.each([
    "SELECT d.| FROM (SELECT original) d()",
    "SELECT d.| FROM (SELECT original) d(schema.name)",
    "SELECT d.| FROM (SELECT original) d((nested))",
    "SELECT d.| FROM (SELECT original) d(name,)",
    "SELECT d.| FROM (SELECT original) d(/*comment*/ name",
  ])("marks malformed relation-alias column lists partial in %s", (marked) => {
    expect(analyze(marked)).toMatchObject({
      coverage: "partial",
      issues: ["local-output-partial"],
      status: "ready",
    });
  });

  it("bounds relation-alias column lists", () => {
    const columns = Array.from(
      { length: 257 },
      (_, index) => `column_${index}`,
    ).join(", ");
    const result = ready(
      analyze(`SELECT d.| FROM (SELECT original) d(${columns})`),
    );
    expect(result).toMatchObject({
      coverage: "partial",
      issues: ["local-output-partial"],
      relations: [{
        columnAliases: {
          columns: { length: 256 },
          coverage: "partial",
        },
      }],
    });
  });

  it.each([
    "SELECT i| FROM (SELECT id FROM users)",
    "SELECT i| FROM (VALUES (1)) v",
    "SELECT i| FROM (SELECT id FROM users AS",
  ])("marks an unprovable derived source partial in %s", (marked) => {
    const result = analyze(marked);
    expect(result).toMatchObject({
      coverage: "partial",
      status: "ready",
    });
    if (result.status === "ready") {
      expect(result.issues).toContain("derived-relation");
    }
  });

  it.each([
    "SELECT * FROM users WHERE na|",
    "SELECT * FROM users GROUP BY na|",
    "SELECT * FROM users HAVING na|",
    "SELECT * FROM users QUALIFY na|",
    "SELECT * FROM users ORDER BY na|",
    "SELECT * FROM users u JOIN orders o ON o.id = u.|",
    "SELECT * FROM users u JOIN orders o USING (i|)",
  ])("recognizes expression clause sites in %s", (marked) => {
    expect(ready(analyze(marked)).relations.length).toBeGreaterThan(0);
  });

  it.each([
    "SELECT * FROM users LIMIT |",
    "SELECT * FROM users FETCH |",
    "SELECT * FROM users OFFSET |",
  ])("rejects row-limit clause sites in %s", (marked) => {
    expect(analyze(marked)).toMatchObject({
      reason: "not-column-position",
      status: "inactive",
    });
  });

  it("supports implicit quoted aliases and incomplete relations", () => {
    expect(
      ready(analyze('SELECT "u".| FROM app.users "u"')).relations[0],
    ).toMatchObject({
      alias: { quoted: true, value: "u" },
    });
    expect(ready(analyze("SELECT | FROM"))).toMatchObject({
      coverage: "partial",
      issues: ["incomplete-relation"],
      relations: [],
    });
    expect(ready(analyze('SELECT | FROM ""'))).toMatchObject({
      coverage: "partial",
      issues: ["incomplete-relation"],
      relations: [],
    });
    expect(ready(analyze("SELECT | FROM users AS"))).toMatchObject({
      coverage: "partial",
      issues: ["incomplete-relation"],
      relations: [{
        alias: null,
        path: [{ value: "users" }],
      }],
    });
    expect(ready(analyze("SELECT | FROM users AS WHERE true")))
      .toMatchObject({
        coverage: "partial",
        issues: ["incomplete-relation"],
      });
    expect(ready(analyze('SELECT | FROM users AS "u"')).relations[0])
      .toMatchObject({
        alias: { quoted: true, value: "u" },
      });
  });

  it("fails closed for malformed typed paths and line comments", () => {
    expect(analyze("SELECT u..| FROM users u")).toMatchObject({
      reason: "not-column-position",
      status: "inactive",
    });
    expect(analyze("SELECT 1 -- co|mment\nFROM users")).toMatchObject({
      reason: "cursor-in-comment",
      status: "inactive",
    });
    expect(analyze("SELECT 1 -- comment|")).toMatchObject({
      reason: "cursor-in-comment",
      status: "inactive",
    });
    expect(analyze("SELECT 1 -- comment|\nFROM users")).toMatchObject({
      reason: "cursor-in-comment",
      status: "inactive",
    });
    expect(
      analyze("SELECT 1 # comment|", {
        dialect: BIGQUERY_SQL_RELATION_DIALECT,
      }),
    ).toMatchObject({
      reason: "cursor-in-comment",
      status: "inactive",
    });
  });

  it("bounds lexical work before relation analysis", () => {
    const expression = Array.from(
      { length: MAX_BOUNDED_SQL_LEXEMES + 1 },
      () => "x",
    ).join("+");
    expect(analyze(`SELECT ${expression}| FROM users`)).toMatchObject({
      reason: "resource-limit",
      status: "unavailable",
    });
  });

  it("bounds relation materialization", () => {
    const joins = Array.from(
      { length: MAX_COLUMN_QUERY_RELATIONS + 1 },
      (_, index) => ` JOIN table_${index} t_${index} ON true`,
    ).join("");
    expect(analyze(`SELECT | FROM base b${joins}`)).toMatchObject({
      reason: "resource-limit",
      status: "unavailable",
    });
    expect(analyze(`SELECT (SELECT |) FROM base b${joins}`))
      .toMatchObject({
        reason: "resource-limit",
        status: "unavailable",
      });
  });

  it("rejects foreign contract values without inspecting them", () => {
    let inspected = false;
    const hostile = new Proxy({}, {
      get() {
        inspected = true;
        throw new Error("hostile");
      },
    });
    expect(
      Reflect.apply(recognizeSqlColumnQuerySite, undefined, [
        hostile,
        hostile,
        0,
        hostile,
      ]),
    ).toMatchObject({
      reason: "ambiguous-query-site",
      status: "unavailable",
    });
    expect(inspected).toBe(false);
  });

  it("rejects each unauthenticated argument and invalid position", () => {
    const source = createIdentitySqlSource("SELECT |");
    const position = source.analysisText.indexOf("|");
    const index = buildSqlStatementIndex(
      source.analysisText,
      POSTGRESQL_SQL_RELATION_DIALECT.querySite.lexicalProfile,
    );
    const slot = findSqlStatementSlot(index, position, "left");
    for (const input of [
      [{}, slot, position, POSTGRESQL_SQL_RELATION_DIALECT],
      [source, {}, position, POSTGRESQL_SQL_RELATION_DIALECT],
      [source, slot, position, {}],
      [source, slot, Number.NaN, POSTGRESQL_SQL_RELATION_DIALECT],
      [source, slot, -1, POSTGRESQL_SQL_RELATION_DIALECT],
      [
        source,
        slot,
        source.analysisText.length + 1,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ],
    ]) {
      expect(
        Reflect.apply(recognizeSqlColumnQuerySite, undefined, input),
      ).toMatchObject({
        reason: "ambiguous-query-site",
        status: "unavailable",
      });
    }
  });

  it("rejects a cursor outside its authenticated exact slot", () => {
    const text =
      "SELECT x FROM first_table WHERE ; SELECT y FROM second_table";
    const source = createIdentitySqlSource(text);
    const index = buildSqlStatementIndex(
      text,
      POSTGRESQL_SQL_RELATION_DIALECT.querySite.lexicalProfile,
    );
    const first = findSqlStatementSlot(index, 0, "right");
    const secondPosition = text.indexOf("y FROM");

    expect(
      recognizeSqlColumnQuerySite(
        source,
        first,
        secondPosition,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    ).toEqual({
      reason: "not-column-position",
      status: "inactive",
    });
  });

  it("preserves opaque statement failures", () => {
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
    expect(slot.boundaryQuality).toBe("opaque");
    expect(
      recognizeSqlColumnQuerySite(
        source,
        slot,
        source.analysisText.length,
        POSTGRESQL_SQL_RELATION_DIALECT,
      ),
    ).toMatchObject({
      reason: "opaque-statement",
      status: "unavailable",
    });
  });
});
