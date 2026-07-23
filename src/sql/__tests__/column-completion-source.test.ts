import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import type { SQLNamespace } from "@codemirror/lang-sql";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { unqualifiedColumnCompletionSource } from "../column-completion-source.js";
import { sqlSchemaFacet } from "../schema-facet.js";

const schema: SQLNamespace = {
  users: ["id", "username", "email"],
  orders: [
    { label: "order_id", detail: "Order ID", type: "property" },
    "total",
  ],
};

const nestedSchema: SQLNamespace = {
  mydb: {
    users: ["id", "username"],
  },
};

async function complete(
  doc: string,
  opts: {
    schema?: SQLNamespace;
    pos?: number;
    explicit?: boolean;
    facetSchema?: SQLNamespace;
  } = {},
): Promise<CompletionResult | null> {
  const source = unqualifiedColumnCompletionSource(
    opts.schema === undefined && opts.facetSchema !== undefined ? {} : { schema: opts.schema },
  );
  const state = EditorState.create({
    doc,
    extensions: opts.facetSchema !== undefined ? [sqlSchemaFacet.of(opts.facetSchema)] : [],
  });
  const pos = opts.pos ?? doc.length;
  const context = new CompletionContext(state, pos, opts.explicit ?? false);
  return (await source(context)) as CompletionResult | null;
}

function labels(result: CompletionResult | null): string[] {
  return (result?.options ?? []).map((option) => option.label);
}

describe("unqualifiedColumnCompletionSource", () => {
  it("offers the FROM table's columns for a bare prefix", async () => {
    const result = await complete("SELECT e FROM users", {
      schema,
      pos: "SELECT e".length,
    });
    expect(labels(result)).toEqual(["id", "username", "email"]);
    expect(result?.from).toBe("SELECT ".length);
    expect(result?.options.every((option) => option.type === "property")).toBe(true);
  });

  it("completes in ORDER BY position", async () => {
    const doc = "SELECT id FROM users ORDER BY user";
    const result = await complete(doc, { schema, pos: doc.length });
    expect(labels(result)).toContain("username");
    expect(result?.from).toBe(doc.indexOf("user", doc.indexOf("ORDER BY")));
  });

  it("only offers columns of the referenced table when the schema has many", async () => {
    const result = await complete("SELECT e FROM users", {
      schema,
      pos: "SELECT e".length,
    });
    expect(labels(result)).not.toContain("total");
    expect(labels(result)).not.toContain("order_id");
  });

  it("offers the union of all joined tables' columns with per-table details", async () => {
    const doc = "SELECT  FROM users u JOIN orders o ON u.id = o.user_id";
    const result = await complete(doc, {
      schema,
      pos: "SELECT ".length,
      explicit: true,
    });
    expect(labels(result)).toEqual(["id", "username", "email", "order_id", "total"]);
    expect(result?.options.find((option) => option.label === "email")?.detail).toBe(
      "column of users",
    );
    expect(result?.options.find((option) => option.label === "total")?.detail).toBe(
      "column of orders",
    );
    // Schema-provided details are preserved
    expect(result?.options.find((option) => option.label === "order_id")?.detail).toBe(
      "Order ID",
    );
  });

  it("offers a duplicate column name once, from the first table", async () => {
    const dupSchema: SQLNamespace = { a: ["id", "x"], b: ["id", "y"] };
    const doc = "SELECT  FROM a JOIN b ON a.id = b.id";
    const result = await complete(doc, { schema: dupSchema, pos: "SELECT ".length, explicit: true });
    expect(labels(result)).toEqual(["id", "x", "y"]);
    expect(result?.options.find((option) => option.label === "id")?.detail).toBe("column of a");
  });

  it("returns null after a dot", async () => {
    const result = await complete("SELECT u. FROM users u", {
      schema,
      pos: "SELECT u.".length,
      explicit: true,
    });
    expect(result).toBeNull();
  });

  it("returns null in table-name position", async () => {
    expect(await complete("SELECT id FROM use", { schema, pos: "SELECT id FROM use".length })).toBeNull();
    const doc = "SELECT id FROM users JOIN ord";
    expect(await complete(doc, { schema, pos: doc.length })).toBeNull();
  });

  it("returns null in a comma-continued FROM table list", async () => {
    expect(await complete("SELECT id FROM users, ord", { schema })).toBeNull();
    expect(await complete("SELECT id FROM users u, ord", { schema })).toBeNull();
    expect(await complete("SELECT id FROM users AS u, orders o, ord", { schema })).toBeNull();
  });

  it("still completes after commas in non-FROM clauses", async () => {
    const groupBy = "SELECT id FROM users GROUP BY id, user";
    expect(labels(await complete(groupBy, { schema }))).toContain("username");
    const selectList = "SELECT id, e FROM users";
    expect(labels(await complete(selectList, { schema, pos: "SELECT id, e".length }))).toContain(
      "email",
    );
  });

  it("returns null inside string literals and comments", async () => {
    const inString = "SELECT id FROM users WHERE name = 'em";
    expect(await complete(inString, { schema })).toBeNull();
    const inLineComment = "SELECT id FROM users -- em";
    expect(await complete(inLineComment, { schema })).toBeNull();
    const inBlockComment = "SELECT id FROM users /* em";
    expect(await complete(inBlockComment, { schema })).toBeNull();
  });

  it("requires a prefix unless the request is explicit", async () => {
    const doc = "SELECT  FROM users";
    expect(await complete(doc, { schema, pos: "SELECT ".length })).toBeNull();
    expect(labels(await complete(doc, { schema, pos: "SELECT ".length, explicit: true }))).toEqual([
      "id",
      "username",
      "email",
    ]);
  });

  it("returns null when the statement has no FROM clause yet", async () => {
    const result = await complete("SELECT em", { schema, pos: "SELECT em".length });
    expect(result).toBeNull();
  });

  it("still completes while the statement is mid-edit (unparsable)", async () => {
    const result = await complete("SELECT em FROM users WHERE", {
      schema,
      pos: "SELECT em".length,
    });
    expect(labels(result)).toEqual(["id", "username", "email"]);
  });

  it("scopes tables to the statement containing the cursor", async () => {
    const doc = "SELECT id FROM users; SELECT t FROM orders";
    const result = await complete(doc, { schema, pos: doc.indexOf("t FROM orders") + 1 });
    expect(labels(result)).toEqual(["order_id", "total"]);
  });

  it("completes columns of an aliased table", async () => {
    const result = await complete("SELECT e FROM users u", {
      schema,
      pos: "SELECT e".length,
    });
    expect(labels(result)).toEqual(["id", "username", "email"]);
  });

  it("resolves tables nested in the schema", async () => {
    const qualified = await complete("SELECT user FROM mydb.users", {
      schema: nestedSchema,
      pos: "SELECT user".length,
    });
    expect(labels(qualified)).toEqual(["id", "username"]);

    const underQualified = await complete("SELECT user FROM users", {
      schema: nestedSchema,
      pos: "SELECT user".length,
    });
    expect(labels(underQualified)).toEqual(["id", "username"]);
  });

  it("returns null when an under-qualified table is ambiguous across schemas", async () => {
    const ambiguousSchema: SQLNamespace = {
      db1: { users: ["id"] },
      db2: { users: ["email"] },
    };
    const result = await complete("SELECT i FROM users", {
      schema: ambiguousSchema,
      pos: "SELECT i".length,
    });
    expect(result).toBeNull();
  });

  it("offers CTE columns when the FROM table is a CTE", async () => {
    const doc = "WITH recent AS (SELECT x, y FROM logs) SELECT x FROM recent";
    const result = await complete(doc, { schema, pos: doc.indexOf("x FROM recent") + 1 });
    const resultLabels = labels(result);
    expect(resultLabels).toContain("x");
    expect(resultLabels).toContain("y");
    expect(result?.options.find((option) => option.label === "x")?.detail).toBe(
      "column of recent",
    );
  });

  it("completes columns of a quoted table name", async () => {
    const quotedSchema: SQLNamespace = { "User Table": ["id", "full_name"] };
    const doc = 'SELECT full FROM "User Table"';
    const result = await complete(doc, { schema: quotedSchema, pos: "SELECT full".length });
    expect(labels(result)).toEqual(["id", "full_name"]);
  });

  it("completes columns of a quoted table name containing a dot", async () => {
    const dottedSchema: SQLNamespace = { "my.table": ["id", "email"] };
    const doc = 'SELECT e FROM "my.table"';
    const result = await complete(doc, { schema: dottedSchema, pos: "SELECT e".length });
    expect(labels(result)).toEqual(["id", "email"]);
  });

  it("falls back to the sqlSchemaFacet when no schema is configured", async () => {
    const result = await complete("SELECT e FROM users", {
      facetSchema: schema,
      pos: "SELECT e".length,
    });
    expect(labels(result)).toEqual(["id", "username", "email"]);
  });

  it("returns null when the table is not in the schema", async () => {
    const result = await complete("SELECT x FROM missing", {
      schema,
      pos: "SELECT x".length,
    });
    expect(result).toBeNull();
  });

  it("boosts columns while preserving schema-provided boosts", async () => {
    const boostedSchema: SQLNamespace = {
      users: ["id", { label: "email", boost: 5 }],
    };
    const result = await complete("SELECT e FROM users", {
      schema: boostedSchema,
      pos: "SELECT e".length,
    });
    expect(result?.options.find((option) => option.label === "id")?.boost).toBe(1);
    expect(result?.options.find((option) => option.label === "email")?.boost).toBe(5);
  });
});
