import { createSqlAnalysis } from "../analysis.js";
import type { SqlParseResult } from "../types.js";
import { createTestView, required } from "./test-utils.js";
import { EditorView } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { computeMarkerStyle, sqlStructureGutter } from "../structure-extension.js";

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("computeMarkerStyle", () => {
  const focused = { isCurrent: false, isValid: true, isFocused: true };

  describe("background color", () => {
    it("uses the default blue for valid statements", () => {
      expect(computeMarkerStyle({}, focused).backgroundColor).toBe("#3b82f6");
    });

    it("honors a custom backgroundColor", () => {
      expect(computeMarkerStyle({ backgroundColor: "#123456" }, focused).backgroundColor).toBe(
        "#123456",
      );
    });

    it("uses the default red for invalid statements", () => {
      expect(
        computeMarkerStyle({}, { isCurrent: false, isValid: false, isFocused: true })
          .backgroundColor,
      ).toBe("#ef4444");
    });

    it("honors a custom errorBackgroundColor for invalid statements", () => {
      expect(
        computeMarkerStyle(
          { errorBackgroundColor: "#abcdef" },
          { isCurrent: false, isValid: false, isFocused: true },
        ).backgroundColor,
      ).toBe("#abcdef");
    });

    it("does not use the error color when showInvalid is false", () => {
      expect(
        computeMarkerStyle(
          { showInvalid: false },
          { isCurrent: false, isValid: false, isFocused: true },
        ).backgroundColor,
      ).toBe("#3b82f6");
    });
  });

  describe("opacity when focused", () => {
    it("is fully opaque for the current statement", () => {
      expect(
        computeMarkerStyle({}, { isCurrent: true, isValid: true, isFocused: true }).opacity,
      ).toBe("1");
    });

    it("defaults to 0.3 for non-current statements", () => {
      expect(computeMarkerStyle({}, focused).opacity).toBe("0.3");
    });

    it("honors a custom inactiveOpacity", () => {
      expect(computeMarkerStyle({ inactiveOpacity: 0.5 }, focused).opacity).toBe("0.5");
    });

    it("honors an explicit inactiveOpacity of 0", () => {
      expect(computeMarkerStyle({ inactiveOpacity: 0 }, focused).opacity).toBe("0");
    });
  });

  describe("opacity when not focused", () => {
    const unfocused = { isCurrent: false, isValid: true, isFocused: false };

    it("uses unfocusedOpacity when provided", () => {
      expect(computeMarkerStyle({ unfocusedOpacity: 0.2 }, unfocused).opacity).toBe("0.2");
    });

    it("prefers unfocusedOpacity over hideWhenNotFocused", () => {
      expect(
        computeMarkerStyle(
          { unfocusedOpacity: 0.4, hideWhenNotFocused: true },
          unfocused,
        ).opacity,
      ).toBe("0.4");
    });

    it("hides the marker when hideWhenNotFocused is set", () => {
      expect(computeMarkerStyle({ hideWhenNotFocused: true }, unfocused).opacity).toBe("0");
    });

    it("falls back to normal opacity when neither unfocused option is set", () => {
      expect(computeMarkerStyle({}, unfocused).opacity).toBe("0.3");
      expect(
        computeMarkerStyle({}, { isCurrent: true, isValid: true, isFocused: false }).opacity,
      ).toBe("1");
    });
  });
});

describe("sqlStructureGutter", () => {
  it("should create a gutter extension with default config", () => {
    const extensions = sqlStructureGutter();
    expect(Array.isArray(extensions)).toBe(true);
    expect(extensions.length).toBeGreaterThan(0);
  });

  it("should accept custom configuration", () => {
    const config = {
      backgroundColor: "#ff0000",
      errorBackgroundColor: "#00ff00",
      width: 5,
      className: "custom-sql-gutter",
      showInvalid: false,
      inactiveOpacity: 0.5,
      hideWhenNotFocused: true,
    };

    const extensions = sqlStructureGutter(config);
    expect(Array.isArray(extensions)).toBe(true);
    expect(extensions.length).toBeGreaterThan(0);
  });

  it("should handle empty configuration", () => {
    const extensions = sqlStructureGutter({});
    expect(Array.isArray(extensions)).toBe(true);
  });

  it("should create extensions for all required parts", () => {
    const extensions = sqlStructureGutter();
    // Should include state field, update listener, theme, and gutter
    expect(extensions.length).toBe(4);
  });

  it("should handle unfocusedOpacity configuration", () => {
    const config = { unfocusedOpacity: 0.2 };
    const extensions = sqlStructureGutter(config);
    expect(extensions.length).toBe(4);
  });

  it("should handle whenHide configuration", () => {
    const config = {
      whenHide: (view: EditorView) => view.state.doc.length === 0,
    };
    const extensions = sqlStructureGutter(config);
    expect(extensions.length).toBe(4);
  });

  it("should work with minimal configuration", () => {
    const config = { width: 2 };
    const extensions = sqlStructureGutter(config);
    expect(extensions.length).toBe(4);
  });

  it("renders gutter markers for pre-filled content without user interaction", async () => {
    const view = new EditorView({
      doc: "SELECT 1;\nSELECT 2;",
      extensions: [sqlStructureGutter()],
      parent: document.body,
    });

    try {
      await waitFor(() => view.dom.querySelectorAll(".cm-sql-gutter-marker").length >= 2);
      expect(view.dom.querySelectorAll(".cm-sql-gutter-marker").length).toBeGreaterThanOrEqual(2);
    } finally {
      view.destroy();
    }
  });

  it("honors an explicit inactiveOpacity of 0", async () => {
    const view = new EditorView({
      doc: "SELECT 1;\nSELECT 2;",
      extensions: [sqlStructureGutter({ inactiveOpacity: 0 })],
      parent: document.body,
    });

    try {
      // Put the cursor in the first statement so the second one is inactive
      view.dispatch({ selection: { anchor: 0 } });
      await waitFor(() => view.dom.querySelectorAll(".cm-sql-gutter-marker").length >= 2);

      const opacities = Array.from(
        view.dom.querySelectorAll<HTMLElement>(".cm-sql-gutter-marker"),
      ).map((marker) => marker.style.opacity);
      expect(opacities).toContain("0");
    } finally {
      view.destroy();
    }
  });
});

it("discards a slow analysis after a newer document is rendered", async () => {
  const pending = new Map<string, (value: SqlParseResult) => void>();
  const parser = {
    parse: (sql: string) => new Promise<SqlParseResult>((resolve) => pending.set(sql, resolve)),
  };
  const analysis = createSqlAnalysis({ parser });
  const view = createTestView({ doc: "SELECT 1;\nSELECT 2;", extensions: [sqlStructureGutter(analysis)] });
  const original = view.state;
  await vi.waitFor(() => expect(pending.has("SELECT 1;")).toBe(true));
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "SELECT 3;" } });
  await vi.waitFor(() => expect(pending.has("SELECT 3;")).toBe(true));
  required(pending.get("SELECT 3;"))({ success: true, errors: [] });
  await vi.waitFor(() => expect(view.dom.querySelectorAll(".cm-sql-gutter-marker")).toHaveLength(1));
  required(pending.get("SELECT 1;"))({ success: false, errors: [] });
  await vi.waitFor(() => expect(pending.has("SELECT 2;")).toBe(true));
  required(pending.get("SELECT 2;"))({ success: false, errors: [] });
  await analysis.structureAnalyzer.analyzeDocument(original);
  expect(view.dom.querySelectorAll(".cm-sql-gutter-marker")).toHaveLength(1);
  expect(view.dom.querySelector<HTMLElement>(".cm-sql-gutter-marker")?.style.background).toBe("rgb(59, 130, 246)");
});

it("does not dispatch a pending gutter result after destruction", async () => {
  let finish: ((result: SqlParseResult) => void) | undefined;
  const analysis = createSqlAnalysis({ parser: {
    parse: () => new Promise<SqlParseResult>((resolve) => { finish = resolve; }),
  } });
  const view = new EditorView({ doc: "SELECT 1", extensions: [sqlStructureGutter(analysis)] });
  const state = view.state;
  const dispatch = vi.spyOn(view, "dispatch");
  await vi.waitFor(() => expect(finish).toBeDefined());
  view.destroy();
  required(finish)({ success: true, errors: [] });
  await analysis.structureAnalyzer.analyzeDocument(state);
  expect(dispatch).not.toHaveBeenCalled();
});

it("reuses gutter analysis on selection and focus changes while refreshing parser configuration", async () => {
  let release: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const invalidate = StateEffect.define<boolean>();
  const invalid = StateField.define<boolean>({
    create: () => false,
    update: (value, transaction) => transaction.effects.find((effect) => effect.is(invalidate))?.value ?? value,
  });
  const analysis = createSqlAnalysis({ parser: {
    parse: async (_sql, { state }) => {
      await ready;
      return { success: !state.field(invalid), errors: [] };
    },
  } });
  const parse = vi.spyOn(analysis.parser, "parse");
  const view = createTestView({
    doc: "SELECT 1;\nSELECT 2;",
    extensions: [invalid, sqlStructureGutter({
      ...analysis,
      needsRefresh: (update) => update.startState.field(invalid) !== update.state.field(invalid),
    })],
  });
  const markers = () => [...view.dom.querySelectorAll<HTMLElement>(".cm-sql-gutter-marker")];
  await vi.waitFor(() => expect(parse).toHaveBeenCalledTimes(1));
  view.focus();
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  required(release)();
  await vi.waitFor(() => expect(markers()).toHaveLength(2));
  expect(markers().map((marker) => marker.style.opacity)).toEqual(["0.3", "1"]);
  expect(parse).toHaveBeenCalledTimes(2);

  view.dispatch({ selection: { anchor: 0 } });
  await vi.waitFor(() => expect(markers().map((marker) => marker.style.opacity)).toEqual(["1", "0.3"]));
  expect(parse).toHaveBeenCalledTimes(2);

  view.dispatch({ effects: invalidate.of(true) });
  await vi.waitFor(() => expect(markers().every((marker) => marker.style.background === "rgb(239, 68, 68)")).toBe(true));
  expect(parse).toHaveBeenCalledTimes(4);

  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "SELECT 3;" } });
  await vi.waitFor(() => expect(markers()).toHaveLength(1));
  expect(parse).toHaveBeenCalledTimes(5);
});
