import { currentCompletions, startCompletion } from "@codemirror/autocomplete";
import { MariaSQL, MySQL, PostgreSQL, SQLite } from "@codemirror/lang-sql";
import { forceLinting, forEachDiagnostic } from "@codemirror/lint";
import { expect, onTestFinished, test } from "vitest";
import { userEvent } from "vitest/browser";
import demoHtml from "../../demo/index.html?raw";
import { getDatabase, initializeEditor } from "../../demo/index.js";
import { DuckDBDialect } from "../dialects/duckdb/duckdb.js";

const dialects = [
  { value: "PostgreSQL", database: "PostgreSQL", language: PostgreSQL, query: "SELECT id FROM users" },
  { value: "MySQL", database: "MySQL", language: MySQL, query: "SELECT id FROM users LIMIT 1, 2" },
  { value: "SQLite", database: "Sqlite", language: SQLite, query: "SELECT id FROM users LIMIT 1, 2" },
  { value: "MariaDB", database: "MariaDB", language: MariaSQL, query: "SELECT id FROM users LIMIT 1, 2" },
  { value: "Snowflake", database: "Snowflake", language: PostgreSQL, query: "SELECT TOP 1 id FROM users" },
  { value: "DuckDB", database: "DuckDB", language: DuckDBDialect, query: "FROM users SELECT * LIMIT 100" },
];

function mountDemo() {
  const main = new DOMParser().parseFromString(demoHtml, "text/html").querySelector("main");
  if (!main) throw new Error("Demo markup is missing its main element");
  document.body.appendChild(main);
  const editor = initializeEditor();
  onTestFinished(() => {
    editor.destroy();
    main.remove();
  });
  const select = main.querySelector("#database-select");
  if (!(select instanceof HTMLSelectElement)) throw new Error("Demo is missing its dialect selector");
  return { editor, select };
}

test.each(dialects)("demo $value updates parsing, language, and completion", async (dialect) => {
  const { editor, select } = mountDemo();
  expect([...select.options].map((option) => option.value)).toEqual(dialects.map((option) => option.value));

  await userEvent.selectOptions(select, dialect.value === "MySQL" ? "PostgreSQL" : "MySQL");
  await userEvent.selectOptions(select, dialect.value);
  expect(select.value).toBe(dialect.value);
  expect(getDatabase(editor.state)).toBe(dialect.database);
  expect(dialect.language.language.isActiveAt(editor.state, 0)).toBe(true);

  const messages = () => {
    const result: string[] = [];
    forEachDiagnostic(editor.state, (diagnostic) => result.push(diagnostic.message));
    return result;
  };
  const setDoc = (doc: string, pos = 0) => editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: doc },
    selection: { anchor: pos },
  });
  setDoc("SELECT * FROM;");
  forceLinting(editor);
  await expect.poll(messages).not.toHaveLength(0);
  setDoc(dialect.query);
  forceLinting(editor);
  await expect.poll(messages).toEqual([]);

  const doc = "WITH recent AS (SELECT email FROM users) SELECT r. FROM recent r";
  setDoc(doc, doc.indexOf("r. FROM") + 2);
  editor.focus();
  expect(startCompletion(editor)).toBe(true);
  await expect.poll(() => currentCompletions(editor.state).some(
    (option) => option.label === "email" && option.detail === "column of recent",
  )).toBe(true);
  expect(editor.dom.querySelector(".cm-tooltip-autocomplete")).not.toBeNull();
}, 10000);
