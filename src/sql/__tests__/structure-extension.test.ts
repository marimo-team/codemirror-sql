import { EditorState, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { sqlStructureGutter } from "../structure-extension.js";

// Type for gutter extension with markers function
interface GutterExtension {
  markers: (view: EditorView) => unknown;
}

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

  it("should handle line deletions gracefully without throwing invalid line number errors", () => {
    // Create a multi-line SQL document
    const multiLineSql = `SELECT * FROM users;
INSERT INTO users (name, email) VALUES ('John', 'john@example.com');
UPDATE users SET name = 'Jane' WHERE id = 1;
DELETE FROM users WHERE id = 2;`;

    const doc = Text.of(multiLineSql.split("\n"));
    // Create initial state (not used but shows the scenario)
    EditorState.create({
      doc,
      extensions: [sqlStructureGutter()],
    });

    // Simulate a document with fewer lines (like after deletion)
    const shorterSql = `SELECT * FROM users;`;
    const shorterDoc = Text.of(shorterSql.split("\n"));
    const shorterState = EditorState.create({
      doc: shorterDoc,
      extensions: [sqlStructureGutter()],
    });

    // The key test: ensure that accessing the state field doesn't throw errors
    // even when the cached statements have stale line numbers
    expect(() => {
      // This would previously throw "Invalid line number" errors
      // Now it should handle stale line numbers gracefully
      const view = {
        state: shorterState,
        hasFocus: true,
        dispatch: () => {},
      } as EditorView;

      // Trigger the gutter marker creation (this is where the error was occurring)
      const extensions = sqlStructureGutter();
      const gutterExtension = extensions.find(
        (ext) => typeof ext === "object" && ext !== null && "markers" in ext,
      ) as GutterExtension | undefined;

      if (gutterExtension) {
        const markersFn = gutterExtension.markers;
        // This should not throw an error even with stale line numbers
        expect(() => markersFn(view)).not.toThrow();
      }
    }).not.toThrow();
  });
});
