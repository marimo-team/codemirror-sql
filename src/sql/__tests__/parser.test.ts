import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { exportedForTesting, NodeSqlParser } from "../parser.js";

describe("SqlParser", () => {
  const parser = new NodeSqlParser();
  const state = EditorState.create({
    doc: "SELECT * FROM users WHERE id = 1",
  });

  describe("parse", () => {
    it("should parse valid SQL successfully", async () => {
      const sql = "SELECT * FROM users WHERE id = 1";
      const result = await parser.parse(sql, { state });

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.ast).toBeDefined();
    });

    it("should handle complex queries", async () => {
      const sql = `
        SELECT u.name, p.title
        FROM users u
        JOIN posts p ON u.id = p.user_id
        WHERE u.active = true
        ORDER BY p.created_at DESC
      `;
      const result = await parser.parse(sql, { state });

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should return errors for invalid SQL", async () => {
      const sql = "SELECT * FROM";
      const result = await parser.parse(sql, { state });

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].severity).toBe("error");
      expect(result.errors[0].message).toBeTruthy();
    });

    it("should return errors for syntax errors", async () => {
      const sql = "SELECT * FORM users";
      const result = await parser.parse(sql, { state });

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
    });

    it("should use custom parser options when provided", async () => {
      const customParser = new NodeSqlParser({
        getParserOptions: () => ({
          database: "PostgreSQL",
          parseOptions: {
            includeLocations: true,
          },
        }),
      });

      const sql = "SELECT * FROM users";
      const result = await customParser.parse(sql, { state });

      expect(result.success).toBe(true);
      expect(result.ast).toBeDefined();
      // The AST should include location information when includeLocations is true
      if (result.success && Array.isArray(result.ast)) {
        const selectStmt = result.ast[0];
        if (selectStmt && typeof selectStmt === "object" && "loc" in selectStmt) {
          expect(selectStmt.loc).toBeDefined();
        }
      }
    });

    it("should call getParserOptions with correct state", async () => {
      const mockGetParserOptions = vi.fn().mockReturnValue({
        database: "MySQL",
      });

      const customParser = new NodeSqlParser({
        getParserOptions: mockGetParserOptions,
      });

      const sql = "SELECT 1";
      await customParser.parse(sql, { state });

      expect(mockGetParserOptions).toHaveBeenCalledTimes(1);
      expect(mockGetParserOptions).toHaveBeenCalledWith(state);
    });
  });

  describe("validateSql", () => {
    it("should return empty array for valid SQL", async () => {
      const sql = "SELECT 1";
      const errors = await parser.validateSql(sql, { state });

      expect(errors).toHaveLength(0);
    });

    it("should return errors for invalid SQL", async () => {
      const sql = "SELECT * FROM WHERE";
      const errors = await parser.validateSql(sql, { state });

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toHaveProperty("message");
      expect(errors[0]).toHaveProperty("line");
      expect(errors[0]).toHaveProperty("column");
      expect(errors[0]).toHaveProperty("severity");
    });
  });

  describe("DuckDB dialect support", () => {
    it("should accept FROM queries syntax without parsing", async () => {
      const duckdbParser = new NodeSqlParser({
        getParserOptions: () => ({
          database: "DuckDB",
        }),
      });

      const sql = "from nyc.rideshare select * limit 100";
      const result = await duckdbParser.parse(sql, { state });

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.ast).toBeUndefined();
    });

    it("should still parse standard SQL with DuckDB dialect", async () => {
      const duckdbParser = new NodeSqlParser({
        getParserOptions: () => ({
          database: "DuckDB",
        }),
      });

      const state = EditorState.create({
        doc: "SELECT * FROM users WHERE id = 1",
      });

      const result = await duckdbParser.parse("SELECT * FROM users WHERE id = 1", { state });

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should treat CREATE OR REPLACE TABLE as a normal SQL query", async () => {
      const duckdbParser = new NodeSqlParser({
        getParserOptions: () => ({
          database: "DuckDB",
        }),
      });

      const queries = [
        "CREATE OR REPLACE TABLE users (id INT, name VARCHAR(255))",
        "create or replace VIEW v1 AS SELECT 1",
      ];

      for (const sql of queries) {
        const state = EditorState.create({
          doc: sql,
        });
        const result = await duckdbParser.parse(sql, { state });
        expect(result.success).toBe(true);
        expect(result.errors).toHaveLength(0);
        expect(result.ast).toBeDefined();
      }
    });

    it("should handle error offsets correctly when replacing CREATE OR REPLACE TABLE", async () => {
      const duckdbParser = new NodeSqlParser({
        getParserOptions: () => ({
          database: "DuckDB",
        }),
      });

      // This SQL has a syntax error at the end - missing closing parenthesis
      const sql = "CREATE OR REPLACE TABLE users (id INT, name VARCHAR(255), invalid_syntax";

      const state = EditorState.create({
        doc: sql,
      });

      const result = await duckdbParser.parse(sql, { state });
      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);

      const error = result.errors[0];

      // The offset should be at the original position of the error
      const expectedColumn = sql.length;
      expect(error.column).toBe(expectedColumn);
    });

    it("should be successful with macro keyword", async () => {
      const duckdbParser = new NodeSqlParser({
        getParserOptions: () => ({
          database: "DuckDB",
        }),
      });

      const queries = ["CREATE macro test1(a) as 1"];

      for (const sql of queries) {
        const state = EditorState.create({
          doc: sql,
        });
        const result = await duckdbParser.parse(sql, { state });
        expect(result.success).toBe(true);
        expect(result.errors).toHaveLength(0);
      }
    });

    it("should quote {} in quotes", async () => {
      const duckdbParser = new NodeSqlParser({
        getParserOptions: () => ({
          database: "DuckDB",
          ignoreBrackets: true,
        }),
      });

      const state = EditorState.create({
        doc: "SELECT {id} FROM users WHERE id = {id} and name = {name}",
      });

      const sql = "SELECT {id} FROM users WHERE id = {id} and name = {name}";
      const result = await duckdbParser.parse(sql, { state });

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });
});

const { removeCommentsFromStart, replaceBracketsWithQuotes } = exportedForTesting;

describe("removeComments", () => {
  it("should remove comments from the start of the query", () => {
    const sql = "/* comment */ SELECT * FROM users";
    const result = removeCommentsFromStart(sql).trim();
    expect(result).toBe("SELECT * FROM users");
  });

  it("should remove comments from the start of the query with multiple lines", () => {
    const sql = `
      /* comment */
    SELECT * FROM users
    `;
    const result = removeCommentsFromStart(sql).trim();
    expect(result).toBe("SELECT * FROM users");
  });

  it("should remove single line comments", () => {
    const sql = `
    -- comment
    SELECT * FROM users
    `;
    const result2 = removeCommentsFromStart(sql).trim();
    expect(result2).toBe("SELECT * FROM users");
  });

  it("should remove comments from the start of the query with multiple lines and single line comments", () => {
    const sql = `
    /* comment */
      -- comment
    SELECT * FROM users

    `;
    const result = removeCommentsFromStart(sql).trim();
    expect(result).toBe("SELECT * FROM users");
  });
});

describe("replaceBracketsWithQuotes", () => {
  it("should replace brackets with quotes", () => {
    const sql = "SELECT {id} FROM users WHERE id = {id}";
    const result = replaceBracketsWithQuotes(sql);
    expect(result.sql).toBe("SELECT '{id}' FROM users WHERE id = '{id}'");
    expect(result.offsetRecord).toEqual({ 7: 2, 34: 2 });
  });

  it("should not replace brackets that are already inside quotes", () => {
    const sql = "SELECT '{id}' FROM users WHERE id = '{id}'";
    const result = replaceBracketsWithQuotes(sql);
    expect(result.sql).toBe("SELECT '{id}' FROM users WHERE id = '{id}'");
    expect(result.offsetRecord).toEqual({});
  });

  it("should replace multiple brackets", () => {
    const sql = "SELECT {id} FROM users WHERE id = {id} and name = {name}";
    const result = replaceBracketsWithQuotes(sql);
    expect(result.sql).toBe("SELECT '{id}' FROM users WHERE id = '{id}' and name = '{name}'");
    expect(result.offsetRecord).toEqual({ 50: 2, 7: 2, 34: 2 });
  });

  it("should not replace multiple brackets that are already inside quotes", () => {
    const sql = "SELECT '{id}' FROM users WHERE id = '{id}' and name = '{name}'";
    const result = replaceBracketsWithQuotes(sql);
    expect(result.sql).toBe("SELECT '{id}' FROM users WHERE id = '{id}' and name = '{name}'");
    expect(result.offsetRecord).toEqual({});
  });

  it("should handle multiple brackets in quotes", () => {
    const sql = "SELECT '{id} {name}' FROM users WHERE id = '{id} {name}'";
    const result = replaceBracketsWithQuotes(sql);
    expect(result.sql).toBe("SELECT '{id} {name}' FROM users WHERE id = '{id} {name}'");
    expect(result.offsetRecord).toEqual({});
  });

  it("should handle mixed quotes", () => {
    const sql = "SELECT '{id}' FROM users WHERE id = \"{id}\"";
    const result = replaceBracketsWithQuotes(sql);
    expect(result.sql).toBe("SELECT '{id}' FROM users WHERE id = \"{id}\"");
    expect(result.offsetRecord).toEqual({});
  });

  it.fails("should handle escaped quotes", () => {
    const sql = "SELECT \\'{id}\\' FROM users WHERE id = \\'{id}\\'";
    const result = replaceBracketsWithQuotes(sql);
    expect(result.sql).toBe("SELECT \\'{id}\\' FROM users WHERE id = \\'{id}\\'");
  });

  it("should handle brackets at the beginning of string", () => {
    const sql = "{id} FROM users";
    const result = replaceBracketsWithQuotes(sql);
    expect(result.sql).toBe("'{id}' FROM users");
    expect(result.offsetRecord).toEqual({ 0: 2 });
  });

  it("should handle brackets at the end of string", () => {
    const sql = "SELECT * FROM users WHERE id = {id}";
    const result = replaceBracketsWithQuotes(sql);
    expect(result.sql).toBe("SELECT * FROM users WHERE id = '{id}'");
  });

  it("should handle empty brackets", () => {
    const sql = "SELECT {} FROM users";
    const result = replaceBracketsWithQuotes(sql);
    expect(result.sql).toBe("SELECT '{}' FROM users");
  });

  it("should handle brackets with spaces", () => {
    const sql = "SELECT { user id } FROM users WHERE id = { user id }";
    const result = replaceBracketsWithQuotes(sql);
    expect(result.sql).toBe("SELECT '{ user id }' FROM users WHERE id = '{ user id }'");
  });

  it("should handle complex nested structures", () => {
    const sql =
      "SELECT {user.profile.name} FROM users WHERE id = '{user.id}' AND name = \"{user.name}\"";
    const result = replaceBracketsWithQuotes(sql);
    expect(result.sql).toBe(
      "SELECT '{user.profile.name}' FROM users WHERE id = '{user.id}' AND name = \"{user.name}\"",
    );
  });

  it("should handle unclosed brackets", () => {
    const sql = "SELECT {id FROM users";
    const result = replaceBracketsWithQuotes(sql);
    expect(result.sql).toBe("SELECT {id FROM users");
  });

  it("should handle multiple unquoted brackets in sequence", () => {
    const sql = "SELECT {id}{name}{email} FROM users";
    const result = replaceBracketsWithQuotes(sql);
    expect(result.sql).toBe("SELECT '{id}''{name}''{email}' FROM users");
  });

  it("should handle brackets inside string literals with escaped quotes", () => {
    const sql = "SELECT 'user\\'s {id}' FROM users";
    const result = replaceBracketsWithQuotes(sql);
    expect(result.sql).toBe("SELECT 'user\\'s {id}' FROM users");
  });
});
