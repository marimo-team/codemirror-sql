import { currentCompletions } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSqlLanguageService,
  duckdbDialect,
} from "../../index.js";
import { sqlEditor } from "../index.js";

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

function measureKeystrokeP95(
  text: string,
  position: number,
): number {
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
        insert: current === "x" ? "X" : "x",
        to: position + 1,
      },
      userEvent: "input.type",
    });
    durations.push(performance.now() - startedAt);
  }
  durations.sort((left, right) => left - right);
  service.dispose();
  return durations[Math.ceil(durations.length * 0.95) - 1] ??
    Number.POSITIVE_INFINITY;
}

describe("CodeMirror performance gates", () => {
  it("keeps warmed 1 MiB multi-statement bookkeeping below 8 ms p95", () => {
    const statement = "SELECT id FROM users WHERE active = true;\n";
    const text = statement.repeat(
      Math.ceil((1_024 * 1_024) / statement.length),
    ).slice(0, 1_024 * 1_024);
    expect(measureKeystrokeP95(text, text.indexOf("active")))
      .toBeLessThan(8);
  });

  it("keeps a warmed 1 MiB single-statement edit below 20 ms p95", () => {
    const size = 1_024 * 1_024;
    const prefix = "SELECT ";
    const suffix = " FROM users";
    const text = `${prefix}${
      "x".repeat(size - prefix.length - suffix.length)
    }${suffix}`;
    expect(measureKeystrokeP95(text, Math.floor(size / 2)))
      .toBeLessThan(20);
  });

  it("settles rapid typing with delayed provider work within 500 ms", async () => {
    let aborts = 0;
    let providerCalls = 0;
    const providerDelayMs = 200;
    const service = createSqlLanguageService({
      catalog: {
        id: "performance-catalog",
        search: async (_request, signal) => {
          providerCalls += 1;
          await new Promise<void>((resolve, reject) => {
            const handle = setTimeout(resolve, providerDelayMs);
            signal.addEventListener("abort", () => {
              aborts += 1;
              clearTimeout(handle);
              reject(signal.reason);
            }, { once: true });
          });
          return {
            coverage: { kind: "complete" },
            epoch: { generation: 0, token: "ready" },
            relations: [{
              canonicalPath: [{
                quoted: false,
                role: "relation",
                value: "users",
              }],
              completionPathStart: 0,
              entityId: "users",
              matchQuality: "exact",
              relationKind: "table",
            }],
            status: "ready" as const,
          };
        },
      },
      completion: { catalogResponseBudgetMs: 5 },
      dialects: [duckdbDialect()],
    });
    const support = sqlEditor({
      autocomplete: { activateOnTypingDelay: 0 },
      initialContext: {
        catalog: { scope: "performance" },
        dialect: "duckdb",
      },
      service,
    });
    const initialText = "SELECT * FROM ";
    const view = new EditorView({
      doc: initialText,
      extensions: support.extension,
      parent: document.body,
      selection: { anchor: initialText.length },
    });
    views.push(view);
    view.focus();
    const startedAt = performance.now();

    for (const character of "users") {
      const callsBefore = providerCalls;
      view.dispatch({
        changes: {
          from: view.state.doc.length,
          insert: character,
        },
        selection: { anchor: view.state.doc.length + 1 },
        userEvent: "input.type",
      });
      await vi.waitFor(() => {
        expect(providerCalls).toBeGreaterThan(callsBefore);
      }, { interval: 1, timeout: 100 });
    }

    await vi.waitFor(() => {
      expect(
        currentCompletions(view.state).map((item) => item.label),
      ).toEqual(["users"]);
    }, { interval: 5, timeout: 500 });
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(aborts).toBeGreaterThan(0);
    expect(providerCalls).toBeLessThanOrEqual(5);
    service.dispose();
  });
});
