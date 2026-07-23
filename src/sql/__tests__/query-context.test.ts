import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { NodeSqlParser } from "../parser.js";
import {
  analyzeQueryContext,
  maskLiteralsAndComments,
  type QueryContext,
  QueryContextAnalyzer,
  stripIdentifierQuotes,
} from "../query-context.js";
import type { SqlParser } from "../types.js";

const parser = new NodeSqlParser();

async function analyze(sql: string): Promise<QueryContext> {
  return analyzeQueryContext(sql, parser, { state: EditorState.create({ doc: sql }) });
}

async function analyzeWith(customParser: SqlParser, sql: string): Promise<QueryContext> {
  return analyzeQueryContext(sql, customParser, { state: EditorState.create({ doc: sql }) });
}

/** Minimal parser stub; only `parse` is exercised by analyzeQueryContext. */
function makeParser(parse: SqlParser["parse"]): SqlParser {
  return {
    parse,
    validateSql: async () => [],
    extractTableReferences: async () => [],
    extractColumnReferences: async () => [],
  };
}

describe("analyzeQueryContext", () => {
  it("returns an empty context for empty input", async () => {
    const context = await analyze("   ");
    expect(context.tables).toEqual([]);
    expect(context.ctes).toEqual([]);
    expect(context.aliases.size).toBe(0);
    expect(context.selectAliases).toEqual([]);
  });

  it("extracts a bare alias (no AS)", async () => {
    const context = await analyze("SELECT u.name FROM users u");
    expect(context.tables).toEqual([{ name: "users", path: ["users"], alias: "u" }]);
    expect(context.aliases.get("u")).toBe("users");
  });

  it("extracts an AS alias", async () => {
    const context = await analyze("SELECT u.name FROM users AS u");
    expect(context.aliases.get("u")).toBe("users");
  });

  it("records tables without aliases", async () => {
    const context = await analyze("SELECT name FROM users");
    expect(context.tables).toEqual([{ name: "users", path: ["users"] }]);
    expect(context.aliases.size).toBe(0);
  });

  it("extracts both aliases from a join", async () => {
    const context = await analyze(
      "SELECT u.name, o.total FROM users u JOIN orders o ON u.id = o.user_id",
    );
    expect(context.aliases.get("u")).toBe("users");
    expect(context.aliases.get("o")).toBe("orders");
    expect(context.tables).toHaveLength(2);
  });

  it("lets an alias shadow a real table name", async () => {
    // `orders` here is an alias for `users`, not the orders table
    const context = await analyze("SELECT orders.name FROM users orders");
    expect(context.aliases.get("orders")).toBe("users");
  });

  it("keeps qualified paths in the alias target", async () => {
    const context = await analyze("SELECT u.name FROM mydb.users u");
    expect(context.tables).toEqual([{ name: "users", path: ["mydb", "users"], alias: "u" }]);
    expect(context.aliases.get("u")).toBe("mydb.users");
  });

  it("extracts aliases from subqueries", async () => {
    const context = await analyze(
      "SELECT * FROM (SELECT u.id FROM users u) sub WHERE sub.id > 1",
    );
    expect(context.aliases.get("u")).toBe("users");
  });

  it("collects select-list aliases", async () => {
    const context = await analyze("SELECT count(*) AS total, name AS n FROM users");
    expect(context.selectAliases).toEqual(["total", "n"]);
  });

  describe("CTEs", () => {
    it("extracts a CTE with inferred columns and its alias", async () => {
      const sql = "WITH recent AS (SELECT x, y FROM logs) SELECT r.x FROM recent r";
      const context = await analyze(sql);

      expect(context.ctes).toHaveLength(1);
      const cte = context.ctes[0];
      expect(cte?.name).toBe("recent");
      expect(cte?.columns).toEqual(["x", "y"]);
      expect(cte?.from).toBe(sql.indexOf("recent"));
      expect(cte?.to).toBe(sql.indexOf("recent") + "recent".length);

      expect(context.aliases.get("r")).toBe("recent");
      // The CTE body's table is still visible
      expect(context.tables.some((t) => t.name === "logs")).toBe(true);
    });

    it("prefers declared CTE column lists", async () => {
      const context = await analyze(
        "WITH recent (a, b) AS (SELECT x, y FROM logs) SELECT * FROM recent",
      );
      expect(context.ctes[0]?.columns).toEqual(["a", "b"]);
    });

    it("uses select aliases as CTE output columns", async () => {
      const context = await analyze(
        "WITH stats AS (SELECT count(*) AS n FROM logs) SELECT * FROM stats",
      );
      expect(context.ctes[0]?.columns).toEqual(["n"]);
    });

    it("extracts multiple CTEs", async () => {
      const context = await analyze(
        "WITH a AS (SELECT id FROM users), b AS (SELECT id FROM orders) SELECT * FROM a JOIN b ON a.id = b.id",
      );
      expect(context.ctes.map((c) => c.name)).toEqual(["a", "b"]);
    });
  });

  describe("regex fallback for unparsable statements", () => {
    it("still resolves aliases mid-edit", async () => {
      // Trailing dot makes this unparsable
      const context = await analyze("SELECT u. FROM users u");
      expect(context.aliases.get("u")).toBe("users");
      expect(context.tables).toEqual([{ name: "users", path: ["users"], alias: "u" }]);
    });

    it("does not treat keywords after a table as aliases", async () => {
      const context = await analyze("SELECT u.name, FROM users u JOIN orders WHERE x = 1");
      expect(context.aliases.get("u")).toBe("users");
      expect(context.aliases.has("where")).toBe(false);
      expect(context.tables.some((t) => t.name === "orders" && t.alias)).toBe(false);
    });

    it("still records a joined table when the previous table has no alias", async () => {
      const context = await analyze("SELECT FROM users JOIN orders o ON ");
      expect(context.tables.map((t) => t.name)).toEqual(["users", "orders"]);
      expect(context.aliases.get("o")).toBe("orders");
    });

    it("ignores FROM/JOIN inside string literals", async () => {
      const context = await analyze("SELECT u. FROM users u WHERE name = 'from phantom p'");
      expect(context.tables.map((t) => t.name)).toEqual(["users"]);
      expect(context.aliases.has("p")).toBe(false);
    });

    it("ignores FROM/JOIN inside comments", async () => {
      const context = await analyze(
        "SELECT u. -- join phantom ph\n/* from ghost g */ FROM users u",
      );
      expect(context.tables.map((t) => t.name)).toEqual(["users"]);
      expect(context.aliases.has("ph")).toBe(false);
      expect(context.aliases.has("g")).toBe(false);
    });

    it("does not let a quote inside a quoted identifier start a string", async () => {
      const context = await analyze(`SELECT x. FROM "it's" x`);
      expect(context.aliases.get("x")).toBe("it's");
    });

    it("handles AS aliases and qualified paths", async () => {
      const context = await analyze("SELECT FROM mydb.users AS u WHERE u.");
      expect(context.aliases.get("u")).toBe("mydb.users");
    });

    it("strips quotes from quoted identifiers but resolves the alias", async () => {
      const context = await analyze('SELECT ut. FROM "User Table" ut');
      expect(context.aliases.get("ut")).toBe("User Table");
      expect(context.tables[0]?.name).toBe("User Table");
    });

    it("extracts CTEs with declared columns", async () => {
      const sql = "WITH recent (a, b) AS (SELECT x FROM logs WHERE ) SELECT r. FROM recent r";
      const context = await analyze(sql);
      expect(context.ctes[0]?.name).toBe("recent");
      expect(context.ctes[0]?.columns).toEqual(["a", "b"]);
      expect(context.ctes[0]?.from).toBe(sql.indexOf("recent"));
      expect(context.aliases.get("r")).toBe("recent");
    });
  });
});

describe("QueryContextAnalyzer", () => {
  it("caches by statement text", async () => {
    const spy = vi.spyOn(parser, "parse");
    const analyzer = new QueryContextAnalyzer(parser);
    const sql = "SELECT u.name FROM users u";
    const state = EditorState.create({ doc: sql });

    const first = await analyzer.getContext(sql, { state });
    const second = await analyzer.getContext(sql, { state });
    expect(second).toBe(first);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("clears its cache", async () => {
    const analyzer = new QueryContextAnalyzer(parser);
    const sql = "SELECT u.name FROM users u";
    const state = EditorState.create({ doc: sql });

    const first = await analyzer.getContext(sql, { state });
    analyzer.clearCache();
    const second = await analyzer.getContext(sql, { state });
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });
});

describe("analyzeQueryContext parser fallbacks", () => {
  it("falls back to the regex path when the parser throws", async () => {
    const throwing = makeParser(async () => {
      throw new Error("boom");
    });
    const context = await analyzeWith(throwing, "SELECT id FROM users u");
    expect(context.aliases.get("u")).toBe("users");
    expect(context.tables).toEqual([{ name: "users", path: ["users"], alias: "u" }]);
  });

  it("falls back to the regex path when parsing reports failure", async () => {
    const failing = makeParser(async () => ({ success: false, errors: [] }));
    const context = await analyzeWith(failing, "SELECT id FROM users u");
    expect(context.aliases.get("u")).toBe("users");
  });

  it("falls back to the regex path when the parser returns a null ast", async () => {
    const nullAst = makeParser(async () => ({ success: true, errors: [], ast: null }));
    const context = await analyzeWith(nullAst, "SELECT id FROM users u");
    expect(context.aliases.get("u")).toBe("users");
  });

  it("falls back to the regex path when the AST walk throws", async () => {
    // An ast whose property access throws forces the post-parse try/catch to
    // fall back to the regex scan.
    const exploding: Record<string, unknown> = {};
    Object.defineProperty(exploding, "type", {
      enumerable: true,
      get() {
        throw new Error("kaboom");
      },
    });
    const badAst = makeParser(async () => ({ success: true, errors: [], ast: exploding }));
    const context = await analyzeWith(badAst, "SELECT id FROM users u");
    // Regex fallback still resolves the alias
    expect(context.aliases.get("u")).toBe("users");
  });
});

describe("analyzeQueryContext multiple statements", () => {
  it("collects tables from statements split by semicolons", async () => {
    const context = await analyze("SELECT a FROM t1; SELECT b FROM t2");
    const names = context.tables.map((t) => t.name).sort();
    expect(names).toEqual(["t1", "t2"]);
  });

  it("collects select aliases across multiple statements", async () => {
    const context = await analyze("SELECT a AS x FROM t1; SELECT b AS y FROM t2");
    expect(context.selectAliases).toEqual(["x", "y"]);
  });
});

describe("analyzeQueryContext CTE column inference", () => {
  it("ignores SELECT * when inferring CTE columns from the AST", async () => {
    const context = await analyze("WITH c AS (SELECT * FROM logs) SELECT * FROM c");
    expect(context.ctes[0]?.name).toBe("c");
    expect(context.ctes[0]?.columns).toEqual([]);
  });

  it("infers columns from the select body in the regex fallback, skipping stars", async () => {
    // Trailing `c.` keeps the statement unparsable, forcing the regex fallback.
    const sql =
      "WITH c AS (SELECT a AS x, foo(b, c) AS f, t.*, plain FROM logs WHERE ) SELECT c. FROM c";
    const context = await analyzeWith(parser, sql);
    expect(context.ctes[0]?.name).toBe("c");
    expect(context.ctes[0]?.columns).toEqual(["x", "f", "plain"]);
  });
});

describe("analyzeQueryContext literal and comment masking", () => {
  it("does not read FROM inside an escaped single-quoted literal as a table", async () => {
    const context = await analyze("SELECT x. FROM users u WHERE n = 'it''s from ghost g'");
    expect(context.tables.map((t) => t.name)).toEqual(["users"]);
    expect(context.aliases.has("g")).toBe(false);
    expect(context.aliases.get("u")).toBe("users");
  });

  it("resolves an alias for a bracket-quoted table name via the regex fallback", async () => {
    const context = await analyze("SELECT x. FROM [my table] x");
    expect(context.aliases.get("x")).toBe("my table");
    expect(context.tables[0]?.name).toBe("my table");
  });
});

describe("maskLiteralsAndComments", () => {
  it("blanks single-line comments while preserving offsets", () => {
    const input = "SELECT 1 -- from ghost\nFROM t";
    const masked = maskLiteralsAndComments(input);
    expect(masked).toHaveLength(input.length);
    expect(masked).not.toContain("ghost");
    expect(masked.endsWith("FROM t")).toBe(true);
  });

  it("blanks block comments while preserving offsets", () => {
    const input = "SELECT /* from ghost */ 1 FROM t";
    const masked = maskLiteralsAndComments(input);
    expect(masked).toHaveLength(input.length);
    expect(masked).not.toContain("ghost");
  });

  it("blanks single-quoted string literals including escaped quotes", () => {
    const input = "SELECT 'it''s a from' FROM t";
    const masked = maskLiteralsAndComments(input);
    expect(masked).toHaveLength(input.length);
    expect(masked).not.toContain("from'");
    expect(masked.includes("FROM t")).toBe(true);
  });

  it("leaves quoted, backtick, and bracket identifiers intact", () => {
    const input = `SELECT "a'b", \`c'd\`, [e'f] FROM t`;
    const masked = maskLiteralsAndComments(input);
    expect(masked).toBe(input);
  });
});

describe("stripIdentifierQuotes", () => {
  it.each([
    ['"User Table"', "User Table"],
    ["`users`", "users"],
    ["[users]", "users"],
    ["'users'", "users"],
    ["users", "users"],
    ['"', '"'],
  ])("strips %s to %s", (input, expected) => {
    expect(stripIdentifierQuotes(input)).toBe(expected);
  });
});
