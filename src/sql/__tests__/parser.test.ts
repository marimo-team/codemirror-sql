import { describe, expect, it } from "vitest";
import { NodeSqlParser } from "../parser.js";

describe("SqlParser", () => {
  const parser = new NodeSqlParser();

  describe("parse", () => {
    it("should parse valid SQL successfully", async () => {
      const sql = "SELECT * FROM users WHERE id = 1";
      const result = await parser.parse(sql);

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
      const result = await parser.parse(sql);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should return errors for invalid SQL", async () => {
      const sql = "SELECT * FROM";
      const result = await parser.parse(sql);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].severity).toBe("error");
      expect(result.errors[0].message).toBeTruthy();
    });

    it("should return errors for syntax errors", async () => {
      const sql = "SELECT * FORM users";
      const result = await parser.parse(sql);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
    });
  });

  describe("validateSql", () => {
    it("should return empty array for valid SQL", async () => {
      const sql = "SELECT 1";
      const errors = await parser.validateSql(sql);

      expect(errors).toHaveLength(0);
    });

    it("should return errors for invalid SQL", async () => {
      const sql = "SELECT * FROM WHERE";
      const errors = await parser.validateSql(sql);

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toHaveProperty("message");
      expect(errors[0]).toHaveProperty("line");
      expect(errors[0]).toHaveProperty("column");
      expect(errors[0]).toHaveProperty("severity");
    });
  });
});
