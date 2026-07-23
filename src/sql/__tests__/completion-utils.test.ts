import type { Completion, CompletionContext } from "@codemirror/autocomplete";
import type { SQLNamespace } from "@codemirror/lang-sql";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { columnsOf, findTableColumns, resolveSchema, toCompletion } from "../completion-utils.js";
import { sqlSchemaFacet } from "../schema-facet.js";
import { createCompletionContext, createState } from "./test-utils.js";

describe("resolveSchema", () => {
  it("returns an explicitly provided namespace as-is", () => {
    const schema: SQLNamespace = { users: ["id"] };
    const context = createCompletionContext("SELECT ");
    expect(resolveSchema(schema, context)).toBe(schema);
  });

  it("falls back to the schema facet when no explicit source is given", () => {
    const schema: SQLNamespace = { users: ["id"] };
    const context = createCompletionContext("SELECT ", {
      extensions: [sqlSchemaFacet.of(schema)],
    });
    expect(resolveSchema(undefined, context)).toBe(schema);
  });

  it("returns null when neither an explicit source nor a facet is present", () => {
    const context = createCompletionContext("SELECT ");
    expect(resolveSchema(undefined, context)).toBeNull();
  });

  it("returns null for a function source when the context has no view", () => {
    // Contexts created without an editor (as in unit tests) get no schema
    const source = vi.fn(() => ({ users: ["id"] }) as SQLNamespace);
    const context = createCompletionContext("SELECT ");
    expect(resolveSchema(source, context)).toBeNull();
    expect(source).not.toHaveBeenCalled();
  });

  it("invokes a function source with the view when one is present", () => {
    const schema: SQLNamespace = { users: ["id"] };
    const view = {} as EditorView;
    const source = vi.fn(() => schema);
    // Minimal context carrying a view — resolveSchema only reads `state`/`view`
    const context = { state: createState("SELECT "), view } as unknown as CompletionContext;

    expect(resolveSchema(source, context)).toBe(schema);
    expect(source).toHaveBeenCalledWith(view);
  });
});

describe("columnsOf", () => {
  it("returns null for a nullish namespace", () => {
    expect(columnsOf(undefined)).toBeNull();
  });

  it("returns the array itself for an array namespace", () => {
    const columns = ["id", "name"];
    expect(columnsOf(columns)).toBe(columns);
  });

  it("unwraps the children of a self/children namespace", () => {
    const children = ["id", "name"];
    const namespace = { self: { label: "users" }, children } as unknown as SQLNamespace;
    expect(columnsOf(namespace)).toBe(children);
  });

  it("returns null for an object (non-column) namespace", () => {
    expect(columnsOf({ users: ["id"] } as SQLNamespace)).toBeNull();
  });

  it("returns null when a self/children node wraps a non-array child", () => {
    const namespace = {
      self: { label: "db" },
      children: { users: ["id"] },
    } as unknown as SQLNamespace;
    expect(columnsOf(namespace)).toBeNull();
  });
});

describe("findTableColumns", () => {
  const schema: SQLNamespace = {
    users: ["id", "username", "email"],
    orders: ["order_id", "total"],
  };

  it("resolves a simple table name (case-insensitively)", () => {
    expect(findTableColumns(schema, "users")).toEqual(["id", "username", "email"]);
    expect(findTableColumns(schema, "USERS")).toEqual(["id", "username", "email"]);
  });

  it("resolves a fully-qualified path", () => {
    const nested: SQLNamespace = { mydb: { users: ["id", "name"] } };
    expect(findTableColumns(nested, "mydb.users")).toEqual(["id", "name"]);
  });

  it("resolves an under-qualified name to a table nested deeper", () => {
    const nested: SQLNamespace = { mydb: { users: ["id", "name"] } };
    expect(findTableColumns(nested, "users")).toEqual(["id", "name"]);
  });

  it("resolves via pre-split segments (preserving dotted identifiers)", () => {
    const nested: SQLNamespace = { "my.db": { users: ["id"] } };
    expect(findTableColumns(nested, ["my.db", "users"])).toEqual(["id"]);
  });

  it("returns null for an unknown table", () => {
    expect(findTableColumns(schema, "missing")).toBeNull();
  });

  it("returns null when the last segment is empty", () => {
    // A path that reduces to no final segment cannot resolve
    expect(findTableColumns(schema, [])).toBeNull();
    expect(findTableColumns(schema, "")).toBeNull();
  });

  it("returns null when an under-qualified name is ambiguous", () => {
    const ambiguous: SQLNamespace = {
      db1: { users: ["id", "a"] },
      db2: { users: ["id", "b"] },
    };
    // `users` exists under two catalogs — refuse to guess
    expect(findTableColumns(ambiguous, "users")).toBeNull();
  });

  it("returns null when the qualified path is longer than any match", () => {
    const nested: SQLNamespace = { mydb: { users: ["id"] } };
    // `other.users` — the suffix does not match the `mydb.users` path
    expect(findTableColumns(nested, "other.users")).toBeNull();
  });
});

describe("toCompletion", () => {
  it("wraps a string column with the property type and detail", () => {
    expect(toCompletion("id", "column")).toEqual({
      label: "id",
      type: "property",
      detail: "column",
    });
  });

  it("adds a boost to a string column when provided", () => {
    expect(toCompletion("id", "column", 5)).toEqual({
      label: "id",
      type: "property",
      detail: "column",
      boost: 5,
    });
  });

  it("preserves an existing Completion detail and forces the property type", () => {
    const column: Completion = { label: "id", type: "keyword", detail: "Primary key" };
    expect(toCompletion(column, "fallback")).toEqual({
      label: "id",
      type: "property",
      detail: "Primary key",
    });
  });

  it("uses the fallback detail when the Completion has none", () => {
    const column: Completion = { label: "id" };
    expect(toCompletion(column, "fallback")).toMatchObject({
      label: "id",
      type: "property",
      detail: "fallback",
    });
  });

  it("applies a boost to a Completion only when it has none of its own", () => {
    expect(toCompletion({ label: "id" }, "d", 3).boost).toBe(3);
    expect(toCompletion({ label: "id", boost: 9 }, "d", 3).boost).toBe(9);
  });
});
