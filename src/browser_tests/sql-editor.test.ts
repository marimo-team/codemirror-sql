import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { basicSetup, EditorView } from "codemirror";
import { expect, test } from "vitest";
import { NodeSqlParser, sqlExtension } from "../index.js";

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
