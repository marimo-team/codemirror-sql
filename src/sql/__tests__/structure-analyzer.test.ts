import { EditorState } from "@codemirror/state";
import { beforeEach, describe, expect, it } from "vitest";
import { NodeSqlParser } from "../parser.js";
import { SqlStructureAnalyzer } from "../structure-analyzer.js";

describe("SqlStructureAnalyzer", () => {
  let analyzer: SqlStructureAnalyzer;
  let state: EditorState;

  beforeEach(() => {
    analyzer = new SqlStructureAnalyzer(new NodeSqlParser());
  });

  const createState = (content: string) => {
    return EditorState.create({ doc: content });
  };

  describe("analyzeDocument", () => {
    it("should identify single SQL statement", async () => {
      state = createState("SELECT * FROM users WHERE id = 1;");
      const statements = await analyzer.analyzeDocument(state);

      expect(statements).toHaveLength(1);
      expect(statements[0].content).toBe("SELECT * FROM users WHERE id = 1");
      expect(statements[0].type).toBe("select");
      expect(statements[0].isValid).toBe(true);
      expect(statements[0].lineFrom).toBe(1);
      expect(statements[0].lineTo).toBe(1);
    });

    it("should identify multiple SQL statements", async () => {
      state = createState(`
        SELECT * FROM users;
        INSERT INTO users (name) VALUES ('John');
        DELETE FROM users WHERE id = 1;
      `);
      const statements = await analyzer.analyzeDocument(state);

      expect(statements).toHaveLength(3);
      expect(statements[0].type).toBe("select");
      expect(statements[1].type).toBe("insert");
      expect(statements[2].type).toBe("delete");
    });

    it("should handle statements without semicolons", async () => {
      state = createState("SELECT * FROM users WHERE id = 1");
      const statements = await analyzer.analyzeDocument(state);

      expect(statements).toHaveLength(1);
      expect(statements[0].content).toBe("SELECT * FROM users WHERE id = 1");
      expect(statements[0].type).toBe("select");
    });

    it("should handle semicolons in string literals", async () => {
      state = createState(`SELECT 'Hello; World' FROM users; UPDATE users SET name = 'Test;';`);
      const statements = await analyzer.analyzeDocument(state);

      expect(statements).toHaveLength(2);
      expect(statements[0].content).toBe("SELECT 'Hello; World' FROM users");
      expect(statements[1].content).toBe("UPDATE users SET name = 'Test;'");
    });

    it("should determine correct statement types", () => {
      const testCases = [
        { sql: "SELECT * FROM users", expected: "select" },
        { sql: "INSERT INTO users VALUES (1)", expected: "insert" },
        { sql: "UPDATE users SET name = 'test'", expected: "update" },
        { sql: "DELETE FROM users", expected: "delete" },
        { sql: "CREATE TABLE users (id INT)", expected: "create" },
        { sql: "DROP TABLE users", expected: "drop" },
        { sql: "ALTER TABLE users ADD COLUMN email VARCHAR(255)", expected: "alter" },
        { sql: "USE database_name", expected: "use" },
        { sql: "SHOW TABLES", expected: "other" },
      ];

      testCases.forEach(async ({ sql, expected }) => {
        state = createState(`${sql};`);
        const statements = await analyzer.analyzeDocument(state);
        expect(statements[0].type).toBe(expected);
      });
    });

    it("should handle invalid SQL statements", async () => {
      state = createState("SELECT * FROM;");
      const statements = await analyzer.analyzeDocument(state);

      expect(statements).toHaveLength(1);
      expect(statements[0].isValid).toBe(false);
    });

    it("should cache results for identical content", async () => {
      const content = "SELECT * FROM users;";
      state = createState(content);

      const statements1 = await analyzer.analyzeDocument(state);
      const statements2 = await analyzer.analyzeDocument(state);

      expect(statements1).toBe(statements2); // Should be the same reference (cached)
    });
  });

  describe("getStatementAtPosition", () => {
    beforeEach(() => {
      state = createState(`SELECT * FROM users;
INSERT INTO users (name) VALUES ('John');
DELETE FROM users WHERE id = 1;`);
    });

    it("should return correct statement for cursor position", async () => {
      const statement1 = await analyzer.getStatementAtPosition(state, 5); // Inside first SELECT
      const statement2 = await analyzer.getStatementAtPosition(state, 25); // Inside INSERT
      const statement3 = await analyzer.getStatementAtPosition(state, 80); // Inside DELETE

      expect(statement1?.type).toBe("select");
      expect(statement2?.type).toBe("insert");
      expect(statement3?.type).toBe("delete");
    });

    it("should return null for position outside any statement", async () => {
      state = createState("   \n\n   ");
      const statement = await analyzer.getStatementAtPosition(state, 2);
      expect(statement).toBeNull();
    });
  });

  describe("getStatementsInRange", () => {
    beforeEach(() => {
      state = createState(`SELECT * FROM users;
INSERT INTO users (name) VALUES ('John');
DELETE FROM users WHERE id = 1;`);
    });

    it("should return statements that intersect with range", async () => {
      const statements = await analyzer.getStatementsInRange(state, 0, 50);
      expect(statements).toHaveLength(2); // SELECT and INSERT
      expect(statements[0].type).toBe("select");
      expect(statements[1].type).toBe("insert");
    });

    it("should return single statement when range is within one statement", async () => {
      const statements = await analyzer.getStatementsInRange(state, 5, 10);
      expect(statements).toHaveLength(1);
      expect(statements[0].type).toBe("select");
    });

    it("should return all statements when range covers entire document", async () => {
      const statements = await analyzer.getStatementsInRange(state, 0, state.doc.toString().length);
      expect(statements).toHaveLength(3);
    });
  });

  describe("clearCache", () => {
    it("should clear internal cache", async () => {
      state = createState("SELECT * FROM users;");

      // Populate cache
      await analyzer.analyzeDocument(state);

      // Clear cache
      analyzer.clearCache();

      // Should re-analyze (though we can't directly test this, we ensure no errors)
      const statements = await analyzer.analyzeDocument(state);
      expect(statements).toHaveLength(1);
    });
  });

  describe("multiline statements", () => {
    it("should handle statements spanning multiple lines", async () => {
      state = createState(`SELECT u.id,
       u.name,
       u.email
FROM users u
WHERE u.active = true
  AND u.created_at > '2023-01-01';`);

      const statements = await analyzer.analyzeDocument(state);
      expect(statements).toHaveLength(1);
      expect(statements[0].lineFrom).toBe(1);
      expect(statements[0].lineTo).toBe(6);
      expect(statements[0].type).toBe("select");
    });
  });

  describe("comment handling", () => {
    describe("single-line comments (--)", () => {
      it("should strip single-line comments from statement content", async () => {
        state = createState("SELECT * FROM users -- this is a comment\nWHERE id = 1;");
        const statements = await analyzer.analyzeDocument(state);

        expect(statements).toHaveLength(1);
        expect(statements[0].content).toBe("SELECT * FROM users \nWHERE id = 1");
        expect(statements[0].type).toBe("select");
      });

      it("should handle single-line comment at end of statement", async () => {
        state = createState("SELECT * FROM users WHERE id = 1; -- comment");
        const statements = await analyzer.analyzeDocument(state);

        expect(statements).toHaveLength(1);
        expect(statements[0].content).toBe("SELECT * FROM users WHERE id = 1");
      });

      it("should handle statement that is entirely a comment", async () => {
        state = createState("-- This is just a comment\nSELECT * FROM users;");
        const statements = await analyzer.analyzeDocument(state);

        expect(statements).toHaveLength(1);
        expect(statements[0].content).toBe("SELECT * FROM users");
        expect(statements[0].type).toBe("select");
      });

      it("should handle multiple single-line comments", async () => {
        state = createState(`
          -- First comment
          SELECT * FROM users -- inline comment
          -- Another comment
          WHERE id = 1; -- final comment
        `);
        const statements = await analyzer.analyzeDocument(state);

        expect(statements).toHaveLength(1);
        expect(statements[0].content.trim()).toBe(
          "SELECT * FROM users \n          \n          WHERE id = 1",
        );
      });
    });

    describe("multi-line comments (/* */)", () => {
      it("should strip multi-line comments from statement content", async () => {
        state = createState("SELECT * FROM users /* this is a comment */ WHERE id = 1;");
        const statements = await analyzer.analyzeDocument(state);

        expect(statements).toHaveLength(1);
        expect(statements[0].content).toBe("SELECT * FROM users  WHERE id = 1");
        expect(statements[0].type).toBe("select");
      });

      it("should handle multi-line comments spanning multiple lines", async () => {
        state = createState(`SELECT * FROM users /*
          This is a multi-line
          comment that spans
          several lines
        */ WHERE id = 1;`);
        const statements = await analyzer.analyzeDocument(state);

        expect(statements).toHaveLength(1);
        expect(statements[0].content).toBe("SELECT * FROM users  WHERE id = 1");
      });

      it("should handle nested-like comment patterns", async () => {
        state = createState("SELECT * FROM users /* comment /* nested */ text */ WHERE id = 1;");
        const statements = await analyzer.analyzeDocument(state);

        expect(statements).toHaveLength(1);
        expect(statements[0].content).toBe("SELECT * FROM users  text */ WHERE id = 1");
      });
    });

    describe("comments in string literals", () => {
      it("should not strip comment patterns inside string literals", async () => {
        state = createState("SELECT 'This -- is not a comment' FROM users;");
        const statements = await analyzer.analyzeDocument(state);

        expect(statements).toHaveLength(1);
        expect(statements[0].content).toBe("SELECT 'This -- is not a comment' FROM users");
      });

      it("should not strip multi-line comment patterns inside string literals", async () => {
        state = createState("SELECT 'This /* is not */ a comment' FROM users;");
        const statements = await analyzer.analyzeDocument(state);

        expect(statements).toHaveLength(1);
        expect(statements[0].content).toBe("SELECT 'This /* is not */ a comment' FROM users");
      });

      it("should handle mixed real comments and string literal comment patterns", async () => {
        state = createState(
          "SELECT 'Text -- not comment' FROM users -- real comment\nWHERE id = 1;",
        );
        const statements = await analyzer.analyzeDocument(state);

        expect(statements).toHaveLength(1);
        expect(statements[0].content).toBe(
          "SELECT 'Text -- not comment' FROM users \nWHERE id = 1",
        );
      });
    });

    describe("mixed comments and statements", () => {
      it("should handle statements separated by comments", async () => {
        state = createState(`
          SELECT * FROM users; -- First query
          /* Comment between queries */
          INSERT INTO users (name) VALUES ('John'); -- Second query
        `);
        const statements = await analyzer.analyzeDocument(state);

        expect(statements).toHaveLength(2);
        expect(statements[0].content.trim()).toBe("SELECT * FROM users");
        expect(statements[0].type).toBe("select");
        expect(statements[1].content.trim()).toBe("INSERT INTO users (name) VALUES ('John')");
        expect(statements[1].type).toBe("insert");
      });

      it("should not create statements from comment-only content", async () => {
        state = createState(`
          -- Just a comment
          /* Another comment */
          SELECT * FROM users;
          -- Final comment
        `);
        const statements = await analyzer.analyzeDocument(state);

        expect(statements).toHaveLength(1);
        expect(statements[0].type).toBe("select");
      });

      it("should handle semicolons in comments", async () => {
        state = createState(`
          SELECT * FROM users; -- Comment with; semicolon
          /* Multi-line comment with;
             semicolon; on multiple; lines */
          INSERT INTO logs VALUES (1);
        `);
        const statements = await analyzer.analyzeDocument(state);

        expect(statements).toHaveLength(2);
        expect(statements[0].type).toBe("select");
        expect(statements[1].type).toBe("insert");
      });
    });
  });

  describe("error detection and validation", () => {
    it("should detect syntax errors in statements", async () => {
      state = createState("SELECT * FROM;");
      const statements = await analyzer.analyzeDocument(state);

      expect(statements).toHaveLength(1);
      expect(statements[0].isValid).toBe(false);
      expect(statements[0].type).toBe("select");
    });

    it("should detect missing table name errors", async () => {
      state = createState("SELECT * FROM;");
      const statements = await analyzer.analyzeDocument(state);

      expect(statements).toHaveLength(1);
      expect(statements[0].isValid).toBe(false);
    });

    it("should detect typo errors in keywords", async () => {
      state = createState("SELECT * FORM users;");
      const statements = await analyzer.analyzeDocument(state);

      expect(statements).toHaveLength(1);
      expect(statements[0].isValid).toBe(false);
    });

    it("should detect missing table name in INSERT", async () => {
      state = createState("INSERT INTO VALUES (1, 2);");
      const statements = await analyzer.analyzeDocument(state);

      expect(statements).toHaveLength(1);
      expect(statements[0].isValid).toBe(false);
      expect(statements[0].type).toBe("insert");
    });

    it("should detect missing table name in UPDATE", async () => {
      state = createState("UPDATE SET name = 'test';");
      const statements = await analyzer.analyzeDocument(state);

      expect(statements).toHaveLength(1);
      expect(statements[0].isValid).toBe(false);
      expect(statements[0].type).toBe("update");
    });

    it("should detect invalid column references", async () => {
      // Create analyzer with schema to detect column validation errors
      const schema = {
        users: ["id", "name", "email", "active"],
      };
      const analyzerWithSchema = new SqlStructureAnalyzer(new NodeSqlParser({ schema }));

      state = createState("SELECT invalid_column FROM users;");
      const statements = await analyzerWithSchema.analyzeDocument(state);

      expect(statements).toHaveLength(1);
      expect(statements[0].isValid).toBe(false);
    });

    it("should detect invalid table references", async () => {
      // Create analyzer with schema to detect table validation errors
      const schema = {
        users: ["id", "name", "email", "active"],
      };
      const analyzerWithSchema = new SqlStructureAnalyzer(new NodeSqlParser({ schema }));

      state = createState("SELECT * FROM non_existent_table;");
      const statements = await analyzerWithSchema.analyzeDocument(state);

      expect(statements).toHaveLength(1);
      expect(statements[0].isValid).toBe(false);
    });

    it("should handle mixed valid and invalid statements", async () => {
      state = createState(`
        SELECT * FROM users; -- Valid
        SELECT * FROM; -- Invalid
        INSERT INTO users (name) VALUES ('John'); -- Valid
        UPDATE SET name = 'test'; -- Invalid
      `);
      const statements = await analyzer.analyzeDocument(state);

      expect(statements).toHaveLength(4);
      expect(statements[0].isValid).toBe(true);
      expect(statements[1].isValid).toBe(false);
      expect(statements[2].isValid).toBe(true);
      expect(statements[3].isValid).toBe(false);
    });

    it("should detect errors in complex multi-line statements", async () => {
      // Create analyzer with schema to detect column validation errors
      const schema = {
        users: ["id", "name", "email", "active"],
      };
      const analyzerWithSchema = new SqlStructureAnalyzer(new NodeSqlParser({ schema }));

      state = createState(`
        SELECT u.id,
               u.name,
               u.email
        FROM users u
        WHERE u.active = true
          AND u.invalid_column > 100;
      `);
      const statements = await analyzerWithSchema.analyzeDocument(state);

      expect(statements).toHaveLength(1);
      expect(statements[0].isValid).toBe(false);
      expect(statements[0].lineFrom).toBeGreaterThan(0);
      expect(statements[0].lineTo).toBeGreaterThan(statements[0].lineFrom);
    });

    it("should detect errors in subqueries", async () => {
      // Create analyzer with schema to detect table validation errors
      const schema = {
        orders: ["customer_id", "order_date", "total_amount"],
      };
      const analyzerWithSchema = new SqlStructureAnalyzer(new NodeSqlParser({ schema }));

      state = createState(`
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
      `);
      const statements = await analyzerWithSchema.analyzeDocument(state);

      expect(statements).toHaveLength(1);
      expect(statements[0].isValid).toBe(false);
    });

    it("should detect errors in JOIN clauses", async () => {
      // Create analyzer with schema to detect table validation errors
      const schema = {
        users: ["id", "name"],
        posts: ["id", "title", "user_id"],
      };
      const analyzerWithSchema = new SqlStructureAnalyzer(new NodeSqlParser({ schema }));

      state = createState(`
        SELECT u.name, p.title
        FROM users u
        JOIN posts p ON u.id = p.user_id
        JOIN non_existent_table n ON p.id = n.post_id;
      `);
      const statements = await analyzerWithSchema.analyzeDocument(state);

      expect(statements).toHaveLength(1);
      expect(statements[0].isValid).toBe(false);
    });

    it("should detect errors in CTE statements", async () => {
      // Create analyzer with schema to detect table validation errors
      const schema = {
        users: ["id", "name"],
      };
      const analyzerWithSchema = new SqlStructureAnalyzer(new NodeSqlParser({ schema }));

      state = createState(`
        WITH cte_name AS (
          SELECT * FROM non_existent_table
        )
        SELECT * FROM cte_name;
      `);
      const statements = await analyzerWithSchema.analyzeDocument(state);

      expect(statements).toHaveLength(1);
      expect(statements[0].isValid).toBe(false);
    });

    it("should handle valid statements with schema validation", async () => {
      // Create analyzer with schema
      const schema = {
        users: ["id", "name", "email", "active"],
        posts: ["id", "title", "user_id"],
      };
      const analyzerWithSchema = new SqlStructureAnalyzer(new NodeSqlParser({ schema }));

      state = createState("SELECT id, name, email FROM users WHERE active = true;");
      const statements = await analyzerWithSchema.analyzeDocument(state);

      expect(statements).toHaveLength(1);
      expect(statements[0].isValid).toBe(true);
    });

    it("should detect schema validation errors", async () => {
      // Create analyzer with schema
      const schema = {
        users: ["id", "name", "email", "active"],
        posts: ["id", "title", "user_id"],
      };
      const analyzerWithSchema = new SqlStructureAnalyzer(new NodeSqlParser({ schema }));

      state = createState("SELECT invalid_column FROM users;");
      const statements = await analyzerWithSchema.analyzeDocument(state);

      expect(statements).toHaveLength(1);
      expect(statements[0].isValid).toBe(false);
    });

    it("should detect missing table errors in schema validation", async () => {
      // Create analyzer with schema
      const schema = {
        users: ["id", "name", "email", "active"],
        posts: ["id", "title", "user_id"],
      };
      const analyzerWithSchema = new SqlStructureAnalyzer(new NodeSqlParser({ schema }));

      state = createState("SELECT * FROM non_existent_table;");
      const statements = await analyzerWithSchema.analyzeDocument(state);

      expect(statements).toHaveLength(1);
      expect(statements[0].isValid).toBe(false);
    });

    it("should handle qualified column references with schema validation", async () => {
      // Create analyzer with schema
      const schema = {
        users: ["id", "name", "email", "active"],
        posts: ["id", "title", "user_id"],
      };
      const analyzerWithSchema = new SqlStructureAnalyzer(new NodeSqlParser({ schema }));

      state = createState(
        "SELECT u.id, u.name, p.title FROM users u JOIN posts p ON u.id = p.user_id;",
      );
      const statements = await analyzerWithSchema.analyzeDocument(state);

      expect(statements).toHaveLength(1);
      expect(statements[0].isValid).toBe(true);
    });

    it("should detect errors in qualified column references", async () => {
      // Create analyzer with schema
      const schema = {
        users: ["id", "name", "email", "active"],
        posts: ["id", "title", "user_id"],
      };
      const analyzerWithSchema = new SqlStructureAnalyzer(new NodeSqlParser({ schema }));

      state = createState("SELECT u.invalid_column FROM users u;");
      const statements = await analyzerWithSchema.analyzeDocument(state);

      expect(statements).toHaveLength(1);
      expect(statements[0].isValid).toBe(false);
    });
  });
});
