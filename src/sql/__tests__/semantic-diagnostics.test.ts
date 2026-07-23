import { EditorState, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { sqlSchemaFacet } from "../schema-facet.js";
import {
  exportedForTesting,
  type SqlSemanticLinterConfig,
  sqlSemanticLinter,
} from "../semantic-diagnostics.js";
import type { SqlParser } from "../types.js";

const { createSemanticLintSource } = exportedForTesting;

const SCHEMA = {
  users: ["id", "name", "email"],
  posts: ["id", "user_id", "title"],
};

const createMockView = (content: string, extensions: Extension[] = []) => {
  return {
    state: EditorState.create({ doc: content, extensions }),
  } as EditorView;
};

const lint = (content: string, config: SqlSemanticLinterConfig = {}, extensions: Extension[] = []) => {
  return createSemanticLintSource(config)(createMockView(content, extensions));
};

describe("sqlSemanticLinter", () => {
  it("should create a linter extension", () => {
    expect(sqlSemanticLinter()).toBeDefined();
    expect(sqlSemanticLinter({ schema: SCHEMA, delay: 100 })).toBeDefined();
  });
});

describe("unknown tables", () => {
  it("flags a table missing from the schema", async () => {
    const doc = "SELECT * FROM usres";
    const diagnostics = await lint(doc, { schema: SCHEMA });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("usres");
    expect(diagnostics[0].severity).toBe("warning");
    expect(diagnostics[0].source).toBe("sql-schema");
    // Positioned on the identifier itself
    expect(doc.slice(diagnostics[0].from, diagnostics[0].to)).toBe("usres");
  });

  it("does not flag known tables", async () => {
    expect(await lint("SELECT * FROM users", { schema: SCHEMA })).toEqual([]);
  });

  it("is case-insensitive", async () => {
    expect(await lint("SELECT * FROM USERS", { schema: SCHEMA })).toEqual([]);
  });

  it("resolves qualified names through nested namespaces", async () => {
    const nested = { mydb: { users: ["id", "name"] } };
    expect(await lint("SELECT * FROM mydb.users", { schema: nested })).toEqual([]);

    const diagnostics = await lint("SELECT * FROM mydb.usres", { schema: nested });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("mydb.usres");
  });

  it("does not flag unqualified references to tables nested deeper in the schema", async () => {
    const nested = { mydb: { users: ["id", "name"] } };
    expect(await lint("SELECT * FROM users", { schema: nested })).toEqual([]);
  });

  it("does not flag CTE names", async () => {
    const doc = "WITH t AS (SELECT id FROM users) SELECT * FROM t";
    expect(await lint(doc, { schema: SCHEMA })).toEqual([]);
  });

  it("flags unknown tables inside CTE bodies", async () => {
    const doc = "WITH t AS (SELECT id FROM usres) SELECT * FROM t";
    const diagnostics = await lint(doc, { schema: SCHEMA });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("usres");
  });

  it("does not flag CREATE TABLE targets but flags their source tables", async () => {
    expect(await lint("CREATE TABLE newtbl (id int)", { schema: SCHEMA })).toEqual([]);

    const diagnostics = await lint("CREATE TABLE newtbl AS SELECT * FROM usres", {
      schema: SCHEMA,
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("usres");
  });

  it("flags unknown DML targets", async () => {
    expect(
      await lint("INSERT INTO usres (id) VALUES (1)", { schema: SCHEMA }),
    ).toHaveLength(1);
    expect(await lint("UPDATE usres SET id = 1", { schema: SCHEMA })).toHaveLength(1);
    expect(await lint("DELETE FROM usres WHERE id = 1", { schema: SCHEMA })).toHaveLength(1);
    expect(await lint("INSERT INTO users (id) VALUES (1)", { schema: SCHEMA })).toEqual([]);
  });

  it("flags unknown tables in subqueries", async () => {
    const diagnostics = await lint("SELECT * FROM users WHERE id IN (SELECT user_id FROM psts)", {
      schema: SCHEMA,
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("psts");
  });
});

describe("unknown columns", () => {
  it("flags a column missing from the referenced table", async () => {
    const doc = "SELECT nme FROM users";
    const diagnostics = await lint(doc, { schema: SCHEMA });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("nme");
    expect(diagnostics[0].message).toContain("users");
    expect(doc.slice(diagnostics[0].from, diagnostics[0].to)).toBe("nme");
  });

  it("does not flag known columns, *, or case variants", async () => {
    expect(await lint("SELECT id, NAME, * FROM users", { schema: SCHEMA })).toEqual([]);
  });

  it("resolves alias-qualified references", async () => {
    expect(await lint("SELECT u.name FROM users u", { schema: SCHEMA })).toEqual([]);

    const diagnostics = await lint("SELECT u.nme FROM users u", { schema: SCHEMA });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("nme");
  });

  it("checks table-qualified references across joins", async () => {
    const doc = "SELECT users.name, posts.title FROM users JOIN posts ON posts.user_id = users.id";
    expect(await lint(doc, { schema: SCHEMA })).toEqual([]);

    const bad = "SELECT users.nme FROM users JOIN posts ON posts.user_id = users.id";
    expect(await lint(bad, { schema: SCHEMA })).toHaveLength(1);
  });

  it("skips qualifiers that do not resolve to a scope source", async () => {
    // `x` might be an outer alias or something we can't resolve — never guess
    expect(await lint("SELECT x.nme FROM users u", { schema: SCHEMA })).toEqual([]);
  });

  it("skips unqualified columns when multiple tables are referenced", async () => {
    // `title` only exists in posts, but we only check unqualified columns
    // against single-table statements
    expect(await lint("SELECT missing_col FROM users, posts", { schema: SCHEMA })).toEqual([]);
  });

  it("is CTE and alias aware", async () => {
    expect(
      await lint("WITH t AS (SELECT 1 AS x) SELECT x FROM t", { schema: SCHEMA }),
    ).toEqual([]);
  });

  it("skips SELECT-list aliases referenced in ORDER BY / GROUP BY", async () => {
    const doc = "SELECT name AS display_name FROM users ORDER BY display_name";
    expect(await lint(doc, { schema: SCHEMA })).toEqual([]);
  });

  it("checks columns inside FROM subqueries", async () => {
    const diagnostics = await lint("SELECT * FROM (SELECT nme FROM users) sub", {
      schema: SCHEMA,
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("nme");
  });

  it("skips unqualified columns in correlated subqueries", async () => {
    // `email` is not in posts, but unqualified names in a correlated subquery
    // may resolve to the outer scope, so it must not be flagged
    const doc = "SELECT * FROM users WHERE EXISTS (SELECT 1 FROM posts WHERE user_id = id)";
    expect(await lint(doc, { schema: SCHEMA })).toEqual([]);
  });

  it("flags unknown columns in UPDATE statements", async () => {
    const diagnostics = await lint("UPDATE users SET nme = 'x' WHERE id = 1", {
      schema: SCHEMA,
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("nme");
  });

  it("checks columns referenced inside function calls", async () => {
    expect(await lint("SELECT count(*) FROM users", { schema: SCHEMA })).toEqual([]);
    expect(await lint("SELECT count(nme) FROM users", { schema: SCHEMA })).toHaveLength(1);
  });

  it("supports self/children namespaces", async () => {
    const schema = {
      users: { self: { label: "users" }, children: ["id", "name"] },
    };
    expect(await lint("SELECT name FROM users", { schema })).toEqual([]);
    expect(await lint("SELECT nme FROM users", { schema })).toHaveLength(1);
  });

  it("positions diagnostics correctly with inline comments", async () => {
    const doc = "SELECT -- comment\n  nme\nFROM users";
    const diagnostics = await lint(doc, { schema: SCHEMA });
    expect(diagnostics).toHaveLength(1);
    expect(doc.slice(diagnostics[0].from, diagnostics[0].to)).toBe("nme");
  });

  it("supports Completion objects as columns", async () => {
    const schema = {
      users: [{ label: "id", detail: "int" }, { label: "name", detail: "text" }],
    };
    expect(await lint("SELECT name FROM users", { schema })).toEqual([]);
    expect(await lint("SELECT nme FROM users", { schema })).toHaveLength(1);
  });
});

describe("ambiguous columns", () => {
  it("flags an unqualified column that exists in multiple referenced tables", async () => {
    const doc = "SELECT id FROM users, posts";
    const diagnostics = await lint(doc, { schema: SCHEMA });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("ambiguous");
    expect(diagnostics[0].message).toContain("users");
    expect(diagnostics[0].message).toContain("posts");
    expect(doc.slice(diagnostics[0].from, diagnostics[0].to)).toBe("id");
  });

  it("does not flag qualified references or single-table columns", async () => {
    expect(
      await lint("SELECT users.id, title FROM users JOIN posts ON posts.user_id = users.id", {
        schema: SCHEMA,
      }),
    ).toEqual([]);
  });

  it("does not flag columns joined with USING", async () => {
    expect(await lint("SELECT id FROM users JOIN posts USING (id)", { schema: SCHEMA })).toEqual(
      [],
    );
  });
});

describe("inertness and gating", () => {
  it("returns no diagnostics and never parses when no schema is configured", async () => {
    const parser = {
      parse: vi.fn(),
      validateSql: vi.fn(),
      extractTableReferences: vi.fn(),
      extractColumnReferences: vi.fn(),
    } as unknown as SqlParser;

    expect(await lint("SELECT * FROM usres", { parser })).toEqual([]);
    expect(parser.parse).not.toHaveBeenCalled();
  });

  it("treats an empty schema as no schema (lazy loading upstream)", async () => {
    expect(await lint("SELECT * FROM usres", { schema: {} })).toEqual([]);
    expect(await lint("SELECT * FROM usres", { schema: [] })).toEqual([]);
  });

  it("returns no diagnostics for empty documents", async () => {
    expect(await lint("", { schema: SCHEMA })).toEqual([]);
    expect(await lint("   \n  ", { schema: SCHEMA })).toEqual([]);
  });

  it("skips statements with syntax errors", async () => {
    // Broken statement: no semantic noise on top of the syntax error;
    // the valid statement is still checked
    const diagnostics = await lint("SELCT * FROM usres;\nSELECT * FROM usres;", {
      schema: SCHEMA,
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].source).toBe("sql-schema");
  });

  it("reads the schema from sqlSchemaFacet when not configured directly", async () => {
    const diagnostics = await lint("SELECT * FROM usres", {}, [sqlSchemaFacet.of(SCHEMA)]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("usres");
  });

  it("prefers the explicit schema over the facet", async () => {
    const diagnostics = await lint("SELECT * FROM other_table", { schema: SCHEMA }, [
      sqlSchemaFacet.of({ other_table: ["id"] }),
    ]);
    expect(diagnostics).toHaveLength(1);
  });

  it("supports function schema sources", async () => {
    const schema = vi.fn(() => SCHEMA);
    const diagnostics = await lint("SELECT * FROM usres", { schema });
    expect(diagnostics).toHaveLength(1);
    expect(schema).toHaveBeenCalled();
  });
});

describe("severity configuration", () => {
  it("supports severity overrides", async () => {
    const diagnostics = await lint("SELECT * FROM usres", {
      schema: SCHEMA,
      severity: { unknownTable: "error" },
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe("error");
  });

  it("supports turning checks off", async () => {
    expect(
      await lint("SELECT * FROM usres", {
        schema: SCHEMA,
        severity: { unknownTable: "off" },
      }),
    ).toEqual([]);

    expect(
      await lint("SELECT id FROM users, posts", {
        schema: SCHEMA,
        severity: { ambiguousColumn: "off" },
      }),
    ).toEqual([]);
  });
});

describe("multiple statements", () => {
  it("reports findings per statement with document-relative positions", async () => {
    const doc = "SELECT * FROM users;\nSELECT nme FROM users;\nSELECT * FROM usres;";
    const diagnostics = await lint(doc, { schema: SCHEMA });

    expect(diagnostics).toHaveLength(2);
    const spans = diagnostics.map((d) => doc.slice(d.from, d.to)).sort();
    expect(spans).toEqual(["nme", "usres"]);
  });
});
