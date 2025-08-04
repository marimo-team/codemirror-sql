import { EditorState } from "@codemirror/state";
import { beforeEach, describe, expect, it } from "vitest";
import { SqlParser } from "../parser.js";
import { SqlStructureAnalyzer } from "../structure-analyzer.js";

describe("SqlStructureAnalyzer", () => {
  let analyzer: SqlStructureAnalyzer;
  let state: EditorState;

  beforeEach(() => {
    const parser = new SqlParser({ dialect: "PostgresQL" });
    analyzer = new SqlStructureAnalyzer(parser);
  });

  const createState = (content: string) => {
    return EditorState.create({ doc: content });
  };

  describe("analyzeDocument", () => {
    it("should identify single SQL statement", () => {
      state = createState("SELECT * FROM users WHERE id = 1;");
      const statements = analyzer.analyzeDocument(state);

      expect(statements).toHaveLength(1);
      expect(statements[0].content).toBe("SELECT * FROM users WHERE id = 1");
      expect(statements[0].type).toBe("select");
      expect(statements[0].isValid).toBe(true);
      expect(statements[0].lineFrom).toBe(1);
      expect(statements[0].lineTo).toBe(1);
    });

    it("should identify multiple SQL statements", () => {
      state = createState(`
        SELECT * FROM users;
        INSERT INTO users (name) VALUES ('John');
        DELETE FROM users WHERE id = 1;
      `);
      const statements = analyzer.analyzeDocument(state);

      expect(statements).toHaveLength(3);
      expect(statements[0].type).toBe("select");
      expect(statements[1].type).toBe("insert");
      expect(statements[2].type).toBe("delete");
    });

    it("should handle statements without semicolons", () => {
      state = createState("SELECT * FROM users WHERE id = 1");
      const statements = analyzer.analyzeDocument(state);

      expect(statements).toHaveLength(1);
      expect(statements[0].content).toBe("SELECT * FROM users WHERE id = 1");
      expect(statements[0].type).toBe("select");
    });

    it("should handle semicolons in string literals", () => {
      state = createState(`SELECT 'Hello; World' FROM users; UPDATE users SET name = 'Test;';`);
      const statements = analyzer.analyzeDocument(state);

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

      testCases.forEach(({ sql, expected }) => {
        state = createState(`${sql};`);
        const statements = analyzer.analyzeDocument(state);
        expect(statements[0].type).toBe(expected);
      });
    });

    it("should handle invalid SQL statements", () => {
      state = createState("SELECT * FROM;");
      const statements = analyzer.analyzeDocument(state);

      expect(statements).toHaveLength(1);
      expect(statements[0].isValid).toBe(false);
    });

    it("should cache results for identical content", () => {
      const content = "SELECT * FROM users;";
      state = createState(content);

      const statements1 = analyzer.analyzeDocument(state);
      const statements2 = analyzer.analyzeDocument(state);

      expect(statements1).toBe(statements2); // Should be the same reference (cached)
    });
  });

  describe("getStatementAtPosition", () => {
    beforeEach(() => {
      state = createState(`SELECT * FROM users;
INSERT INTO users (name) VALUES ('John');
DELETE FROM users WHERE id = 1;`);
    });

    it("should return correct statement for cursor position", () => {
      const statement1 = analyzer.getStatementAtPosition(state, 5); // Inside first SELECT
      const statement2 = analyzer.getStatementAtPosition(state, 25); // Inside INSERT
      const statement3 = analyzer.getStatementAtPosition(state, 80); // Inside DELETE

      expect(statement1?.type).toBe("select");
      expect(statement2?.type).toBe("insert");
      expect(statement3?.type).toBe("delete");
    });

    it("should return null for position outside any statement", () => {
      state = createState("   \n\n   ");
      const statement = analyzer.getStatementAtPosition(state, 2);
      expect(statement).toBeNull();
    });
  });

  describe("getStatementsInRange", () => {
    beforeEach(() => {
      state = createState(`SELECT * FROM users;
INSERT INTO users (name) VALUES ('John');
DELETE FROM users WHERE id = 1;`);
    });

    it("should return statements that intersect with range", () => {
      const statements = analyzer.getStatementsInRange(state, 0, 50);
      expect(statements).toHaveLength(2); // SELECT and INSERT
      expect(statements[0].type).toBe("select");
      expect(statements[1].type).toBe("insert");
    });

    it("should return single statement when range is within one statement", () => {
      const statements = analyzer.getStatementsInRange(state, 5, 10);
      expect(statements).toHaveLength(1);
      expect(statements[0].type).toBe("select");
    });

    it("should return all statements when range covers entire document", () => {
      const statements = analyzer.getStatementsInRange(state, 0, state.doc.toString().length);
      expect(statements).toHaveLength(3);
    });
  });

  describe("clearCache", () => {
    it("should clear internal cache", () => {
      state = createState("SELECT * FROM users;");

      // Populate cache
      analyzer.analyzeDocument(state);

      // Clear cache
      analyzer.clearCache();

      // Should re-analyze (though we can't directly test this, we ensure no errors)
      const statements = analyzer.analyzeDocument(state);
      expect(statements).toHaveLength(1);
    });
  });

  describe("multiline statements", () => {
    it("should handle statements spanning multiple lines", () => {
      state = createState(`SELECT u.id,
       u.name,
       u.email
FROM users u
WHERE u.active = true
  AND u.created_at > '2023-01-01';`);

      const statements = analyzer.analyzeDocument(state);
      expect(statements).toHaveLength(1);
      expect(statements[0].lineFrom).toBe(1);
      expect(statements[0].lineTo).toBe(6);
      expect(statements[0].type).toBe("select");
    });
  });

  describe("comment handling", () => {
    describe("single-line comments (--)", () => {
      it("should strip single-line comments from statement content", () => {
        state = createState("SELECT * FROM users -- this is a comment\nWHERE id = 1;");
        const statements = analyzer.analyzeDocument(state);

        expect(statements).toHaveLength(1);
        expect(statements[0].content).toBe("SELECT * FROM users \nWHERE id = 1");
        expect(statements[0].type).toBe("select");
      });

      it("should handle single-line comment at end of statement", () => {
        state = createState("SELECT * FROM users WHERE id = 1; -- comment");
        const statements = analyzer.analyzeDocument(state);

        expect(statements).toHaveLength(1);
        expect(statements[0].content).toBe("SELECT * FROM users WHERE id = 1");
      });

      it("should handle statement that is entirely a comment", () => {
        state = createState("-- This is just a comment\nSELECT * FROM users;");
        const statements = analyzer.analyzeDocument(state);

        expect(statements).toHaveLength(1);
        expect(statements[0].content).toBe("SELECT * FROM users");
        expect(statements[0].type).toBe("select");
      });

      it("should handle multiple single-line comments", () => {
        state = createState(`
          -- First comment
          SELECT * FROM users -- inline comment
          -- Another comment
          WHERE id = 1; -- final comment
        `);
        const statements = analyzer.analyzeDocument(state);

        expect(statements).toHaveLength(1);
        expect(statements[0].content.trim()).toBe(
          "SELECT * FROM users \n          \n          WHERE id = 1",
        );
      });
    });

    describe("multi-line comments (/* */)", () => {
      it("should strip multi-line comments from statement content", () => {
        state = createState("SELECT * FROM users /* this is a comment */ WHERE id = 1;");
        const statements = analyzer.analyzeDocument(state);

        expect(statements).toHaveLength(1);
        expect(statements[0].content).toBe("SELECT * FROM users  WHERE id = 1");
        expect(statements[0].type).toBe("select");
      });

      it("should handle multi-line comments spanning multiple lines", () => {
        state = createState(`SELECT * FROM users /*
          This is a multi-line
          comment that spans
          several lines
        */ WHERE id = 1;`);
        const statements = analyzer.analyzeDocument(state);

        expect(statements).toHaveLength(1);
        expect(statements[0].content).toBe("SELECT * FROM users  WHERE id = 1");
      });

      it("should handle nested-like comment patterns", () => {
        state = createState("SELECT * FROM users /* comment /* nested */ text */ WHERE id = 1;");
        const statements = analyzer.analyzeDocument(state);

        expect(statements).toHaveLength(1);
        expect(statements[0].content).toBe("SELECT * FROM users  text */ WHERE id = 1");
      });
    });

    describe("comments in string literals", () => {
      it("should not strip comment patterns inside string literals", () => {
        state = createState("SELECT 'This -- is not a comment' FROM users;");
        const statements = analyzer.analyzeDocument(state);

        expect(statements).toHaveLength(1);
        expect(statements[0].content).toBe("SELECT 'This -- is not a comment' FROM users");
      });

      it("should not strip multi-line comment patterns inside string literals", () => {
        state = createState("SELECT 'This /* is not */ a comment' FROM users;");
        const statements = analyzer.analyzeDocument(state);

        expect(statements).toHaveLength(1);
        expect(statements[0].content).toBe("SELECT 'This /* is not */ a comment' FROM users");
      });

      it("should handle mixed real comments and string literal comment patterns", () => {
        state = createState(
          "SELECT 'Text -- not comment' FROM users -- real comment\nWHERE id = 1;",
        );
        const statements = analyzer.analyzeDocument(state);

        expect(statements).toHaveLength(1);
        expect(statements[0].content).toBe(
          "SELECT 'Text -- not comment' FROM users \nWHERE id = 1",
        );
      });
    });

    describe("mixed comments and statements", () => {
      it("should handle statements separated by comments", () => {
        state = createState(`
          SELECT * FROM users; -- First query
          /* Comment between queries */
          INSERT INTO users (name) VALUES ('John'); -- Second query
        `);
        const statements = analyzer.analyzeDocument(state);

        expect(statements).toHaveLength(2);
        expect(statements[0].content.trim()).toBe("SELECT * FROM users");
        expect(statements[0].type).toBe("select");
        expect(statements[1].content.trim()).toBe("INSERT INTO users (name) VALUES ('John')");
        expect(statements[1].type).toBe("insert");
      });

      it("should not create statements from comment-only content", () => {
        state = createState(`
          -- Just a comment
          /* Another comment */
          SELECT * FROM users;
          -- Final comment
        `);
        const statements = analyzer.analyzeDocument(state);

        expect(statements).toHaveLength(1);
        expect(statements[0].type).toBe("select");
      });

      it("should handle semicolons in comments", () => {
        state = createState(`
          SELECT * FROM users; -- Comment with; semicolon
          /* Multi-line comment with;
             semicolon; on multiple; lines */
          INSERT INTO logs VALUES (1);
        `);
        const statements = analyzer.analyzeDocument(state);

        expect(statements).toHaveLength(2);
        expect(statements[0].type).toBe("select");
        expect(statements[1].type).toBe("insert");
      });
    });
  });
});
