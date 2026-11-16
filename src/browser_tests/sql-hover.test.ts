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
