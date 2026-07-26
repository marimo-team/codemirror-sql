import {
  currentCompletions,
  startCompletion,
} from "@codemirror/autocomplete";
import { sql, StandardSQL } from "@codemirror/lang-sql";
import { EditorView } from "@codemirror/view";
import { expect, onTestFinished, test } from "vitest";
import {
  createSqlLanguageService,
  duckdbDialect,
} from "../../index.js";
import { sqlEditor } from "../index.js";

test("standard completion gate routes unmatched template EOF to external sources", async () => {
  const parent = document.createElement("div");
  document.body.append(parent);
  onTestFinished(() => parent.remove());
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
  onTestFinished(() => service.dispose());
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
  onTestFinished(() => view.destroy());

  expect(startCompletion(view)).toBe(true);
  await expect.poll(() =>
    currentCompletions(view.state).map((item) => item.label)
  ).toEqual(["python_variable"]);
  expect(catalogSearches).toBe(0);
});

test("standard completion gate permits normal SQL in a browser editor", async () => {
  const parent = document.createElement("div");
  document.body.append(parent);
  onTestFinished(() => parent.remove());
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
  onTestFinished(() => service.dispose());
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
  onTestFinished(() => view.destroy());

  expect(startCompletion(view)).toBe(true);
  await expect.poll(() =>
    currentCompletions(view.state).map((item) => item.label)
  ).toContain("users");
});

test("standard editor preserves SQL language completions", async () => {
  const parent = document.createElement("div");
  document.body.append(parent);
  onTestFinished(() => parent.remove());
  const service = createSqlLanguageService({
    dialects: [duckdbDialect()],
  });
  onTestFinished(() => service.dispose());
  const support = sqlEditor({
    initialContext: {
      dialect: "duckdb",
    },
    service,
  });
  const documentText = "SEL";
  const view = new EditorView({
    doc: documentText,
    extensions: [
      sql({ dialect: StandardSQL }),
      support.extension,
    ],
    parent,
    selection: { anchor: documentText.length },
  });
  onTestFinished(() => view.destroy());

  expect(startCompletion(view)).toBe(true);
  await expect.poll(() =>
    currentCompletions(view.state).map((item) => item.label)
  ).toContain("select");
});

test("standard editor refreshes the first completion after a slow provider", async () => {
  const parent = document.createElement("div");
  document.body.append(parent);
  onTestFinished(() => parent.remove());
  const service = createSqlLanguageService({
    catalog: {
      id: "browser-slow-catalog",
      search: async (_request, signal) => {
        await new Promise<void>((resolve, reject) => {
          const handle = setTimeout(resolve, 60);
          signal.addEventListener("abort", () => {
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
  onTestFinished(() => service.dispose());
  const support = sqlEditor({
    initialContext: {
      catalog: { scope: "browser-slow" },
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
  onTestFinished(() => view.destroy());
  view.focus();

  expect(startCompletion(view)).toBe(true);
  await expect.poll(() =>
    currentCompletions(view.state).map((item) => item.label)
  ).toEqual(["users"]);
});

test("standard editor activates catalog completion while typing", async () => {
  const parent = document.createElement("div");
  document.body.append(parent);
  onTestFinished(() => parent.remove());
  const service = createSqlLanguageService({
    catalog: {
      id: "browser-typing-catalog",
      search: async () => ({
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
      }),
    },
    dialects: [duckdbDialect()],
  });
  onTestFinished(() => service.dispose());
  const support = sqlEditor({
    autocomplete: { activateOnTypingDelay: 0 },
    initialContext: {
      catalog: { scope: "browser-typing" },
      dialect: "duckdb",
    },
    service,
  });
  const documentText = "SELECT * FROM u";
  const view = new EditorView({
    doc: documentText,
    extensions: support.extension,
    parent,
    selection: { anchor: documentText.length },
  });
  onTestFinished(() => view.destroy());
  view.focus();
  view.dispatch({
    changes: { from: documentText.length, insert: "s" },
    userEvent: "input.type",
  });

  await expect.poll(() =>
    currentCompletions(view.state).map((item) => item.label)
  ).toEqual(["users"]);
});

test("standard completion gate preserves external sources when it closes SQL options", async () => {
  const parent = document.createElement("div");
  document.body.append(parent);
  onTestFinished(() => parent.remove());
  let allowed = true;
  const service = createSqlLanguageService({
    catalog: {
      id: "browser-gate-transition",
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
  onTestFinished(() => service.dispose());
  const support = sqlEditor({
    autocomplete: {
      externalSources: [(context) => ({
        from: context.pos,
        options: [{ label: "python_variable" }],
      })],
      isCompletionPositionAllowed: () => allowed,
    },
    initialContext: {
      catalog: { scope: "browser-gate-transition" },
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
  onTestFinished(() => view.destroy());

  expect(startCompletion(view)).toBe(true);
  await expect.poll(() =>
    currentCompletions(view.state).map((item) => item.label).sort()
  ).toEqual(["python_variable", "users"]);

  allowed = false;
  view.dispatch({});
  await expect.poll(() =>
    currentCompletions(view.state).map((item) => item.label)
  ).toEqual(["python_variable"]);
});

test("standard editor applies a batched column completion", async () => {
  const parent = document.createElement("div");
  document.body.append(parent);
  onTestFinished(() => parent.remove());
  let columnCalls = 0;
  const service = createSqlLanguageService({
    catalog: {
      id: "browser-relations",
      search: async () => ({
        coverage: { kind: "complete" },
        epoch: { generation: 1, token: "epoch-1" },
        relations: [],
        status: "ready" as const,
      }),
    },
    columns: {
      id: "browser-columns",
      loadColumns: async (request) => {
        columnCalls += 1;
        const relation = request.relations[0];
        if (!relation) throw new Error("Expected one relation");
        return {
          epoch: { generation: 1, token: "epoch-1" },
          relations: [{
            columns: [{
              columnEntityId: "users:name",
              dataType: "VARCHAR",
              identifier: { quoted: false, value: "name" },
              insertText: "name",
              ordinal: 0,
            }],
            coverage: "complete",
            relationEntityId: "users",
            requestKey: relation.requestKey,
            status: "ready",
          }],
        };
      },
    },
    dialects: [duckdbDialect()],
  });
  onTestFinished(() => service.dispose());
  const support = sqlEditor({
    initialContext: {
      catalog: { scope: "browser-columns" },
      dialect: "duckdb",
    },
    service,
  });
  const documentText = "SELECT u.na FROM users u";
  const view = new EditorView({
    doc: documentText,
    extensions: support.extension,
    parent,
    selection: { anchor: "SELECT u.na".length },
  });
  onTestFinished(() => view.destroy());

  expect(startCompletion(view)).toBe(true);
  await expect.poll(() =>
    currentCompletions(view.state).map((item) => ({
      label: item.label,
      type: item.type,
    }))
  ).toEqual([{ label: "name", type: "property" }]);
  expect(columnCalls).toBe(1);
});

test("standard editor exposes namespace containers at relation sites", async () => {
  const parent = document.createElement("div");
  document.body.append(parent);
  onTestFinished(() => parent.remove());
  let namespaceCalls = 0;
  const service = createSqlLanguageService({
    dialects: [duckdbDialect()],
    namespaces: {
      id: "browser-namespaces",
      search: async () => {
        namespaceCalls += 1;
        return {
          containers: [{
            canonicalPath: [{
              quoted: false,
              role: "schema",
              value: "main",
            }],
            containerEntityId: "schema:main",
            insertText: "main",
            matchQuality: "exact",
          }],
          coverage: "complete",
          epoch: { generation: 1, token: "epoch-1" },
          status: "ready",
        };
      },
    },
  });
  onTestFinished(() => service.dispose());
  const support = sqlEditor({
    initialContext: {
      catalog: { scope: "browser-namespaces" },
      dialect: "duckdb",
    },
    service,
  });
  const documentText = "SELECT * FROM ma";
  const view = new EditorView({
    doc: documentText,
    extensions: support.extension,
    parent,
    selection: { anchor: documentText.length },
  });
  onTestFinished(() => view.destroy());

  expect(startCompletion(view)).toBe(true);
  await expect.poll(() =>
    currentCompletions(view.state).map((item) => ({
      label: item.label,
      type: item.type,
    }))
  ).toEqual([{ label: "main", type: "namespace" }]);
  expect(namespaceCalls).toBe(1);
});
