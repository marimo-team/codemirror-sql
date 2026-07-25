import {
  closeCompletion,
  completionStatus,
  currentCompletions,
  setSelectedCompletion,
  startCompletion,
  type Completion,
  type CompletionInfo,
} from "@codemirror/autocomplete";
import { EditorSelection, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bigQueryDialect,
  createSqlLanguageService,
  duckdbDialect,
  type SqlCatalogSearchRequest,
  type SqlCatalogSearchResponse,
  type SqlCompletionItem,
  type SqlCompletionRefreshToken,
  type SqlCompletionResult,
  type SqlCompletionTask,
  type SqlContextInput,
  type SqlDocumentContext,
  type SqlDocumentSession,
  type SqlDocumentUpdate,
  type SqlLanguageService,
  type SqlRelationCatalogProvider,
  type SqlRevision,
  type SqlSessionChangeEvent,
  type SqlTextRange,
} from "../../index.js";
import {
  createSqlCompletionRefreshToken,
} from "../../relation-completion-types.js";
import { createSqlRevisionToken } from "../../types.js";
import {
  createSqlEditorInternal,
  sqlEditor,
  type SqlEditorRuntime,
} from "../sql-editor.js";

interface TestContext extends SqlDocumentContext {
  readonly engine: string;
}

interface FakeServiceHarness {
  readonly completeSignals: AbortSignal[];
  readonly emit: (event: SqlSessionChangeEvent) => void;
  readonly getLastToken: () => SqlCompletionRefreshToken | null;
  readonly invalidations: () => number;
  readonly service: SqlLanguageService<TestContext>;
  readonly sessionDisposals: () => number;
  readonly statementBoundaryCalls: () => number;
  readonly statementIntersectionCalls: () => number;
  readonly updates: readonly SqlDocumentUpdate<TestContext>[];
}

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

function relationResponse(
  relation = "users",
): SqlCatalogSearchResponse {
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
          value: relation,
        },
      ],
      completionPathStart: 1,
      entityId: `main.${relation}`,
      matchQuality: "exact",
      relationKind: "table",
    }],
    status: "ready",
  };
}

function completionItem(
  from = 14,
  to = 16,
  relationKind: "cte" | "table" = "table",
): SqlCompletionItem {
  const edit = {
    from,
    insert: "users",
    to,
  };
  return relationKind === "cte"
    ? {
        edit,
        kind: "relation",
        label: "users",
        provenance: {
          declarationPosition: 0,
          kind: "cte",
        },
        relationKind,
      }
    : {
        detail: "Table",
        edit,
        kind: "relation",
        label: "users",
        provenance: {
          entityId: "main.users",
          kind: "catalog",
          providerId: "fake",
        },
        relationKind,
      };
}

function fakeService(
  result: (
    revision: SqlRevision,
    token: SqlCompletionRefreshToken,
  ) => SqlCompletionResult | Promise<SqlCompletionResult>,
  rejectUpdates = false,
  statementCode: SqlTextRange | null = null,
): FakeServiceHarness {
  const completeSignals: AbortSignal[] = [];
  const updates: SqlDocumentUpdate<TestContext>[] = [];
  let listener:
    | ((event: SqlSessionChangeEvent) => void)
    | null = null;
  let lastToken: SqlCompletionRefreshToken | null = null;
  let invalidationCount = 0;
  let sessionDisposalCount = 0;
  let statementBoundaryCallCount = 0;
  let statementIntersectionCallCount = 0;
  const service: SqlLanguageService<TestContext> = {
    dispose: () => undefined,
    openDocument: () => {
      let disposed = false;
      let revision = createSqlRevisionToken();
      const session: SqlDocumentSession<TestContext> = {
        complete: (request): SqlCompletionTask => {
          completeSignals.push(request.signal ?? new AbortController().signal);
          const token = createSqlCompletionRefreshToken();
          lastToken = token;
          return Object.assign(
            Promise.resolve(result(revision, token)),
            { refreshToken: token },
          );
        },
        dispose: () => {
          if (disposed) return;
          disposed = true;
          sessionDisposalCount += 1;
        },
        invalidateCatalog: () => {
          invalidationCount += 1;
          revision = createSqlRevisionToken();
          return revision;
        },
        isCurrent: (candidate) => !disposed && candidate === revision,
        onDidChange: (nextListener) => {
          listener = nextListener;
          return {
            dispose: () => {
              if (listener === nextListener) listener = null;
            },
          };
        },
        get revision() {
          return revision;
        },
        statementBoundaryAt: () => {
          statementBoundaryCallCount += 1;
          return {
            boundary: statementCode === null
              ? {
                  boundaryQuality: "exact",
                  code: null,
                  endState: { kind: "normal" },
                  extent: { from: 0, to: 0 },
                  hasCode: false,
                  source: { from: 0, to: 0 },
                  terminator: null,
                }
              : {
                  boundaryQuality: "exact",
                  code: statementCode,
                  endState: { kind: "normal" },
                  extent: statementCode,
                  hasCode: true,
                  source: statementCode,
                  terminator: null,
                },
            revision,
          };
        },
        statementBoundariesIntersecting: () => {
          statementIntersectionCallCount += 1;
          return {
            boundaries: [statementCode === null
              ? {
                  boundaryQuality: "exact",
                  code: null,
                  endState: { kind: "normal" },
                  extent: { from: 0, to: 0 },
                  hasCode: false,
                  source: { from: 0, to: 0 },
                  terminator: null,
                }
              : {
                  boundaryQuality: "exact",
                  code: statementCode,
                  endState: { kind: "normal" },
                  extent: statementCode,
                  hasCode: true,
                  source: statementCode,
                  terminator: null,
                }],
            revision,
          };
        },
        update: (update) => {
          updates.push(update);
          if (rejectUpdates) {
            throw new Error("update rejected");
          }
          revision = createSqlRevisionToken();
          return revision;
        },
      };
      return session;
    },
  };
  return {
    completeSignals,
    emit: (event) => listener?.(event),
    getLastToken: () => lastToken,
    invalidations: () => invalidationCount,
    service,
    sessionDisposals: () => sessionDisposalCount,
    statementBoundaryCalls: () => statementBoundaryCallCount,
    statementIntersectionCalls: () =>
      statementIntersectionCallCount,
    updates,
  };
}

function readyResult(
  revision: SqlRevision,
  items: readonly SqlCompletionItem[],
  refreshToken: SqlCompletionRefreshToken | null = null,
): SqlCompletionResult {
  return {
    refreshToken,
    revision,
    sources: [],
    status: "ready",
    value: refreshToken === null
      ? {
          isIncomplete: false,
          issues: [],
          items,
        }
      : {
          isIncomplete: true,
          issues: [{
            reason: "catalog-loading",
            remainingIntentLeaseMs: 1_000,
          }],
          items,
        },
  };
}

function context(
  scope = "connection:fake",
): SqlContextInput<TestContext> {
  return {
    catalog: { scope },
    dialect: "duckdb",
    engine: "local",
  };
}

function controlledRuntime(): {
  readonly closes: EditorView[];
  readonly queued: Array<() => void>;
  readonly runtime: SqlEditorRuntime;
  readonly starts: EditorView[];
  readonly timerDelays: number[];
  readonly timers: Array<() => void>;
} {
  const closes: EditorView[] = [];
  const queued: Array<() => void> = [];
  const starts: EditorView[] = [];
  const timerDelays: number[] = [];
  const timers: Array<() => void> = [];
  return {
    closes,
    queued,
    runtime: {
      clearTimeout: (handle) => clearTimeout(handle),
      closeCompletion: (view) => {
        closes.push(view);
        return true;
      },
      queueMicrotask: (callback) => {
        queued.push(callback);
      },
      setTimeout: (callback, delayMs) => {
        timerDelays.push(delayMs);
        timers.push(callback);
        return setTimeout(() => undefined, 60_000);
      },
      startCompletion: (view) => {
        starts.push(view);
        return true;
      },
    },
    starts,
    timerDelays,
    timers,
  };
}

function createView(
  extension: Extension,
  doc = "SELECT * FROM us",
): EditorView {
  const view = new EditorView({
    doc,
    extensions: extension,
    parent: document.body,
    selection: EditorSelection.cursor(doc.length),
  });
  views.push(view);
  return view;
}

async function waitForActiveCompletion(view: EditorView): Promise<void> {
  await vi.waitFor(() => {
    expect(completionStatus(view.state)).toBe("active");
  });
}

async function resolveCompletionInfo(
  completion: Completion,
): Promise<CompletionInfo> {
  if (typeof completion.info !== "function") {
    throw new Error("Expected a completion info resolver");
  }
  return completion.info(completion);
}

describe("sqlEditor", () => {
  it("exposes session controls only for owned views", () => {
    const service = createSqlLanguageService<TestContext>({
      dialects: [duckdbDialect()],
    });
    const support = sqlEditor({
      initialContext: { dialect: "duckdb", engine: "local" },
      service,
    });
    const view = createView(support.extension, "SELECT 1;SELECT 2");
    const foreign = createView([]);

    expect(support.statementBoundaryAt(view, {
      affinity: "left",
      position: 9,
    })?.boundary).toMatchObject({
      boundaryQuality: "exact",
      code: { from: 0, to: 8 },
      hasCode: true,
    });
    expect(support.statementBoundariesIntersecting(view, {
      from: 0,
      to: view.state.doc.length,
    })?.boundaries).toHaveLength(2);
    expect(support.invalidateCatalog(view)).not.toBeNull();
    expect(support.invalidateCatalog(foreign)).toBeNull();
    expect(support.statementBoundaryAt(foreign, {
      affinity: "left",
      position: 0,
    })).toBeNull();
    expect(support.statementBoundariesIntersecting(foreign, {
      from: 0,
      to: 0,
    })).toBeNull();
    expect(support.statementBoundaryAt(view, {
      affinity: "left",
      position: 100,
    })).toBeNull();

    view.destroy();
    expect(support.invalidateCatalog(view)).toBeNull();
    expect(support.statementBoundaryAt(view, {
      affinity: "left",
      position: 0,
    })).toBeNull();
    expect(support.statementBoundariesIntersecting(view, {
      from: 0,
      to: 0,
    })).toBeNull();
    service.dispose();
  });

  it("proxies catalog invalidation only to its owned live session", () => {
    const harness = fakeService((revision) => readyResult(revision, []));
    const support = sqlEditor({
      initialContext: context(),
      service: harness.service,
    });
    const view = createView(support.extension);
    const foreign = createView([]);

    expect(support.invalidateCatalog(view)).not.toBeNull();
    expect(harness.invalidations()).toBe(1);
    expect(support.invalidateCatalog(foreign)).toBeNull();
    expect(harness.invalidations()).toBe(1);
    view.destroy();
    expect(support.invalidateCatalog(view)).toBeNull();
    expect(harness.invalidations()).toBe(1);
  });

  it("renders an opt-in visible-line statement gutter", async () => {
    const service = createSqlLanguageService<TestContext>({
      dialects: [duckdbDialect()],
    });
    const support = sqlEditor({
      initialContext: { dialect: "duckdb", engine: "local" },
      service,
      statementGutter: {},
    });
    const view = createView(
      support.extension,
      "SELECT 1;\n\n/* separator */\nSELECT 2;",
    );

    await vi.waitFor(() => {
      expect(
        view.dom.querySelectorAll(".cm-sql-statement-marker"),
      ).toHaveLength(2);
    });
    expect(
      view.dom.querySelectorAll(".cm-sql-statement-marker-active"),
    ).toHaveLength(1);
    expect(
      view.dom.querySelectorAll(".cm-sql-statement-marker-inactive"),
    ).toHaveLength(1);
    expect(Array.from(
      view.dom.querySelectorAll(".cm-sql-statement-marker"),
    ).findIndex((marker) =>
      marker.classList.contains("cm-sql-statement-marker-active")
    )).toBe(1);

    view.dispatch({ selection: { anchor: 1 } });
    await vi.waitFor(() => {
      const markers = view.dom.querySelectorAll(
        ".cm-sql-statement-marker",
      );
      expect(markers).toHaveLength(2);
      expect(
        view.dom.querySelectorAll(
          ".cm-sql-statement-marker-active",
        ),
      ).toHaveLength(1);
      expect(Array.from(markers).findIndex((marker) =>
        marker.classList.contains(
          "cm-sql-statement-marker-active",
        )
      )).toBe(0);
    });
    service.dispose();
  });

  it("does not install a statement gutter by default", () => {
    const service = createSqlLanguageService<TestContext>({
      dialects: [duckdbDialect()],
    });
    const support = sqlEditor({
      initialContext: { dialect: "duckdb", engine: "local" },
      service,
    });
    const view = createView(support.extension, "SELECT 1");

    expect(
      view.dom.querySelector(".cm-sql-statement-gutter"),
    ).toBeNull();
    service.dispose();
  });

  it("renders no marker for an empty document", () => {
    const service = createSqlLanguageService<TestContext>({
      dialects: [duckdbDialect()],
    });
    const support = sqlEditor({
      initialContext: { dialect: "duckdb", engine: "local" },
      service,
      statementGutter: {},
    });
    const view = createView(support.extension, "");

    expect(
      view.dom.querySelectorAll(".cm-sql-statement-marker"),
    ).toHaveLength(0);
    service.dispose();
  });

  it("supports hidden and active-only gutter policies", async () => {
    const service = createSqlLanguageService<TestContext>({
      dialects: [duckdbDialect()],
    });
    const hidden = sqlEditor({
      initialContext: { dialect: "duckdb", engine: "local" },
      service,
      statementGutter: { hideWhenNotFocused: true },
    });
    const hiddenView = createView(hidden.extension, "SELECT 1");
    expect(
      hiddenView.dom.querySelectorAll(".cm-sql-statement-marker"),
    ).toHaveLength(0);
    hiddenView.focus();
    await vi.waitFor(() => {
      expect(
        hiddenView.dom.querySelectorAll(".cm-sql-statement-marker"),
      ).toHaveLength(1);
    });

    const activeOnly = sqlEditor({
      initialContext: { dialect: "duckdb", engine: "local" },
      service,
      statementGutter: { showInactive: false },
    });
    const activeView = createView(
      activeOnly.extension,
      "SELECT 1;\nSELECT 2",
    );
    await vi.waitFor(() => {
      expect(
        activeView.dom.querySelectorAll(
          ".cm-sql-statement-marker-active",
        ),
      ).toHaveLength(1);
      expect(
        activeView.dom.querySelectorAll(
          ".cm-sql-statement-marker-inactive",
        ),
      ).toHaveLength(0);
    });
    activeOnly.setContext(activeView, {
      dialect: "duckdb",
      engine: "remote",
    });
    await vi.waitFor(() => {
      expect(
        activeView.dom.querySelectorAll(
          ".cm-sql-statement-marker-active",
        ),
      ).toHaveLength(1);
    });
    service.dispose();
  });

  it("shows only inactive markers when no code boundary is current", async () => {
    const service = createSqlLanguageService<TestContext>({
      dialects: [duckdbDialect()],
    });
    const support = sqlEditor({
      initialContext: { dialect: "duckdb", engine: "local" },
      service,
      statementGutter: {},
    });
    const view = createView(
      support.extension,
      "SELECT 1;\n/* trailing */",
    );

    await vi.waitFor(() => {
      expect(
        view.dom.querySelectorAll(
          ".cm-sql-statement-marker-active",
        ),
      ).toHaveLength(0);
      expect(
        view.dom.querySelectorAll(
          ".cm-sql-statement-marker-inactive",
        ),
      ).toHaveLength(1);
    });
    service.dispose();
    expect(() => {
      view.dispatch({ selection: { anchor: 0 } });
    }).not.toThrow();
  });

  it("accepts an explicit false gutter option", () => {
    const service = createSqlLanguageService<TestContext>({
      dialects: [duckdbDialect()],
    });
    const support = sqlEditor({
      initialContext: { dialect: "duckdb", engine: "local" },
      service,
      statementGutter: false,
    });
    const view = createView(support.extension, "SELECT 1");
    expect(
      view.dom.querySelector(".cm-sql-statement-gutter"),
    ).toBeNull();
    service.dispose();
  });

  it("marks internal blank lines but not separator trivia", async () => {
    const service = createSqlLanguageService<TestContext>({
      dialects: [duckdbDialect()],
    });
    const support = sqlEditor({
      initialContext: { dialect: "duckdb", engine: "local" },
      service,
      statementGutter: {},
    });
    const view = createView(
      support.extension,
      "SELECT\n\n  1;\n\nSELECT 2",
    );

    await vi.waitFor(() => {
      expect(
        view.dom.querySelectorAll(".cm-sql-statement-marker"),
      ).toHaveLength(4);
    });
    service.dispose();
  });

  it("does not fall back across an opaque right boundary", async () => {
    const service = createSqlLanguageService<TestContext>({
      dialects: [bigQueryDialect()],
    });
    const support = sqlEditor({
      initialContext: { dialect: "bigquery", engine: "local" },
      service,
      statementGutter: {},
    });
    const documentText =
      "SELECT 1; IF condition THEN SELECT 2; END IF;";
    const sharedBoundary = documentText.indexOf(";") + 1;
    const view = createView(support.extension, documentText);
    view.dispatch({ selection: { anchor: sharedBoundary } });

    expect(
      support.statementBoundaryAt(view, {
        affinity: "right",
        position: sharedBoundary,
      })?.boundary.boundaryQuality,
    ).toBe("opaque");
    await vi.waitFor(() => {
      expect(
        view.dom.querySelectorAll(
          ".cm-sql-statement-marker-active",
        ),
      ).toHaveLength(0);
    });
    service.dispose();
  });

  it("queries structural boundaries once per relevant redraw", () => {
    const documentText = "SELECT\n\n  1;\nSELECT 2";
    const harness = fakeService(
      (revision) => readyResult(revision, []),
      false,
      { from: 0, to: documentText.length },
    );
    const support = sqlEditor({
      initialContext: { dialect: "duckdb", engine: "local" },
      service: harness.service,
      statementGutter: {},
    });
    const view = createView(support.extension, documentText);

    expect(harness.statementBoundaryCalls()).toBe(1);
    expect(harness.statementIntersectionCalls()).toBe(1);
    view.dispatch({ selection: { anchor: 1 } });
    expect(harness.statementBoundaryCalls()).toBe(2);
    expect(harness.statementIntersectionCalls()).toBe(2);
    view.dispatch({});
    expect(harness.statementBoundaryCalls()).toBe(2);
    expect(harness.statementIntersectionCalls()).toBe(2);
  });

  it("maps current service completions and applies the exact core edit", async () => {
    const service = createSqlLanguageService<TestContext>({
      catalog: {
        id: "catalog",
        search: async () => relationResponse(),
      },
      dialects: [duckdbDialect()],
    });
    const support = sqlEditor({
      initialContext: {
        catalog: {
          scope: "connection:1",
          searchPath: [[{
            quoted: false,
            value: "main",
          }]],
        },
        dialect: "duckdb",
        engine: "local",
      },
      service,
    });
    const view = createView(support.extension);

    expect(startCompletion(view)).toBe(true);
    await waitForActiveCompletion(view);
    const completion = currentCompletions(view.state).find(
      (item) => item.label === "users",
    );
    expect(completion).toBeDefined();
    if (!completion || typeof completion.apply !== "function") {
      throw new Error("Expected an exact completion apply callback");
    }
    completion.apply(view, completion, 14, 16);
    expect(view.state.doc.toString()).toBe("SELECT * FROM users");

    view.destroy();
    service.dispose();
  });

  it("owns rich completion info until CodeMirror destroys it", async () => {
    const item = completionItem();
    const destroys: Array<ReturnType<typeof vi.fn>> = [];
    const resolver = vi.fn((resolvedItem, { signal }) => {
      const dom = document.createElement("div");
      const index = destroys.length;
      const destroy = vi.fn();
      destroys.push(destroy);
      dom.dataset.resolverIndex = String(index);
      return { dom, destroy, signal };
    });
    const harness = fakeService((revision) =>
      readyResult(revision, [item])
    );
    const support = sqlEditor({
      autocomplete: { infoResolver: resolver },
      initialContext: context(),
      service: harness.service,
    });
    const view = createView(support.extension);

    startCompletion(view);
    await waitForActiveCompletion(view);
    const completion = currentCompletions(view.state)[0];
    if (!completion) throw new Error("Expected a completion");
    const info = await resolveCompletionInfo(completion);

    expect(resolver).toHaveBeenCalledWith(
      item,
      { signal: expect.any(AbortSignal) },
    );
    expect(info).toMatchObject({ dom: expect.any(Node) });
    if (info === null || info instanceof Node) {
      throw new Error("Expected disposable completion info");
    }
    const index = Number(
      (info.dom as HTMLElement).dataset.resolverIndex,
    );
    info.destroy?.();
    info.destroy?.();
    expect(destroys[index]).toHaveBeenCalledTimes(1);
  });

  it("rejects info requests reentered during host cleanup", async () => {
    let reenter = () => undefined;
    const resolver = vi.fn(() => ({
      dom: document.createElement("div"),
      destroy: () => reenter(),
    }));
    const harness = fakeService((revision) =>
      readyResult(revision, [completionItem()])
    );
    const support = sqlEditor({
      autocomplete: { infoResolver: resolver },
      initialContext: context(),
      service: harness.service,
    });
    const view = createView(support.extension);

    startCompletion(view);
    await waitForActiveCompletion(view);
    const completion = currentCompletions(view.state)[0];
    if (!completion) throw new Error("Expected a completion");
    await resolveCompletionInfo(completion);
    const callsBeforeReplacement = resolver.mock.calls.length;
    reenter = () => {
      void resolveCompletionInfo(completion);
    };

    await resolveCompletionInfo(completion);
    expect(resolver).toHaveBeenCalledTimes(
      callsBeforeReplacement + 1,
    );
  });

  it("aborts superseded info and destroys its late resource", async () => {
    let resolveFirst:
      | ((value: {
          readonly dom: Node;
          readonly destroy: () => void;
        }) => void)
      | undefined;
    const firstDestroy = vi.fn();
    const signals: AbortSignal[] = [];
    const resolver = vi.fn((_item, { signal }) => {
      signals.push(signal);
      if (signals.length === 1) {
        return new Promise<{
          readonly dom: Node;
          readonly destroy: () => void;
        }>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({
        dom: document.createElement("div"),
        destroy: vi.fn(),
      });
    });
    const harness = fakeService((revision) =>
      readyResult(revision, [completionItem()])
    );
    const support = sqlEditor({
      autocomplete: { infoResolver: resolver },
      initialContext: context(),
      service: harness.service,
    });
    const view = createView(support.extension);

    startCompletion(view);
    await waitForActiveCompletion(view);
    const completion = currentCompletions(view.state)[0];
    if (!completion) throw new Error("Expected a completion");
    const first = resolveCompletionInfo(completion);
    const second = resolveCompletionInfo(completion);
    expect(signals[0]?.aborted).toBe(true);

    resolveFirst?.({
      dom: document.createElement("div"),
      destroy: firstDestroy,
    });
    expect(await first).toBeNull();
    expect(firstDestroy).toHaveBeenCalledTimes(1);
    expect(await second).toMatchObject({ dom: expect.any(Node) });
  });

  it("disposes info when selection moves to an external option", async () => {
    let resolveInfo:
      | ((value: {
          readonly dom: Node;
          readonly destroy: () => void;
        }) => void)
      | undefined;
    const destroy = vi.fn();
    let signal: AbortSignal | undefined;
    const harness = fakeService((revision) =>
      readyResult(revision, [completionItem()])
    );
    const support = sqlEditor({
      autocomplete: {
        externalSources: [() => ({
          from: 14,
          options: [{ label: "users_external" }],
        })],
        infoResolver: (_item, context) => {
          signal = context.signal;
          return new Promise((resolve) => {
            resolveInfo = resolve;
          });
        },
      },
      initialContext: context(),
      service: harness.service,
    });
    const view = createView(support.extension);

    startCompletion(view);
    await waitForActiveCompletion(view);
    await vi.waitFor(() => {
      expect(
        currentCompletions(view.state).map((item) => item.label),
      ).toContain("users_external");
    });
    const completions = currentCompletions(view.state);
    const coreIndex = completions.findIndex(
      (completion) => completion.label === "users",
    );
    const externalIndex = completions.findIndex(
      (completion) => completion.label === "users_external",
    );
    const core = completions[coreIndex];
    if (!core || coreIndex < 0 || externalIndex < 0) {
      throw new Error("Expected core and external completions");
    }
    view.dispatch({ effects: setSelectedCompletion(coreIndex) });
    const pending = resolveCompletionInfo(core);
    view.dispatch({ effects: setSelectedCompletion(externalIndex) });

    expect(signal?.aborted).toBe(true);
    resolveInfo?.({ dom: document.createElement("div"), destroy });
    await expect(pending).resolves.toBeNull();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys resolved info when selection moves away", async () => {
    const destroys: Array<ReturnType<typeof vi.fn>> = [];
    const harness = fakeService((revision) =>
      readyResult(revision, [completionItem()])
    );
    const support = sqlEditor({
      autocomplete: {
        externalSources: [() => ({
          from: 14,
          options: [{ label: "users_external" }],
        })],
        infoResolver: () => {
          const dom = document.createElement("div");
          const destroy = vi.fn();
          const index = destroys.push(destroy) - 1;
          dom.dataset.resolverIndex = String(index);
          return { dom, destroy };
        },
      },
      initialContext: context(),
      service: harness.service,
    });
    const view = createView(support.extension);

    startCompletion(view);
    await waitForActiveCompletion(view);
    await vi.waitFor(() => {
      expect(
        currentCompletions(view.state).map((item) => item.label),
      ).toContain("users_external");
    });
    const completions = currentCompletions(view.state);
    const coreIndex = completions.findIndex(
      (completion) => completion.label === "users",
    );
    const externalIndex = completions.findIndex(
      (completion) => completion.label === "users_external",
    );
    const core = completions[coreIndex];
    if (!core || coreIndex < 0 || externalIndex < 0) {
      throw new Error("Expected core and external completions");
    }
    view.dispatch({ effects: setSelectedCompletion(coreIndex) });
    const info = await resolveCompletionInfo(core);
    if (info === null || info instanceof Node) {
      throw new Error("Expected disposable completion info");
    }
    const index = Number(
      (info.dom as HTMLElement).dataset.resolverIndex,
    );
    view.dispatch({ effects: setSelectedCompletion(externalIndex) });

    expect(destroys[index]).toHaveBeenCalledTimes(1);
  });

  it("aborts pending info when editor input changes", async () => {
    let resolveInfo:
      | ((value: {
          readonly dom: Node;
          readonly destroy: () => void;
        }) => void)
      | undefined;
    const destroy = vi.fn();
    let signal: AbortSignal | undefined;
    const harness = fakeService((revision) =>
      readyResult(revision, [completionItem()])
    );
    const support = sqlEditor({
      autocomplete: {
        infoResolver: (_item, context) => {
          signal = context.signal;
          return new Promise((resolve) => {
            resolveInfo = resolve;
          });
        },
      },
      initialContext: context(),
      service: harness.service,
    });
    const view = createView(support.extension);

    startCompletion(view);
    await waitForActiveCompletion(view);
    const completion = currentCompletions(view.state)[0];
    if (!completion) throw new Error("Expected a completion");
    const pending = resolveCompletionInfo(completion);
    view.dispatch({ selection: { anchor: 0 } });
    expect(signal?.aborted).toBe(true);

    resolveInfo?.({ dom: document.createElement("div"), destroy });
    expect(await pending).toBeNull();
    expect(destroy).toHaveBeenCalledTimes(1);
    await expect(resolveCompletionInfo(completion)).resolves.toBeNull();
  });

  it("omits null completion info", async () => {
    const resolver = vi.fn(() => null);
    const harness = fakeService((revision) =>
      readyResult(revision, [completionItem()])
    );
    const support = sqlEditor({
      autocomplete: { infoResolver: resolver },
      initialContext: context(),
      service: harness.service,
    });
    const view = createView(support.extension);

    startCompletion(view);
    await waitForActiveCompletion(view);
    const completion = currentCompletions(view.state)[0];
    if (!completion) throw new Error("Expected a completion");
    await expect(resolveCompletionInfo(completion)).resolves.toBeNull();
  });

  it("contains info resolver and cleanup failures", async () => {
    const harness = fakeService((revision) =>
      readyResult(revision, [completionItem()])
    );
    const support = sqlEditor({
      autocomplete: {
        infoResolver: () => {
          throw new Error("resolver failed");
        },
      },
      initialContext: context(),
      service: harness.service,
    });
    const view = createView(support.extension);

    startCompletion(view);
    await waitForActiveCompletion(view);
    const completion = currentCompletions(view.state)[0];
    if (!completion) throw new Error("Expected a completion");
    await expect(resolveCompletionInfo(completion)).resolves.toBeNull();

    const cleanupSupport = sqlEditor({
      autocomplete: {
        infoResolver: () => ({
          dom: document.createElement("div"),
          destroy: () => {
            throw new Error("cleanup failed");
          },
        }),
      },
      initialContext: context(),
      service: harness.service,
    });
    const cleanupView = createView(cleanupSupport.extension);
    startCompletion(cleanupView);
    await waitForActiveCompletion(cleanupView);
    const cleanupCompletion = currentCompletions(cleanupView.state)[0];
    if (!cleanupCompletion) throw new Error("Expected a completion");
    const info = await resolveCompletionInfo(cleanupCompletion);
    if (info === null || info instanceof Node) {
      throw new Error("Expected disposable completion info");
    }
    expect(() => info.destroy?.()).not.toThrow();
  });

  it("maps embedded regions through its own non-overlapping apply edit", async () => {
    const harness = fakeService((revision) =>
      readyResult(revision, [completionItem(16, 18)])
    );
    const support = sqlEditor({
      initialContext: context(),
      initialEmbeddedRegions: [{
        from: 0,
        language: "host",
        to: 2,
      }, {
        from: 18,
        language: "host",
        to: 20,
      }],
      service: harness.service,
    });
    const view = createView(support.extension, "xxSELECT * FROM usYY");
    view.dispatch({ selection: { anchor: 18 } });
    expect(startCompletion(view)).toBe(true);
    await waitForActiveCompletion(view);
    const completion = currentCompletions(view.state)[0];
    if (!completion || typeof completion.apply !== "function") {
      throw new Error("Expected completion apply callback");
    }

    completion.apply(view, completion, 16, 18);
    expect(view.state.doc.toString()).toBe("xxSELECT * FROM usersYY");
    expect(harness.updates.at(-1)).toMatchObject({
      document: {
        changes: [{ from: 16, insert: "users", to: 18 }],
      },
      embeddedRegions: [{
        from: 0,
        language: "host",
        to: 2,
      }, {
        from: 21,
        language: "host",
        to: 23,
      }],
    });
    expect(harness.sessionDisposals()).toBe(0);
  });

  it("refuses a completion edit that overlaps an embedded region", async () => {
    const harness = fakeService((revision) =>
      readyResult(revision, [completionItem(14, 16)])
    );
    const support = sqlEditor({
      initialContext: context(),
      initialEmbeddedRegions: [{
        from: 15,
        language: "host",
        to: 16,
      }],
      service: harness.service,
    });
    const view = createView(support.extension);
    expect(startCompletion(view)).toBe(true);
    await waitForActiveCompletion(view);
    const completion = currentCompletions(view.state)[0];
    if (!completion || typeof completion.apply !== "function") {
      throw new Error("Expected completion apply callback");
    }

    completion.apply(view, completion, 14, 16);
    expect(view.state.doc.toString()).toBe("SELECT * FROM us");
    expect(harness.updates).toEqual([]);
  });

  it("combines document and final context effects into one current input", async () => {
    const requests: SqlCatalogSearchRequest[] = [];
    const service = createSqlLanguageService<TestContext>({
      catalog: {
        id: "catalog",
        search: async (request) => {
          requests.push(request);
          return relationResponse("orders");
        },
      },
      dialects: [duckdbDialect()],
    });
    const support = sqlEditor({
      initialContext: {
        catalog: { scope: "connection:old" },
        dialect: "duckdb",
        engine: "local",
      },
      service,
    });
    const view = createView(support.extension, "SELECT * FROM ");
    view.dispatch(
      {
        changes: { from: 14, insert: "or" },
        effects: support.contextEffect.of({
          catalog: { scope: "connection:middle" },
          dialect: "duckdb",
          engine: "remote",
        }),
      },
      {
        changes: { from: 16, insert: "d" },
        effects: support.contextEffect.of({
          catalog: { scope: "connection:final" },
          dialect: "duckdb",
          engine: "remote",
        }),
        selection: { anchor: 17 },
        sequential: true,
      },
    );

    expect(startCompletion(view)).toBe(true);
    await waitForActiveCompletion(view);
    expect(requests.at(-1)).toMatchObject({
      prefix: { value: "ord" },
      scope: "connection:final",
    });

    view.destroy();
    service.dispose();
  });

  it("refreshes an empty loading result once when its exact work becomes ready", async () => {
    let resolveSearch:
      | ((response: SqlCatalogSearchResponse) => void)
      | undefined;
    const pending = new Promise<SqlCatalogSearchResponse>((resolve) => {
      resolveSearch = resolve;
    });
    let searches = 0;
    const provider: SqlRelationCatalogProvider = {
      id: "deferred",
      search: async () => {
        searches += 1;
        return pending;
      },
    };
    const service = createSqlLanguageService<TestContext>({
      catalog: provider,
      completion: { catalogResponseBudgetMs: 0 },
      dialects: [duckdbDialect()],
    });
    const support = sqlEditor({
      autocomplete: { closeOnBlur: false },
      initialContext: {
        catalog: {
          scope: "connection:deferred",
          searchPath: [[{
            quoted: false,
            value: "main",
          }]],
        },
        dialect: "duckdb",
        engine: "local",
      },
      service,
    });
    const view = createView(support.extension, "SELECT * FROM ");

    expect(startCompletion(view)).toBe(true);
    await vi.waitFor(() => {
      expect(searches).toBe(1);
      expect(completionStatus(view.state)).toBeNull();
    });
    resolveSearch?.(relationResponse());
    await vi.waitFor(() => {
      expect(currentCompletions(view.state).map((item) => item.label))
        .toContain("users");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(currentCompletions(view.state).map((item) => item.label))
      .toEqual(["users"]);

    view.destroy();
    service.dispose();
  });

  it("keeps shared-service ownership with the caller", () => {
    const service = createSqlLanguageService<TestContext>({
      dialects: [duckdbDialect()],
    });
    const support = sqlEditor({
      initialContext: {
        dialect: "duckdb",
        engine: "local",
      },
      service,
    });
    const first = createView(support.extension);
    const second = createView(support.extension);
    first.destroy();
    second.destroy();

    const session = service.openDocument({
      context: {
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT 1",
    });
    expect(session.revision).toBeDefined();
    session.dispose();
    service.dispose();
  });

  it("contains caller service disposal before its view is destroyed", () => {
    const service = createSqlLanguageService<TestContext>({
      dialects: [duckdbDialect()],
    });
    const support = sqlEditor({
      initialContext: context(),
      service,
    });
    const view = createView(support.extension);
    service.dispose();

    expect(() => {
      support.setContext(view, context("connection:disposed"));
    }).not.toThrow();
    expect(() => view.destroy()).not.toThrow();
  });

  it("composes external sources and maps CTE presentation", async () => {
    const harness = fakeService((revision) =>
      readyResult(revision, [completionItem(14, 16, "cte")])
    );
    const support = sqlEditor({
      autocomplete: {
        externalSources: [() => ({
          from: 14,
          options: [{ label: "user_external" }],
        })],
      },
      initialContext: context(),
      service: harness.service,
    });
    const view = createView(support.extension);

    expect(startCompletion(view)).toBe(true);
    await waitForActiveCompletion(view);
    expect(currentCompletions(view.state)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "user_external" }),
        expect.objectContaining({ label: "users", type: "type" }),
      ]),
    );
  });

  it("maps column and namespace completion presentation", async () => {
    const epoch = { generation: 1, token: "epoch-1" };
    const items: readonly SqlCompletionItem[] = [{
      edit: { from: 14, insert: "users_column", to: 16 },
      kind: "column",
      label: "users_column",
      provenance: {
        columnEntityId: "users:name",
        epoch,
        kind: "column-catalog",
        providerId: "columns",
        relationEntityId: "users",
        scope: "connection:fake",
      },
      relationRequestKey: "binding:0",
    }, {
      edit: { from: 14, insert: "users_namespace", to: 16 },
      kind: "namespace",
      label: "users_namespace",
      provenance: {
        containerEntityId: "schema:main",
        epoch,
        kind: "namespace-catalog",
        providerId: "namespaces",
        scope: "connection:fake",
      },
      role: "schema",
    }];
    const harness = fakeService((revision) =>
      readyResult(revision, items)
    );
    const support = sqlEditor({
      initialContext: context(),
      service: harness.service,
    });
    const view = createView(support.extension);

    expect(startCompletion(view)).toBe(true);
    await waitForActiveCompletion(view);
    expect(currentCompletions(view.state)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "users_column",
          type: "property",
        }),
        expect.objectContaining({
          label: "users_namespace",
          type: "namespace",
        }),
      ]),
    );
  });

  it("denies SQL completion at an unmatched template EOF without removing external sources", async () => {
    const harness = fakeService((revision) =>
      readyResult(revision, [completionItem()])
    );
    const gate = vi.fn((state, position) =>
      !state.sliceDoc(0, position).endsWith("{")
    );
    const support = sqlEditor({
      autocomplete: {
        externalSources: [() => ({
          from: 15,
          options: [{ label: "python_variable" }],
        })],
        isCompletionPositionAllowed: gate,
      },
      initialContext: context(),
      service: harness.service,
    });
    const view = createView(support.extension, "SELECT * FROM {");

    expect(startCompletion(view)).toBe(true);
    await waitForActiveCompletion(view);
    expect(harness.completeSignals).toHaveLength(0);
    expect(currentCompletions(view.state)).toEqual([
      expect.objectContaining({ label: "python_variable" }),
    ]);
    expect(gate).toHaveBeenCalledWith(view.state, 15);
  });

  it("allows normal SQL completion through the position gate", async () => {
    const harness = fakeService((revision) =>
      readyResult(revision, [completionItem()])
    );
    const gate = vi.fn(() => true);
    const support = sqlEditor({
      autocomplete: {
        isCompletionPositionAllowed: gate,
      },
      initialContext: context(),
      service: harness.service,
    });
    const view = createView(support.extension);

    expect(startCompletion(view)).toBe(true);
    await waitForActiveCompletion(view);
    expect(harness.completeSignals).toHaveLength(1);
    expect(currentCompletions(view.state)).toEqual([
      expect.objectContaining({ label: "users" }),
    ]);
    expect(gate).toHaveBeenCalledWith(view.state, 16);
  });

  it("fails a throwing position gate closed while retaining external sources", async () => {
    const harness = fakeService((revision) =>
      readyResult(revision, [completionItem()])
    );
    const support = sqlEditor({
      autocomplete: {
        externalSources: [() => ({
          from: 15,
          options: [{ label: "python_variable" }],
        })],
        isCompletionPositionAllowed: () => {
          throw new Error("host state unavailable");
        },
      },
      initialContext: context(),
      service: harness.service,
    });
    const view = createView(support.extension, "SELECT * FROM {");

    expect(startCompletion(view)).toBe(true);
    await waitForActiveCompletion(view);
    expect(harness.completeSignals).toHaveLength(0);
    expect(currentCompletions(view.state)).toEqual([
      expect.objectContaining({ label: "python_variable" }),
    ]);
  });

  it("cancels pending SQL completion when the position gate flips false", async () => {
    let allowed = true;
    const harness = fakeService(
      () => new Promise(() => undefined),
    );
    const support = sqlEditor({
      autocomplete: {
        isCompletionPositionAllowed: () => allowed,
      },
      initialContext: context(),
      service: harness.service,
    });
    const view = createView(support.extension);

    expect(startCompletion(view)).toBe(true);
    await vi.waitFor(() => {
      expect(harness.completeSignals).toHaveLength(1);
    });
    allowed = false;
    view.dispatch({});
    await vi.waitFor(() => {
      expect(harness.completeSignals[0]?.aborted).toBe(true);
    });
  });

  it("disposes rich info when the position gate flips false", async () => {
    let allowed = true;
    const destroys: Array<ReturnType<typeof vi.fn>> = [];
    const harness = fakeService((revision) =>
      readyResult(revision, [completionItem()])
    );
    const support = sqlEditor({
      autocomplete: {
        infoResolver: () => {
          const destroy = vi.fn();
          destroys.push(destroy);
          return {
            destroy,
            dom: document.createElement("div"),
          };
        },
        isCompletionPositionAllowed: () => allowed,
      },
      initialContext: context(),
      service: harness.service,
    });
    const view = createView(support.extension);

    expect(startCompletion(view)).toBe(true);
    await waitForActiveCompletion(view);
    await vi.waitFor(() => expect(destroys.length).toBeGreaterThan(0));
    const currentDestroy = destroys.at(-1);
    if (!currentDestroy) throw new Error("Expected rich info");

    allowed = false;
    view.dispatch({});
    expect(currentDestroy).toHaveBeenCalledTimes(1);
  });

  it.each([
    "cancelled",
    "failed",
    "unavailable",
  ] as const)("maps %s service results to no CodeMirror result", async (status) => {
    const harness = fakeService((revision) => {
      if (status === "cancelled") {
        return {
          reason: "caller",
          revision,
          status,
        };
      }
      if (status === "failed") {
        return {
          failure: { code: "internal", retryable: false },
          revision,
          status,
        };
      }
      return {
        reason: "inactive",
        retryable: false,
        revision,
        status,
      };
    });
    const support = sqlEditor({
      initialContext: context(),
      service: harness.service,
    });
    const view = createView(support.extension);

    expect(startCompletion(view)).toBe(true);
    await vi.waitFor(() => {
      expect(harness.completeSignals).toHaveLength(1);
      expect(completionStatus(view.state)).toBeNull();
    });
  });

  it("fails closed for mixed edit ranges and token/list mismatches", async () => {
    const runtime = controlledRuntime();
    let malformed = false;
    const harness = fakeService((revision, token) =>
      malformed
        ? {
            refreshToken: token,
            revision,
            sources: [],
            status: "ready",
            value: {
              isIncomplete: true,
              issues: [{
                reason: "catalog-partial",
              }],
              items: [completionItem()],
            },
          }
        : readyResult(
            revision,
            [
              completionItem(),
              completionItem(13, 16),
            ],
            token,
          )
    );
    const support = createSqlEditorInternal({
      autocomplete: { closeOnBlur: false },
      initialContext: context(),
      service: harness.service,
    }, runtime.runtime);
    const view = createView(support.extension);

    expect(startCompletion(view)).toBe(true);
    await vi.waitFor(() => {
      expect(harness.completeSignals).toHaveLength(1);
      expect(completionStatus(view.state)).toBeNull();
    });
    const mixedToken = harness.getLastToken();
    if (!mixedToken) throw new Error("Expected mixed-result token");
    harness.emit({
      reason: "catalog-availability",
      refreshToken: mixedToken,
      revision: createSqlRevisionToken(),
    });
    expect(runtime.timers).toHaveLength(0);
    expect(runtime.queued).toHaveLength(0);
    malformed = true;
    expect(startCompletion(view)).toBe(true);
    await vi.waitFor(() => {
      expect(harness.completeSignals).toHaveLength(2);
      expect(completionStatus(view.state)).toBeNull();
    });
  });

  it("rejects a refresh token that does not match its task", async () => {
    const runtime = controlledRuntime();
    const mismatchedToken = createSqlCompletionRefreshToken();
    const harness = fakeService((revision) =>
      readyResult(revision, [], mismatchedToken)
    );
    const support = createSqlEditorInternal({
      autocomplete: { closeOnBlur: false },
      initialContext: context(),
      service: harness.service,
    }, runtime.runtime);
    const view = createView(support.extension, "SELECT * FROM ");
    expect(startCompletion(view)).toBe(true);
    await vi.waitFor(() => {
      expect(harness.completeSignals).toHaveLength(1);
      expect(completionStatus(view.state)).toBeNull();
    });
    const taskToken = harness.getLastToken();
    if (!taskToken) throw new Error("Expected task token");

    for (const refreshToken of [taskToken, mismatchedToken]) {
      harness.emit({
        reason: "catalog-availability",
        refreshToken,
        revision: createSqlRevisionToken(),
      });
    }
    expect(runtime.timers).toHaveLength(0);
    expect(runtime.queued).toHaveLength(0);
  });

  it("uses the service-reported remaining refresh lease", async () => {
    const runtime = controlledRuntime();
    let resolveResult:
      | ((result: SqlCompletionResult) => void)
      | undefined;
    let resultRevision: SqlRevision | null = null;
    let resultToken: SqlCompletionRefreshToken | null = null;
    const harness = fakeService((revision, token) => {
      resultRevision = revision;
      resultToken = token;
      return new Promise((resolve) => {
        resolveResult = resolve;
      });
    });
    const support = createSqlEditorInternal({
      autocomplete: { closeOnBlur: false },
      initialContext: context(),
      service: harness.service,
    }, runtime.runtime);
    const view = createView(support.extension, "SELECT * FROM ");
    expect(startCompletion(view)).toBe(true);
    await vi.waitFor(() =>
      expect(harness.completeSignals).toHaveLength(1)
    );
    if (!resultRevision || !resultToken) {
      throw new Error("Expected deferred completion identity");
    }
    resolveResult?.(readyResult(resultRevision, [], resultToken));

    await vi.waitFor(() => {
      expect(runtime.timerDelays).toEqual([1_000]);
    });
  });

  it("rejects a stale completion apply after a context update", async () => {
    const harness = fakeService((revision) =>
      readyResult(revision, [completionItem()])
    );
    const support = sqlEditor({
      initialContext: context(),
      service: harness.service,
    });
    const view = createView(support.extension);
    expect(startCompletion(view)).toBe(true);
    await waitForActiveCompletion(view);
    const completion = currentCompletions(view.state)[0];
    if (!completion || typeof completion.apply !== "function") {
      throw new Error("Expected completion apply callback");
    }

    support.setContext(view, context("connection:new"));
    completion.apply(view, completion, 14, 16);
    expect(view.state.doc.toString()).toBe("SELECT * FROM us");
    expect(harness.updates).toHaveLength(1);
    expect(harness.updates[0]).not.toHaveProperty("embeddedRegions");
  });

  it("updates regions explicitly and requires them for transformed documents", () => {
    const harness = fakeService((revision) => readyResult(revision, []));
    const support = sqlEditor({
      initialContext: context(),
      service: harness.service,
    });
    const view = createView(support.extension, "xxSELECT 1");
    support.setEmbeddedRegions(view, [{
      from: 0,
      language: "host",
      to: 2,
    }]);
    expect(harness.updates.at(-1)).toMatchObject({
      embeddedRegions: [{ from: 0, language: "host", to: 2 }],
    });

    view.dispatch({
      effects: [
        support.contextEffect.of(context("connection:regions")),
        support.embeddedRegionsEffect.of([{
          from: 0,
          language: "host",
          to: 2,
        }]),
      ],
    });
    view.dispatch({
      changes: { from: 10, insert: " " },
      effects: support.embeddedRegionsEffect.of([{
        from: 0,
        language: "host",
        to: 2,
      }]),
    });
    expect(harness.updates).toHaveLength(3);

    const removeEventListener = vi.spyOn(
      document,
      "removeEventListener",
    );
    const error = vi.spyOn(console, "error").mockImplementation(
      () => undefined,
    );
    view.dispatch({ changes: { from: 10, insert: "x" } });
    expect(harness.sessionDisposals()).toBe(1);
    expect(removeEventListener).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    removeEventListener.mockRestore();
    error.mockRestore();
  });

  it("destroys owned resources when a session update is rejected", () => {
    const harness = fakeService(
      (revision) => readyResult(revision, []),
      true,
    );
    const support = sqlEditor({
      initialContext: context(),
      service: harness.service,
    });
    const view = createView(support.extension);
    const error = vi.spyOn(console, "error").mockImplementation(
      () => undefined,
    );

    support.setContext(view, context("connection:rejected"));
    expect(harness.sessionDisposals()).toBe(1);
    expect(harness.updates).toHaveLength(1);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it.each(["sync", "async"] as const)(
    "contains a %s completion service failure",
    async (failureKind) => {
      const harness = fakeService(() => {
        if (failureKind === "sync") {
          throw new Error("synchronous service failure");
        }
        return Promise.reject(new Error("asynchronous service failure"));
      });
      const support = sqlEditor({
        initialContext: context(),
        service: harness.service,
      });
      const view = createView(support.extension);

      expect(startCompletion(view)).toBe(true);
      await vi.waitFor(() => {
        expect(completionStatus(view.state)).toBeNull();
        expect(harness.sessionDisposals()).toBe(1);
      });
      view.destroy();
      expect(harness.sessionDisposals()).toBe(1);
    },
  );

  it("cancels invisible intent on selection, Escape, expiry, and visibility", async () => {
    const runtime = controlledRuntime();
    const harness = fakeService((revision, token) =>
      readyResult(revision, [], token)
    );
    const support = createSqlEditorInternal({
      autocomplete: { closeOnBlur: false },
      initialContext: context(),
      service: harness.service,
    }, runtime.runtime);
    const view = createView(support.extension, "SELECT * FROM ");

    expect(startCompletion(view)).toBe(true);
    await vi.waitFor(() => expect(runtime.timers).toHaveLength(1));
    const selectionToken = harness.getLastToken();
    view.dispatch({ selection: { anchor: 0 } });
    if (!selectionToken) throw new Error("Expected completion token");
    harness.emit({
      reason: "catalog-availability",
      refreshToken: selectionToken,
      revision: createSqlRevisionToken(),
    });
    expect(runtime.queued).toHaveLength(0);

    view.dispatch({ selection: { anchor: 14 } });
    expect(startCompletion(view)).toBe(true);
    await vi.waitFor(() => expect(runtime.timers).toHaveLength(2));
    view.focus();
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      key: "Escape",
    }));
    const escapeToken = harness.getLastToken();
    if (!escapeToken) throw new Error("Expected completion token");
    harness.emit({
      reason: "catalog-availability",
      refreshToken: escapeToken,
      revision: createSqlRevisionToken(),
    });
    expect(runtime.queued).toHaveLength(0);

    expect(startCompletion(view)).toBe(true);
    await vi.waitFor(() => expect(runtime.timers).toHaveLength(3));
    runtime.timers.at(-1)?.();
    const expiredToken = harness.getLastToken();
    if (!expiredToken) throw new Error("Expected completion token");
    harness.emit({
      reason: "catalog-availability",
      refreshToken: expiredToken,
      revision: createSqlRevisionToken(),
    });
    expect(runtime.queued).toHaveLength(0);

    let resolveResult:
      | ((result: SqlCompletionResult) => void)
      | undefined;
    const deferredHarness = fakeService(
      () => new Promise((resolve) => {
        resolveResult = resolve;
      }),
    );
    const deferredSupport = sqlEditor({
      autocomplete: { closeOnBlur: false },
      initialContext: context(),
      service: deferredHarness.service,
    });
    const deferredView = createView(deferredSupport.extension);
    expect(startCompletion(deferredView)).toBe(true);
    await vi.waitFor(() =>
      expect(deferredHarness.completeSignals).toHaveLength(1)
    );
    const visibilityDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(deferredHarness.completeSignals[0]?.aborted).toBe(true);
    if (visibilityDescriptor) {
      Object.defineProperty(
        document,
        "visibilityState",
        visibilityDescriptor,
      );
    } else {
      Reflect.deleteProperty(document, "visibilityState");
    }
    resolveResult?.({
      reason: "caller",
      revision: createSqlRevisionToken(),
      status: "cancelled",
    });
  });

  it("coalesces matching refreshes and suppresses queued work after destroy", async () => {
    const runtime = controlledRuntime();
    const harness = fakeService((revision, token) =>
      readyResult(revision, [], token)
    );
    const support = createSqlEditorInternal({
      initialContext: context(),
      service: harness.service,
    }, runtime.runtime);
    const view = createView(support.extension, "SELECT * FROM ");
    view.focus();
    expect(startCompletion(view)).toBe(true);
    await vi.waitFor(() => expect(runtime.timers).toHaveLength(1));
    const token = harness.getLastToken();
    if (!token) throw new Error("Expected completion token");
    const event: SqlSessionChangeEvent = {
      reason: "catalog-availability",
      refreshToken: token,
      revision: createSqlRevisionToken(),
    };
    harness.emit(event);
    harness.emit(event);
    expect(runtime.queued).toHaveLength(1);
    runtime.queued[0]?.();
    expect(runtime.starts).toEqual([view]);

    harness.emit({
      reason: "provider-configuration",
      refreshToken: null,
      revision: createSqlRevisionToken(),
    });
    expect(runtime.queued).toHaveLength(2);
    runtime.queued[1]?.();
    expect(runtime.closes).toEqual([view]);

    harness.emit({
      reason: "provider-configuration",
      refreshToken: null,
      revision: createSqlRevisionToken(),
    });
    expect(runtime.queued).toHaveLength(3);
    view.destroy();
    runtime.queued[2]?.();
    expect(runtime.closes).toEqual([view]);
    view.destroy();
    expect(harness.sessionDisposals()).toBe(1);
  });

  it("invalidates active and scheduled work across hostile lifecycle timing", async () => {
    const runtime = controlledRuntime();
    let resolveResult:
      | ((result: SqlCompletionResult) => void)
      | undefined;
    const harness = fakeService(
      () => new Promise((resolve) => {
        resolveResult = resolve;
      }),
    );
    const support = createSqlEditorInternal({
      autocomplete: { closeOnBlur: false },
      initialContext: context(),
      service: harness.service,
    }, runtime.runtime);
    const view = createView(support.extension, "SELECT * FROM ");
    expect(startCompletion(view)).toBe(true);
    await vi.waitFor(() =>
      expect(harness.completeSignals).toHaveLength(1)
    );
    const token = harness.getLastToken();
    if (!token) throw new Error("Expected active token");
    harness.emit({
      reason: "catalog-availability",
      refreshToken: token,
      revision: createSqlRevisionToken(),
    });
    expect(runtime.queued).toHaveLength(1);
    expect(harness.completeSignals[0]?.aborted).toBe(true);

    support.setContext(view, context("connection:new"));
    runtime.queued[0]?.();
    expect(runtime.starts).toHaveLength(0);
    document.dispatchEvent(new Event("visibilitychange"));

    resolveResult?.({
      reason: "caller",
      revision: createSqlRevisionToken(),
      status: "cancelled",
    });
  });

  it("does not let a stale rejected task destroy its queued replacement", async () => {
    const runtime = controlledRuntime();
    let rejectResult:
      | ((reason: Error) => void)
      | undefined;
    const harness = fakeService(
      () => new Promise((_resolve, reject) => {
        rejectResult = reject;
      }),
    );
    const support = createSqlEditorInternal({
      autocomplete: { closeOnBlur: false },
      initialContext: context(),
      service: harness.service,
    }, runtime.runtime);
    const view = createView(support.extension, "SELECT * FROM ");
    expect(startCompletion(view)).toBe(true);
    await vi.waitFor(() =>
      expect(harness.completeSignals).toHaveLength(1)
    );
    const token = harness.getLastToken();
    if (!token) throw new Error("Expected active token");
    harness.emit({
      reason: "catalog-availability",
      refreshToken: token,
      revision: createSqlRevisionToken(),
    });
    expect(harness.completeSignals[0]?.aborted).toBe(true);
    expect(runtime.queued).toHaveLength(1);

    rejectResult?.(new Error("late aborted rejection"));
    await vi.waitFor(() => {
      expect(completionStatus(view.state)).toBeNull();
    });
    expect(harness.sessionDisposals()).toBe(0);
    runtime.queued[0]?.();
    expect(runtime.starts).toEqual([view]);
  });

  it("keeps a replacement intent when an older lease timer fires", async () => {
    const runtime = controlledRuntime();
    const harness = fakeService((revision, token) =>
      readyResult(revision, [], token)
    );
    const support = createSqlEditorInternal({
      autocomplete: { closeOnBlur: false },
      initialContext: context(),
      service: harness.service,
    }, runtime.runtime);
    const view = createView(support.extension, "SELECT * FROM ");
    expect(startCompletion(view)).toBe(true);
    await vi.waitFor(() => expect(runtime.timers).toHaveLength(1));
    const oldTimer = runtime.timers[0];

    expect(startCompletion(view)).toBe(true);
    await vi.waitFor(() => expect(runtime.timers).toHaveLength(2));
    oldTimer?.();
    const token = harness.getLastToken();
    if (!token) throw new Error("Expected replacement token");
    harness.emit({
      reason: "catalog-availability",
      refreshToken: token,
      revision: createSqlRevisionToken(),
    });
    expect(runtime.queued).toHaveLength(1);
  });

  it("does not retain a zero-duration loading intent", async () => {
    const runtime = controlledRuntime();
    const harness = fakeService((revision, token) => ({
      refreshToken: token,
      revision,
      sources: [],
      status: "ready",
      value: {
        isIncomplete: true,
        issues: [{
          reason: "catalog-loading",
          remainingIntentLeaseMs: 0,
        }],
        items: [],
      },
    }));
    const support = createSqlEditorInternal({
      autocomplete: { closeOnBlur: false },
      initialContext: context(),
      service: harness.service,
    }, runtime.runtime);
    const view = createView(support.extension, "SELECT * FROM ");
    expect(startCompletion(view)).toBe(true);
    await vi.waitFor(() =>
      expect(harness.completeSignals).toHaveLength(1)
    );
    const token = harness.getLastToken();
    if (!token) throw new Error("Expected completion token");
    harness.emit({
      reason: "catalog-availability",
      refreshToken: token,
      revision: createSqlRevisionToken(),
    });
    expect(runtime.timers).toHaveLength(0);
    expect(runtime.queued).toHaveLength(0);
  });

  it("bridges CodeMirror cancellation and blur into the service signal", async () => {
    let resolveResult:
      | ((result: SqlCompletionResult) => void)
      | undefined;
    const harness = fakeService(
      () => new Promise((resolve) => {
        resolveResult = resolve;
      }),
    );
    const support = sqlEditor({
      initialContext: context(),
      service: harness.service,
    });
    const view = createView(support.extension);
    expect(startCompletion(view)).toBe(true);
    await vi.waitFor(() =>
      expect(harness.completeSignals).toHaveLength(1)
    );
    expect(closeCompletion(view)).toBe(true);
    await vi.waitFor(() => {
      expect(harness.completeSignals[0]?.aborted).toBe(true);
    });
    resolveResult?.({
      reason: "caller",
      revision: createSqlRevisionToken(),
      status: "cancelled",
    });
    await vi.waitFor(() => {
      expect(completionStatus(view.state)).toBeNull();
    });

    view.focus();
    view.dispatch({ selection: { anchor: 15 } });
    expect(startCompletion(view)).toBe(true);
    await vi.waitFor(() =>
      expect(harness.completeSignals).toHaveLength(2)
    );
    view.contentDOM.blur();
    await vi.waitFor(() => {
      expect(harness.completeSignals[1]?.aborted).toBe(true);
    });
    resolveResult?.({
      reason: "caller",
      revision: createSqlRevisionToken(),
      status: "cancelled",
    });
  });
});
