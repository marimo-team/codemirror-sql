import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { NodeSqlParser } from "../parser.js";

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
    it("should accept DuckDB-specific syntax without parsing", async () => {
      const duckdbParser = new NodeSqlParser({
        getParserOptions: () => ({
          database: "DuckDB",
        }),
      });

      const state = EditorState.create({
        doc: "from nyc.rideshare select * limit 100",
      });

      const result = await duckdbParser.parse("from nyc.rideshare select * limit 100", { state });

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

    it("should accept complex DuckDB queries without parsing", async () => {
      const duckdbParser = new NodeSqlParser({
        getParserOptions: () => ({
          database: "DuckDB",
        }),
      });

      const state = EditorState.create({
        doc: "from nyc.rideshare select pickup_datetime, dropoff_datetime limit 50",
      });

      const result = await duckdbParser.parse(
        "from nyc.rideshare select pickup_datetime, dropoff_datetime limit 50",
        { state },
      );

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.ast).toBeUndefined();
    });

    it("should accept DuckDB queries with semicolons without parsing", async () => {
      const duckdbParser = new NodeSqlParser({
        getParserOptions: () => ({
          database: "DuckDB",
        }),
      });

      const state = EditorState.create({
        doc: "from posts select title, name;",
      });

      const result = await duckdbParser.parse("from posts select title, name;", { state });

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.ast).toBeUndefined();
    });

    it("should treat OR REPLACE as a normal SQL query", async () => {
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

    it("should be succesful with duckdb specific keywords", async () => {
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
