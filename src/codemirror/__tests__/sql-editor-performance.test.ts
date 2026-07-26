import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSqlLanguageService,
  duckdbDialect,
} from "../../index.js";
import { sqlEditor } from "../index.js";

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

describe("CodeMirror performance gates", () => {
  it("keeps warmed 1 MiB keystroke bookkeeping below the envelope", () => {
    const statement = "SELECT id FROM users WHERE active = true;\n";
    const text = statement.repeat(
      Math.ceil((1_024 * 1_024) / statement.length),
    ).slice(0, 1_024 * 1_024);
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
    const view = new EditorView({
      doc: text,
      extensions: support.extension,
      parent: document.body,
    });
    views.push(view);
    const position = text.indexOf("active");
    support.statementBoundaryAt(view, {
      affinity: "left",
      position,
    });

    const durations: number[] = [];
    for (let index = 0; index < 25; index += 1) {
      const startedAt = performance.now();
      const current = view.state.sliceDoc(position, position + 1);
      view.dispatch({
        changes: {
          from: position,
          insert: current === "a" ? "A" : "a",
          to: position + 1,
        },
        userEvent: "input.type",
      });
      durations.push(performance.now() - startedAt);
    }
    durations.sort((left, right) => left - right);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
    expect(p95).toBeDefined();
    expect(p95).toBeLessThan(8);

    service.dispose();
  });
});
