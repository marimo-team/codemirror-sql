import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { NodeSqlParser } from "../../parser.js";

describe("Table Alias Parsing", () => {
  const schema = {
    users: ["id", "name", "email", "created_at"],
    orders: ["id", "user_id", "order_date", "total"],
    products: ["id", "name", "price", "category"],
  };

  const parser = new NodeSqlParser({ schema });
  const state = EditorState.create({
    doc: "SELECT * FROM users",
  });

  describe("Basic Alias Support", () => {
    it("should handle simple table aliases", async () => {
      const sql = "SELECT u.name FROM users as u";
      const errors = await parser.validateSql(sql, { state });

      expect(errors).toHaveLength(0);
    });

    it("should handle aliases without 'as' keyword", async () => {
      const sql = "SELECT u.name FROM users u";
      const errors = await parser.validateSql(sql, { state });

      expect(errors).toHaveLength(0);
    });

    it("should handle multiple table aliases", async () => {
      const sql = "SELECT u.name, o.order_date FROM users u, orders o WHERE u.id = o.user_id";
      const errors = await parser.validateSql(sql, { state });

      expect(errors).toHaveLength(0);
    });

    it("should handle aliases in JOIN clauses", async () => {
      const sql = "SELECT u.name, o.order_date FROM users u JOIN orders o ON u.id = o.user_id";
      const errors = await parser.validateSql(sql, { state });

      expect(errors).toHaveLength(0);
    });
  });

  describe("Column Validation with Aliases", () => {
    it("should detect missing columns in aliased tables", async () => {
      const sql = "SELECT u.nonexistent FROM users as u";
      const errors = await parser.validateSql(sql, { state });

      expect(errors.length).toBeGreaterThan(0);
      expect(
        errors.some((error) => error.message.includes("Column 'nonexistent' does not exist")),
      ).toBe(true);
    });

    it("should validate columns exist in the correct aliased table", async () => {
      const sql = "SELECT u.name, o.total FROM users u, orders o WHERE u.id = o.user_id";
      const errors = await parser.validateSql(sql, { state });

      expect(errors).toHaveLength(0);
    });

    it("should handle ambiguous column references", async () => {
      const sql = "SELECT id FROM users u, orders o WHERE u.id = o.user_id";
      const errors = await parser.validateSql(sql, { state });

      // This should work since both tables have 'id' column
      expect(errors).toHaveLength(0);
    });
  });

  describe("Complex Alias Scenarios", () => {
    it("should handle subqueries with aliases", async () => {
      const sql = `
        SELECT u.name, sub.total 
        FROM users u 
        JOIN (SELECT user_id, SUM(total) as total FROM orders GROUP BY user_id) sub 
        ON u.id = sub.user_id
      `;
      const errors = await parser.validateSql(sql, { state });

      // Should have table validation errors for subquery since 'sub' is not a real table
      expect(errors.filter((e) => e.message.includes("Table 'sub' does not exist"))).toHaveLength(
        2,
      );
    });

    it("should handle multiple joins with aliases", async () => {
      const sql = `
        SELECT u.name, p.name as product_name, o.order_date 
        FROM users u 
        JOIN orders o ON u.id = o.user_id 
        JOIN products p ON o.product_id = p.id
      `;
      const errors = await parser.validateSql(sql, { state });

      // Should have validation errors for missing columns
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("Column 'product_id' does not exist"))).toBe(
        true,
      );
    });

    it("should handle self-joins with aliases", async () => {
      const sql = `
        SELECT u1.name as user1, u2.name as user2 
        FROM users u1 
        JOIN users u2 ON u1.id < u2.id
      `;
      const errors = await parser.validateSql(sql, { state });

      expect(errors).toHaveLength(0);
    });
  });

  describe("Context Extraction with Aliases", () => {
    it("should extract correct table names from aliased queries", async () => {
      const sql = "SELECT u.name, o.total FROM users u, orders o";
      const result = await parser.parse(sql, { state });

      expect(result.success).toBe(true);
      if (result.success && result.ast) {
        const context = await parser.extractContext(result.ast);

        expect(context.tables).toContain("users");
        expect(context.tables).toContain("orders");
        expect(context.aliases.get("u")).toBe("users");
        expect(context.aliases.get("o")).toBe("orders");
      }
    });

    it("should handle references with proper alias resolution", async () => {
      const sql = "SELECT u.name FROM users as u WHERE u.email = 'test@example.com'";
      const result = await parser.parse(sql, { state });

      expect(result.success).toBe(true);
      if (result.success && result.ast) {
        const references = await parser.extractReferences(result.ast);

        // Should have table reference for 'users'
        const tableRefs = references.filter((r) => r.type === "table");
        expect(tableRefs).toHaveLength(1);
        expect(tableRefs[0].name).toBe("users");

        // Should have column references with resolved table names
        const columnRefs = references.filter((r) => r.type === "column");
        expect(columnRefs.length).toBeGreaterThan(0);

        for (const ref of columnRefs) {
          expect(ref.tableName).toBe("users"); // Should be resolved from alias
          expect(ref.tableAlias).toBe("u"); // Should preserve original alias
        }
      }
    });
  });

  describe("Error Handling with Aliases", () => {
    it("should report errors with alias names in messages", async () => {
      const sql = "SELECT u.nonexistent FROM users as u";
      const errors = await parser.validateSql(sql, { state });

      expect(errors.length).toBeGreaterThan(0);
      const columnError = errors.find((e) =>
        e.message.includes("Column 'nonexistent' does not exist"),
      );
      expect(columnError).toBeDefined();
      expect(columnError?.message).toContain("u"); // Should mention the alias
    });

    it("should handle non-existent aliased tables", async () => {
      const sql = "SELECT u.name FROM nonexistent as u";
      const errors = await parser.validateSql(sql, { state });

      expect(errors.length).toBeGreaterThan(0);
      const tableError = errors.find((e) =>
        e.message.includes("Table 'nonexistent' does not exist"),
      );
      expect(tableError).toBeDefined();
      // The error should mention the alias in the context, but the main error is about the table not existing
      expect(tableError?.message).toContain("nonexistent");
    });
  });
});
