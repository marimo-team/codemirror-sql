import type { CompletionSource } from "@codemirror/autocomplete";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { sqlCompletion } from "../completion-extension.js";

const schema = { users: ["id", "name", "email"] };

/** Collect the `autocomplete` completion sources registered on the language. */
type EditorStateConfig = NonNullable<Parameters<typeof EditorState.create>[0]>;
type EditorExtension = NonNullable<EditorStateConfig["extensions"]>;

function autocompleteSources(...extensions: EditorExtension[]) {
  const state = EditorState.create({
    doc: "SELECT ",
    extensions: [sql({ dialect: PostgreSQL, schema }), ...extensions],
  });
  return state
    .languageDataAt<CompletionSource>("autocomplete", state.doc.length)
    .filter((value) => typeof value === "function");
}

describe("sqlCompletion", () => {
  it("registers all three completion sources by default", () => {
    // Baseline: lang-sql registers its own schema-based autocomplete source
    const baseline = autocompleteSources().length;
    const withHelper = autocompleteSources(
      sqlCompletion({ dialect: PostgreSQL, schema }),
    ).length;
    expect(withHelper - baseline).toBe(3);
  });

  it("omits sources that are disabled", () => {
    const baseline = autocompleteSources().length;
    const withHelper = autocompleteSources(
      sqlCompletion({
        dialect: PostgreSQL,
        schema,
        enableAliasCompletion: false,
        enableColumnCompletion: false,
      }),
    ).length;
    expect(withHelper - baseline).toBe(1);
  });

  it("returns no extra sources when everything is disabled", () => {
    const baseline = autocompleteSources().length;
    const withHelper = autocompleteSources(
      sqlCompletion({
        dialect: PostgreSQL,
        schema,
        enableCteCompletion: false,
        enableAliasCompletion: false,
        enableColumnCompletion: false,
      }),
    ).length;
    expect(withHelper - baseline).toBe(0);
  });
});
