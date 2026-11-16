import { type Diagnostic, forEachDiagnostic } from "@codemirror/lint";
import { StateEffect, StateField } from "@codemirror/state";
import { userEvent } from "vitest/browser";
import { acceptCompletion, currentCompletions, startCompletion } from "@codemirror/autocomplete";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { basicSetup, EditorView } from "codemirror";
import { expect, onTestFinished, test, vi } from "vitest";
import { createSqlAnalysis, NodeSqlParser, sqlCompletion, sqlExtension, type SupportedDialects } from "../index.js";

const schema: Record<string, string[]> = {
  users: ["id", "name", "email", "active", "status", "created_at"],
  posts: ["id", "title", "content", "user_id", "published", "created_at"],
  orders: ["id", "customer_id", "order_date", "total_amount", "status"],
  customers: ["id", "first_name", "last_name", "email", "phone"],
  categories: ["id", "name", "description", "parent_id"],
  tbl: ["id", "name"],
};

function initializeEditor(container: HTMLElement) {
  const parser = new NodeSqlParser({
    getParserOptions: () => {
      return {
        database: "PostgreSQL",
      };
    },
  });

  const extensions = [
    basicSetup,
    EditorView.lineWrapping,
    sql({
      dialect: PostgreSQL,
      schema: schema,
      upperCaseKeywords: true,
    }),
    sqlExtension({
      linterConfig: {
        delay: 250,
        parser,
      },
      gutterConfig: {
        backgroundColor: "#3b82f6",
        errorBackgroundColor: "#ef4444",
        hideWhenNotFocused: true,
        parser,
      },
      enableHover: false,
    }),
  ];

  const editor = new EditorView({
    doc: "",
    extensions,
    parent: container,
  });

  return editor;
}

test("SQL editor with input", { timeout: 5000 }, async () => {
  const container = document.createElement("div");
  container.id = "sql-editor-test";
  container.style.width = "800px";
  container.style.height = "400px";
  document.body.appendChild(container);

  const editor = initializeEditor(container);
  onTestFinished(() => {
    editor.destroy();
    container.remove();
  });

  const sqlText = "select * from tbl\n inner join";

  editor.dispatch({
    changes: {
      from: 0,
      to: editor.state.doc.length,
      insert: sqlText,
    },
    selection: {
      anchor: sqlText.length,
      head: sqlText.length,
    },
  });

  editor.focus();

  // Wait a moment for potential browser freeze
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // If we get here, test should complete quickly
  const content = editor.state.doc.toString();
  expect(content).toBe(sqlText);
});

test("completes a column using the current editor view's schema", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const schemaSource = vi.fn((_view: EditorView) => schema);
  const editor = new EditorView({
    doc: "SELECT e FROM users",
    selection: { anchor: "SELECT e".length },
    extensions: [
      basicSetup,
      sql({ dialect: PostgreSQL }),
      sqlCompletion({ dialect: PostgreSQL, schema: schemaSource }),
    ],
    parent: container,
  });
  onTestFinished(() => {
    editor.destroy();
    container.remove();
  });

  editor.focus();
  expect(startCompletion(editor)).toBe(true);
  await expect.poll(() => currentCompletions(editor.state).map((option) => option.label))
    .toContain("email");
  expect(schemaSource).toHaveBeenCalledWith(editor);
  expect(container.querySelector(".cm-tooltip-autocomplete")).not.toBeNull();
  await expect.poll(() => acceptCompletion(editor)).toBe(true);
  expect(editor.state.doc.toString()).toBe("SELECT email FROM users");
});

test("renames an alias through F2 and restores the statement with undo", async () => {
  const doc = "SELECT u.id FROM users u WHERE u.active";
  const editor = new EditorView({
    doc,
    selection: { anchor: doc.indexOf("u.id") },
    extensions: [basicSetup, sqlExtension({
      enableLinting: false,
      enableSemanticLinting: false,
      enableGutterMarkers: false,
      enableHover: false,
      navigationConfig: { keymap: true, prompt: () => "account" },
    })],
    parent: document.body,
  });
  onTestFinished(() => editor.destroy());
  editor.focus();
  await userEvent.keyboard("{F2}");
  await expect.poll(() => editor.state.doc.toString()).toBe("SELECT account.id FROM users account WHERE account.active");
  const modifier = /Mac/.test(navigator.platform) ? "Meta" : "Control";
  await userEvent.keyboard(`{${modifier}>}z{/${modifier}}`);
  await expect.poll(() => editor.state.doc.toString()).toBe(doc);
});

test("updates syntax diagnostics and gutter validity when only the dialect changes", async () => {
  const setDialect = StateEffect.define<SupportedDialects>();
  const dialect = StateField.define<SupportedDialects>({
    create: () => "PostgreSQL",
    update: (value, transaction) => transaction.effects.find((effect) => effect.is(setDialect))?.value ?? value,
  });
  const analysis = createSqlAnalysis({ parser: new NodeSqlParser({
    getParserOptions: (state) => ({ database: state.field(dialect) }),
  }) });
  const doc = "SELECT id FROM users LIMIT 1, 2";
  const editor = new EditorView({
    doc,
    extensions: [basicSetup, dialect, sqlExtension({
      ...analysis,
      needsRefresh: (update) => update.startState.field(dialect) !== update.state.field(dialect),
      linterConfig: { delay: 0 },
      enableSemanticLinting: false,
      enableHover: false,
      enableNavigation: false,
    })],
    parent: document.body,
  });
  onTestFinished(() => editor.destroy());
  const diagnostics = () => {
    const result: Diagnostic[] = [];
    forEachDiagnostic(editor.state, (diagnostic) => result.push(diagnostic));
    return result;
  };
  const markerColor = () => editor.dom.querySelector<HTMLElement>(".cm-sql-gutter-marker")?.style.background;
  await expect.poll(diagnostics).toHaveLength(1);
  await expect.poll(markerColor).toBe("rgb(239, 68, 68)");
  editor.dispatch({ effects: setDialect.of("MySQL") });
  await expect.poll(diagnostics).toHaveLength(0);
  await expect.poll(markerColor).toBe("rgb(59, 130, 246)");
  expect(editor.state.doc.toString()).toBe(doc);
});

test("moving the cursor updates reference highlights without reparsing the document", async () => {
  const parser = new NodeSqlParser({ getParserOptions: () => ({ database: "PostgreSQL" }) });
  const parse = vi.spyOn(parser, "parse");
  const doc = Array.from({ length: 10 }, (_, i) => `SELECT u.id FROM users u WHERE u.id = ${i};`).join("\n");
  const editor = new EditorView({
    doc,
    selection: { anchor: doc.indexOf("u.id") },
    extensions: [basicSetup, sql({ dialect: PostgreSQL }), sqlExtension({
      parser,
      schema,
      linterConfig: { delay: 0 },
      semanticLinterConfig: { delay: 0 },
      navigationConfig: { highlightDelay: 0 },
    })],
    parent: document.body,
  });
  onTestFinished(() => editor.destroy());
  editor.focus();
  const highlights = () => editor.dom.querySelectorAll(".cm-sqlReference").length;
  await expect.poll(highlights).toBe(3);
  expect(parse).toHaveBeenCalledTimes(10);

  await userEvent.keyboard("{ArrowRight}{ArrowRight}");
  await expect.poll(highlights).toBe(0);
  expect(parse).toHaveBeenCalledTimes(10);

  await userEvent.keyboard("{ArrowLeft}");
  await expect.poll(highlights).toBe(3);
  expect(parse).toHaveBeenCalledTimes(10);
});
