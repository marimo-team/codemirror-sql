import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
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
