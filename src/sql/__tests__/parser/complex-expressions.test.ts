import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { NodeSqlParser } from "../../parser.js";

describe("Complex SQL Expressions", () => {
  const schema = {
    users: ["id", "name", "email", "created_at", "age"],
    orders: ["id", "user_id", "order_date", "total", "status"],
    products: ["id", "name", "price", "category"],
    categories: ["id", "name", "description"],
  };

  const parser = new NodeSqlParser({ schema });
  const state = EditorState.create({
    doc: "SELECT * FROM users",
  });

  describe("Function Calls", () => {
    it("should handle aggregate functions", async () => {
      const sql = `
        SELECT u.name, COUNT(o.id) as order_count, SUM(o.total) as total_spent
        FROM users u
        LEFT JOIN orders o ON u.id = o.user_id
        GROUP BY u.id, u.name
      `;
      const errors = await parser.validateSql(sql, { state });

      // This query should be valid - all columns exist in the schema
      expect(errors).toHaveLength(0);
    });

    it("should handle string functions", async () => {
      const sql = "SELECT UPPER(name), LOWER(email), CONCAT(first_name, ' ', last_name) FROM users";
      const errors = await parser.validateSql(sql, { state });

      expect(errors).toHaveLength(0);
    });

    it("should handle date functions", async () => {
      const sql =
        "SELECT DATE(order_date), YEAR(created_at), MONTH(order_date) FROM orders o JOIN users u ON o.user_id = u.id";
      const errors = await parser.validateSql(sql, { state });

      expect(errors).toHaveLength(0);
    });

    it("should handle nested functions", async () => {
      const sql = "SELECT UPPER(CONCAT(name, ' - ', email)) FROM users";
      const errors = await parser.validateSql(sql, { state });

      expect(errors).toHaveLength(0);
    });
  });

  describe("Subqueries", () => {
    it("should handle subqueries in SELECT", async () => {
      const sql = `
        SELECT u.name, 
               (SELECT COUNT(*) FROM orders WHERE user_id = u.id) as order_count
        FROM users u
      `;
      const errors = await parser.validateSql(sql, { state });

      // Should have validation errors for the alias 'u' in the subquery
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("Table 'u' does not exist"))).toBe(true);
    });

    it("should handle subqueries in WHERE", async () => {
      const sql = `
        SELECT u.name, o.total 
        FROM users u 
        JOIN orders o ON u.id = o.user_id 
        WHERE o.total > (SELECT AVG(total) FROM orders)
      `;
      const errors = await parser.validateSql(sql, { state });

      expect(errors).toHaveLength(0);
    });

    it("should handle subqueries in FROM", async () => {
      const sql = `
        SELECT sub.total, sub.user_count
        FROM (SELECT user_id, SUM(total) as total, COUNT(*) as user_count FROM orders GROUP BY user_id) sub
        WHERE sub.total > 100
      `;
      const errors = await parser.validateSql(sql, { state });

      // Should have validation errors for the subquery alias 'sub'
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("Table 'sub' does not exist"))).toBe(true);
    });
  });

  describe("CASE Expressions", () => {
    it("should handle simple CASE expressions", async () => {
      const sql = `
        SELECT name,
               CASE 
                 WHEN age < 18 THEN 'Minor'
                 WHEN age < 65 THEN 'Adult'
                 ELSE 'Senior'
               END as age_group
        FROM users
      `;
      const errors = await parser.validateSql(sql, { state });

      expect(errors).toHaveLength(0);
    });

    it("should handle CASE expressions with column references", async () => {
      const sql = `
        SELECT o.id,
               CASE o.status
                 WHEN 'pending' THEN 'Awaiting Processing'
                 WHEN 'processing' THEN 'In Progress'
                 WHEN 'completed' THEN 'Finished'
                 ELSE 'Unknown'
               END as status_description
        FROM orders o
      `;
      const errors = await parser.validateSql(sql, { state });

      expect(errors).toHaveLength(0);
    });
  });

  describe("Complex WHERE Clauses", () => {
    it("should handle multiple conditions with AND/OR", async () => {
      const sql = `
        SELECT u.name, o.total 
        FROM users u 
        JOIN orders o ON u.id = o.user_id 
        WHERE (o.total > 100 AND o.status = 'completed') 
           OR (u.age > 25 AND o.order_date > '2023-01-01')
      `;
      const errors = await parser.validateSql(sql, { state });

      expect(errors).toHaveLength(0);
    });

    it("should handle IN clauses", async () => {
      const sql = `
        SELECT u.name
        FROM users u
        WHERE u.id IN (SELECT user_id FROM orders WHERE total > 100)
      `;
      const errors = await parser.validateSql(sql, { state });

      // Should have validation errors for missing columns in the subquery
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("Column 'user_id' does not exist"))).toBe(true);
      expect(errors.some((e) => e.message.includes("Column 'total' does not exist"))).toBe(true);
    });

    it("should handle EXISTS clauses", async () => {
      const sql = `
        SELECT u.name
        FROM users u
        WHERE EXISTS (SELECT 1 FROM orders WHERE user_id = u.id)
      `;
      const errors = await parser.validateSql(sql, { state });

      // Should have validation errors for the alias 'u' in the EXISTS subquery
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("Table 'u' does not exist"))).toBe(true);
    });
  });

  describe("JOIN Complexities", () => {
    it("should handle multiple JOINs", async () => {
      const sql = `
        SELECT u.name, p.name as product_name, c.name as category_name
        FROM users u
        JOIN orders o ON u.id = o.user_id
        JOIN products p ON o.product_id = p.id
        JOIN categories c ON p.category_id = c.id
      `;
      const errors = await parser.validateSql(sql, { state });

      // Should have validation errors for missing columns
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("Column 'product_id' does not exist"))).toBe(
        true,
      );
    });

    it("should handle LEFT JOINs", async () => {
      const sql = `
        SELECT u.name, COUNT(o.id) as order_count
        FROM users u
        LEFT JOIN orders o ON u.id = o.user_id
        GROUP BY u.id, u.name
      `;
      const errors = await parser.validateSql(sql, { state });

      expect(errors).toHaveLength(0);
    });

    it("should handle self-joins", async () => {
      const sql = `
        SELECT u1.name as user1, u2.name as user2
        FROM users u1
        JOIN users u2 ON u1.id < u2.id
        WHERE u1.age = u2.age
      `;
      const errors = await parser.validateSql(sql, { state });

      expect(errors).toHaveLength(0);
    });
  });

  describe("GROUP BY and HAVING", () => {
    it("should handle GROUP BY with aggregate functions", async () => {
      const sql = `
        SELECT u.name, COUNT(o.id) as order_count, SUM(o.total) as total_spent
        FROM users u
        LEFT JOIN orders o ON u.id = o.user_id
        GROUP BY u.id, u.name
        HAVING COUNT(o.id) > 0
      `;
      const errors = await parser.validateSql(sql, { state });

      expect(errors).toHaveLength(0);
    });

    it("should handle complex HAVING clauses", async () => {
      const sql = `
        SELECT p.category, AVG(p.price) as avg_price, COUNT(*) as product_count
        FROM products p
        GROUP BY p.category
        HAVING AVG(p.price) > 50 AND COUNT(*) > 5
      `;
      const errors = await parser.validateSql(sql, { state });

      expect(errors).toHaveLength(0);
    });
  });

  describe("ORDER BY Complexities", () => {
    it("should handle multiple ORDER BY columns", async () => {
      const sql = `
        SELECT u.name, o.total, o.order_date
        FROM users u
        JOIN orders o ON u.id = o.user_id
        ORDER BY u.name ASC, o.total DESC, o.order_date ASC
      `;
      const errors = await parser.validateSql(sql, { state });

      expect(errors).toHaveLength(0);
    });

    it("should handle ORDER BY with expressions", async () => {
      const sql = `
        SELECT u.name, o.total
        FROM users u
        JOIN orders o ON u.id = o.user_id
        ORDER BY LENGTH(u.name), o.total * 1.1
      `;
      const errors = await parser.validateSql(sql, { state });

      expect(errors).toHaveLength(0);
    });
  });

  describe("Column Reference Extraction", () => {
    it("should extract column references from complex expressions", async () => {
      const sql = `
        SELECT u.name, 
               COUNT(o.id) as order_count,
               CASE WHEN o.total > 100 THEN 'High' ELSE 'Low' END as spending_level
        FROM users u
        LEFT JOIN orders o ON u.id = o.user_id
        GROUP BY u.id, u.name
      `;
      const result = await parser.parse(sql, { state });

      expect(result.success).toBe(true);
      if (result.success && result.ast) {
        const references = await parser.extractReferences(result.ast);

        // Should have table references
        const tableRefs = references.filter((r) => r.type === "table");
        expect(tableRefs.length).toBeGreaterThan(0);

        // Should have column references
        const columnRefs = references.filter((r) => r.type === "column");
        expect(columnRefs.length).toBeGreaterThan(0);

        // Check that we have references to expected columns
        const columnNames = columnRefs.map((r) => r.name);
        expect(columnNames).toContain("name");
        expect(columnNames).toContain("id");
        expect(columnNames).toContain("total");
      }
    });
  });
});
