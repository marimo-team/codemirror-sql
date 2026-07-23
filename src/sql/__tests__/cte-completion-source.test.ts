import type { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { cteCompletionSource } from "../cte-completion-source.js";

// Helper function to handle both sync and async completion results
async function getCompletionResult(context: CompletionContext) {
  const result = cteCompletionSource(context);
  if (result instanceof Promise) {
    return await result;
  }
  return result;
}

// Helper function to create a mock completion context
function createMockContext(doc: string, pos: number, explicit = false): CompletionContext {
  const state = EditorState.create({ doc });

  return {
    state,
    pos,
    explicit,
    matchBefore: (pattern: RegExp) => {
      const before = doc.slice(0, pos);

      // For word patterns, find the word at the end
      if (pattern.source === "\\w*" || pattern.source === "[\\w$]*") {
        const wordMatch = before.match(/([\w$]*)$/);
        if (!wordMatch) return null;

        const text = wordMatch[1] || "";
        const from = pos - text.length;
        return {
          from,
          to: pos,
          text,
        };
      }

      // For other patterns, use the original logic
      const match = before.match(pattern);
      if (!match) return null;

      const from = pos - match[0].length;
      return {
        from,
        to: pos,
        text: match[0],
      };
    },
    aborted: false,
  } as CompletionContext;
}

describe("cteCompletionSource", () => {
  describe("basic CTE detection", () => {
    it("should detect single CTE", async () => {
      const sql = `WITH user_stats AS (
        SELECT id, name FROM users
      )
      SELECT * FROM user_`;

      const context = createMockContext(sql, sql.length, true);
      const result = await getCompletionResult(context);

      expect(result).toBeTruthy();
      expect(result?.options).toHaveLength(1);
      expect(result?.options[0].label).toBe("user_stats");
      expect(result?.options[0].type).toBe("variable");
      expect(result?.options[0].info).toBe("Common Table Expression: user_stats");
    });

    it("should detect multiple CTEs", async () => {
      const sql = `WITH
        user_stats AS (SELECT id, name FROM users),
        post_counts AS (SELECT user_id, COUNT(*) as count FROM posts GROUP BY user_id)
      SELECT * FROM `;

      const context = createMockContext(sql, sql.length, true);
      const result = await getCompletionResult(context);

      expect(result).toBeTruthy();
      expect(result?.options).toHaveLength(2);

      const labels = result?.options.map((opt) => opt.label).sort();
      expect(labels).toEqual(["post_counts", "user_stats"]);
    });

    it("should detect RECURSIVE CTEs", async () => {
      const sql = `WITH RECURSIVE category_tree AS (
        SELECT id, name, parent_id FROM categories WHERE parent_id IS NULL
        UNION ALL
        SELECT c.id, c.name, c.parent_id
        FROM categories c
        JOIN category_tree ct ON c.parent_id = ct.id
      )
      SELECT * FROM category_`;

      const context = createMockContext(sql, sql.length, true);
      const result = await getCompletionResult(context);

      expect(result).toBeTruthy();
      expect(result?.options).toHaveLength(1);
      expect(result?.options[0].label).toBe("category_tree");
    });
  });

  describe("CTE name patterns", () => {
    it("should handle CTEs with underscores", async () => {
      const sql = `WITH user_activity_stats AS (
        SELECT * FROM users
      )
      SELECT * FROM user_`;

      const context = createMockContext(sql, sql.length, true);
      const result = await getCompletionResult(context);

      expect(result).toBeTruthy();
      expect(result?.options[0].label).toBe("user_activity_stats");
    });

    it("should handle CTEs with numbers", async () => {
      const sql = `WITH stats2024 AS (
        SELECT * FROM users
      )
      SELECT * FROM stats`;

      const context = createMockContext(sql, sql.length, true);
      const result = await getCompletionResult(context);

      expect(result).toBeTruthy();
      expect(result?.options[0].label).toBe("stats2024");
    });

    it("should handle case-insensitive WITH keyword", async () => {
      const sql = `with user_data as (
        select * from users
      )
      select * from user_`;

      const context = createMockContext(sql, sql.length, true);
      const result = await getCompletionResult(context);

      expect(result).toBeTruthy();
      expect(result?.options[0].label).toBe("user_data");
    });
  });

  describe("complex SQL scenarios", () => {
    it("should detect CTEs in nested queries", async () => {
      const sql = `WITH outer_cte AS (
        WITH inner_cte AS (SELECT id FROM users)
        SELECT * FROM inner_cte
      )
      SELECT * FROM `;

      const context = createMockContext(sql, sql.length, true);
      const result = await getCompletionResult(context);

      expect(result).toBeTruthy();
      expect(result?.options).toHaveLength(2);

      const labels = result?.options.map((opt) => opt.label).sort();
      expect(labels).toEqual(["inner_cte", "outer_cte"]);
    });

    it("should handle CTEs with complex subqueries", async () => {
      const sql = `WITH filtered_users AS (
        SELECT u.id, u.name
        FROM users u
        WHERE u.active = true
          AND u.created_at > (
            SELECT DATE_SUB(NOW(), INTERVAL 30 DAY)
          )
      )
      SELECT * FROM filtered_`;

      const context = createMockContext(sql, sql.length, true);
      const result = await getCompletionResult(context);

      expect(result).toBeTruthy();
      expect(result?.options[0].label).toBe("filtered_users");
    });

    it("scopes CTEs to the statement containing the cursor", async () => {
      const sql = `WITH first_cte AS (SELECT 1)
      SELECT * FROM first_cte;

      WITH second_cte AS (SELECT 2)
      SELECT * FROM `;

      const context = createMockContext(sql, sql.length, true);
      const result = await getCompletionResult(context);

      expect(result).toBeTruthy();
      // first_cte belongs to the previous statement and must not leak in
      expect(result?.options.map((opt) => opt.label)).toEqual(["second_cte"]);
    });

    it("offers the first statement's CTE when the cursor is in it", async () => {
      const sql = `WITH first_cte AS (SELECT 1)
      SELECT * FROM first_;

      WITH second_cte AS (SELECT 2)
      SELECT * FROM second_cte`;

      const pos = sql.indexOf("first_;") + "first_".length;
      const context = createMockContext(sql, pos, true);
      const result = await getCompletionResult(context);

      expect(result?.options.map((opt) => opt.label)).toEqual(["first_cte"]);
    });
  });

  describe("edge cases", () => {
    it("should return null when no CTEs are present", async () => {
      const sql = "SELECT * FROM users WHERE id = 1";
      const context = createMockContext(sql, sql.length, true);
      const result = await getCompletionResult(context);

      expect(result).toBeNull();
    });

    it("should return null when not in explicit mode and no word being typed", async () => {
      const sql = `WITH user_stats AS (SELECT * FROM users)
      SELECT * FROM `;

      const context = createMockContext(sql, sql.length, false); // explicit = false
      const result = await getCompletionResult(context);

      expect(result).toBeNull();
    });

    it("should handle incomplete CTEs gracefully", async () => {
      const sql = "WITH incomplete_cte AS SELECT * FROM users";
      const context = createMockContext(sql, sql.length, true);
      const result = await getCompletionResult(context);

      expect(result).toBeNull();
    });

    it("should handle empty document", async () => {
      const sql = "";
      const context = createMockContext(sql, 0, true);
      const result = await getCompletionResult(context);

      expect(result).toBeNull();
    });

    it("should deduplicate CTE names", async () => {
      const sql = `WITH user_stats AS (SELECT * FROM users)
      SELECT * FROM user_stats
      UNION ALL
      WITH user_stats AS (SELECT * FROM users)
      SELECT * FROM `;

      const context = createMockContext(sql, sql.length, true);
      const result = await getCompletionResult(context);

      expect(result).toBeTruthy();
      expect(result?.options).toHaveLength(1);
      expect(result?.options[0].label).toBe("user_stats");
    });
  });

  describe("completion context", () => {
    it("should respect word boundaries", async () => {
      const sql = `WITH user_stats AS (SELECT * FROM users)
      SELECT * FROM user_st`;

      const context = createMockContext(sql, sql.length, true);
      const result = await getCompletionResult(context);

      expect(result).toBeTruthy();
      expect(result?.from).toBe(sql.lastIndexOf("user_st"));
      expect(result?.options[0].label).toBe("user_stats");
    });

    it("should provide correct completion metadata", async () => {
      const sql = `WITH my_cte AS (SELECT * FROM users)
      SELECT * FROM my_`;

      const context = createMockContext(sql, sql.length, true);
      const result = await getCompletionResult(context);

      expect(result).toBeTruthy();
      const completion = result?.options[0];

      expect(completion?.label).toBe("my_cte");
      expect(completion?.type).toBe("variable");
      expect(completion?.info).toBe("Common Table Expression: my_cte");
      expect(completion?.boost).toBe(10);
    });
  });

  describe("CTE bodies containing parentheses", () => {
    it("detects CTEs after a body with a function call", async () => {
      const sql = "WITH a AS (SELECT max(x) FROM t), b AS (SELECT 1) SELECT * FROM ";

      const context = createMockContext(sql, sql.length, true);
      const result = await getCompletionResult(context);

      const labels = result?.options.map((option) => option.label) ?? [];
      expect(labels).toContain("a");
      expect(labels).toContain("b");
    });

    it("detects CTEs after a body with a nested subquery", async () => {
      const sql =
        "WITH a AS (SELECT * FROM (SELECT 1) sub), b AS (SELECT 2), c AS (SELECT 3) SELECT * FROM ";

      const context = createMockContext(sql, sql.length, true);
      const result = await getCompletionResult(context);

      const labels = result?.options.map((option) => option.label) ?? [];
      expect(labels).toContain("a");
      expect(labels).toContain("b");
      expect(labels).toContain("c");
    });

    it("detects CTEs declared with a column list", async () => {
      const sql = "WITH a(x, y) AS (SELECT 1, 2), b AS (SELECT 3) SELECT * FROM ";

      const context = createMockContext(sql, sql.length, true);
      const result = await getCompletionResult(context);

      const labels = result?.options.map((option) => option.label) ?? [];
      expect(labels).toContain("a");
      expect(labels).toContain("b");
    });

    it("detects 3+ comma-separated CTEs with nested parens mid-edit", async () => {
      const sql =
        "WITH a AS (SELECT max(x) FROM (SELECT 1) s), b AS (SELECT count(*) FROM t), c AS (SELECT 3) SELECT * FROM ";

      const context = createMockContext(sql, sql.length, true);
      const result = await getCompletionResult(context);

      const labels = result?.options.map((option) => option.label) ?? [];
      expect(labels).toEqual(["a", "b", "c"]);
    });
  });

  describe("quoted CTE names", () => {
    it("detects quoted CTE names", async () => {
      const sql = `WITH "My Stats" AS (SELECT 1) SELECT * FROM `;

      const context = createMockContext(sql, sql.length, true);
      const result = await getCompletionResult(context);

      expect(result?.options.map((opt) => opt.label)).toEqual(["My Stats"]);
      expect(result?.options[0].apply).toBe('"My Stats"');
    });

    it("does not add an apply override for bare names", async () => {
      const sql = "WITH stats AS (SELECT 1) SELECT * FROM ";

      const context = createMockContext(sql, sql.length, true);
      const result = await getCompletionResult(context);

      expect(result?.options[0].apply).toBeUndefined();
    });

    it("completes names containing $ as one token", async () => {
      const sql = "WITH t$1 AS (SELECT 1) SELECT * FROM t$";

      const context = createMockContext(sql, sql.length, true);
      const result = await getCompletionResult(context);

      expect(result?.from).toBe(sql.lastIndexOf("t$"));
      expect(result?.options[0].label).toBe("t$1");
    });

    it("quotes non-bare column labels on apply", async () => {
      const sql = 'WITH t("My Col", b) AS (SELECT 1, 2) SELECT t. FROM t';
      const pos = sql.indexOf("t. FROM") + 2;

      const context = createMockContext(sql, pos, false);
      const result = await getCompletionResult(context);

      const myCol = result?.options.find((opt) => opt.label === "My Col");
      expect(myCol?.apply).toBe('"My Col"');
      expect(result?.options.find((opt) => opt.label === "b")?.apply).toBeUndefined();
    });
  });

  describe("CTE column completion", () => {
    it("completes columns after <cte>. from a declared column list", async () => {
      const sql = "WITH t(a, b) AS (SELECT 1, 2) SELECT t. FROM t";
      const pos = sql.indexOf("t. FROM") + 2;

      const context = createMockContext(sql, pos, false);
      const result = await getCompletionResult(context);

      expect(result).toBeTruthy();
      expect(result?.from).toBe(pos);
      expect(result?.options.map((opt) => opt.label)).toEqual(["a", "b"]);
      expect(result?.options[0].type).toBe("property");
      expect(result?.options[0].detail).toBe("column of t");
    });

    it("completes columns after <cte>. inferred from the select list", async () => {
      const sql = "WITH t AS (SELECT id, name AS n FROM users) SELECT t. FROM t";
      const pos = sql.indexOf("t. FROM") + 2;

      const context = createMockContext(sql, pos, false);
      const result = await getCompletionResult(context);

      expect(result?.options.map((opt) => opt.label)).toEqual(["id", "n"]);
    });

    it("offers no columns for a SELECT * CTE", async () => {
      const sql = "WITH t AS (SELECT * FROM users) SELECT t. FROM t";
      const pos = sql.indexOf("t. FROM") + 2;

      const context = createMockContext(sql, pos, false);
      const result = await getCompletionResult(context);

      expect(result).toBeNull();
    });

    it("does not complete columns for a multi-segment qualifier", async () => {
      const sql = "WITH t(a) AS (SELECT 1) SELECT db.t. FROM t";
      const pos = sql.indexOf("db.t. FROM") + "db.t.".length;

      const context = createMockContext(sql, pos, false);
      const result = await getCompletionResult(context);

      expect(result).toBeNull();
    });

    it("offers CTE columns unqualified in a column position", async () => {
      const sql = "WITH t(a, b) AS (SELECT 1, 2) SELECT  FROM t";
      const pos = sql.indexOf("SELECT  FROM") + "SELECT ".length;

      const context = createMockContext(sql, pos, true);
      const result = await getCompletionResult(context);

      const labels = result?.options.map((opt) => opt.label) ?? [];
      expect(labels).toContain("t");
      expect(labels).toContain("a");
      expect(labels).toContain("b");
    });

    it("does not offer columns right after FROM", async () => {
      const sql = "WITH t(a, b) AS (SELECT 1, 2) SELECT a FROM ";

      const context = createMockContext(sql, sql.length, true);
      const result = await getCompletionResult(context);

      expect(result?.options.map((opt) => opt.label)).toEqual(["t"]);
    });
  });
});
