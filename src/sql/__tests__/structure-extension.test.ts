import { EditorState, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { NodeSqlParser } from "../parser.js";
import { sqlStructureGutter } from "../structure-extension.js";

// Mock EditorView
const _createMockView = (content: string, hasFocus = true) => {
  const doc = Text.of(content.split("\n"));
  const state = EditorState.create({
    doc,
    extensions: [sqlStructureGutter()],
  });

  return {
    state,
    hasFocus,
    dispatch: () => {},
  } as EditorView;
};

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

  it("should handle error configuration", () => {
    const config = {
      errorBackgroundColor: "#ff0000",
      showInvalid: true,
    };
    const extensions = sqlStructureGutter(config);
    expect(extensions.length).toBe(4);
  });

  it("should handle error gutter with custom parser", () => {
    const config = {
      errorBackgroundColor: "#ef4444",
      showInvalid: true,
      parser: new NodeSqlParser(),
    };
    const extensions = sqlStructureGutter(config);
    expect(extensions.length).toBe(4);
  });

  it("should handle gutter with schema validation", () => {
    const schema = {
      users: ["id", "name", "email"],
      posts: ["id", "title", "user_id"],
    };
    const config = {
      errorBackgroundColor: "#ef4444",
      showInvalid: true,
      parser: new NodeSqlParser({ schema }),
    };
    const extensions = sqlStructureGutter(config);
    expect(extensions.length).toBe(4);
  });
});
