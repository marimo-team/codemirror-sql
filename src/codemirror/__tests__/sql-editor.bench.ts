import { EditorView } from "@codemirror/view";
import { afterAll, bench, describe } from "vitest";
import {
  createSqlLanguageService,
  duckdbDialect,
} from "../../index.js";
import { sqlEditor } from "../index.js";

const statement = "SELECT id, name FROM users WHERE active = true;\n";
const documentText = statement.repeat(
  Math.ceil((100 * 1_024) / statement.length),
).slice(0, 100 * 1_024);
const service = createSqlLanguageService({
  dialects: [duckdbDialect()],
});
const support = sqlEditor({
  autocomplete: { activateOnTyping: false },
  initialContext: { dialect: "duckdb" },
  service,
  statementGutter: {
    hideWhenNotFocused: false,
    showInactive: true,
  },
});
const parent = document.createElement("div");
document.body.append(parent);
const view = new EditorView({
  doc: documentText,
  extensions: support.extension,
  parent,
});
const position = documentText.indexOf("active");
support.statementBoundaryAt(view, {
  affinity: "left",
  position,
});

afterAll(() => {
  view.destroy();
  service.dispose();
  parent.remove();
});

describe("CodeMirror editor", () => {
  bench("100 KiB warmed single-character replacement", () => {
    const current = view.state.sliceDoc(position, position + 1);
    view.dispatch({
      changes: {
        from: position,
        insert: current === "a" ? "A" : "a",
        to: position + 1,
      },
      userEvent: "input.type",
    });
  });
});
