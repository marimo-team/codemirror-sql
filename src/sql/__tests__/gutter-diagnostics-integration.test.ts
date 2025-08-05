import { EditorState, Text } from "@codemirror/state";
import { beforeEach, describe, expect, it } from "vitest";
import { sqlLinter } from "../diagnostics.js";
import { NodeSqlParser } from "../parser.js";
import { sqlStructureGutter } from "../structure-extension.js";

describe("Gutter and Diagnostics Integration", () => {
  let parser: NodeSqlParser;

  beforeEach(() => {
    parser = new NodeSqlParser({
      schema: {
        users: ["id", "name", "email", "active"],
        posts: ["id", "title", "user_id"],
        orders: ["id", "customer_id", "order_date", "total_amount"],
      },
    });
  });

  const createState = (content: string) => {
    return EditorState.create({
      doc: Text.of(content.split("\n")),
      extensions: [sqlLinter({ parser }), sqlStructureGutter({ parser })],
    });
  };

  describe("error detection consistency", () => {
    it("should detect syntax errors consistently between gutter and diagnostics", async () => {
      const content = "SELECT * FROM;";

      // Test diagnostics directly
      const errors = await parser.validateSql(content, { state: createState(content) });

      expect(errors).toHaveLength(1);
      expect(errors[0].severity).toBe("error");
      expect(errors[0].message).toContain("unexpected token");
    });

    it("should detect schema validation errors consistently", async () => {
      const content = "SELECT invalid_column FROM users;";

      const errors = await parser.validateSql(content, { state: createState(content) });

      expect(errors).toHaveLength(1);
      expect(errors[0].severity).toBe("error");
      expect(errors[0].message).toContain("does not exist");
    });

    it("should detect missing table errors consistently", async () => {
      const content = "SELECT * FROM non_existent_table;";

      const errors = await parser.validateSql(content, { state: createState(content) });

      expect(errors.length).toBeGreaterThan(0);
      expect(errors.every((e) => e.severity === "error")).toBe(true);
      expect(errors.some((e) => e.message.includes("does not exist"))).toBe(true);
    });

    it("should handle mixed valid and invalid statements", async () => {
      const content = `
        SELECT * FROM users; -- Valid
        SELECT * FROM; -- Invalid
        INSERT INTO users (name) VALUES ('John'); -- Valid
        UPDATE SET name = 'test'; -- Invalid
      `;

      const errors = await parser.validateSql(content, { state: createState(content) });

      // Should have errors for the invalid statements
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.every((e) => e.severity === "error")).toBe(true);
    });

    it("should detect errors in complex queries", async () => {
      const content = `
        SELECT u.id,
               u.name,
               u.email
        FROM users u
        WHERE u.active = true
          AND u.invalid_column > 100;
      `;

      const errors = await parser.validateSql(content, { state: createState(content) });

      expect(errors).toHaveLength(1);
      expect(errors[0].severity).toBe("error");
      expect(errors[0].message).toContain("does not exist");
    });

    it("should detect errors in JOIN clauses", async () => {
      const content = `
        SELECT u.name, p.title
        FROM users u
        JOIN posts p ON u.id = p.user_id
        JOIN non_existent_table n ON p.id = n.post_id;
      `;

      const errors = await parser.validateSql(content, { state: createState(content) });

      expect(errors.length).toBeGreaterThan(0);
      expect(errors.every((e) => e.severity === "error")).toBe(true);
      expect(errors.some((e) => e.message.includes("does not exist"))).toBe(true);
    });

    it("should detect errors in subqueries", async () => {
      const content = `
        SELECT customer_id,
               order_date,
               total_amount
        FROM orders
        WHERE order_date >= '2024-01-01'
          AND total_amount > (
            SELECT AVG(total_amount) * 0.8
            FROM non_existent_table
            WHERE YEAR(order_date) = 2024
          );
      `;

      const errors = await parser.validateSql(content, { state: createState(content) });

      expect(errors).toHaveLength(1);
      expect(errors[0].severity).toBe("error");
      expect(errors[0].message).toContain("does not exist");
    });

    it("should handle valid statements without errors", async () => {
      const content = `
        SELECT id, name, email FROM users WHERE active = true;
        INSERT INTO users (name, email) VALUES ('John', 'john@example.com');
        UPDATE users SET active = false WHERE id = 1;
      `;

      const errors = await parser.validateSql(content, { state: createState(content) });

      // All statements should be valid
      expect(errors).toHaveLength(0);
    });

    it("should handle qualified column references correctly", async () => {
      const content = `
        SELECT u.id, u.name, p.title 
        FROM users u 
        JOIN posts p ON u.id = p.user_id;
      `;

      const errors = await parser.validateSql(content, { state: createState(content) });

      // Should be valid with proper schema
      expect(errors).toHaveLength(0);
    });

    it("should detect errors in qualified column references", async () => {
      const content = `
        SELECT u.invalid_column, p.title 
        FROM users u 
        JOIN posts p ON u.id = p.user_id;
      `;

      const errors = await parser.validateSql(content, { state: createState(content) });

      expect(errors).toHaveLength(1);
      expect(errors[0].severity).toBe("error");
      expect(errors[0].message).toContain("does not exist");
    });
  });

  describe("gutter marker behavior", () => {
    it("should create gutter extensions with error configuration", () => {
      const gutterExtensions = sqlStructureGutter({
        errorBackgroundColor: "#ef4444",
        showInvalid: true,
        parser,
      });

      expect(Array.isArray(gutterExtensions)).toBe(true);
      expect(gutterExtensions.length).toBe(4);
    });

    it("should handle gutter with schema validation", () => {
      const gutterExtensions = sqlStructureGutter({
        errorBackgroundColor: "#ef4444",
        showInvalid: true,
        parser,
      });

      expect(Array.isArray(gutterExtensions)).toBe(true);
      expect(gutterExtensions.length).toBe(4);
    });

    it("should configure gutter to show invalid statements", () => {
      const gutterExtensions = sqlStructureGutter({
        showInvalid: true,
        errorBackgroundColor: "#ff0000",
        parser,
      });

      expect(Array.isArray(gutterExtensions)).toBe(true);
      expect(gutterExtensions.length).toBe(4);
    });
  });
});
