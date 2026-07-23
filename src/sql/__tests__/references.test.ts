import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { findReferences, type SqlReferenceResult } from "../references.js";

/**
 * Resolves references at the position of `marker` in `sql` (the marker is the
 * substring whose first character the cursor is placed on; an occurrence
 * index selects which match).
 */
async function resolveAt(
  sql: string,
  marker: string,
  occurrence = 0,
): Promise<SqlReferenceResult | null> {
  let pos = -1;
  for (let i = 0; i <= occurrence; i++) {
    pos = sql.indexOf(marker, pos + 1);
  }
  if (pos < 0) {
    throw new Error(`marker ${marker} (occurrence ${occurrence}) not found`);
  }
  const state = EditorState.create({ doc: sql });
  return findReferences(state, pos);
}

function texts(sql: string, result: SqlReferenceResult): string[] {
  return result.references.map((range) => sql.slice(range.from, range.to));
}

describe("findReferences", () => {
  describe("CTE names", () => {
    const sql = "WITH recent AS (SELECT x FROM logs) SELECT r.x FROM recent r JOIN recent r2 ON 1=1";

    it("resolves a CTE use to its definition", async () => {
      const result = await resolveAt(sql, "recent", 1);
      expect(result).toBeTruthy();
      expect(result?.kind).toBe("cte");
      expect(result?.name).toBe("recent");
      expect(result?.definition).toEqual({ from: 5, to: 5 + "recent".length });
      expect(texts(sql, result!)).toEqual(["recent", "recent", "recent"]);
      expect(result?.references).toHaveLength(3);
    });

    it("resolves the definition to all uses", async () => {
      const result = await resolveAt(sql, "recent", 0);
      expect(result?.references).toHaveLength(3);
      expect(result?.references[0]).toEqual(result?.definition);
    });

    it("resolves CTE uses in nested-paren bodies", async () => {
      const doc =
        "WITH a AS (SELECT max(x) FROM (SELECT 1) s), b AS (SELECT * FROM a) SELECT * FROM b";
      const result = await resolveAt(doc, "a AS");
      expect(result?.kind).toBe("cte");
      // definition + use inside b's body
      expect(result?.references).toHaveLength(2);
    });

    it("does not include qualified same-named columns", async () => {
      const doc = "WITH t AS (SELECT 1) SELECT x.t FROM t, other x";
      const result = await resolveAt(doc, "t AS");
      // definition + `FROM t`, but not `x.t`
      expect(result?.references).toHaveLength(2);
      const refTexts = result?.references.map((r) => doc.slice(r.from - 1, r.to));
      expect(refTexts?.some((t) => t.startsWith("."))).toBe(false);
    });

    it("ignores occurrences inside string literals", async () => {
      const doc = "WITH t AS (SELECT 1) SELECT * FROM t WHERE name = 't'";
      const result = await resolveAt(doc, "t AS");
      expect(result?.references).toHaveLength(2);
    });

    it("returns null when the cursor is on an occurrence inside a string literal", async () => {
      const doc = "WITH tbl AS (SELECT 1) SELECT * FROM tbl WHERE name = 'tbl'";
      const result = await resolveAt(doc, "tbl", 2);
      expect(result).toBeNull();
    });

    it("resolves quoted CTE declarations from bare uses", async () => {
      const doc = 'WITH "recent" AS (SELECT 1) SELECT * FROM recent';
      const result = await resolveAt(doc, "recent", 1);
      expect(result?.kind).toBe("cte");
      expect(doc.slice(result!.definition.from, result!.definition.to)).toBe('"recent"');
      expect(result?.references).toHaveLength(2);
    });

    it("resolves from a cursor inside a quoted declaration", async () => {
      const doc = 'WITH "recent" AS (SELECT 1) SELECT * FROM recent';
      const state = EditorState.create({ doc });
      const result = await findReferences(state, doc.indexOf("recent"));
      expect(result?.kind).toBe("cte");
      expect(result?.references).toHaveLength(2);
    });

    it("does not treat a bare same-named select-list identifier as a reference", async () => {
      const doc = "WITH t AS (SELECT 1) SELECT t FROM t";
      const result = await resolveAt(doc, "t AS");
      // definition + `FROM t`; the select-list `t` is a column reference
      expect(result?.references).toHaveLength(2);
      expect(result?.references.some((r) => r.from === doc.indexOf("t FROM"))).toBe(false);
    });

    it("counts FROM-list comma entries as references", async () => {
      const doc = "WITH t AS (SELECT 1) SELECT * FROM a, t";
      const result = await resolveAt(doc, "t AS");
      expect(result?.references).toHaveLength(2);
    });

    it("refuses when a CTE name collides with a select alias", async () => {
      const doc = "WITH t AS (SELECT 1) SELECT 1 AS t FROM t ORDER BY t";
      const result = await resolveAt(doc, "t AS (");
      expect(result).toBeNull();
    });

    it("refuses when a CTE name is also a table alias in the same statement", async () => {
      // `x` is a CTE name and also an alias bound to `users` — two distinct
      // bindings, so it refuses rather than mixing them
      const doc = "WITH x AS (SELECT 1) SELECT * FROM users x";
      const result = await resolveAt(doc, "x AS");
      expect(result).toBeNull();
    });

    it("does not count a comma-separated select-list entry as a relation use", async () => {
      // The `t` after `SELECT a, ` is a column, not a FROM-list relation
      const doc = "WITH t AS (SELECT 1) SELECT a, t FROM t";
      const result = await resolveAt(doc, "t AS");
      // definition + `FROM t` only
      expect(result?.references).toHaveLength(2);
      expect(result?.references.some((r) => r.from === doc.indexOf("t FROM"))).toBe(false);
    });
  });

  describe("table aliases", () => {
    it("resolves an alias qualifier to its definition", async () => {
      const sql = "SELECT u.name FROM users u JOIN orders o ON u.id = o.user_id";
      const result = await resolveAt(sql, "u.id");
      expect(result?.kind).toBe("table-alias");
      expect(result?.name).toBe("u");
      expect(sql.slice(result!.definition.from, result!.definition.to)).toBe("u");
      expect(result?.definition.from).toBe(sql.indexOf("users u") + "users ".length);
      // definition + u.name + u.id
      expect(result?.references).toHaveLength(3);
    });

    it("resolves the alias definition token to its uses", async () => {
      const sql = "SELECT u.name FROM users u WHERE u.active";
      const result = await resolveAt(sql, "u WHERE");
      expect(result?.kind).toBe("table-alias");
      expect(result?.references).toHaveLength(3);
    });

    it("resolves AS aliases of qualified tables", async () => {
      const sql = "SELECT u.name FROM mydb.users AS u";
      const result = await resolveAt(sql, "u.name");
      expect(result?.kind).toBe("table-alias");
      expect(result?.definition.from).toBe(sql.indexOf("AS u") + "AS ".length);
    });

    it("refuses when an alias collides with a select alias", async () => {
      const sql = "SELECT u.name AS u FROM users u ORDER BY u";
      const result = await resolveAt(sql, "u.name");
      expect(result).toBeNull();
    });

    it("refuses when the same alias is bound to two tables", async () => {
      const sql =
        "SELECT * FROM (SELECT x.a FROM t1 x) s1, (SELECT x.b FROM t2 x) s2 WHERE 1 = 1";
      const result = await resolveAt(sql, "x.a");
      expect(result).toBeNull();
    });

    it("resolves an alias whose table has a quoted qualifier", async () => {
      const sql = 'SELECT u.name FROM "mydb".users AS u';
      const result = await resolveAt(sql, "u.name");
      expect(result?.kind).toBe("table-alias");
      expect(result?.name).toBe("u");
      expect(result?.definition.from).toBe(sql.indexOf("AS u") + "AS ".length);
      // definition + u.name
      expect(result?.references).toHaveLength(2);
    });

    it("returns null when the cursor is on a bare (non-qualifier) alias name", async () => {
      // The select-list `u` is not a `u.column` qualifier use, so the cursor
      // there does not resolve to the alias
      const sql = "SELECT u FROM users u";
      const result = await resolveAt(sql, "u FROM");
      expect(result).toBeNull();
    });
  });

  describe("select aliases", () => {
    it("resolves a select alias referenced in ORDER BY", async () => {
      const sql = "SELECT count(*) AS total FROM users GROUP BY name ORDER BY total";
      const result = await resolveAt(sql, "total", 1);
      expect(result?.kind).toBe("select-alias");
      expect(result?.definition.from).toBe(sql.indexOf("total"));
      expect(result?.references).toHaveLength(2);
    });

    it("resolves a select alias referenced in GROUP BY and HAVING", async () => {
      const sql = "SELECT name AS n FROM users GROUP BY n HAVING n <> 'x' ORDER BY n";
      const result = await resolveAt(sql, "n FROM");
      expect(result?.kind).toBe("select-alias");
      // definition + GROUP BY + HAVING + ORDER BY
      expect(result?.references).toHaveLength(4);
    });

    it("does not treat a same-named column in WHERE as a reference", async () => {
      const sql = "SELECT x AS total FROM t WHERE total > 5 ORDER BY total";
      const result = await resolveAt(sql, "total", 0);
      // definition + ORDER BY only; WHERE resolves to a column in SQL
      expect(result?.references).toHaveLength(2);
      expect(result?.references.some((r) => r.from === sql.indexOf("total > 5"))).toBe(false);
    });

    it("returns null when the cursor is on a same-named column in WHERE", async () => {
      // The WHERE occurrence is a column, not the select alias, so the cursor
      // there is not a resolvable reference
      const sql = "SELECT x AS total FROM t WHERE total > 5 ORDER BY total";
      const result = await resolveAt(sql, "total", 1);
      expect(result).toBeNull();
    });

    it("resolves a select alias in ORDER BY when there is no FROM clause", async () => {
      const sql = "SELECT 1 AS total ORDER BY total";
      const result = await resolveAt(sql, "total", 1);
      expect(result?.kind).toBe("select-alias");
      expect(result?.references).toHaveLength(2);
    });

    it("returns null for an alias declared without the AS keyword", async () => {
      // The definition is only located via `AS <alias>`; without AS there is
      // no confidently-resolvable declaration token
      const sql = "SELECT count(*) total FROM users GROUP BY total";
      const result = await resolveAt(sql, "total", 1);
      expect(result).toBeNull();
    });
  });

  describe("scoping and refusal", () => {
    it("does not cross statement boundaries", async () => {
      const sql =
        "WITH t AS (SELECT 1) SELECT * FROM t;\nWITH t AS (SELECT 2) SELECT * FROM t";
      const secondUse = sql.lastIndexOf("t");
      const state = EditorState.create({ doc: sql });
      const result = await findReferences(state, secondUse);
      expect(result).toBeTruthy();
      const boundary = sql.indexOf(";");
      for (const range of result!.references) {
        expect(range.from).toBeGreaterThan(boundary);
      }
    });

    it("returns null for plain table names", async () => {
      const result = await resolveAt("SELECT name FROM users", "users");
      expect(result).toBeNull();
    });

    it("returns null for plain column names", async () => {
      const result = await resolveAt("SELECT name FROM users", "name");
      expect(result).toBeNull();
    });

    it("returns null on whitespace", async () => {
      const state = EditorState.create({ doc: "SELECT 1 " });
      expect(await findReferences(state, 9)).toBeNull();
    });

    it("resolves mid-edit statements via the regex fallback", async () => {
      const sql = "WITH recent AS (SELECT x FROM logs) SELECT r. FROM recent r";
      const result = await resolveAt(sql, "recent", 1);
      expect(result?.kind).toBe("cte");
      expect(result?.references).toHaveLength(2);
    });

    it("returns null for a token trailing after the final statement", async () => {
      // `zzz` sits past the terminating `;`, outside the (preceding) statement
      const sql = "WITH t AS (SELECT 1) SELECT * FROM t; zzz";
      const result = await resolveAt(sql, "zzz");
      expect(result).toBeNull();
    });

    it("returns null on an empty document", async () => {
      const state = EditorState.create({ doc: "" });
      expect(await findReferences(state, 0)).toBeNull();
    });

    it("accepts an explicit config object", async () => {
      const sql = "WITH recent AS (SELECT 1) SELECT * FROM recent";
      const state = EditorState.create({ doc: sql });
      const result = await findReferences(state, sql.indexOf("recent"), {});
      expect(result?.kind).toBe("cte");
      expect(result?.references).toHaveLength(2);
    });
  });
});
