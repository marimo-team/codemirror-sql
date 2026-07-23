import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { NodeSqlParser } from "../parser.js";
import {
  analyzeQueryContext,
  type QueryContext,
  QueryContextAnalyzer,
  stripIdentifierQuotes,
} from "../query-context.js";

const parser = new NodeSqlParser();

async function analyze(sql: string): Promise<QueryContext> {
  return analyzeQueryContext(sql, parser, { state: EditorState.create({ doc: sql }) });
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

  describe("regex fallback for unparseable statements", () => {
    it("still resolves aliases mid-edit", async () => {
      // Trailing dot makes this unparseable
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
