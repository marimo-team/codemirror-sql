import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { expect, it } from "vitest";
import { defaultSqlHoverTheme } from "../hover.js";
import { sqlStructureGutter } from "../structure-extension.js";

function styleModules(extensions: Extension) {
  return EditorState.create({ extensions }).facet(EditorView.styleModule);
}

it.each(["light", "dark"] as const)("shares the %s hover style modules", (mode) => {
  const first = styleModules(defaultSqlHoverTheme(mode));
  const second = styleModules(defaultSqlHoverTheme(mode));
  expect(first.length).toBeGreaterThan(0);
  expect(second).toHaveLength(first.length);
  first.forEach((module, index) => expect(second[index]).toBe(module));
});

it("shares gutter styles across editors with different widths", () => {
  const first = styleModules(sqlStructureGutter());
  const second = styleModules(sqlStructureGutter({ width: 8 }));
  expect(first.length).toBeGreaterThan(0);
  expect(second).toHaveLength(first.length);
  first.forEach((module, index) => expect(second[index]).toBe(module));

  const views = [undefined, 8].map((width) =>
    new EditorView({ extensions: sqlStructureGutter({ width }) }),
  );
  try {
    expect(views.map((view) => view.dom.style.getPropertyValue("--cm-sql-gutter-width")))
      .toEqual(["3px", "8px"]);
  } finally {
    views.forEach((view) => view.destroy());
  }
});
