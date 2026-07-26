import { EditorView } from "@codemirror/view";
import { expect, onTestFinished, test } from "vitest";
import {
  createSqlLanguageService,
  duckdbDialect,
} from "../../index.js";
import { sqlEditor } from "../index.js";

test("standard statement gutter follows the current statement", async () => {
  const parent = document.createElement("div");
  parent.style.height = "240px";
  document.body.append(parent);
  onTestFinished(() => parent.remove());
  const service = createSqlLanguageService({
    dialects: [duckdbDialect()],
  });
  onTestFinished(() => service.dispose());
  const support = sqlEditor({
    initialContext: { dialect: "duckdb" },
    service,
    statementGutter: {},
  });
  const documentText = "SELECT 1;\n\n/* separator */\nSELECT 2;";
  const view = new EditorView({
    doc: documentText,
    extensions: support.extension,
    parent,
    selection: { anchor: documentText.length },
  });
  onTestFinished(() => view.destroy());
  view.focus();

  await expect.poll(() =>
    view.dom.querySelectorAll(".cm-sql-statement-marker").length
  ).toBe(2);
  expect(
    view.dom.querySelectorAll(".cm-sql-statement-marker-active"),
  ).toHaveLength(1);
  expect(Array.from(
    view.dom.querySelectorAll(".cm-sql-statement-marker"),
  ).findIndex((marker) =>
    marker.classList.contains("cm-sql-statement-marker-active")
  )).toBe(1);

  view.dispatch({ selection: { anchor: 1 } });
  await expect.poll(() => {
    const markers = Array.from(
      view.dom.querySelectorAll(".cm-sql-statement-marker"),
    );
    return markers.findIndex((marker) =>
      marker.classList.contains("cm-sql-statement-marker-active")
    );
  }).toBe(0);
});

test("standard statement gutter virtualizes a tall focused editor", async () => {
  const parent = document.createElement("div");
  parent.style.height = "120px";
  parent.style.setProperty(
    "--cm-sql-statement-color",
    "rgb(1, 2, 3)",
  );
  document.body.append(parent);
  onTestFinished(() => parent.remove());
  const service = createSqlLanguageService({
    dialects: [duckdbDialect()],
  });
  onTestFinished(() => service.dispose());
  const support = sqlEditor({
    initialContext: { dialect: "duckdb" },
    service,
    statementGutter: { hideWhenNotFocused: true },
  });
  const documentText = Array.from(
    { length: 200 },
    (_, index) => `SELECT\n\n  ${index};`,
  ).join("\n/* separator */\n");
  const view = new EditorView({
    doc: documentText,
    extensions: support.extension,
    parent,
  });
  onTestFinished(() => view.destroy());

  expect(
    view.dom.querySelectorAll(".cm-sql-statement-marker"),
  ).toHaveLength(0);
  view.focus();
  await expect.poll(() =>
    view.dom.querySelectorAll(".cm-sql-statement-marker").length
  ).toBeGreaterThan(0);
  const initialCount = view.dom.querySelectorAll(
    ".cm-sql-statement-marker",
  ).length;
  expect(initialCount).toBeLessThan(200);
  const marker = view.dom.querySelector<HTMLElement>(
    ".cm-sql-statement-marker",
  );
  expect(marker).not.toBeNull();
  expect(getComputedStyle(marker!).width).toBe("3px");
  expect(getComputedStyle(marker!).backgroundColor).toBe(
    "rgb(1, 2, 3)",
  );

  view.dispatch({
    effects: EditorView.scrollIntoView(documentText.length, {
      y: "start",
    }),
    selection: { anchor: documentText.length },
  });
  await expect.poll(() => view.viewport.from).toBeGreaterThan(0);
  await expect.poll(() =>
    view.dom.querySelectorAll(
      ".cm-sql-statement-marker-active",
    ).length
  ).toBe(3);
  expect(
    view.dom.querySelectorAll(".cm-sql-statement-marker").length,
  ).toBeLessThan(200);
});
