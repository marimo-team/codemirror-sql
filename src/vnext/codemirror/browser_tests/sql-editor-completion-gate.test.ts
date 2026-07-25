import {
  currentCompletions,
  startCompletion,
} from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { expect, test } from "vitest";
import {
  createSqlLanguageService,
  duckdbDialect,
} from "../../index.js";
import { sqlEditor } from "../index.js";

test("vNext completion gate routes unmatched template EOF to external sources", async () => {
  const parent = document.createElement("div");
  document.body.append(parent);
  let catalogSearches = 0;
  const service = createSqlLanguageService({
    catalog: {
      id: "browser-catalog",
      search: async () => {
        catalogSearches += 1;
        return {
          coverage: { kind: "complete" },
          epoch: { generation: 0, token: "ready" },
          relations: [{
            canonicalPath: [
              {
                quoted: false,
                role: "schema",
                value: "main",
              },
              {
                quoted: false,
                role: "relation",
                value: "users",
              },
            ],
            completionPathStart: 1,
            entityId: "main.users",
            matchQuality: "exact",
            relationKind: "table",
          }],
          status: "ready" as const,
        };
      },
    },
    dialects: [duckdbDialect()],
  });
  const support = sqlEditor({
    autocomplete: {
      externalSources: [(context) => ({
        from: context.pos,
        options: [{ label: "python_variable" }],
      })],
      isCompletionPositionAllowed: (state, position) => {
        const prefix = state.sliceDoc(0, position);
        return prefix.lastIndexOf("{") <= prefix.lastIndexOf("}");
      },
    },
    initialContext: {
      catalog: {
        scope: "browser",
        searchPath: [[{ quoted: false, value: "main" }]],
      },
      dialect: "duckdb",
    },
    initialEmbeddedRegions: [{
      from: 14,
      language: "python",
      to: 15,
    }],
    service,
  });
  const view = new EditorView({
    doc: "SELECT * FROM {",
    extensions: support.extension,
    parent,
    selection: { anchor: 15 },
  });

  expect(startCompletion(view)).toBe(true);
  await expect.poll(() =>
    currentCompletions(view.state).map((item) => item.label)
  ).toEqual(["python_variable"]);
  expect(catalogSearches).toBe(0);

  view.destroy();
  service.dispose();
  parent.remove();
});

test("vNext completion gate permits normal SQL in a browser editor", async () => {
  const parent = document.createElement("div");
  document.body.append(parent);
  const service = createSqlLanguageService({
    catalog: {
      id: "browser-catalog",
      search: async () => ({
        coverage: { kind: "complete" },
        epoch: { generation: 0, token: "ready" },
        relations: [{
          canonicalPath: [
            {
              quoted: false,
              role: "schema",
              value: "main",
            },
            {
              quoted: false,
              role: "relation",
              value: "users",
            },
          ],
          completionPathStart: 1,
          entityId: "main.users",
          matchQuality: "exact",
          relationKind: "table",
        }],
        status: "ready" as const,
      }),
    },
    dialects: [duckdbDialect()],
  });
  const support = sqlEditor({
    autocomplete: {
      isCompletionPositionAllowed: () => true,
    },
    initialContext: {
      catalog: {
        scope: "browser",
        searchPath: [[{ quoted: false, value: "main" }]],
      },
      dialect: "duckdb",
    },
    service,
  });
  const documentText = "SELECT * FROM us";
  const view = new EditorView({
    doc: documentText,
    extensions: support.extension,
    parent,
    selection: { anchor: documentText.length },
  });

  expect(startCompletion(view)).toBe(true);
  await expect.poll(() =>
    currentCompletions(view.state).map((item) => item.label)
  ).toContain("users");

  view.destroy();
  service.dispose();
  parent.remove();
});
