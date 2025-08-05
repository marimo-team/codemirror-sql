import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { NodeSqlParser } from "../../parser.js";

describe("Location Tracking and Error Reporting", () => {
  const schema = {
    users: ["id", "name", "email"],
    orders: ["id", "user_id", "total"],
  };

  const parser = new NodeSqlParser({ schema });
  const state = EditorState.create({
    doc: "SELECT * FROM users",
  });

  describe("Basic Location Tracking", () => {
    it("should track locations for simple queries", async () => {
      const sql = "SELECT name FROM users";
      const result = await parser.parse(sql, { state });

      expect(result.success).toBe(true);
      if (result.success && result.ast) {
        const references = await parser.extractReferences(result.ast);

        expect(references.length).toBeGreaterThan(0);

        // All references should have line and column numbers
        for (const ref of references) {
          expect(ref.line).toBeGreaterThan(0);
          expect(ref.column).toBeGreaterThan(0);
        }
      }
    });

    it("should track locations for aliased queries", async () => {
      const sql = "SELECT u.name FROM users as u";
      const result = await parser.parse(sql, { state });

      expect(result.success).toBe(true);
      if (result.success && result.ast) {
        const references = await parser.extractReferences(result.ast);

        // Should have both table and column references
        const tableRefs = references.filter((r) => r.type === "table");
        const columnRefs = references.filter((r) => r.type === "column");

        expect(tableRefs.length).toBeGreaterThan(0);
        expect(columnRefs.length).toBeGreaterThan(0);

        // All should have valid locations
        for (const ref of references) {
          expect(ref.line).toBeGreaterThan(0);
          expect(ref.column).toBeGreaterThan(0);
        }
      }
    });
  });

  describe("Error Location Reporting", () => {
    it("should report errors with correct locations", async () => {
      const sql = "SELECT nonexistent FROM users";
      const errors = await parser.validateSql(sql, { state });

      expect(errors.length).toBeGreaterThan(0);

      for (const error of errors) {
        expect(error.line).toBeGreaterThan(0);
        expect(error.column).toBeGreaterThan(0);
        expect(error.message).toBeTruthy();
        expect(error.severity).toBe("error");
      }
    });

    it("should report table errors with correct locations", async () => {
      const sql = "SELECT name FROM nonexistent";
      const errors = await parser.validateSql(sql, { state });

      expect(errors.length).toBeGreaterThan(0);

      const tableError = errors.find((e) =>
        e.message.includes("Table 'nonexistent' does not exist"),
      );
      expect(tableError).toBeDefined();
      expect(tableError?.line).toBeGreaterThan(0);
      expect(tableError?.column).toBeGreaterThan(0);
    });

    it("should report column errors with correct locations", async () => {
      const sql = "SELECT nonexistent FROM users";
      const errors = await parser.validateSql(sql, { state });

      expect(errors.length).toBeGreaterThan(0);

      const columnError = errors.find((e) =>
        e.message.includes("Column 'nonexistent' does not exist"),
      );
      expect(columnError).toBeDefined();
      expect(columnError?.line).toBeGreaterThan(0);
      expect(columnError?.column).toBeGreaterThan(0);
    });
  });

  describe("Multi-line Query Location Tracking", () => {
    it("should track locations in multi-line queries", async () => {
      const sql = `
        SELECT u.name, 
               o.total
        FROM users u
        JOIN orders o ON u.id = o.user_id
        WHERE o.total > 100
      `;
      const result = await parser.parse(sql, { state });

      expect(result.success).toBe(true);
      if (result.success && result.ast) {
        const references = await parser.extractReferences(result.ast);

        expect(references.length).toBeGreaterThan(0);

        // Should have different line numbers for different parts
        const lineNumbers = references.map((r) => r.line);
        expect(Math.max(...lineNumbers)).toBeGreaterThan(Math.min(...lineNumbers));
      }
    });

    it("should handle complex multi-line queries", async () => {
      const sql = `
        SELECT 
          u.name,
          COUNT(o.id) as order_count,
          SUM(o.total) as total_spent
        FROM users u
        LEFT JOIN orders o ON u.id = o.user_id
        WHERE u.email LIKE '%@example.com'
        GROUP BY u.id, u.name
        HAVING COUNT(o.id) > 0
        ORDER BY total_spent DESC
      `;
      const result = await parser.parse(sql, { state });

      expect(result.success).toBe(true);
      if (result.success && result.ast) {
        const references = await parser.extractReferences(result.ast);

        expect(references.length).toBeGreaterThan(0);

        // All references should have valid locations
        for (const ref of references) {
          expect(ref.line).toBeGreaterThan(0);
          expect(ref.column).toBeGreaterThan(0);
        }
      }
    });
  });

  describe("Context-Specific Location Tracking", () => {
    it("should track locations for different contexts", async () => {
      const sql = `
        SELECT u.name 
        FROM users u 
        WHERE u.email = 'test@example.com'
        ORDER BY u.name
      `;
      const result = await parser.parse(sql, { state });

      expect(result.success).toBe(true);
      if (result.success && result.ast) {
        const references = await parser.extractReferences(result.ast);

        // Should have references from different contexts
        const contexts = references.map((r) => r.context);
        expect(contexts).toContain("select");
        expect(contexts).toContain("from");
        expect(contexts).toContain("where");
        expect(contexts).toContain("order_by");

        // All should have valid locations
        for (const ref of references) {
          expect(ref.line).toBeGreaterThan(0);
          expect(ref.column).toBeGreaterThan(0);
        }
      }
    });

    it("should track locations for JOIN clauses", async () => {
      const sql = `
        SELECT u.name, o.total
        FROM users u
        JOIN orders o ON u.id = o.user_id
      `;
      const result = await parser.parse(sql, { state });

      expect(result.success).toBe(true);
      if (result.success && result.ast) {
        const references = await parser.extractReferences(result.ast);

        expect(references.length).toBeGreaterThan(0);

        // Should have join context references
        const joinRefs = references.filter((r) => r.context === "join");
        expect(joinRefs.length).toBeGreaterThan(0);

        for (const ref of joinRefs) {
          expect(ref.line).toBeGreaterThan(0);
          expect(ref.column).toBeGreaterThan(0);
        }
      }
    });
  });

  describe("Error Message Quality", () => {
    it("should provide clear error messages", async () => {
      const sql = "SELECT nonexistent FROM users";
      const errors = await parser.validateSql(sql, { state });

      expect(errors.length).toBeGreaterThan(0);

      const columnError = errors.find((e) =>
        e.message.includes("Column 'nonexistent' does not exist"),
      );
      expect(columnError).toBeDefined();
      expect(columnError?.message).toContain("Column 'nonexistent' does not exist");
      expect(columnError?.message).toContain("users");
    });

    it("should provide clear error messages for aliased tables", async () => {
      const sql = "SELECT u.nonexistent FROM users as u";
      const errors = await parser.validateSql(sql, { state });

      expect(errors.length).toBeGreaterThan(0);

      const columnError = errors.find((e) =>
        e.message.includes("Column 'nonexistent' does not exist"),
      );
      expect(columnError).toBeDefined();
      expect(columnError?.message).toContain("Column 'nonexistent' does not exist");
      expect(columnError?.message).toContain("u"); // Should mention the alias
    });

    it("should provide clear error messages for missing tables", async () => {
      const sql = "SELECT name FROM nonexistent";
      const errors = await parser.validateSql(sql, { state });

      expect(errors.length).toBeGreaterThan(0);

      const tableError = errors.find((e) =>
        e.message.includes("Table 'nonexistent' does not exist"),
      );
      expect(tableError).toBeDefined();
      expect(tableError?.message).toContain("Table 'nonexistent' does not exist");
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty queries gracefully", async () => {
      const sql = "";
      const result = await parser.parse(sql, { state });

      // Should not crash, but may not succeed
      expect(result).toBeDefined();
    });

    it("should handle queries with only whitespace", async () => {
      const sql = "   \n   \t   ";
      const result = await parser.parse(sql, { state });

      // Should not crash
      expect(result).toBeDefined();
    });

    it("should handle malformed SQL gracefully", async () => {
      const sql = "SELECT * FROM";
      const result = await parser.parse(sql, { state });

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);

      // Should still provide location information if possible
      for (const error of result.errors) {
        expect(error.line).toBeGreaterThan(0);
        expect(error.column).toBeGreaterThan(0);
      }
    });
  });
});
