import {
  closeCompletion,
  completionStatus,
  currentCompletions,
  startCompletion,
} from "@codemirror/autocomplete";
import { EditorSelection, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
  readonly service: SqlLanguageService<TestContext>;
  readonly sessionDisposals: () => number;
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
): FakeServiceHarness {
  const completeSignals: AbortSignal[] = [];
  const updates: SqlDocumentUpdate<TestContext>[] = [];
  let listener:
    | ((event: SqlSessionChangeEvent) => void)
    | null = null;
  let lastToken: SqlCompletionRefreshToken | null = null;
  let sessionDisposalCount = 0;
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
    service,
    sessionDisposals: () => sessionDisposalCount,
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

describe("sqlEditor", () => {
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
