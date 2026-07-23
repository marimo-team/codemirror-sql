import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { sqlExtension } from "../extension.js";
import { sqlSchemaFacet } from "../schema-facet.js";

describe("sqlExtension", () => {
  it("should return an array of extensions with default config", () => {
    const extensions = sqlExtension();
    expect(Array.isArray(extensions)).toBe(true);
    expect(extensions.length).toBeGreaterThan(0);
  });

  it("should return extensions with all features enabled by default", () => {
    const extensions = sqlExtension({});
    // Should include linter, gutter (4 parts), hover, and hover theme
    expect(extensions.length).toBeGreaterThan(2);
  });

  it("should exclude linting when disabled", () => {
    const extensions = sqlExtension({ enableLinting: false });
    // Should include gutter, hover, and hover theme (no linter)
    expect(extensions.length).toBeGreaterThan(2);
  });

  it("should exclude gutter markers when disabled", () => {
    const extensions = sqlExtension({ enableGutterMarkers: false });
    // Should include linter, hover, and hover theme (no gutter)
    expect(extensions.length).toBeGreaterThan(1);
  });

  it("should exclude hover when disabled", () => {
    const extensions = sqlExtension({ enableHover: false });
    // Should include linter and gutter (no hover or hover theme)
    expect(extensions.length).toBeGreaterThan(0);
  });

  it("should handle all features disabled", () => {
    const extensions = sqlExtension({
      enableLinting: false,
      enableSemanticLinting: false,
      enableGutterMarkers: false,
      enableHover: false,
    });
    expect(extensions).toEqual([]);
  });

  it("should register the shared schema facet when a schema is provided", () => {
    const schema = { users: ["id"] };
    const withSchema = sqlExtension({
      schema,
      enableLinting: false,
      enableSemanticLinting: false,
      enableGutterMarkers: false,
      enableHover: false,
    });
    expect(withSchema).toHaveLength(1);

    const state = EditorState.create({ extensions: withSchema });
    expect(state.facet(sqlSchemaFacet)).toBe(schema);

    const withoutSchema = sqlExtension({
      enableLinting: false,
      enableSemanticLinting: false,
      enableGutterMarkers: false,
      enableHover: false,
    });
    const emptyState = EditorState.create({ extensions: withoutSchema });
    expect(emptyState.facet(sqlSchemaFacet)).toBeNull();
  });

  it("should pass config objects to individual extensions", () => {
    const linterConfig = { delay: 500 };
    const gutterConfig = { backgroundColor: "#ff0000" };
    const hoverConfig = { hoverTime: 200 };

    const extensions = sqlExtension({
      linterConfig,
      gutterConfig,
      hoverConfig,
    });

    expect(extensions.length).toBeGreaterThan(2);
  });

  it("should handle partial configuration", () => {
    const extensions = sqlExtension({
      enableLinting: true,
      linterConfig: { delay: 100 },
    });

    expect(extensions.length).toBeGreaterThan(2);
  });
});
