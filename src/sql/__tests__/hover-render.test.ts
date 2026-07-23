import type { SQLNamespace } from "@codemirror/lang-sql";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { DefaultSqlTooltipRenders, defaultSqlHoverTheme, exportedForTesting } from "../hover.js";
import type { ResolvedNamespaceItem } from "../namespace-utils.js";

const { createHoverSource } = exportedForTesting;

// ---------------------------------------------------------------------------
// Pure tooltip HTML builders (exposed via DefaultSqlTooltipRenders)
// ---------------------------------------------------------------------------

describe("DefaultSqlTooltipRenders.keyword", () => {
  const render = DefaultSqlTooltipRenders.keyword;

  it("renders an uppercased keyword header and description", () => {
    const html = render({ keyword: "select", info: { description: "Selects rows" } });
    expect(html).toContain("<strong>SELECT</strong>");
    expect(html).toContain("keyword");
    expect(html).toContain("Selects rows");
  });

  it("renders syntax, example, and metadata tags when present", () => {
    const html = render({
      keyword: "join",
      info: {
        description: "Combines rows",
        syntax: "A JOIN B ON ...",
        example: "SELECT * FROM a JOIN b",
        metadata: { since: "SQL-92", category: "clause" },
      },
    });
    expect(html).toContain("Syntax:");
    expect(html).toContain("A JOIN B ON ...");
    expect(html).toContain("Example:");
    expect(html).toContain("SELECT * FROM a JOIN b");
    expect(html).toContain('title="since"');
    expect(html).toContain("SQL-92");
    expect(html).toContain('title="category"');
  });

  it("omits the metadata block for empty metadata", () => {
    const html = render({ keyword: "where", info: { description: "Filters", metadata: {} } });
    expect(html).not.toContain("sql-hover-metadata");
  });
});

describe("DefaultSqlTooltipRenders.table", () => {
  const render = DefaultSqlTooltipRenders.table;

  it("pluralizes the column count and lists columns", () => {
    const html = render({ tableName: "users", columns: ["id", "name"] });
    expect(html).toContain("<strong>users</strong>");
    expect(html).toContain("2 columns");
    expect(html).toContain("<code>id</code>");
    expect(html).toContain("<code>name</code>");
  });

  it("uses singular wording for exactly one column", () => {
    const html = render({ tableName: "t", columns: ["only"] });
    expect(html).toContain("1 column");
    expect(html).not.toContain("1 columns");
  });

  it("renders no column list when there are no columns", () => {
    const html = render({ tableName: "empty", columns: [] });
    expect(html).toContain("0 columns");
    expect(html).not.toContain("sql-hover-columns");
  });

  it("truncates when there are more than 10 columns", () => {
    const columns = Array.from({ length: 13 }, (_, i) => `c${i}`);
    const html = render({ tableName: "wide", columns });
    expect(html).toContain("and 3 more");
    expect(html).toContain("<code>c9</code>");
    expect(html).not.toContain("<code>c10</code>");
  });

  it("renders metadata tags", () => {
    const html = render({ tableName: "t", columns: ["a"], metadata: { rows: "100" } });
    expect(html).toContain('title="rows"');
    expect(html).toContain("100");
  });
});

describe("DefaultSqlTooltipRenders.column", () => {
  const render = DefaultSqlTooltipRenders.column;

  it("lists other columns in the same table", () => {
    const html = render({
      tableName: "users",
      columnName: "id",
      schema: { users: ["id", "name", "email"] },
    });
    expect(html).toContain("<strong>id</strong>");
    expect(html).toContain("Column in table <code>users</code>");
    expect(html).toContain("Other columns in users");
    expect(html).toContain("<code>name</code>");
    expect(html).toContain("<code>email</code>");
    // "id" itself is filtered from the related list (it only appears in the header)
    expect(html).not.toContain("<code>id</code>");
  });

  it("truncates the related columns list beyond 8", () => {
    const cols = ["target", ...Array.from({ length: 12 }, (_, i) => `o${i}`)];
    const html = render({ tableName: "t", columnName: "target", schema: { t: cols } });
    expect(html).toContain("and 4 more");
  });

  it("omits the related section when the table is unknown", () => {
    const html = render({ tableName: "ghost", columnName: "x", schema: {} });
    expect(html).not.toContain("Other columns");
  });

  it("omits the related section when the table has a single column", () => {
    const html = render({ tableName: "t", columnName: "only", schema: { t: ["only"] } });
    expect(html).not.toContain("Other columns");
  });

  it("renders metadata tags", () => {
    const html = render({
      tableName: "t",
      columnName: "a",
      schema: { t: ["a", "b"] },
      metadata: { type: "int" },
    });
    expect(html).toContain('title="type"');
    expect(html).toContain("int");
  });

  it("omits the related section when the only other columns are the column itself", () => {
    // Duplicate column names mean the filtered "other columns" list is empty
    // even though the table has more than one entry.
    const html = render({ tableName: "t", columnName: "a", schema: { t: ["a", "a"] } });
    expect(html).toContain("<strong>a</strong>");
    expect(html).not.toContain("Other columns");
  });
});

describe("DefaultSqlTooltipRenders.namespace", () => {
  const render = DefaultSqlTooltipRenders.namespace;

  it("renders a database with schema count and detail", () => {
    const item: ResolvedNamespaceItem = {
      path: ["mydb"],
      type: "completion",
      semanticType: "database",
      completion: { label: "mydb", detail: "primary db" },
      namespace: { public: { users: ["id"] }, private: { secrets: ["k"] } },
    };
    const html = render(item);
    expect(html).toContain("<strong>mydb</strong>");
    expect(html).toContain("database");
    expect(html).toContain("Database: primary db");
    expect(html).toContain("Contains 2 schemas");
  });

  it("uses singular schema wording and no detail when absent", () => {
    const item: ResolvedNamespaceItem = {
      path: ["db"],
      type: "namespace",
      semanticType: "database",
      namespace: { public: { users: ["id"] } },
    };
    const html = render(item);
    expect(html).toContain("Contains 1 schema");
    expect(html).not.toContain("1 schemas");
    expect(html).toContain("Database</div>");
  });

  it("counts self/children namespaces as children", () => {
    const item: ResolvedNamespaceItem = {
      path: ["db"],
      type: "namespace",
      semanticType: "database",
      // self/children counts as 1 + children length (2) = 3
      namespace: { self: { label: "t" }, children: ["a", "b"] } as SQLNamespace,
    };
    const html = render(item);
    expect(html).toContain("Contains 3 schemas");
  });

  it("renders a schema with path and table count", () => {
    const item: ResolvedNamespaceItem = {
      path: ["mydb", "public"],
      type: "namespace",
      semanticType: "schema",
      namespace: { users: ["id"], orders: ["id"] },
    };
    const html = render(item);
    expect(html).toContain("Schema");
    expect(html).toContain("<code>mydb.public</code>");
    expect(html).toContain("Contains 2 tables");
  });

  it("renders a table with columns, truncation, and schema path", () => {
    const columns = [{ label: "id" }, "name", ...Array.from({ length: 8 }, (_, i) => `c${i}`)];
    const item: ResolvedNamespaceItem = {
      path: ["mydb", "public", "users"],
      type: "namespace",
      semanticType: "table",
      namespace: columns as SQLNamespace,
    };
    const html = render(item);
    expect(html).toContain("<strong>users</strong>"); // name falls back to last path segment
    expect(html).toContain("Columns (10)");
    expect(html).toContain("<code>id</code>");
    expect(html).toContain("and 2 more");
    expect(html).toContain("Schema:</strong> <code>mydb.public</code>");
  });

  it("renders a column with its table path and completion info", () => {
    const item: ResolvedNamespaceItem = {
      path: ["users", "email"],
      type: "completion",
      semanticType: "column",
      completion: { label: "email", detail: "user email", info: "the primary contact" },
    };
    const html = render(item);
    expect(html).toContain("<strong>email</strong>");
    expect(html).toContain("Column: user email");
    expect(html).toContain("Table:</strong> <code>users</code>");
    expect(html).toContain("the primary contact");
  });

  it("falls back to the string value for the name when no completion", () => {
    const item: ResolvedNamespaceItem = {
      path: ["users", "created_at"],
      type: "string",
      semanticType: "column",
      value: "created_at",
    };
    const html = render(item);
    expect(html).toContain("<strong>created_at</strong>");
  });

  it("renders the default namespace branch with an item count", () => {
    const item: ResolvedNamespaceItem = {
      path: ["misc"],
      type: "namespace",
      semanticType: "namespace",
      namespace: ["a", "b", "c"] as SQLNamespace,
    };
    const html = render(item);
    expect(html).toContain("Namespace");
    expect(html).toContain("Contains 3 items");
  });

  it("falls back to 'unknown' when there is no name source", () => {
    const item: ResolvedNamespaceItem = {
      path: [],
      type: "namespace",
      semanticType: "namespace",
    };
    const html = render(item);
    expect(html).toContain("<strong>unknown</strong>");
  });

  it("omits the children line when the namespace is not countable", () => {
    // A namespace value that is neither an array nor an object makes
    // countNamespaceChildren return 0, so no "Contains N items" line renders.
    const item: ResolvedNamespaceItem = {
      path: ["x"],
      type: "namespace",
      semanticType: "namespace",
      namespace: "not-a-namespace" as unknown as SQLNamespace,
    };
    const html = render(item);
    expect(html).toContain("<strong>x</strong>");
    expect(html).toContain("Namespace");
    expect(html).not.toContain("Contains");
  });

  it("renders a table with no detail and no columns", () => {
    // Exercises the table branch with an empty (array) namespace and no
    // completion detail: no "Columns" block, no "Schema" path (single segment).
    const item: ResolvedNamespaceItem = {
      path: ["solo"],
      type: "namespace",
      semanticType: "table",
      namespace: [] as unknown as SQLNamespace,
    };
    const html = render(item);
    expect(html).toContain("<strong>solo</strong>");
    expect(html).toContain("Table</div>");
    expect(html).not.toContain("sql-hover-columns");
    expect(html).not.toContain("Schema:");
  });

  it("renders a column without a table path when the path has a single segment", () => {
    const item: ResolvedNamespaceItem = {
      path: ["lonely"],
      type: "string",
      semanticType: "column",
      value: "lonely",
    };
    const html = render(item);
    expect(html).toContain("<strong>lonely</strong>");
    expect(html).toContain("Column</div>");
    expect(html).not.toContain("Table:");
  });

  it("renders a column with no table path when the path is empty", () => {
    const item: ResolvedNamespaceItem = {
      path: [],
      type: "string",
      semanticType: "column",
      value: "bare",
    };
    const html = render(item);
    expect(html).toContain("<strong>bare</strong>");
    expect(html).not.toContain("sql-hover-path");
    expect(html).not.toContain("Table:");
  });

  it("renders a database with a detail but no namespace children line", () => {
    const item: ResolvedNamespaceItem = {
      path: ["db"],
      type: "completion",
      semanticType: "database",
      completion: { label: "db", detail: "the database" },
    };
    const html = render(item);
    expect(html).toContain("Database: the database");
    expect(html).not.toContain("Contains");
  });

  it("renders a schema with a detail but no table count", () => {
    const item: ResolvedNamespaceItem = {
      path: ["db", "sch"],
      type: "completion",
      semanticType: "schema",
      completion: { label: "sch", detail: "a schema" },
    };
    const html = render(item);
    expect(html).toContain("Schema: a schema");
    expect(html).toContain("<code>db.sch</code>");
    expect(html).not.toContain("Contains");
  });

  it("renders a table with an object namespace (not a column array) and skips the column list", () => {
    const item: ResolvedNamespaceItem = {
      path: ["sch", "t"],
      type: "completion",
      semanticType: "table",
      completion: { label: "t", detail: "a table" },
      namespace: { self: { label: "t" }, children: ["a"] } as SQLNamespace,
    };
    const html = render(item);
    expect(html).toContain("Table: a table");
    expect(html).toContain("Schema:</strong> <code>sch</code>");
    expect(html).not.toContain("sql-hover-columns");
  });

  it("uses singular table wording for a schema with exactly one table", () => {
    const item: ResolvedNamespaceItem = {
      path: ["db", "public"],
      type: "namespace",
      semanticType: "schema",
      namespace: { users: ["id"] },
    };
    const html = render(item);
    expect(html).toContain("Contains 1 table");
    expect(html).not.toContain("1 tables");
  });

  it("renders a database with an empty namespace and no children line", () => {
    const item: ResolvedNamespaceItem = {
      path: ["db"],
      type: "namespace",
      semanticType: "database",
      namespace: {} as SQLNamespace,
    };
    const html = render(item);
    expect(html).toContain("Database</div>");
    expect(html).not.toContain("Contains");
  });

  it("renders a schema with an empty path and empty namespace", () => {
    const item: ResolvedNamespaceItem = {
      path: [],
      type: "namespace",
      semanticType: "schema",
      namespace: {} as SQLNamespace,
    };
    const html = render(item);
    expect(html).toContain("Schema</div>");
    // No path segment and no children => neither block is rendered
    expect(html).not.toContain("sql-hover-path");
    expect(html).not.toContain("Contains");
  });

  it("renders a table with an empty path and no schema line", () => {
    const item: ResolvedNamespaceItem = {
      path: [],
      type: "namespace",
      semanticType: "table",
      namespace: ["id"] as SQLNamespace,
    };
    const html = render(item);
    expect(html).toContain("Table</div>");
    expect(html).not.toContain("Schema:");
    expect(html).toContain("Columns (1)");
  });

  it("renders the default namespace branch with a detail and child count", () => {
    const item: ResolvedNamespaceItem = {
      path: ["misc"],
      type: "completion",
      semanticType: "namespace",
      completion: { label: "misc", detail: "misc ns" },
      namespace: { a: ["x"], b: ["y"] } as SQLNamespace,
    };
    const html = render(item);
    expect(html).toContain("Namespace: misc ns");
    expect(html).toContain("Contains 2 items");
  });
});

describe("defaultSqlHoverTheme", () => {
  it("builds a light theme by default", () => {
    expect(defaultSqlHoverTheme()).toBeDefined();
    expect(defaultSqlHoverTheme("light")).toBeDefined();
  });

  it("builds a dark theme when requested", () => {
    expect(defaultSqlHoverTheme("dark")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Hover source `create` path (produces the tooltip DOM)
// ---------------------------------------------------------------------------

describe("hover source tooltip DOM creation", () => {
  function mockView(doc: string): EditorView {
    const state = EditorState.create({ doc });
    return { state } as unknown as EditorView;
  }

  const schema: SQLNamespace = {
    users: ["id", "username", "email"],
    orders: ["id", "total"],
  };

  async function hoverWord(
    doc: string,
    word: string,
    config: Parameters<typeof createHoverSource>[0] = {},
    side = 1,
  ) {
    const source = createHoverSource({ schema, ...config });
    const view = mockView(doc);
    const pos = doc.indexOf(word) + 2;
    const tooltip = await source(view, pos, side);
    return { tooltip, view };
  }

  it("renders a default table tooltip DOM when hovering a table", async () => {
    const { tooltip, view } = await hoverWord("SELECT id FROM users", "users");
    expect(tooltip).not.toBeNull();
    const { dom } = tooltip!.create(view);
    expect(dom.className).toBe("cm-sql-hover-tooltip");
    expect(dom.innerHTML).toContain("users");
    expect(dom.innerHTML).toContain("table");
  });

  it("renders a default column tooltip DOM when hovering a column", async () => {
    const { tooltip, view } = await hoverWord("SELECT username FROM users", "username");
    expect(tooltip).not.toBeNull();
    const { dom } = tooltip!.create(view);
    expect(dom.innerHTML).toContain("username");
    expect(dom.innerHTML).toContain("column");
  });

  it("renders a default keyword tooltip DOM", async () => {
    const { tooltip, view } = await hoverWord("SELECT id FROM users", "SELECT", {
      keywords: { select: { description: "Selects rows" } },
    });
    expect(tooltip).not.toBeNull();
    const { dom } = tooltip!.create(view);
    expect(dom.innerHTML).toContain("SELECT");
    expect(dom.innerHTML).toContain("Selects rows");
  });

  it("uses a custom tooltipRender when it returns an element", async () => {
    const custom = document.createElement("span");
    custom.textContent = "custom!";
    const { tooltip, view } = await hoverWord("SELECT id FROM users", "users", {
      tooltipRender: () => custom,
    });
    const { dom } = tooltip!.create(view);
    expect(dom).toBe(custom);
  });

  it("falls back to the default renderer when tooltipRender returns null", async () => {
    const { tooltip, view } = await hoverWord("SELECT id FROM users", "users", {
      tooltipRender: () => null,
    });
    const { dom } = tooltip!.create(view);
    expect(dom.className).toBe("cm-sql-hover-tooltip");
    expect(dom.innerHTML).toContain("users");
  });

  it("uses a custom table renderer for table items", async () => {
    const table = vi.fn().mockReturnValue("<div>custom table</div>");
    const { tooltip, view } = await hoverWord("SELECT id FROM users", "users", {
      tooltipRenderers: { table },
    });
    const { dom } = tooltip!.create(view);
    expect(table).toHaveBeenCalledOnce();
    expect(dom.innerHTML).toContain("custom table");
  });

  it("uses a custom column renderer for column items", async () => {
    const column = vi.fn().mockReturnValue("<div>custom column</div>");
    const { tooltip, view } = await hoverWord("SELECT username FROM users", "username", {
      tooltipRenderers: { column },
    });
    const { dom } = tooltip!.create(view);
    expect(column).toHaveBeenCalledOnce();
    expect(dom.innerHTML).toContain("custom column");
  });

  it("uses a custom keyword renderer for keyword items", async () => {
    const keyword = vi.fn().mockReturnValue("<div>custom keyword</div>");
    const { tooltip, view } = await hoverWord("SELECT id FROM users", "SELECT", {
      keywords: { select: { description: "Selects rows" } },
      tooltipRenderers: { keyword },
    });
    const { dom } = tooltip!.create(view);
    expect(keyword).toHaveBeenCalledOnce();
    expect(dom.innerHTML).toContain("custom keyword");
  });

  it("returns an empty div when a custom renderer yields no content", async () => {
    const { tooltip, view } = await hoverWord("SELECT id FROM users", "users", {
      tooltipRenderers: { table: () => "" },
    });
    const { dom } = tooltip!.create(view);
    expect(dom.className).toBe("");
    expect(dom.innerHTML).toBe("");
  });

  it("returns null when the pointer sits just before a word (side < 0)", async () => {
    const source = createHoverSource({ schema });
    const doc = "SELECT id FROM users";
    const view = mockView(doc);
    const tooltip = await source(view, doc.indexOf("users"), -1);
    expect(tooltip).toBeNull();
  });

  it("falls back to the full schema when the query has no parseable tables", async () => {
    // "users" alone is not a valid query, so no table refs are extracted;
    // the resolver must fall back to the full schema to still show the table.
    const { tooltip, view } = await hoverWord("users", "users");
    expect(tooltip).not.toBeNull();
    const { dom } = tooltip!.create(view);
    expect(dom.innerHTML).toContain("users");
  });

  it("returns null when nothing matches", async () => {
    const source = createHoverSource({ schema, keywords: {} });
    const doc = "SELECT zzz FROM users";
    const view = mockView(doc);
    const tooltip = await source(view, doc.indexOf("zzz") + 1, 1);
    expect(tooltip).toBeNull();
  });

  it("respects enableKeywords: false", async () => {
    const source = createHoverSource({
      schema: {},
      keywords: { select: { description: "Selects rows" } },
      enableKeywords: false,
    });
    const doc = "SELECT id FROM users";
    const view = mockView(doc);
    const tooltip = await source(view, doc.indexOf("SELECT") + 2, 1);
    expect(tooltip).toBeNull();
  });

  it("renders a default namespace tooltip DOM for a nested namespace item", async () => {
    const nestedSchema: SQLNamespace = { mydb: { public: { users: ["id", "name"] } } };
    const source = createHoverSource({ schema: nestedSchema, keywords: {} });
    // "mydb" alone is not a parseable query, so the resolver falls back to the
    // full schema and resolves the bare namespace name.
    const doc = "mydb";
    const view = mockView(doc);
    const tooltip = await source(view, 2, 1);
    expect(tooltip).not.toBeNull();
    const { dom } = tooltip!.create(view);
    expect(dom.className).toBe("cm-sql-hover-tooltip");
    expect(dom.innerHTML).toContain("<strong>mydb</strong>");
    expect(dom.innerHTML).toContain("namespace");
  });

  it("uses a custom namespace renderer for namespace/schema/database items", async () => {
    const namespace = vi.fn().mockReturnValue("<div>custom namespace</div>");
    const nestedSchema: SQLNamespace = { mydb: { public: { users: ["id"] } } };
    const source = createHoverSource({
      schema: nestedSchema,
      keywords: {},
      tooltipRenderers: { namespace },
    });
    const doc = "mydb";
    const view = mockView(doc);
    const tooltip = await source(view, 2, 1);
    expect(tooltip).not.toBeNull();
    const { dom } = tooltip!.create(view);
    expect(namespace).toHaveBeenCalledOnce();
    expect(dom.innerHTML).toContain("custom namespace");
  });

  it("prepends the alias notice to the default tooltip when hovering a bare alias", async () => {
    const source = createHoverSource({ schema, keywords: {} });
    const doc = "SELECT u.id FROM users u";
    const view = mockView(doc);
    const tooltip = await source(view, doc.length - 1, 1);
    expect(tooltip).not.toBeNull();
    const { dom } = tooltip!.create(view);
    expect(dom.innerHTML).toContain("sql-hover-alias");
    expect(dom.innerHTML).toContain("is an alias for");
    expect(dom.innerHTML).toContain("<code>u</code>");
    expect(dom.innerHTML).toContain("<code>users</code>");
  });
});
