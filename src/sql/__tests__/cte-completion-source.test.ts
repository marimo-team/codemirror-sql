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

      // For \w* pattern, find the word at the end
      if (pattern.source === "\\w*") {
        const wordMatch = before.match(/(\w*)$/);
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

    it("should handle multiple WITH clauses in different statements", async () => {
      const sql = `WITH first_cte AS (SELECT 1)
      SELECT * FROM first_cte;

      WITH second_cte AS (SELECT 2)
      SELECT * FROM `;

      const context = createMockContext(sql, sql.length, true);
      const result = await getCompletionResult(context);

      expect(result).toBeTruthy();
      expect(result?.options).toHaveLength(2);

      const labels = result?.options.map((opt) => opt.label).sort();
      expect(labels).toEqual(["first_cte", "second_cte"]);
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
});
