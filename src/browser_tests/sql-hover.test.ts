import { forEachDiagnostic } from "@codemirror/lint";
import { createSqlAnalysis, sqlExtension } from "../index.js";
import { sql } from "@codemirror/lang-sql";
import { Decoration, EditorView } from "@codemirror/view";
import { expect, onTestFinished, test } from "vitest";
import { page } from "vitest/browser";
import { defaultSqlHoverTheme, sqlHover } from "../sql/hover.js";

test.each(["light", "dark"] as const)("SQL hover renders untrusted column names as text in the %s theme", async (theme) => {
  const column = `<img src=x onerror="document.body.dataset.sqlHoverXss='executed'">`;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const editor = new EditorView({
    doc: "SELECT * FROM users",
    extensions: [
      sql(),
      EditorView.decorations.of(Decoration.set([
        Decoration.mark({ class: "hover-table" }).range(14, 19),
      ])),
      sqlHover({ schema: { users: [column, "id"] } }),
      defaultSqlHoverTheme(theme),
    ],
    parent: container,
  });
  onTestFinished(() => {
    editor.destroy();
    container.remove();
    delete document.body.dataset.sqlHoverXss;
  });

  await page.getByText("users", { exact: true }).hover();
  await expect.poll(() => container.querySelector(".sql-hover-columns code")).not.toBeNull();
  const tooltip = container.querySelector(".cm-sql-hover-tooltip");
  expect(tooltip?.querySelector("img")).toBeNull();
  expect(tooltip?.querySelector(".sql-hover-columns code")?.textContent).toBe(column);
  expect(document.body.dataset.sqlHoverXss).toBeUndefined();
  expect(tooltip?.getBoundingClientRect().width).toBeGreaterThan(0);
});

test("retains independent hover defaults with a legacy linter parser override", async () => {
  const configured = createSqlAnalysis({ parser: { parse: async () => ({
    success: true, errors: [], ast: { type: "select", from: [{ table: "orders", as: "u" }] },
  }) } });
  const doc = "SELECT u.email FROM users u";
  const from = doc.indexOf("u.email");
  const editor = new EditorView({
    doc,
    extensions: [
      EditorView.decorations.of(Decoration.set([
        Decoration.mark({ class: "hover-alias" }).range(from, from + "u.email".length),
      ])),
      sqlExtension({
        schema: { users: ["email"] },
        linterConfig: { parser: configured.parser, delay: 0 },
        semanticLinterConfig: { delay: 0 },
        hoverConfig: { hoverTime: 0 },
        enableGutterMarkers: false,
        enableNavigation: false,
      }),
    ],
    parent: document.body,
  });
  onTestFinished(() => editor.destroy());
  await page.getByText("u.email", { exact: true }).hover();
  await expect.poll(() => editor.dom.querySelector(".cm-sql-hover-tooltip")?.textContent).toContain("email");
  await expect.poll(() => {
    const messages: string[] = [];
    forEachDiagnostic(editor.state, (diagnostic) => messages.push(diagnostic.message));
    return messages;
  }).toEqual(["Unknown table 'orders'"]);
});
