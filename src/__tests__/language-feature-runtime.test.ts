import { describe, expect, test } from "vitest";
import {
  captureSqlLanguageFeatureProviders,
  composeSqlCodeActionResults,
  createSqlFeatureDocument,
  invokeSqlFeatureProviders,
  normalizeSqlCodeActions,
  normalizeSqlDiagnostics,
  normalizeSqlDocumentEdit,
  normalizeSqlDocumentSymbols,
  normalizeSqlFoldingRanges,
  normalizeSqlHover,
  normalizeSqlLocations,
  normalizeSqlRanges,
} from "../language-feature-runtime.js";

describe("language feature runtime boundaries", () => {
  test("captures only bounded, unique, data-only providers", () => {
    expect(captureSqlLanguageFeatureProviders(undefined)).toEqual([]);
    expect(captureSqlLanguageFeatureProviders([
      { id: "one", hover: () => null },
    ])).toHaveLength(1);
    for (const candidate of [
      null,
      {},
      { id: "" },
      { id: "x".repeat(257) },
      { diagnostics: () => [] },
      { diagnostics: 1, id: "bad-method" },
    ]) {
      expect(() => captureSqlLanguageFeatureProviders([candidate])).toThrow();
    }
    expect(() => captureSqlLanguageFeatureProviders([
      { id: "same" },
      { id: "same" },
    ])).toThrow();
    expect(() => captureSqlLanguageFeatureProviders({})).toThrow();
    expect(() => captureSqlLanguageFeatureProviders(
      Array.from({ length: 65 }, (_, index) => ({ id: String(index) })),
    )).toThrow();
    const accessor = {};
    Object.defineProperty(accessor, "id", { get: () => "unsafe" });
    expect(() => captureSqlLanguageFeatureProviders([accessor])).toThrow();
  });

  test("normalizes all range-bearing result families", () => {
    expect(normalizeSqlDiagnostics([
      {
        code: "E1",
        from: 0,
        message: "error",
        severity: "error",
        source: "syntax",
        to: 1,
      },
      {
        from: 1,
        message: "warning",
        severity: "warning",
        source: "host",
        to: 2,
      },
      {
        from: 2,
        message: "info",
        severity: "information",
        source: "host",
        to: 3,
      },
      {
        from: 3,
        message: "hint",
        severity: "hint",
        source: "host",
        to: 4,
      },
    ], 4)).toHaveLength(4);
    expect(normalizeSqlLocations([
      { range: { from: 0, to: 1 } },
      { range: { from: 1_000, to: 1_010 }, uri: "file:///query.sql" },
    ], 2)).toHaveLength(2);
    expect(normalizeSqlRanges([{ from: 0, to: 0 }], 1)).toEqual([
      { from: 0, to: 0 },
    ]);
    expect(normalizeSqlRanges(
      Array.from({ length: 1_000 }, () => ({ from: 0, to: 0 })),
      1,
    )).toHaveLength(1_000);
    for (const candidate of [
      null,
      {},
      Array.from({ length: 1_001 }, () => ({})),
    ]) {
      expect(() => normalizeSqlRanges(candidate, 1)).toThrow();
    }
    expect(() => normalizeSqlDiagnostics([{
      from: 0,
      message: "bad",
      severity: "fatal",
      source: "host",
      to: 1,
    }], 1)).toThrow();
    expect(() => normalizeSqlLocations([
      { range: { from: 0, to: 1 }, uri: "" },
    ], 1)).toThrow();
  });

  test("normalizes hover, symbols, and folding", () => {
    expect(normalizeSqlHover(null, 1)).toBeNull();
    expect(normalizeSqlHover({
      contents: { kind: "plaintext", value: "value" },
      range: { from: 0, to: 1 },
    }, 1)).toMatchObject({ contents: { kind: "plaintext" } });
    expect(normalizeSqlHover({
      contents: { kind: "markdown", value: "**value**" },
      range: { from: 0, to: 1 },
    }, 1)).toMatchObject({ contents: { kind: "markdown" } });
    expect(() => normalizeSqlHover({
      contents: { kind: "html", value: "unsafe" },
      range: { from: 0, to: 1 },
    }, 1)).toThrow();
    expect(() => normalizeSqlHover(1, 1)).toThrow();
    expect(() => normalizeSqlHover({}, 1)).toThrow();

    const kinds = ["statement", "relation", "column", "function", "parameter"] as const;
    expect(normalizeSqlDocumentSymbols(kinds.map((kind) => ({
      detail: `${kind} detail`,
      kind,
      name: kind,
      range: { from: 0, to: 2 },
      selectionRange: { from: 0, to: 1 },
    })), 2)).toHaveLength(5);
    expect(() => normalizeSqlDocumentSymbols([{
      kind: "unknown",
      name: "x",
      range: { from: 0, to: 1 },
      selectionRange: { from: 0, to: 1 },
    }], 1)).toThrow();
    expect(() => normalizeSqlDocumentSymbols([{
      kind: "relation",
      name: "x",
      range: { from: 1, to: 2 },
      selectionRange: { from: 0, to: 1 },
    }], 2)).toThrow();

    expect(normalizeSqlFoldingRanges([
      { from: 0, kind: "statement", to: 1 },
      { from: 1, kind: "region", to: 2 },
      { from: 2, kind: "comment", to: 3 },
      { from: 3, to: 4 },
    ], 4)).toHaveLength(4);
    expect(() => normalizeSqlFoldingRanges([
      { from: 0, kind: "custom", to: 1 },
    ], 1)).toThrow();
  });

  test("normalizes edits and code actions atomically", () => {
    expect(normalizeSqlDocumentEdit(null, 2)).toBeNull();
    expect(normalizeSqlDocumentEdit({
      changes: [
        { from: 0, insert: "A", to: 1 },
        { from: 1, insert: "", to: 2 },
      ],
    }, 2)).toMatchObject({ changes: [{ insert: "A" }, { insert: "" }] });
    expect(() => normalizeSqlDocumentEdit({
      changes: [
        { from: 1, insert: "A", to: 2 },
        { from: 0, insert: "B", to: 1 },
      ],
    }, 2)).toThrow();
    expect(() => normalizeSqlDocumentEdit({
      changes: [{ from: 0, insert: 1, to: 1 }],
    }, 1)).toThrow();
    expect(() => normalizeSqlDocumentEdit({
      changes: [
        { from: 0, insert: "x".repeat(16 * 1024 * 1024), to: 0 },
        { from: 0, insert: "x", to: 0 },
      ],
    }, 0)).toThrow();
    expect(() => normalizeSqlDocumentEdit({
      changes: [{ from: 0, insert: "xx", to: 0 }],
    }, 16 * 1024 * 1024 - 1)).toThrow();

    expect(normalizeSqlCodeActions([
      { kind: "quickfix", title: "Fix" },
      {
        diagnostics: ["E1"],
        edit: { changes: [] },
        kind: "refactor",
        title: "Refactor",
      },
      { kind: "source", title: "Source" },
      { edit: null, title: "Null edit" },
      { title: "Other" },
    ], 1)).toHaveLength(5);
    expect(() => normalizeSqlCodeActions([
      { kind: "unsafe", title: "Bad" },
    ], 1)).toThrow();
    const nested = Array.from({ length: 11 }, (_, index) => ({
      diagnostics: Array.from(
        { length: 1_000 },
        (__, diagnostic) => `${index}:${diagnostic}`,
      ),
      title: `Action ${index}`,
    }));
    expect(() => normalizeSqlCodeActions(nested, 1)).toThrow();
    const action = Object.freeze({
      diagnostics: Object.freeze(
        Array.from({ length: 1_000 }, (_, index) => `E${index}`),
      ),
      title: "Nested action",
    });
    const composed = composeSqlCodeActionResults([
      Array.from({ length: 6 }, () => action),
      Array.from({ length: 6 }, () => action),
    ]);
    expect(composed.isIncomplete).toBe(true);
    expect(composed.value).toHaveLength(10);
  });

  test("isolates concurrent invocation outcomes in provider order", async () => {
    let timedOutSignal: AbortSignal | undefined;
    const providers = captureSqlLanguageFeatureProviders([
      { diagnostics: () => [1], id: "ready" },
      { diagnostics: () => {
        throw new Error("private");
      }, id: "throw" },
      { id: "absent" },
      {
        diagnostics: ({ signal }: { readonly signal: AbortSignal }) => {
          timedOutSignal = signal;
          return new Promise<never>(() => {});
        },
        id: "timeout",
      },
    ]);
    const document = createSqlFeatureDocument(
      "select",
      { dialect: "duckdb" },
      [],
    );
    const controller = new AbortController();
    const result = await invokeSqlFeatureProviders(
      providers,
      document,
      {},
      controller.signal,
      5,
      (provider) => provider.diagnostics !== undefined,
      (provider, currentDocument, request, signal) =>
        provider.diagnostics?.({
          document: currentDocument,
          request,
          signal,
        }),
      (value) => value,
    );

    expect(result.reports).toEqual([
      { outcome: "ready", providerId: "ready" },
      { outcome: "failed", providerId: "throw" },
      { outcome: "timed-out", providerId: "timeout" },
    ]);
    expect(result.values).toEqual([[1]]);
    expect(timedOutSignal?.aborted).toBe(true);
    expect(Object.isFrozen(document)).toBe(true);
  });

  test("drains ignored work while aborting publication promptly", async () => {
    const providers = captureSqlLanguageFeatureProviders([
      {
        diagnostics: () => new Promise<never>(() => {}),
        id: "pending",
      },
    ]);
    const controller = new AbortController();
    const result = invokeSqlFeatureProviders(
      providers,
      createSqlFeatureDocument("select", { dialect: "duckdb" }, []),
      {},
      controller.signal,
      1_000,
      (provider) => provider.diagnostics !== undefined,
      (provider, document, request, signal) =>
        provider.diagnostics?.({ document, request, signal }),
      (value) => value,
    );
    controller.abort();
    await expect(result).resolves.toEqual({ reports: [], values: [] });

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(invokeSqlFeatureProviders(
      providers,
      createSqlFeatureDocument("select", { dialect: "duckdb" }, []),
      {},
      alreadyAborted.signal,
      1_000,
      () => true,
      () => [],
      (value) => value,
    )).resolves.toEqual({ reports: [], values: [] });

    const reentrant = new AbortController();
    await expect(invokeSqlFeatureProviders(
      providers,
      createSqlFeatureDocument("select", { dialect: "duckdb" }, []),
      {},
      reentrant.signal,
      1_000,
      () => true,
      () => {
        reentrant.abort();
        return new Promise<never>(() => {});
      },
      (value) => value,
    )).resolves.toEqual({ reports: [], values: [] });
  });

  test("accounts for synchronous provider time in one request deadline", async () => {
    let laterCalls = 0;
    const providers = captureSqlLanguageFeatureProviders([
      {
        diagnostics: () => {
          const deadline = performance.now() + 10;
          while (performance.now() < deadline) {
            // Deliberately model a badly behaved synchronous integration.
          }
          return [];
        },
        id: "blocking",
      },
      {
        diagnostics: () => {
          laterCalls += 1;
          return [];
        },
        id: "later",
      },
    ]);
    const result = await invokeSqlFeatureProviders(
      providers,
      createSqlFeatureDocument("select", { dialect: "duckdb" }, []),
      {},
      new AbortController().signal,
      1,
      (provider) => provider.diagnostics !== undefined,
      (provider, document, request, signal) =>
        provider.diagnostics?.({ document, request, signal }),
      (value) => value,
    );
    expect(result).toEqual({
      reports: [
        { outcome: "timed-out", providerId: "blocking" },
        { outcome: "timed-out", providerId: "later" },
      ],
      values: [],
    });
    expect(laterCalls).toBe(0);
  });

  test("isolates provider mutation during capability inspection", async () => {
    const mutable = {
      diagnostics: () => [],
      id: "mutable",
    };
    const providers = captureSqlLanguageFeatureProviders([mutable]);
    Object.defineProperty(mutable, "diagnostics", {
      configurable: true,
      get: () => {
        throw new Error("private accessor failure");
      },
    });
    const result = await invokeSqlFeatureProviders(
      providers,
      createSqlFeatureDocument("select", { dialect: "duckdb" }, []),
      {},
      new AbortController().signal,
      10,
      (provider) => provider.diagnostics !== undefined,
      () => [],
      (value) => value,
    );
    expect(result).toEqual({
      reports: [{ outcome: "failed", providerId: "mutable" }],
      values: [],
    });
  });
});
