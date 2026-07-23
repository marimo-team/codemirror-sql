import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  gotoSqlDefinition,
  renameSqlIdentifier,
  sqlGotoDefinition,
  sqlHighlightReferences,
  sqlNavigation,
  sqlNavigationKeymap,
} from "../navigation-extension.js";

/**
 * A minimal stand-in for EditorView: enough for the navigation commands,
 * which only read `state` and call `dispatch`.
 */
function createFakeView(doc: string, cursor: number) {
  const dispatched: TransactionSpec[] = [];
  const view = {
    state: EditorState.create({ doc, selection: { anchor: cursor } }),
    dispatch(spec: TransactionSpec) {
      dispatched.push(spec);
      this.state = this.state.update(spec).state;
    },
  };
  return { view: view as unknown as EditorView, dispatched, doc: () => view.state.doc.toString() };
}

describe("extension composition", () => {
  it("sqlNavigation returns highlight + goto extensions", () => {
    const extensions = sqlNavigation();
    expect(extensions).toHaveLength(2);
    expect(() => EditorState.create({ extensions })).not.toThrow();
  });

  it("includes the keymap only when opted in", () => {
    expect(sqlNavigation({ keymap: true })).toHaveLength(3);
  });

  it("individual extensions create cleanly", () => {
    for (const extension of [
      sqlHighlightReferences(),
      sqlGotoDefinition(),
      sqlNavigationKeymap(),
    ]) {
      expect(() => EditorState.create({ extensions: [extension] })).not.toThrow();
    }
  });
});

describe("gotoSqlDefinition", () => {
  it("jumps from a CTE use to its definition", async () => {
    const sql = "WITH recent AS (SELECT 1) SELECT * FROM recent";
    const use = sql.lastIndexOf("recent");
    const { view, dispatched } = createFakeView(sql, use);

    expect(await gotoSqlDefinition(view)).toBe(true);
    expect(dispatched).toHaveLength(1);
    const definitionFrom = sql.indexOf("recent");
    expect(view.state.selection.main.from).toBe(definitionFrom);
    expect(view.state.selection.main.to).toBe(definitionFrom + "recent".length);
  });

  it("jumps from an alias qualifier to the alias token", async () => {
    const sql = "SELECT u.name FROM users u";
    const { view } = createFakeView(sql, sql.indexOf("u.name"));

    expect(await gotoSqlDefinition(view)).toBe(true);
    expect(view.state.selection.main.from).toBe(sql.indexOf("users u") + "users ".length);
  });

  it("returns false on unresolvable identifiers without dispatching", async () => {
    const sql = "SELECT name FROM users";
    const { view, dispatched } = createFakeView(sql, sql.indexOf("users"));

    expect(await gotoSqlDefinition(view)).toBe(false);
    expect(dispatched).toHaveLength(0);
  });
});

describe("renameSqlIdentifier", () => {
  it("renames a CTE's definition and all references in one transaction", async () => {
    const sql = "WITH recent AS (SELECT x FROM logs) SELECT r.x FROM recent r JOIN recent r2 ON 1=1";
    const { view, dispatched, doc } = createFakeView(sql, sql.indexOf("recent"));

    const renamed = await renameSqlIdentifier(view, { prompt: () => "latest" });
    expect(renamed).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(doc()).toBe(
      "WITH latest AS (SELECT x FROM logs) SELECT r.x FROM latest r JOIN latest r2 ON 1=1",
    );
  });

  it("renames a table alias definition and its qualifier uses", async () => {
    const sql = "SELECT u.name FROM users u WHERE u.active";
    const { view, doc } = createFakeView(sql, sql.indexOf("u.name"));

    expect(await renameSqlIdentifier(view, { prompt: () => "usr" })).toBe(true);
    expect(doc()).toBe("SELECT usr.name FROM users usr WHERE usr.active");
  });

  it("does not touch same-named identifiers in other statements", async () => {
    const sql = "WITH t AS (SELECT 1) SELECT * FROM t;\nWITH t AS (SELECT 2) SELECT * FROM t";
    const { view, doc } = createFakeView(sql, sql.lastIndexOf("t"));

    expect(await renameSqlIdentifier(view, { prompt: () => "u" })).toBe(true);
    expect(doc()).toBe("WITH t AS (SELECT 1) SELECT * FROM t;\nWITH u AS (SELECT 2) SELECT * FROM u");
  });

  it("does not touch same-named identifiers inside string literals", async () => {
    const sql = "WITH t AS (SELECT 1) SELECT * FROM t WHERE name = 't'";
    const { view, doc } = createFakeView(sql, sql.indexOf("t AS"));

    expect(await renameSqlIdentifier(view, { prompt: () => "u" })).toBe(true);
    expect(doc()).toBe("WITH u AS (SELECT 1) SELECT * FROM u WHERE name = 't'");
  });

  it("refuses when the identifier is not resolvable", async () => {
    const sql = "SELECT name FROM users";
    const { view, dispatched } = createFakeView(sql, sql.indexOf("users"));

    expect(await renameSqlIdentifier(view, { prompt: () => "people" })).toBe(false);
    expect(dispatched).toHaveLength(0);
  });

  it("refuses when the prompt is cancelled", async () => {
    const sql = "WITH t AS (SELECT 1) SELECT * FROM t";
    const { view, dispatched } = createFakeView(sql, sql.indexOf("t AS"));

    expect(await renameSqlIdentifier(view, { prompt: () => null })).toBe(false);
    expect(dispatched).toHaveLength(0);
  });

  it("refuses reserved words as new names", async () => {
    const sql = "WITH t AS (SELECT 1) SELECT * FROM t";
    const { view, dispatched } = createFakeView(sql, sql.indexOf("t AS"));

    expect(await renameSqlIdentifier(view, { prompt: () => "select" })).toBe(false);
    expect(dispatched).toHaveLength(0);
  });

  it("refuses invalid identifiers as new names", async () => {
    const sql = "WITH t AS (SELECT 1) SELECT * FROM t";
    const { view, dispatched } = createFakeView(sql, sql.indexOf("t AS"));

    expect(await renameSqlIdentifier(view, { prompt: () => "not valid!" })).toBe(false);
    expect(dispatched).toHaveLength(0);
  });

  it("refuses when the document changed while prompting", async () => {
    const sql = "WITH t AS (SELECT 1) SELECT * FROM t";
    const { view, dispatched } = createFakeView(sql, sql.indexOf("t AS"));

    const result = await renameSqlIdentifier(view, {
      prompt: () => {
        view.dispatch({ changes: { from: sql.length, to: sql.length, insert: " -- x" } });
        return "u";
      },
    });
    expect(result).toBe(false);
    // Only the edit made inside the prompt was dispatched, no rename
    expect(dispatched).toHaveLength(1);
  });
});
