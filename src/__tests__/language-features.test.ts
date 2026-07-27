import { describe, expect, test, vi } from "vitest";
import {
  bigQueryDialect,
  createSqlLanguageService,
  duckdbDialect,
  SqlSessionError,
  type SqlDocumentContext,
  type SqlLanguageFeatureProvider,
} from "../index.js";

function open(
  text: string,
  providers: readonly SqlLanguageFeatureProvider[] = [],
  budget = 150,
) {
  const service = createSqlLanguageService({
    dialects: [duckdbDialect()],
    featureProviderBudgetMs: budget,
    featureProviders: providers,
  });
  const session = service.openDocument({
    context: { dialect: "duckdb" },
    text,
  });
  return { service, session };
}

describe("language feature sessions", () => {
  test("provides bounded local statement symbols and folds", async () => {
    const { service, session } = open(
      "select\n  1;\n\ninsert into t\nvalues (1)",
    );

    await expect(session.documentSymbols().result).resolves.toMatchObject({
      status: "ready",
      value: [
        {
          kind: "statement",
          name: "SELECT statement",
          selectionRange: { from: 0, to: 6 },
        },
        {
          kind: "statement",
          name: "INSERT statement",
        },
      ],
    });
    await expect(session.foldingRanges().result).resolves.toMatchObject({
      status: "ready",
      value: [
        { from: 0, kind: "statement", to: 10 },
        { from: 13, kind: "statement", to: 37 },
      ],
    });
    session.dispose();
    service.dispose();
  });

  test("composes diagnostics while preserving provider evidence", async () => {
    const providers: readonly SqlLanguageFeatureProvider[] = [
      {
        id: "syntax",
        diagnostics: () => [{
          from: 0,
          message: "Unexpected token",
          severity: "error",
          source: "parser",
          to: 6,
        }],
      },
      {
        id: "host",
        diagnostics: () => [{
          code: "policy",
          from: 7,
          message: "Use a qualified relation",
          severity: "warning",
          source: "host",
          to: 8,
        }],
      },
    ];
    const { service, session } = open("select t", providers);

    const result = await session.diagnostics().result;

    expect(result).toMatchObject({
      sources: [
        { outcome: "ready", providerId: "syntax" },
        { outcome: "ready", providerId: "host" },
      ],
      status: "ready",
    });
    if (result.status === "ready") {
      expect(result.value).toHaveLength(2);
      expect(result.isIncomplete).toBe(false);
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value[0])).toBe(true);
    }
    session.dispose();
    service.dispose();
  });

  test("supports every scalar and collection feature contract", async () => {
    const provider: SqlLanguageFeatureProvider = {
      id: "engine",
      codeActions: () => [{
        edit: { changes: [{ from: 0, insert: "SELECT", to: 6 }] },
        kind: "quickfix",
        title: "Uppercase SELECT",
      }],
      definitions: () => [{ range: { from: 7, to: 8 } }],
      format: () => ({
        changes: [{ from: 0, insert: "SELECT a", to: 8 }],
      }),
      highlights: () => [{ from: 7, to: 8 }],
      hover: () => ({
        contents: { kind: "markdown", value: "`a`: integer" },
        range: { from: 7, to: 8 },
      }),
      references: () => [
        { range: { from: 7, to: 8 } },
        { range: { from: 17, to: 18 }, uri: "file:///query.sql" },
      ],
      rename: ({ request }) => ({
        changes: [
          { from: 7, insert: request.newName, to: 8 },
          { from: 17, insert: request.newName, to: 18 },
        ],
      }),
    };
    const { service, session } = open(
      "select a from t, a",
      [provider],
    );

    await expect(session.hover({ position: 7 }).result).resolves.toMatchObject({
      status: "ready",
      value: { range: { from: 7, to: 8 } },
    });
    await expect(
      session.definitions({ position: 7 }).result,
    ).resolves.toMatchObject({ status: "ready", value: [{ range: { from: 7 } }] });
    await expect(
      session.references({ position: 7 }).result,
    ).resolves.toMatchObject({ status: "ready", value: [{}, {}] });
    await expect(
      session.highlights({ position: 7 }).result,
    ).resolves.toMatchObject({ status: "ready", value: [{ from: 7 }] });
    await expect(
      session.rename({ newName: "answer", position: 7 }).result,
    ).resolves.toMatchObject({
      status: "ready",
      value: { changes: [{ insert: "answer" }, { insert: "answer" }] },
    });
    await expect(session.format({ tabSize: 2 }).result).resolves.toMatchObject({
      status: "ready",
      value: { changes: [{ insert: "SELECT a" }] },
    });
    await expect(
      session.codeActions({ range: { from: 0, to: 6 } }).result,
    ).resolves.toMatchObject({
      status: "ready",
      value: [{ kind: "quickfix", title: "Uppercase SELECT" }],
    });
    session.dispose();
    service.dispose();
  });

  test("isolates provider failures and malformed results", async () => {
    const malformed = {
      id: "malformed",
      diagnostics: () => [{
        from: -1,
        message: "bad",
        severity: "error",
        source: "bad",
        to: 1,
      }],
    } satisfies SqlLanguageFeatureProvider;
    const rejected = {
      id: "rejected",
      diagnostics: () => Promise.reject(new Error("private detail")),
    } satisfies SqlLanguageFeatureProvider;
    const { service, session } = open("select 1", [malformed, rejected]);

    await expect(session.diagnostics().result).resolves.toEqual({
      reason: "no-result",
      revision: session.revision,
      sources: [
        { outcome: "failed", providerId: "malformed" },
        { outcome: "failed", providerId: "rejected" },
      ],
      status: "unavailable",
    });
    session.dispose();
    service.dispose();
  });

  test("cancels promptly on callers, updates, and disposal", async () => {
    const pending = vi.fn(() => new Promise<never>(() => {}));
    const { service, session } = open(
      "select 1",
      [{ id: "remote", hover: pending }],
      25,
    );
    const controller = new AbortController();
    const caller = session.hover({
      position: 1,
      signal: controller.signal,
    });
    controller.abort();
    await expect(caller.result).resolves.toMatchObject({
      reason: "caller",
      status: "cancelled",
    });

    const superseded = session.hover({ position: 1 });
    session.update({
      baseRevision: session.revision,
      document: { kind: "replace", text: "select 2" },
      embeddedRegions: [],
    });
    await expect(superseded.result).resolves.toMatchObject({
      reason: "superseded",
      status: "cancelled",
    });

    const disposed = session.hover({ position: 1 });
    session.dispose();
    await expect(disposed.result).resolves.toMatchObject({
      reason: "disposed",
      status: "cancelled",
    });
    service.dispose();
  });

  test("runs independent providers concurrently under one latency envelope", async () => {
    const provider = (id: string): SqlLanguageFeatureProvider => ({
      id,
      diagnostics: () => new Promise<never>(() => {}),
    });
    const { service, session } = open(
      "select 1",
      [provider("one"), provider("two"), provider("three")],
      20,
    );
    const started = performance.now();

    const result = await session.diagnostics().result;

    expect(performance.now() - started).toBeLessThan(75);
    expect(result).toMatchObject({
      reason: "no-result",
      status: "unavailable",
    });
    session.dispose();
    service.dispose();
  });

  test("rejects unsafe request and provider shapes atomically", () => {
    const { service, session } = open("select 1");
    expect(() => session.hover({ position: -1 })).toThrowError(
      SqlSessionError,
    );
    expect(() => session.rename({ newName: "", position: 1 })).toThrowError(
      SqlSessionError,
    );
    expect(() => session.format({ tabSize: 0 })).toThrowError(SqlSessionError);
    session.dispose();
    service.dispose();

    expect(() => createSqlLanguageService<SqlDocumentContext>({
      dialects: [duckdbDialect()],
      featureProviders: [
        { id: "same" },
        { id: "same" },
      ],
    })).toThrowError(SqlSessionError);
  });

  test("normalizes the complete request surface", async () => {
    const controller = new AbortController();
    const { service, session } = open("select 1", [{
      id: "empty",
      codeActions: () => [],
      diagnostics: () => [],
      format: () => null,
      hover: () => null,
      rename: () => null,
    }]);
    await expect(session.diagnostics({
      range: undefined,
      signal: controller.signal,
    }).result).resolves.toMatchObject({ status: "ready" });
    await expect(session.diagnostics({
      range: { from: 0, to: 6 },
    }).result).resolves.toMatchObject({ status: "ready" });
    await expect(session.codeActions({
      range: { from: 0, to: 6 },
      signal: controller.signal,
    }).result).resolves.toMatchObject({ status: "ready" });
    await expect(session.format({
      range: { from: 0, to: 6 },
      tabSize: 16,
      useTabs: true,
    }).result).resolves.toMatchObject({
      reason: "no-result",
      status: "unavailable",
    });
    await expect(session.format({
      tabSize: 1,
      useTabs: false,
    }).result).resolves.toMatchObject({ status: "unavailable" });
    await expect(session.hover({
      position: 1,
      signal: controller.signal,
    }).result).resolves.toMatchObject({
      reason: "no-result",
      status: "unavailable",
    });
    await expect(session.rename({
      newName: "x",
      position: 1,
      signal: controller.signal,
    }).result).resolves.toMatchObject({
      reason: "no-result",
      status: "unavailable",
    });

    for (const invoke of [
      () => Reflect.apply(session.hover, session, [null]),
      () => Reflect.apply(session.hover, session, [{ position: Number.NaN }]),
      () => Reflect.apply(session.hover, session, [{ position: 9 }]),
      () => Reflect.apply(session.hover, session, [{ position: 1, signal: "bad" }]),
      () => Reflect.apply(session.codeActions, session, [null]),
      () => Reflect.apply(session.codeActions, session, [{}]),
      () => Reflect.apply(session.codeActions, session, [{ range: { from: 2, to: 1 } }]),
      () => Reflect.apply(session.diagnostics, session, [null]),
      () => Reflect.apply(session.diagnostics, session, [{ range: null }]),
      () => Reflect.apply(session.rename, session, [{ newName: 1, position: 1 }]),
      () => Reflect.apply(session.rename, session, [{ newName: "x".repeat(1_025), position: 1 }]),
      () => Reflect.apply(session.format, session, [{ tabSize: Number.NaN }]),
      () => Reflect.apply(session.format, session, [{ tabSize: 17 }]),
      () => Reflect.apply(session.format, session, [{ tabSize: "2" }]),
      () => Reflect.apply(session.format, session, [{ useTabs: "yes" }]),
    ]) {
      expect(invoke).toThrowError(SqlSessionError);
    }
    const positionAccessor = {};
    Object.defineProperty(positionAccessor, "position", {
      get: () => {
        throw new Error("unsafe");
      },
    });
    const rangeAccessor = {};
    Object.defineProperty(rangeAccessor, "range", {
      get: () => {
        throw new Error("unsafe");
      },
    });
    expect(() => Reflect.apply(
      session.hover,
      session,
      [positionAccessor],
    )).toThrowError(SqlSessionError);
    expect(() => Reflect.apply(
      session.codeActions,
      session,
      [rangeAccessor],
    )).toThrowError(SqlSessionError);
    expect(() => Reflect.apply(
      session.diagnostics,
      session,
      [rangeAccessor],
    )).toThrowError(SqlSessionError);
    session.dispose();
    expect(() => session.diagnostics()).toThrowError(SqlSessionError);
    service.dispose();
  });

  test("clamps composed collection results and masks embedded regions", async () => {
    const diagnostics = Array.from({ length: 1_000 }, (_, index) => ({
      from: index % 2,
      message: `message ${index}`,
      severity: "hint" as const,
      source: "host",
      to: index % 2,
    }));
    const { service, session } = open("s{py}\nelect 1", [
      { diagnostics: () => diagnostics, id: "one" },
      { diagnostics: () => diagnostics, id: "two" },
    ]);
    const result = await session.diagnostics().result;
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.value).toHaveLength(1_000);
      expect(result.isIncomplete).toBe(true);
    }
    session.update({
      baseRevision: session.revision,
      document: { kind: "replace", text: "s{py}\nelect 2" },
      embeddedRegions: [{ from: 1, language: "python", to: 5 }],
    });
    await expect(session.documentSymbols().result).resolves.toMatchObject({
      status: "ready",
    });
    session.dispose();
    service.dispose();
  });

  test("accepts budget boundaries and rejects every invalid budget class", () => {
    const defaults = createSqlLanguageService({
      dialects: [duckdbDialect()],
      featureProviderBudgetMs: undefined,
      featureProviders: undefined,
    });
    defaults.dispose();
    for (const budget of [0, 5_000]) {
      const service = createSqlLanguageService({
        dialects: [duckdbDialect()],
        featureProviderBudgetMs: budget,
      });
      service.dispose();
    }
    for (const budget of [-1, 5_001, Number.POSITIVE_INFINITY, "10"]) {
      expect(() => Reflect.apply(createSqlLanguageService, undefined, [{
          dialects: [duckdbDialect()],
          featureProviderBudgetMs: budget,
        }])).toThrowError(SqlSessionError);
    }
    expect(() => createSqlLanguageService({
      dialects: [duckdbDialect()],
      featureProviders: [{ id: "@marimo/local-structure" }],
    })).toThrowError(SqlSessionError);
  });

  test("makes repeated cancellation idempotent", async () => {
    const { service, session } = open("select", [{
      id: "pending",
      hover: () => new Promise<never>(() => {}),
    }], 1_000);
    const task = session.hover({ position: 1 });
    task.cancel();
    task.cancel();
    session.update({
      baseRevision: session.revision,
      document: { kind: "replace", text: "select 2" },
      embeddedRegions: [],
    });
    await expect(task.result).resolves.toMatchObject({
      reason: "caller",
      status: "cancelled",
    });
    session.dispose();
    service.dispose();
  });

  test("bounds local structure output and handles trivia-only statements", async () => {
    const statement = "select\n1;";
    const text = `; 123;\n${statement.repeat(1_001)}`;
    const { service, session } = open(text);
    const symbols = await session.documentSymbols().result;
    const folds = await session.foldingRanges().result;
    expect(symbols.status).toBe("ready");
    expect(folds.status).toBe("ready");
    if (symbols.status === "ready") {
      expect(symbols.value).toHaveLength(1_000);
      expect(symbols.value[0]?.name).toBe("SQL statement");
    }
    if (folds.status === "ready") {
      expect(folds.value).toHaveLength(1_000);
    }
    session.dispose();
    service.dispose();
  });

  test("does not invent structure inside opaque procedural blocks", async () => {
    const service = createSqlLanguageService({
      dialects: [bigQueryDialect()],
    });
    const session = service.openDocument({
      context: { dialect: "bigquery" },
      text: "IF condition THEN SELECT 1; END IF;",
    });
    await expect(session.documentSymbols().result).resolves.toMatchObject({
      status: "ready",
      value: [],
    });
    await expect(session.foldingRanges().result).resolves.toMatchObject({
      status: "ready",
      value: [],
    });
    session.dispose();
    service.dispose();
  });

  test("uses one provider-owned cancellation signal at maximum fan-out", async () => {
    const providerSignals: AbortSignal[] = [];
    const requestHasSignal: boolean[] = [];
    const providers = Array.from({ length: 64 }, (_, index) => ({
      id: `provider-${index}`,
      hover: ({ request, signal }) => {
        requestHasSignal.push("signal" in request);
        providerSignals.push(signal);
        return new Promise<never>(() => {});
      },
    } satisfies SqlLanguageFeatureProvider));
    const { service, session } = open("select", providers, 1_000);
    const task = session.hover({ position: 1 });
    await Promise.resolve();
    task.cancel();
    await expect(task.result).resolves.toMatchObject({
      reason: "caller",
      status: "cancelled",
    });
    expect(providerSignals).toHaveLength(64);
    expect(providerSignals.every((signal) => signal.aborted)).toBe(true);
    expect(requestHasSignal.every((present) => !present)).toBe(true);
    session.dispose();
    service.dispose();
  });
});
