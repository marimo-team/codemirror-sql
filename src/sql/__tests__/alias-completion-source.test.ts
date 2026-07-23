import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import type { SQLNamespace } from "@codemirror/lang-sql";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { aliasColumnCompletionSource } from "../alias-completion-source.js";
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
  const source = aliasColumnCompletionSource(
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

describe("aliasColumnCompletionSource", () => {
  it("offers the aliased table's columns after `alias.`", async () => {
    const result = await complete("SELECT u. FROM users u", {
      schema,
      pos: "SELECT u.".length,
    });
    expect(labels(result)).toEqual(["id", "username", "email"]);
    expect(result?.from).toBe("SELECT u.".length);
    expect(result?.options.every((option) => option.type === "property")).toBe(true);
  });

  it("completes with a typed prefix and keeps `from` after the dot", async () => {
    const doc = "SELECT u.user FROM users u";
    const result = await complete(doc, { schema, pos: "SELECT u.user".length });
    expect(labels(result)).toEqual(["id", "username", "email"]);
    expect(result?.from).toBe("SELECT u.".length);
    expect(result?.validFor).toBeTruthy();
  });

  it("works on explicit completion requests", async () => {
    const result = await complete("SELECT u. FROM users u", {
      schema,
      pos: "SELECT u.".length,
      explicit: true,
    });
    expect(labels(result)).toEqual(["id", "username", "email"]);
  });

  it("resolves each alias in a join to its own table", async () => {
    const doc = "SELECT o. FROM users u JOIN orders o ON u.id = o.user_id";
    const result = await complete(doc, { schema, pos: "SELECT o.".length });
    expect(labels(result)).toEqual(["order_id", "total"]);
    // Completion objects from the schema are preserved
    expect(result?.options.find((option) => option.label === "order_id")?.detail).toBe(
      "Order ID",
    );
  });

  it("resolves aliases of tables nested in the schema", async () => {
    const result = await complete("SELECT u. FROM mydb.users u", {
      schema: nestedSchema,
      pos: "SELECT u.".length,
    });
    expect(labels(result)).toEqual(["id", "username"]);
  });

  it("offers CTE columns for a CTE alias", async () => {
    const doc = "WITH recent AS (SELECT x, y FROM logs) SELECT r. FROM recent r";
    const result = await complete(doc, { schema, pos: doc.indexOf("r. FROM") + 2 });
    expect(labels(result)).toEqual(["x", "y"]);
  });

  it("falls back to the sqlSchemaFacet when no schema is configured", async () => {
    const result = await complete("SELECT u. FROM users u", {
      facetSchema: schema,
      pos: "SELECT u.".length,
    });
    expect(labels(result)).toEqual(["id", "username", "email"]);
  });

  it("returns null when the qualifier is not an alias", async () => {
    const result = await complete("SELECT x. FROM users u", {
      schema,
      pos: "SELECT x.".length,
    });
    expect(result).toBeNull();
  });

  it("returns null without a dot before the cursor", async () => {
    const result = await complete("SELECT u FROM users u", {
      schema,
      pos: "SELECT u".length,
    });
    expect(result).toBeNull();
  });

  it("ignores multi-segment qualifiers like `db.table.`", async () => {
    const doc = "SELECT mydb.users. FROM mydb.users u";
    const result = await complete(doc, { schema: nestedSchema, pos: "SELECT mydb.users.".length });
    expect(result).toBeNull();
  });

  it("scopes aliases to the statement containing the cursor", async () => {
    const doc = "SELECT id FROM users u; SELECT u. FROM orders o";
    const result = await complete(doc, { schema, pos: doc.indexOf("u. FROM orders") + 2 });
    // `u` is aliased in statement 1, not statement 2
    expect(result).toBeNull();
  });

  it("still completes while the statement is mid-edit (unparsable)", async () => {
    const doc = "SELECT u. FROM users u WHERE";
    const result = await complete(doc, { schema, pos: "SELECT u.".length });
    expect(labels(result)).toEqual(["id", "username", "email"]);
  });

  it("completes after a quoted alias qualifier", async () => {
    const quotedSchema: SQLNamespace = { "User Table": ["id", "full_name"] };
    const doc = 'SELECT "ut". FROM "User Table" ut';
    const result = await complete(doc, { schema: quotedSchema, pos: 'SELECT "ut".'.length });
    expect(labels(result)).toEqual(["id", "full_name"]);
  });

  it("forces the property type but keeps schema-provided details", async () => {
    const typedSchema: SQLNamespace = {
      users: [{ label: "id", type: "keyword", detail: "Primary key" }],
    };
    const result = await complete("SELECT u. FROM users u", {
      schema: typedSchema,
      pos: "SELECT u.".length,
    });
    expect(result?.options).toEqual([
      { label: "id", type: "property", detail: "Primary key" },
    ]);
  });

  it("returns null when the aliased table is not in the schema", async () => {
    const result = await complete("SELECT m. FROM missing m", {
      schema,
      pos: "SELECT m.".length,
    });
    expect(result).toBeNull();
  });
});
