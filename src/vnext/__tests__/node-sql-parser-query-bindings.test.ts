// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  normalizeNodeSqlParserQueryBindings,
  type NodeSqlParserQueryBindingOptions,
} from "../node-sql-parser-query-bindings.js";
import {
  resolveSqlRelationQualifier,
  visibleSqlRelationBindingsAt,
} from "../query-binding-model.js";
import {
  decodeNodeSqlParserWireMessage,
  encodeNodeSqlParserWireBackendOutcome,
} from "../node-sql-parser-wire.js";
import type { SqlIdentifierComponent } from "../types.js";

const PG: NodeSqlParserQueryBindingOptions = {
  compatibility: false,
  grammar: "postgresql",
};
const BQ: NodeSqlParserQueryBindingOptions = {
  compatibility: false,
  grammar: "bigquery",
};

function normalize(
  root: unknown,
  text: string,
  options: NodeSqlParserQueryBindingOptions = PG,
) {
  return normalizeNodeSqlParserQueryBindings(root, text, {}, options);
}

function relation(table: string, alias: string | null = null) {
  return { as: alias, db: null, table };
}

function equals(
  left: SqlIdentifierComponent,
  right: SqlIdentifierComponent,
): boolean {
  return left.quoted === right.quoted &&
    (left.quoted
      ? left.value === right.value
      : left.value.toLowerCase() === right.value.toLowerCase());
}

describe("node-sql-parser query binding normalization", () => {
  it("normalizes named relations, aliases, scopes, and clause visibility", () => {
    const text =
      "SELECT u.id FROM users AS u JOIN teams t ON u.team_id=t.id " +
      "WHERE u.active GROUP BY u.id HAVING count(*)>1 " +
      "ORDER BY u.id LIMIT 5";
    const result = normalize(
      {
        from: [
          relation("users", "u"),
          { ...relation("teams", "t"), join: "JOIN", on: {} },
        ],
        type: "select",
        where: {},
      },
      text,
    );

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      return;
    }
    expect(result.model.coverage).toEqual({
      queryBlocks: "complete",
      relationBindings: "complete",
      visibility: "complete",
    });
    expect(result.model.bindings).toMatchObject([
      {
        alias: { explicit: true, name: { value: "u" } },
        source: { kind: "named", path: [{ value: "users" }] },
      },
      {
        alias: { explicit: false, name: { value: "t" } },
        source: { kind: "named", path: [{ value: "teams" }] },
      },
    ]);
    expect(result.model.regions.map((region) => region.kind)).toEqual(
      expect.arrayContaining([
        "select-list",
        "from-source",
        "join-condition",
        "where",
        "group-by",
        "having",
        "order-by",
        "limit",
      ]),
    );
    const selected = visibleSqlRelationBindingsAt(
      result.model,
      text.indexOf("u.id"),
    );
    expect(selected.status === "ready" && selected.bindings).toHaveLength(2);
    expect(
      resolveSqlRelationQualifier(
        result.model,
        text.indexOf("u.id"),
        { quoted: false, value: "U" },
        equals,
      ).status,
    ).toBe("resolved");
  });

  it("normalizes derived query blocks without leaking sibling scope", () => {
    const text =
      "SELECT d.id FROM (SELECT id FROM teams) AS d " +
      "JOIN users u ON d.id=u.id";
    const derived = {
      from: [relation("teams")],
      type: "select",
    };
    const result = normalize(
      {
        from: [
          {
            as: "d",
            expr: { ast: derived, parentheses: true },
          },
          { ...relation("users", "u"), join: "JOIN", on: {} },
        ],
        type: "select",
      },
      text,
    );

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      return;
    }
    expect(result.model.blocks).toHaveLength(2);
    expect(result.model.blocks[1]?.parentBlock).toBe(0);
    expect(result.model.bindings).toMatchObject([
      { alias: { name: { value: "d" } }, source: { block: 1, kind: "derived" } },
      { alias: { name: { value: "u" } }, source: { kind: "named" } },
      { owner: 1, source: { kind: "named", path: [{ value: "teams" }] } },
    ]);
    expect(result.model.blocks[1]?.baseScope).toBe(0);
  });

  it("resolves CTE references to declaration evidence", () => {
    const text =
      "WITH recent AS (SELECT * FROM events) " +
      "SELECT * FROM recent r";
    const cteStatement = {
      from: [relation("events")],
      type: "select",
    };
    const result = normalize(
      {
        from: [relation("recent", "r")],
        type: "select",
        with: [
          {
            name: { type: "default", value: "recent" },
            stmt: cteStatement,
          },
        ],
      },
      text,
    );

    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.model.blocks).toHaveLength(2);
      expect(result.model.bindings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: expect.objectContaining({
              kind: "cte",
              name: { quoted: false, value: "recent" },
            }),
          }),
        ]),
      );
    }
  });

  it("preserves quoted CTE identity and case semantics", () => {
    const cteStatement = {
      from: [relation("events")],
      type: "select",
    };
    const quoted = normalize(
      {
        from: [relation("Recent")],
        type: "select",
        with: [
          {
            name: { type: "default", value: "Recent" },
            stmt: cteStatement,
          },
        ],
      },
      'WITH "Recent" AS (SELECT * FROM events) SELECT * FROM "Recent"',
    );
    expect(quoted).toMatchObject({
      model: {
        bindings: [
          { source: { kind: "cte", name: { quoted: true, value: "Recent" } } },
          { source: { kind: "named" } },
        ],
      },
      status: "ready",
    });

    const differentlyQuoted = normalize(
      {
        from: [relation("recent")],
        type: "select",
        with: [
          {
            name: { type: "default", value: "Recent" },
            stmt: cteStatement,
          },
        ],
      },
      'WITH "Recent" AS (SELECT * FROM events) SELECT * FROM recent',
    );
    expect(differentlyQuoted).toMatchObject({
      model: {
        bindings: [
          { source: { kind: "named", path: [{ value: "recent" }] } },
          { source: { kind: "named" } },
        ],
      },
      status: "ready",
    });
  });

  it("applies parent and preceding-sibling CTE visibility per block", () => {
    const first = {
      from: [relation("later")],
      type: "select",
    };
    const later = {
      from: [relation("events")],
      type: "select",
    };
    const result = normalize(
      {
        from: [relation("first")],
        type: "select",
        with: [
          { name: { value: "first" }, stmt: first },
          { name: { value: "later" }, stmt: later },
        ],
      },
      "WITH first AS (SELECT * FROM later), " +
        "later AS (SELECT * FROM events) SELECT * FROM first",
    );
    expect(result).toMatchObject({
      model: {
        bindings: [
          { owner: 0, source: { kind: "cte", name: { value: "first" } } },
          {
            owner: 1,
            source: { kind: "named", path: [{ value: "later" }] },
          },
          {
            owner: 2,
            source: { kind: "named", path: [{ value: "events" }] },
          },
        ],
      },
      status: "ready",
    });
  });

  it("authenticates recursive CTE self-visibility", () => {
    const body = {
      from: [relation("self")],
      type: "select",
    };
    const result = normalize(
      {
        from: [relation("self")],
        type: "select",
        with: [{
          name: { value: "self" },
          recursive: true,
          stmt: body,
        }],
      },
      "WITH RECURSIVE self AS (SELECT * FROM self) SELECT * FROM self",
    );
    expect(result).toMatchObject({
      model: {
        bindings: [
          { owner: 0, source: { kind: "cte", name: { value: "self" } } },
          { owner: 1, source: { kind: "cte", name: { value: "self" } } },
        ],
        coverage: { relationBindings: "complete" },
      },
      status: "ready",
    });
    if (result.status === "ready") {
      expect(result.model.issues).not.toContainEqual(
        expect.objectContaining({ code: "recursive-cte-uncertainty" }),
      );
    }
  });

  it("fails closed when recursive lexical and AST evidence disagree", () => {
    const body = {
      from: [relation("self")],
      type: "select",
    };
    const lexicalOnly = normalize(
      {
        from: [relation("self")],
        type: "select",
        with: [{ name: { value: "self" }, stmt: body }],
      },
      "WITH RECURSIVE self AS (SELECT * FROM self) SELECT * FROM self",
    );
    const astOnly = normalize(
      {
        from: [relation("self")],
        type: "select",
        with: [{
          name: { value: "self" },
          recursive: true,
          stmt: body,
        }],
      },
      "WITH self AS (SELECT * FROM self) SELECT * FROM self",
    );
    for (const result of [lexicalOnly, astOnly]) {
      expect(result).toMatchObject({
        model: {
          bindings: [
            { owner: 0, source: { kind: "cte" } },
            {
              owner: 1,
              source: { kind: "unknown", reason: "unknown-correlation" },
            },
          ],
          coverage: { relationBindings: "partial" },
          issues: [{ code: "recursive-cte-uncertainty" }],
        },
        status: "ready",
      });
    }
  });

  it("keeps non-recursive self and forward names outside CTE visibility", () => {
    const self = normalize(
      {
        from: [relation("self")],
        type: "select",
        with: [{
          name: { value: "self" },
          stmt: { from: [relation("self")], type: "select" },
        }],
      },
      "WITH self AS (SELECT * FROM self) SELECT * FROM self",
    );
    expect(self).toMatchObject({
      model: {
        bindings: [
          { owner: 0, source: { kind: "cte" } },
          { owner: 1, source: { kind: "named", path: [{ value: "self" }] } },
        ],
        coverage: { relationBindings: "complete" },
      },
      status: "ready",
    });
  });

  it("marks recursive forward and mutual references uncertain", () => {
    const first = {
      from: [relation("later")],
      type: "select",
    };
    const forward = normalize(
      {
        from: [relation("first")],
        type: "select",
        with: [
          {
            name: { value: "first" },
            recursive: true,
            stmt: first,
          },
          {
            name: { value: "later" },
            stmt: { from: [relation("events")], type: "select" },
          },
        ],
      },
      "WITH RECURSIVE first AS (SELECT * FROM later), " +
        "later AS (SELECT * FROM events) SELECT * FROM first",
    );
    expect(forward).toMatchObject({
      model: {
        bindings: [
          { owner: 0, source: { kind: "cte", name: { value: "first" } } },
          {
            owner: 1,
            source: { kind: "unknown", reason: "unknown-correlation" },
          },
          {
            owner: 2,
            source: { kind: "named", path: [{ value: "events" }] },
          },
        ],
        coverage: { relationBindings: "partial" },
        issues: [{ code: "recursive-cte-uncertainty" }],
      },
      status: "ready",
    });

    const later = {
      from: [relation("first")],
      type: "select",
    };
    const result = normalize(
      {
        from: [relation("first")],
        type: "select",
        with: [
          {
            name: { value: "first" },
            recursive: true,
            stmt: first,
          },
          { name: { value: "later" }, stmt: later },
        ],
      },
      "WITH RECURSIVE first AS (SELECT * FROM later), " +
        "later AS (SELECT * FROM first) SELECT * FROM first",
    );
    expect(result).toMatchObject({
      model: {
        bindings: [
          { owner: 0, source: { kind: "cte", name: { value: "first" } } },
          {
            owner: 1,
            source: { kind: "unknown", reason: "unknown-correlation" },
          },
          { owner: 2, source: { kind: "cte", name: { value: "first" } } },
        ],
        coverage: { relationBindings: "partial" },
        issues: [{ code: "recursive-cte-uncertainty" }],
      },
      status: "ready",
    });
  });

  it("resolves a nested WITH inside its derived query block", () => {
    const nestedCte = {
      from: [relation("events")],
      type: "select",
    };
    const nested = {
      from: [relation("local")],
      type: "select",
      with: [{ name: { value: "local" }, stmt: nestedCte }],
    };
    const result = normalize(
      {
        from: [{ as: "d", expr: { ast: nested, parentheses: true } }],
        type: "select",
      },
      "SELECT * FROM (WITH local AS (SELECT * FROM events) " +
        "SELECT * FROM local) d",
    );
    expect(result).toMatchObject({
      model: {
        bindings: [
          { owner: 0, source: { block: 1, kind: "derived" } },
          { owner: 1, source: { kind: "cte", name: { value: "local" } } },
          {
            owner: 2,
            source: { kind: "named", path: [{ value: "events" }] },
          },
        ],
      },
      status: "ready",
    });
  });

  it("normalizes BigQuery multipart paths and QUALIFY", () => {
    const text =
      "SELECT a.id FROM `project.dataset.users` a " +
      "QUALIFY row_number() over()=1";
    const result = normalize(
      {
        from: [
          {
            as: "a",
            db: null,
            surround: { table: "`" },
            table: "project.dataset.users",
          },
        ],
        qualify: {},
        type: "select",
      },
      text,
      BQ,
    );

    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.model.bindings[0]?.source).toMatchObject({
        kind: "named",
        path: [
          { value: "project" },
          { value: "dataset" },
          { value: "users" },
        ],
      });
      expect(
        result.model.regions.some((region) => region.kind === "qualify"),
      ).toBe(true);
    }
  });

  it("marks DuckDB compatibility evidence partial in every dimension", () => {
    const result = normalize(
      { from: [relation("events")], type: "select" },
      "SELECT * FROM events",
      { compatibility: true, grammar: "postgresql" },
    );
    expect(result).toMatchObject({
      model: {
        coverage: {
          queryBlocks: "partial",
          relationBindings: "partial",
          visibility: "partial",
        },
        issues: [{ code: "parser-compatibility" }],
      },
      status: "ready",
    });
  });

  it("downgrades unmatched lexical or parser relations without guessing", () => {
    const result = normalize(
      {
        from: [
          relation("users"),
          { as: null, expr: { type: "function" } },
        ],
        type: "select",
      },
      "SELECT * FROM users",
    );
    expect(result).toMatchObject({
      model: {
        coverage: {
          relationBindings: "partial",
          visibility: "partial",
        },
        issues: [{ code: "unsupported-relation-source" }],
      },
      status: "ready",
    });
  });

  it("marks extra lexical query blocks and unknown relation shapes partial", () => {
    const extraBlock = normalize(
      { type: "select" },
      "SELECT EXISTS (SELECT 1)",
    );
    expect(extraBlock).toMatchObject({
      model: {
        coverage: { queryBlocks: "partial" },
        issues: [{ code: "unsupported-clause" }],
      },
      status: "ready",
    });

    const unknownRelation = normalize(
      { from: [{}], type: "select" },
      "SELECT * FROM users",
    );
    expect(unknownRelation).toMatchObject({
      model: {
        coverage: { relationBindings: "partial" },
        bindings: [
          {
            source: {
              kind: "unknown",
              reason: "unsupported-relation-source",
            },
          },
        ],
      },
      status: "ready",
    });
  });

  it("downgrades alias disagreement instead of trusting either side", () => {
    const lexicalOnly = normalize(
      { from: [relation("users")], type: "select" },
      "SELECT * FROM users u",
    );
    const astOnly = normalize(
      { from: [relation("users", "u")], type: "select" },
      "SELECT * FROM users",
    );
    const differentValues = normalize(
      { from: [relation("users", "x")], type: "select" },
      "SELECT * FROM users u",
    );
    const differentQuotes = normalize(
      { from: [relation("users", "U")], type: "select" },
      'SELECT * FROM users AS "u"',
    );
    for (const result of [
      lexicalOnly,
      astOnly,
      differentValues,
      differentQuotes,
    ]) {
      expect(result).toMatchObject({
        model: {
          bindings: [{ alias: null }],
          coverage: { relationBindings: "partial" },
          issues: [{ code: "unsupported-relation-source" }],
        },
        status: "ready",
      });
    }
  });

  it("never publishes AST relation names absent from the SQL text", () => {
    const table = normalize(
      { from: [relation("events")], type: "select" },
      "SELECT * FROM users",
    );
    const schema = normalize(
      {
        from: [{ as: null, db: "private", table: "users" }],
        type: "select",
      },
      "SELECT * FROM public.users",
    );
    for (const result of [table, schema]) {
      expect(result).toMatchObject({
        model: {
          bindings: [
            {
              source: {
                kind: "unknown",
                reason: "unsupported-relation-source",
              },
            },
          ],
          coverage: { relationBindings: "partial" },
          issues: [{ code: "unsupported-relation-source" }],
        },
        status: "ready",
      });
    }
    expect(
      normalize(
        { from: [relation("private.dataset.users")], type: "select" },
        "SELECT * FROM `public.dataset.users`",
        BQ,
      ),
    ).toMatchObject({
      model: {
        bindings: [{ source: { kind: "unknown" } }],
        coverage: { relationBindings: "partial" },
      },
      status: "ready",
    });
  });

  it("keeps ON and USING join visibility aligned with relation sites", () => {
    const onText = "SELECT a.id, b.id FROM a JOIN b ON a.id=b.id";
    const onResult = normalize(
      {
        from: [
          relation("a"),
          { ...relation("b"), join: "JOIN", on: {} },
        ],
        type: "select",
      },
      onText,
    );
    const usingText = "SELECT * FROM a JOIN b USING (id)";
    const usingResult = normalize(
      {
        from: [
          relation("a"),
          { ...relation("b"), join: "JOIN" },
        ],
        type: "select",
      },
      usingText,
    );
    for (const [result, position] of [
      [onResult, onText.indexOf("a.id", onText.indexOf("ON"))],
      [usingResult, usingText.indexOf("id")],
    ] as const) {
      expect(result.status).toBe("ready");
      if (result.status === "ready") {
        expect(result.model.coverage.visibility).toBe("complete");
        expect(visibleSqlRelationBindingsAt(result.model, position)).toMatchObject({
          bindings: [{}, {}],
          region: { kind: "join-condition" },
          status: "ready",
        });
      }
    }
  });

  it("does not assign a later join condition to an earlier relation", () => {
    const text = "SELECT * FROM a JOIN b JOIN c ON c.id=b.id";
    const result = normalize(
      {
        from: [
          relation("a"),
          { ...relation("b"), join: "JOIN" },
          { ...relation("c"), join: "JOIN", on: {} },
        ],
        type: "select",
      },
      text,
    );
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      const regions = result.model.regions.filter((region) =>
        region.kind === "join-condition"
      );
      expect(regions).toHaveLength(1);
      expect(visibleSqlRelationBindingsAt(
        result.model,
        text.indexOf("c.id"),
      )).toMatchObject({
        bindings: [{}, {}, {}],
        status: "ready",
      });
    }
  });

  it.each([
    ["WHERE true", { where: {} }],
    ["GROUP BY a.id", { groupby: [{ expr: {} }] }],
    ["HAVING true", { having: {} }],
    ["QUALIFY true", { qualify: {} }],
    ["ORDER BY a.id", { orderby: [{ expr: {} }] }],
    ["LIMIT 1", { limit: {} }],
  ])(
    "stops a conditionless join before %s",
    (suffix, clause) => {
      const result = normalize(
        {
          ...clause,
          from: [
            relation("a"),
            { ...relation("b"), join: "CROSS JOIN" },
          ],
          type: "select",
        },
        `SELECT * FROM a CROSS JOIN b ${suffix}`,
      );
      expect(result.status).toBe("ready");
      if (result.status === "ready") {
        expect(
          result.model.regions.some((region) =>
            region.kind === "join-condition"
          ),
        ).toBe(false);
      }
    },
  );

  it.each([
    "WHERE true",
    "GROUP BY a.id",
    "HAVING true",
    "QUALIFY true",
    "ORDER BY a.id",
    "LIMIT 1",
  ])("ends an ON region before %s", (suffix) => {
    const text = `SELECT * FROM a JOIN b ON true ${suffix}`;
    const result = normalize(
      {
        from: [
          relation("a"),
          { ...relation("b"), join: "JOIN", on: {} },
        ],
        type: "select",
      },
      text,
    );
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      const join = result.model.regions.find((region) =>
        region.kind === "join-condition"
      );
      expect(join?.range.to).toBe(
        text.indexOf(suffix.split(" ")[0] ?? suffix),
      );
    }
  });

  it("emits compound query block kinds", () => {
    for (const type of ["union", "intersect", "except"]) {
      expect(normalize({ type }, "SELECT 1")).toMatchObject({
        model: { blocks: [{ kind: "compound" }] },
        status: "ready",
      });
    }
  });

  it("preserves PostgreSQL quoted path components", () => {
    const result = normalize(
      {
        from: [{ as: "U", db: "MySchema", table: "Users" }],
        type: "select",
      },
      'SELECT * FROM "MySchema"."Users" AS "U"',
    );
    expect(result).toMatchObject({
      model: {
        bindings: [
          {
            alias: { name: { quoted: true, value: "U" } },
            source: {
              kind: "named",
              path: [
                { quoted: true, value: "MySchema" },
                { quoted: true, value: "Users" },
              ],
            },
          },
        ],
      },
      status: "ready",
    });
  });

  it("round trips normalized data across wire v2 without raw AST or text", () => {
    const text = "SELECT u.id FROM users u";
    const result = normalize(
      { from: [relation("users", "u")], type: "select" },
      text,
    );
    if (result.status !== "ready") {
      throw new Error("Expected normalized query bindings");
    }
    const root = { privateAstSecret: "never-cross-wire", type: "select" };
    const encoded = encodeNodeSqlParserWireBackendOutcome(
      1,
      { kind: "parsed", root, statementKind: "query" },
      result.model,
    );
    const decoded = decodeNodeSqlParserWireMessage(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded?.kind).toBe("parsed");
    if (decoded?.kind === "parsed") {
      expect(decoded.queryBindings).toStrictEqual(result.model);
      expect(decoded.queryBindings).not.toBe(result.model);
    }
    expect(JSON.stringify(encoded)).not.toContain("privateAstSecret");
    expect(JSON.stringify(encoded)).not.toContain(text);
    expect(Object.hasOwn(encoded, "root")).toBe(false);
  });
});

describe("node-sql-parser query binding hostile boundaries", () => {
  it("does not invoke AST accessors", () => {
    let calls = 0;
    const root = {};
    Object.defineProperty(root, "type", {
      get() {
        calls += 1;
        return "select";
      },
    });
    expect(normalize(root, "SELECT 1")).toEqual({
      reason: "not-query",
      status: "unavailable",
    });
    expect(calls).toBe(0);
  });

  it("rejects cycles and sparse or oversized AST arrays", () => {
    const cyclic = { from: [] as unknown[], type: "select" };
    cyclic.from.push({ expr: { ast: cyclic } });
    expect(normalize(cyclic, "SELECT * FROM (SELECT 1) x")).toEqual({
      reason: "malformed-ast",
      status: "unavailable",
    });

    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(normalize({ from: sparse, type: "select" }, "SELECT 1")).toEqual({
      reason: "malformed-ast",
      status: "unavailable",
    });

    const oversized = Array.from({ length: 1_025 }, () => relation("x"));
    expect(normalize({ from: oversized, type: "select" }, "SELECT 1")).toEqual({
      reason: "malformed-ast",
      status: "unavailable",
    });

    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    expect(
      normalize({ from: revoked.proxy, type: "select" }, "SELECT 1"),
    ).toEqual({
      reason: "malformed-ast",
      status: "unavailable",
    });
  });

  it("rejects malformed known AST properties and CTE entries", () => {
    const cases: readonly {
      readonly root: unknown;
      readonly text: string;
    }[] = [
      { root: { from: {}, type: "select" }, text: "SELECT 1" },
      { root: { from: [null], type: "select" }, text: "SELECT 1" },
      { root: { type: "select", with: {} }, text: "SELECT 1" },
      { root: { type: "select", with: [null] }, text: "SELECT 1" },
      {
        root: { type: "select", with: [{}] },
        text: "WITH x AS (SELECT 1) SELECT 1",
      },
      {
        root: {
          type: "select",
          with: [{ name: {}, stmt: { type: "select" } }],
        },
        text: "WITH x AS (SELECT 1) SELECT 1",
      },
      {
        root: {
          type: "select",
          with: [{ name: "missing", stmt: { type: "select" } }],
        },
        text: "WITH present AS (SELECT 1) SELECT 1",
      },
    ];
    for (const { root, text } of cases) {
      expect(normalize(root, text).status).toBe("unavailable");
    }
  });

  it("rejects CTE structures that change across safe inspections", () => {
    const child = { type: "select" };
    const item = { name: "x", stmt: child };
    function changingRoot(secondWith: unknown) {
      let reads = 0;
      return new Proxy(
        { type: "select", with: [item] },
        {
          getOwnPropertyDescriptor(target, key) {
            const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
            if (key !== "with" || descriptor === undefined) {
              return descriptor;
            }
            reads += 1;
            return { ...descriptor, value: reads === 1 ? [item] : secondWith };
          },
        },
      );
    }
    for (const root of [changingRoot({}), changingRoot([])]) {
      expect(
        normalize(root, "WITH x AS (SELECT 1) SELECT 1"),
      ).toEqual({ reason: "malformed-ast", status: "unavailable" });
    }

    let itemReads = 0;
    const changingItems = new Proxy([item], {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key !== "0" || descriptor === undefined) {
          return descriptor;
        }
        itemReads += 1;
        return { ...descriptor, value: itemReads === 1 ? item : null };
      },
    });
    expect(
      normalize(
        { type: "select", with: changingItems },
        "WITH x AS (SELECT 1) SELECT 1",
      ),
    ).toEqual({ reason: "malformed-ast", status: "unavailable" });

    function changingChild() {
      let reads = 0;
      return new Proxy(
        { type: "select", with: [] },
        {
          getOwnPropertyDescriptor(target, key) {
            const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
            if (key !== "with" || descriptor === undefined) {
              return descriptor;
            }
            reads += 1;
            return { ...descriptor, value: reads === 1 ? [] : {} };
          },
        },
      );
    }
    expect(
      normalize(
        {
          type: "select",
          with: [{ name: "x", stmt: changingChild() }],
        },
        "WITH x AS (SELECT 1) SELECT 1",
      ),
    ).toEqual({ reason: "malformed-ast", status: "unavailable" });
    expect(
      normalize(
        {
          from: [{ as: "d", expr: { ast: changingChild() } }],
          type: "select",
        },
        "SELECT * FROM (SELECT 1) d",
      ),
    ).toEqual({ reason: "malformed-ast", status: "unavailable" });
  });

  it("handles comments, incomplete relation sites, and nesting limits", () => {
    expect(
      normalize(
        { from: [relation("users")], type: "select" },
        "SELECT /* private */ * FROM users -- tail",
      ).status,
    ).toBe("ready");
    expect(
      normalize({ type: "select" }, "SELECT * FROM").status,
    ).toBe("ready");
    expect(
      normalize(
        { type: "select" },
        `${"(".repeat(257)}SELECT 1${")".repeat(257)}`,
      ),
    ).toEqual({ reason: "resource-limit", status: "unavailable" });
  });

  it("normalizes descriptor traps and invalid normalization authority", () => {
    const hostile = new Proxy(
      { type: "select" },
      {
        getOwnPropertyDescriptor() {
          throw new Error("private trap");
        },
      },
    );
    expect(normalize(hostile, "SELECT 1")).toEqual({
      reason: "not-query",
      status: "unavailable",
    });
    expect(
      normalizeNodeSqlParserQueryBindings(
        { type: "select" },
        "SELECT 1",
        null,
        PG,
      ),
    ).toEqual({ reason: "resource-limit", status: "unavailable" });

    const fromAccessor = { type: "select" };
    Object.defineProperty(fromAccessor, "from", {
      get() {
        throw new Error("private from getter");
      },
    });
    expect(normalize(fromAccessor, "SELECT 1")).toEqual({
      reason: "malformed-ast",
      status: "unavailable",
    });
    expect(
      normalize({ from: null, type: "select" }, "SELECT 1").status,
    ).toBe("ready");
  });

  it("bounds recursive CTEs, unclosed derived sites, and identifier paths", () => {
    const recursive = {
      type: "select",
      with: [] as unknown[],
    };
    recursive.with.push({ name: "self", stmt: recursive });
    expect(
      normalize(
        recursive,
        "WITH self AS (SELECT 1) SELECT 1",
      ),
    ).toEqual({ reason: "malformed-ast", status: "unavailable" });

    const child = { type: "select" };
    expect(
      normalize(
        {
          from: [{ as: "d", expr: { ast: child } }],
          type: "select",
        },
        "SELECT * FROM (SELECT 1",
      ),
    ).toMatchObject({
      model: { coverage: { relationBindings: "partial" } },
      status: "ready",
    });

    const longName = "x".repeat(257);
    expect(
      normalize(
        { from: [relation(longName)], type: "select" },
        `SELECT * FROM ${longName}`,
      ),
    ).toMatchObject({
      model: {
        bindings: [{ source: { kind: "unknown" } }],
        coverage: { relationBindings: "partial" },
      },
      status: "ready",
    });

    const manyComponents = Array.from(
      { length: 9 },
      (_, index) => `p${index}`,
    ).join(".");
    expect(
      normalize(
        { from: [relation(manyComponents)], type: "select" },
        `SELECT * FROM \`${manyComponents}\``,
        BQ,
      ),
    ).toMatchObject({
      model: { bindings: [{ source: { kind: "unknown" } }] },
      status: "ready",
    });
  });

  it("covers alternate bounded grammar shapes without widening evidence", () => {
    expect(normalize({ type: "union" }, "SELECT 1").status).toBe("ready");
    expect(
      normalize(
        {
          from: [{ as: null, schema: "public", table: "users" }],
          type: "select",
        },
        "SELECT * FROM public.users",
      ),
    ).toMatchObject({
      model: {
        bindings: [
          {
            source: {
              path: [{ value: "public" }, { value: "users" }],
            },
          },
        ],
      },
      status: "ready",
    });
    expect(
      normalize(
        {
          type: "select",
          with: [{ name: "x", stmt: { type: "select" } }],
        },
        "WITH x AS (SELECT 1) SELECT 1",
      ).status,
    ).toBe("ready");
    expect(
      normalize(
        { from: [relation("users")], type: "select" },
        'SELECT * FROM ""',
      ).status,
    ).toBe("ready");
    expect(normalize({ type: "select" }, "SELECT 1 ON true").status).toBe(
      "ready",
    );
    expect(
      normalize(
        { type: "select" },
        `SELECT $${"a".repeat(300)}$`,
      ),
    ).toEqual({ reason: "resource-limit", status: "unavailable" });
    expect(
      normalizeNodeSqlParserQueryBindings(
        { type: "select" },
        1,
        {},
        PG,
      ),
    ).toEqual({ reason: "resource-limit", status: "unavailable" });
  });

  it("rejects malformed roots, syntax shapes, and resource excess", () => {
    expect(normalize(null, "SELECT 1")).toEqual({
      reason: "not-query",
      status: "unavailable",
    });
    expect(normalize({ type: "insert" }, "INSERT INTO x VALUES (1)")).toEqual({
      reason: "not-query",
      status: "unavailable",
    });
    expect(normalize({ type: "select" }, "x".repeat(16 * 1024 + 1))).toEqual({
      reason: "resource-limit",
      status: "unavailable",
    });
    expect(normalize({ type: "select" }, "SELECT 1)")).toEqual({
      reason: "resource-limit",
      status: "unavailable",
    });
    expect(normalize({ type: "select" }, "not a query")).toEqual({
      reason: "unsupported-shape",
      status: "unavailable",
    });
  });

  it("rejects hostile wire binding payloads without invoking getters", () => {
    let calls = 0;
    const hostile = {};
    Object.defineProperty(hostile, "statementRange", {
      enumerable: true,
      get() {
        calls += 1;
        return { from: 0, to: 8 };
      },
    });
    const decoded = decodeNodeSqlParserWireMessage({
      kind: "parsed",
      protocolVersion: 2,
      queryBindings: hostile,
      requestId: 1,
      statementKind: "query",
    });
    expect(decoded).toBeNull();
    expect(calls).toBe(0);
  });
});
