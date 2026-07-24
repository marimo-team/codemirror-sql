import { describe, expect, it } from "vitest";
import {
  createCompatibilityParsedAnalysis,
  createDirectParsedAnalysis,
  createEmptySyntaxState,
  createFailedParserAnalysis,
  createIncompleteSyntaxState,
  createInvalidParserAnalysis,
  createOpaqueSyntaxState,
  createSqlConformanceIdentity,
  createSqlDialectSyntaxIdentity,
  createSqlParserDiagnostic,
  createSqlParserAuthority,
  createSqlStatementParseRequest,
  createSqlStatementParser,
  createSqlStatementRelativeRange,
  createSqlSyntaxArtifact,
  createSqlSyntaxBackendIdentity,
  createSqlSyntaxConfigurationIdentity,
  createUnavailableSyntaxState,
  createUnsupportedParserAnalysis,
  isSqlParserAnalysis,
  isSqlStatementSyntaxState,
  MAX_SQL_SYNTAX_DIAGNOSTICS,
  MAX_SQL_SYNTAX_MESSAGE_INPUT_LENGTH,
  MAX_SQL_SYNTAX_MESSAGE_LENGTH,
  MAX_SQL_STATEMENT_PARSE_LENGTH,
  runSqlStatementParser,
  SqlSyntaxContractError,
  type SqlStatementKind,
} from "../syntax.js";

function invokeWithUnknown(
  callback: (...values: never[]) => unknown,
  ...values: unknown[]
): unknown {
  return Reflect.apply(callback, undefined, values);
}

function expectContractError(
  callback: () => unknown,
  code: SqlSyntaxContractError["code"],
): void {
  try {
    callback();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(SqlSyntaxContractError);
    if (error instanceof SqlSyntaxContractError) {
      expect(error.code).toBe(code);
      expect(error.name).toBe("SqlSyntaxContractError");
    }
    return;
  }
  throw new Error(`Expected ${code}`);
}

function createParserAuthority() {
  const backendIdentity = createSqlSyntaxBackendIdentity();
  const configurationIdentity =
    createSqlSyntaxConfigurationIdentity();
  const dialectIdentity = createSqlDialectSyntaxIdentity();
  const authority = createSqlParserAuthority(
    backendIdentity,
    configurationIdentity,
    dialectIdentity,
  );
  const conformance = createSqlConformanceIdentity(authority);
  return {
    authority,
    backendIdentity,
    configurationIdentity,
    conformance,
    dialectIdentity,
  };
}

describe("statement-relative ranges", () => {
  it("creates frozen half-open UTF-16 ranges, including empty ranges", () => {
    const astralText = "a🦆\ud800";
    const full = createSqlStatementRelativeRange(
      0,
      astralText.length,
      astralText.length,
    );
    const atEnd = createSqlStatementRelativeRange(
      astralText.length,
      astralText.length,
      astralText.length,
    );

    expect(full).toMatchObject({ from: 0, to: 4 });
    expect(atEnd).toMatchObject({ from: 4, to: 4 });
    expect(Object.isFrozen(full)).toBe(true);
  });

  it.each([
    [-1, 0, 0],
    [1, 0, 1],
    [0, 2, 1],
    [0.5, 1, 1],
    [0, Number.NaN, 1],
    [0, 1, Number.POSITIVE_INFINITY],
    [0, 0, -1],
    [0, 0, 0.5],
  ])("rejects invalid range (%j, %j, %j)", (from, to, length) => {
    expectContractError(
      () => createSqlStatementRelativeRange(from, to, length),
      "invalid-range",
    );
  });
});

describe("opaque identities", () => {
  it("creates frozen, distinct identities for each authority boundary", () => {
    const backend = createSqlSyntaxBackendIdentity();
    const configuration = createSqlSyntaxConfigurationIdentity();
    const dialect = createSqlDialectSyntaxIdentity();
    const authority = createSqlParserAuthority(
      backend,
      configuration,
      dialect,
    );
    const conformance = createSqlConformanceIdentity(authority);

    expect(Object.isFrozen(backend)).toBe(true);
    expect(Object.isFrozen(configuration)).toBe(true);
    expect(Object.isFrozen(dialect)).toBe(true);
    expect(Object.isFrozen(authority)).toBe(true);
    expect(authority).toMatchObject({
      backendIdentity: backend,
      configurationIdentity: configuration,
      dialectIdentity: dialect,
    });
    expect(Object.isFrozen(conformance)).toBe(true);
    expect(createSqlSyntaxBackendIdentity()).not.toBe(backend);
    expect(createSqlSyntaxConfigurationIdentity()).not.toBe(configuration);
    expect(createSqlDialectSyntaxIdentity()).not.toBe(dialect);
    expect(createSqlConformanceIdentity(authority)).not.toBe(
      conformance,
    );
  });

  it("rejects fabricated authority inputs", () => {
    const backend = createSqlSyntaxBackendIdentity();
    const configuration = createSqlSyntaxConfigurationIdentity();
    const dialect = createSqlDialectSyntaxIdentity();
    expectContractError(
      () =>
        invokeWithUnknown(
          createSqlParserAuthority,
          {},
          configuration,
          dialect,
        ),
      "invalid-identity",
    );
    expectContractError(
      () =>
        invokeWithUnknown(
          createSqlParserAuthority,
          backend,
          {},
          dialect,
        ),
      "invalid-identity",
    );
    expectContractError(
      () =>
        invokeWithUnknown(
          createSqlParserAuthority,
          backend,
          configuration,
          {},
        ),
      "invalid-identity",
    );
    expectContractError(
      () => invokeWithUnknown(createSqlConformanceIdentity, {}),
      "invalid-identity",
    );
  });
});

describe("syntax artifacts and diagnostics", () => {
  const { authority } = createParserAuthority();
  const kinds: readonly SqlStatementKind[] = [
    "alter",
    "create",
    "delete",
    "drop",
    "insert",
    "merge",
    "other",
    "query",
    "transaction",
    "update",
  ];

  it.each(kinds)("creates an authentic frozen %s artifact", (kind) => {
    const artifact = createSqlSyntaxArtifact(
      kind,
      "x".repeat(12),
      authority,
    );
    expect(artifact.kind).toBe(kind);
    expect(artifact.range).toMatchObject({ from: 0, to: 12 });
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.range)).toBe(true);
  });

  it("rejects unknown kinds and invalid lengths", () => {
    expectContractError(
      () => createSqlSyntaxArtifact("select", "abc", authority),
      "invalid-artifact",
    );
    expectContractError(
      () => createSqlSyntaxArtifact("query", -1, authority),
      "invalid-artifact",
    );
  });

  it("normalizes exact and unavailable diagnostic locations", () => {
    const range = createSqlStatementRelativeRange(2, 5, 8);
    const exact = createSqlParserDiagnostic(
      "  bad token  ",
      range,
      "12345678",
      authority,
    );
    const unavailable = createSqlParserDiagnostic(
      "bad",
      null,
      "12345678",
      authority,
    );

    expect(exact).toMatchObject({
      code: "syntax-error",
      location: { availability: "exact", range },
      message: "bad token",
      severity: "error",
    });
    expect(unavailable.location).toEqual({
      availability: "unavailable",
      reason: "not-reported",
    });
    expect(Object.isFrozen(exact)).toBe(true);
    expect(Object.isFrozen(exact.location)).toBe(true);
    expect(Object.isFrozen(unavailable.location)).toBe(true);
  });

  it("bounds messages and rejects malformed diagnostics", () => {
    const longMessage = "x".repeat(MAX_SQL_SYNTAX_MESSAGE_LENGTH + 10);
    expect(
      createSqlParserDiagnostic(
        longMessage,
        null,
        "",
        authority,
      ).message,
    ).toHaveLength(MAX_SQL_SYNTAX_MESSAGE_LENGTH);

    for (const message of ["", " \n "]) {
      expectContractError(
        () =>
          createSqlParserDiagnostic(message, null, "", authority),
        "invalid-diagnostic",
      );
    }
    for (const location of [false, 0, "", undefined, Number.NaN]) {
      expectContractError(
        () =>
          createSqlParserDiagnostic(
            "bad",
            location,
            "x",
            authority,
          ),
        "invalid-diagnostic",
      );
    }
    expectContractError(
      () =>
        invokeWithUnknown(
          createSqlParserDiagnostic,
          12,
          null,
          "",
          authority,
        ),
      "invalid-diagnostic",
    );
    expectContractError(
      () =>
        createSqlParserDiagnostic(
          "x".repeat(MAX_SQL_SYNTAX_MESSAGE_INPUT_LENGTH + 1),
          null,
          "",
          authority,
        ),
      "invalid-diagnostic",
    );
    const outside = createSqlStatementRelativeRange(0, 4, 4);
    expectContractError(
      () =>
        createSqlParserDiagnostic(
          "bad",
          outside,
          "abc",
          authority,
        ),
      "invalid-diagnostic",
    );
    expectContractError(
      () =>
        invokeWithUnknown(
          createSqlParserDiagnostic,
          "bad",
          { from: 0, to: 1 },
          "x",
          authority,
        ),
      "invalid-diagnostic",
    );
  });
});

describe("parser analyses", () => {
  const { authority, conformance } = createParserAuthority();
  const artifact = createSqlSyntaxArtifact(
    "query",
    "SELECT 1",
    authority,
  );
  const diagnostic = createSqlParserDiagnostic(
    "bad",
    null,
    "SELECT 1",
    authority,
  );

  it("constructs direct and compatibility success without raw AST data", () => {
    const direct = createDirectParsedAnalysis(conformance, artifact);
    const input = ["dialect-compatibility", "recovered"] as const;
    const compatibility = createCompatibilityParsedAnalysis(artifact, input);

    expect(direct).toMatchObject({
      artifact,
      conformance,
      mode: "direct",
      status: "parsed",
    });
    expect(compatibility).toMatchObject({
      artifact,
      limitations: input,
      mode: "compatibility",
      status: "parsed",
    });
    expect(compatibility.limitations).not.toBe(input);
    expect(Object.isFrozen(compatibility.limitations)).toBe(true);
    expect(isSqlParserAnalysis(direct)).toBe(true);
    expect(isSqlParserAnalysis(compatibility)).toBe(true);
  });

  it("constructs authoritative invalid analyses with bounded diagnostics", () => {
    const input = [diagnostic] as const;
    const invalid = createInvalidParserAnalysis(conformance, input);

    expect(invalid).toMatchObject({
      conformance,
      diagnostics: input,
      status: "invalid",
    });
    expect(invalid.diagnostics).not.toBe(input);
    expect(Object.isFrozen(invalid.diagnostics)).toBe(true);
  });

  it("constructs every closed unsupported and failure reason", () => {
    for (const reason of [
      "backend-capability",
      "compatibility-rejected",
      "resource-limit",
      "uncovered-construct",
    ] as const) {
      expect(
        createUnsupportedParserAnalysis(
          reason,
          "SELECT 1",
          authority,
        ),
      ).toMatchObject({
        reason,
        status: "unsupported",
      });
    }
    for (const reason of [
      "backend-failure",
      "malformed-output",
    ] as const) {
      expect(
        createFailedParserAnalysis(
          reason,
          "  unavailable  ",
          true,
          "SELECT 1",
          authority,
        ),
      ).toMatchObject({
        message: "unavailable",
        reason,
        retryable: true,
        status: "failed",
      });
    }
  });

  it("rejects fabricated identities, artifacts, and diagnostics", () => {
    expectContractError(
      () =>
        invokeWithUnknown(
          createDirectParsedAnalysis,
          {},
          artifact,
        ),
      "invalid-identity",
    );
    expectContractError(
      () =>
        invokeWithUnknown(
          createDirectParsedAnalysis,
          conformance,
          {},
        ),
      "invalid-artifact",
    );
    expectContractError(
      () =>
        invokeWithUnknown(
          createInvalidParserAnalysis,
          conformance,
          [{}],
        ),
      "invalid-analysis",
    );
    expectContractError(
      () =>
        createCompatibilityParsedAnalysis(artifact, [
          "recovered",
          "recovered",
        ]),
      "invalid-analysis",
    );
    expectContractError(
      () =>
        createCompatibilityParsedAnalysis(artifact, [
          "dialect-compatibility",
          "partial-artifact",
          "recovered",
          "recovered",
        ]),
      "invalid-analysis",
    );
    const hostileDiagnostics = [diagnostic];
    Object.defineProperty(hostileDiagnostics, Symbol.iterator, {
      value: function* hostileIterator() {
        for (
          let index = 0;
          index <= MAX_SQL_SYNTAX_DIAGNOSTICS;
          index += 1
        ) {
          yield diagnostic;
        }
      },
    });
    expect(
      createInvalidParserAnalysis(
        conformance,
        hostileDiagnostics,
      ).diagnostics,
    ).toHaveLength(1);

    const hostileLimitations: Array<"recovered"> = ["recovered"];
    Object.defineProperty(hostileLimitations, Symbol.iterator, {
      value: function* hostileIterator() {
        while (true) {
          yield "recovered";
        }
      },
    });
    expect(
      createCompatibilityParsedAnalysis(
        artifact,
        hostileLimitations,
      ).limitations,
    ).toEqual(["recovered"]);
  });

  it("rejects empty, invalid, and oversized collections", () => {
    expectContractError(
      () => createCompatibilityParsedAnalysis(artifact, []),
      "invalid-analysis",
    );
    expectContractError(
      () =>
        invokeWithUnknown(
          createCompatibilityParsedAnalysis,
          artifact,
          ["unknown"],
        ),
      "invalid-analysis",
    );
    expectContractError(
      () => createInvalidParserAnalysis(conformance, []),
      "invalid-analysis",
    );
    expectContractError(
      () =>
        createInvalidParserAnalysis(
          conformance,
          Array.from(
            { length: MAX_SQL_SYNTAX_DIAGNOSTICS + 1 },
            () => diagnostic,
          ),
        ),
      "invalid-analysis",
    );
    const wrongSource = createSqlParserDiagnostic(
      "bad",
      null,
      "SELECT 2",
      authority,
    );
    expectContractError(
      () =>
        createInvalidParserAnalysis(conformance, [
          diagnostic,
          wrongSource,
        ]),
      "invalid-analysis",
    );
    const other = createParserAuthority();
    const otherDiagnostic = createSqlParserDiagnostic(
      "bad",
      null,
      "SELECT 1",
      other.authority,
    );
    expectContractError(
      () =>
        createInvalidParserAnalysis(conformance, [
          diagnostic,
          otherDiagnostic,
        ]),
      "invalid-analysis",
    );
    expectContractError(
      () =>
        createInvalidParserAnalysis(conformance, [
          otherDiagnostic,
        ]),
      "invalid-analysis",
    );
    expectContractError(
      () =>
        invokeWithUnknown(
          createInvalidParserAnalysis,
          conformance,
          "not-an-array",
        ),
      "invalid-analysis",
    );
  });

  it("rejects invalid reason, message, and retryability values", () => {
    expectContractError(
      () =>
        invokeWithUnknown(
          createUnsupportedParserAnalysis,
          "unknown",
          "x",
          authority,
        ),
      "invalid-analysis",
    );
    expectContractError(
      () =>
        invokeWithUnknown(
          createFailedParserAnalysis,
          "unknown",
          "bad",
          false,
          "x",
          authority,
        ),
      "invalid-analysis",
    );
    expectContractError(
      () =>
        invokeWithUnknown(
          createFailedParserAnalysis,
          "backend-failure",
          "bad",
          "yes",
          "x",
          authority,
        ),
      "invalid-analysis",
    );
    expectContractError(
      () =>
        createFailedParserAnalysis(
          "backend-failure",
          " ",
          false,
          "x",
          authority,
        ),
      "invalid-analysis",
    );
  });

  it("recognizes only package-created analyses", () => {
    expect(isSqlParserAnalysis(null)).toBe(false);
    expect(isSqlParserAnalysis("parsed")).toBe(false);
    expect(
      isSqlParserAnalysis(
        Object.freeze({ mode: "direct", status: "parsed" }),
      ),
    ).toBe(false);
  });
});

describe("lexical eligibility states", () => {
  it("keeps lexical eligibility distinct from parser analysis", async () => {
    const empty = createEmptySyntaxState();
    const opening = createSqlStatementRelativeRange(7, 7, 8);
    const incomplete = createIncompleteSyntaxState(
      "single-quoted-string",
      opening,
      8,
    );
    const opaque = createOpaqueSyntaxState(
      "procedural-block",
      opening,
      8,
    );
    const unavailable = createUnavailableSyntaxState(
      "parser-not-configured",
    );
    const authority = createParserAuthority();
    const unvalidatedAnalysis = createUnsupportedParserAnalysis(
      "backend-capability",
      "SELECT 1",
      authority.authority,
    );
    const parser = createSqlStatementParser(
      authority.authority,
      async () => unvalidatedAnalysis,
    );
    const request = createSqlStatementParseRequest(
      "SELECT 1",
      new AbortController().signal,
    );
    const analyzed = await runSqlStatementParser(parser, request);
    const analysis = analyzed.analysis;

    expect(empty).toMatchObject({ state: "empty" });
    expect(incomplete).toMatchObject({
      construct: "single-quoted-string",
      opening,
      state: "incomplete",
    });
    expect(opaque).toMatchObject({
      at: opening,
      reason: "procedural-block",
      state: "opaque",
    });
    expect(unavailable).toMatchObject({
      reason: "parser-not-configured",
      state: "unavailable",
    });
    expect(analyzed).toMatchObject({ analysis, state: "analyzed" });
    for (const state of [
      empty,
      incomplete,
      opaque,
      unavailable,
      analyzed,
    ]) {
      expect(Object.isFrozen(state)).toBe(true);
      expect(isSqlStatementSyntaxState(state)).toBe(true);
    }
  });

  it("accepts every closed lexical and unavailability reason", () => {
    const point = createSqlStatementRelativeRange(0, 0, 0);
    for (const construct of [
      "backtick-quoted-identifier",
      "block-comment",
      "dollar-quoted-string",
      "double-quoted-identifier",
      "double-quoted-string",
      "single-quoted-string",
      "triple-double-quoted-string",
      "triple-single-quoted-string",
    ] as const) {
      expect(
        createIncompleteSyntaxState(construct, point, 0).construct,
      ).toBe(construct);
    }
    for (const reason of [
      "custom-delimiter",
      "procedural-block",
      "resource-limit",
    ] as const) {
      expect(createOpaqueSyntaxState(reason, point, 0).reason).toBe(
        reason,
      );
    }
    for (const reason of [
      "dialect-not-supported",
      "parser-not-configured",
    ] as const) {
      expect(createUnavailableSyntaxState(reason).reason).toBe(reason);
    }
  });

  it("rejects invalid and fabricated lexical state inputs", () => {
    const point = createSqlStatementRelativeRange(0, 0, 0);
    expectContractError(
      () => createIncompleteSyntaxState("quote", point, 0),
      "invalid-analysis",
    );
    expectContractError(
      () => createOpaqueSyntaxState("guess", point, 0),
      "invalid-analysis",
    );
    expectContractError(
      () => createUnavailableSyntaxState("offline"),
      "invalid-analysis",
    );
    expect(isSqlStatementSyntaxState({ state: "empty" })).toBe(false);
    expect(isSqlStatementSyntaxState(null)).toBe(false);
    expect(isSqlStatementSyntaxState("empty")).toBe(false);
  });
});

describe("parser request boundary", () => {
  it("runs an authentic parser with exact text and signal", async () => {
    const authority = createParserAuthority();
    const controller = new AbortController();
    const expected = createUnsupportedParserAnalysis(
      "backend-capability",
      " SELECT 1 ",
      authority.authority,
    );
    const parser = createSqlStatementParser(
      authority.authority,
      async (request) => {
        request.signal.throwIfAborted();
        expect(request).toMatchObject({
          signal: controller.signal,
          text: " SELECT 1 ",
        });
        expect(Object.isFrozen(request)).toBe(true);
        return expected;
      },
    );

    const request = createSqlStatementParseRequest(
      " SELECT 1 ",
      controller.signal,
    );
    expect(Object.isFrozen(parser)).toBe(true);
    const result = await runSqlStatementParser(parser, request);
    expect(result.state).toBe("analyzed");
    expect(result.analysis).toBe(expected);
  });

  it("rejects pre-aborted requests without invoking the callback", async () => {
    const authority = createParserAuthority();
    const controller = new AbortController();
    const reason = new Error("superseded");
    controller.abort(reason);
    let invoked = false;
    const parser = createSqlStatementParser(
      authority.authority,
      async () => {
        invoked = true;
        return createUnsupportedParserAnalysis(
          "backend-capability",
          "SELECT 1",
          authority.authority,
        );
      },
    );

    await expect(
      runSqlStatementParser(
        parser,
        createSqlStatementParseRequest("SELECT 1", controller.signal),
      ),
    ).rejects.toBe(reason);
    expect(invoked).toBe(false);
  });

  it("rejects in-flight requests with the exact abort reason", async () => {
    const authority = createParserAuthority();
    const controller = new AbortController();
    const reason = { kind: "superseded" };
    let rejectCallback: ((reason: unknown) => void) | undefined;
    const parser = createSqlStatementParser(
      authority.authority,
      () =>
        new Promise((_, reject) => {
          rejectCallback = reject;
        }),
    );
    const result = runSqlStatementParser(
      parser,
      createSqlStatementParseRequest("SELECT 1", controller.signal),
    );

    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    rejectCallback?.(new Error("late backend rejection"));
    await Promise.resolve();
  });

  it("keeps backend success that settles before a later abort", async () => {
    const authority = createParserAuthority();
    const controller = new AbortController();
    const expected = createUnsupportedParserAnalysis(
      "backend-capability",
      "SELECT 1",
      authority.authority,
    );
    let resolveCallback:
      | ((analysis: typeof expected) => void)
      | undefined;
    const parser = createSqlStatementParser(
      authority.authority,
      () =>
        new Promise((resolve) => {
          resolveCallback = resolve;
        }),
    );
    const result = runSqlStatementParser(
      parser,
      createSqlStatementParseRequest("SELECT 1", controller.signal),
    );

    resolveCallback?.(expected);
    controller.abort(new Error("late cancellation"));
    expect((await result).analysis).toBe(expected);
  });

  it("keeps backend failure that settles before a later abort", async () => {
    const authority = createParserAuthority();
    const controller = new AbortController();
    const backendError = new Error("backend failure");
    let rejectCallback: ((reason: unknown) => void) | undefined;
    const parser = createSqlStatementParser(
      authority.authority,
      () =>
        new Promise((_, reject) => {
          rejectCallback = reject;
        }),
    );
    const result = runSqlStatementParser(
      parser,
      createSqlStatementParseRequest("SELECT 1", controller.signal),
    );

    rejectCallback?.(backendError);
    controller.abort(backendError);
    expect((await result).analysis).toMatchObject({
      reason: "backend-failure",
      status: "failed",
    });
  });

  it("lets cancellation win when the callback also throws", async () => {
    const authority = createParserAuthority();
    const controller = new AbortController();
    const reason = new SqlSyntaxContractError(
      "invalid-analysis",
      "superseded",
    );
    const parser = createSqlStatementParser(
      authority.authority,
      () => {
        controller.abort(reason);
        throw new Error("backend failed after cancellation");
      },
    );

    await expect(
      runSqlStatementParser(
        parser,
        createSqlStatementParseRequest("SELECT 1", controller.signal),
      ),
    ).rejects.toBe(reason);
  });

  it("preserves falsy abort reasons", async () => {
    const authority = createParserAuthority();
    const controller = new AbortController();
    controller.abort(0);
    const parser = createSqlStatementParser(
      authority.authority,
      async () =>
        createUnsupportedParserAnalysis(
          "backend-capability",
          "SELECT 1",
          authority.authority,
        ),
    );
    let caught: unknown = Symbol("not rejected");

    try {
      await runSqlStatementParser(
        parser,
        createSqlStatementParseRequest("SELECT 1", controller.signal),
      );
    } catch (error: unknown) {
      caught = error;
    }
    expect(Object.is(caught, 0)).toBe(true);
  });

  it("rejects malformed requests", () => {
    const signal = new AbortController().signal;
    expectContractError(
      () => createSqlStatementParseRequest(1, signal),
      "invalid-request",
    );
    expectContractError(
      () =>
        createSqlStatementParseRequest(
          "x".repeat(MAX_SQL_STATEMENT_PARSE_LENGTH + 1),
          signal,
        ),
      "invalid-request",
    );
    for (const malformedSignal of [
      null,
      {},
      [],
      new Date(),
      { aborted: false },
      {
        aborted: false,
        addEventListener() {},
      },
      {
        aborted: false,
        addEventListener() {},
        removeEventListener() {},
      },
      {
        aborted: false,
        addEventListener() {},
        dispatchEvent() {
          return true;
        },
        onabort: null,
        reason: undefined,
        removeEventListener() {},
        throwIfAborted() {},
      },
    ]) {
      expectContractError(
        () =>
          createSqlStatementParseRequest(
            "SELECT 1",
            malformedSignal,
          ),
        "invalid-request",
      );
    }
    const hostileSignal = Object.defineProperty({}, "aborted", {
      get() {
        throw new Error("hostile getter");
      },
    });
    expectContractError(
      () => createSqlStatementParseRequest("SELECT 1", hostileSignal),
      "invalid-request",
    );
    const hostileTag = Object.defineProperty(
      {},
      Symbol.toStringTag,
      {
        get() {
          throw new Error("hostile identity");
        },
      },
    );
    expectContractError(
      () => createSqlStatementParseRequest("SELECT 1", hostileTag),
      "invalid-request",
    );
  });

  it("accepts genuine cross-realm abort signals", async () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    try {
      const foreignWindow = iframe.contentWindow;
      expect(foreignWindow).not.toBeNull();
      if (foreignWindow === null) {
        throw new Error("iframe window unavailable");
      }
      const ForeignAbortController = Reflect.get(
        foreignWindow,
        "AbortController",
      );
      expect(typeof ForeignAbortController).toBe("function");
      if (typeof ForeignAbortController !== "function") {
        throw new Error("foreign AbortController unavailable");
      }
      const controller: unknown = Reflect.construct(
        ForeignAbortController,
        [],
      );
      if (controller === null || typeof controller !== "object") {
        throw new Error("foreign AbortController is invalid");
      }
      const signal = Reflect.get(controller, "signal");
      const request = createSqlStatementParseRequest(
        "SELECT 1",
        signal,
      );
      const authority = createParserAuthority();
      const expected = createUnsupportedParserAnalysis(
        "backend-capability",
        "SELECT 1",
        authority.authority,
      );
      const parser = createSqlStatementParser(
        authority.authority,
        async () => expected,
      );
      expect(request.signal).toBe(signal);
      expect((await runSqlStatementParser(parser, request)).analysis).toBe(
        expected,
      );
    } finally {
      iframe.remove();
    }
  });

  it("rejects fabricated parser identities and callbacks", () => {
    const authority = createParserAuthority();
    const parseStatement = async () =>
      createUnsupportedParserAnalysis(
        "backend-capability",
        "x",
        authority.authority,
      );

    expectContractError(
      () =>
        invokeWithUnknown(
          createSqlStatementParser,
          {},
          parseStatement,
        ),
      "invalid-identity",
    );
    expectContractError(
      () =>
        invokeWithUnknown(
          createSqlStatementParser,
          authority.authority,
          "parse",
        ),
      "invalid-request",
    );
  });

  it("rejects fabricated parsers, requests, and parser output", async () => {
    const authority = createParserAuthority();
    const request = createSqlStatementParseRequest(
      "x",
      new AbortController().signal,
    );
    const malformedParser = invokeWithUnknown(
      createSqlStatementParser,
      authority.authority,
      async () => ({ status: "parsed" }),
    );
    const malformedResult = await Promise.resolve(
      invokeWithUnknown(
        runSqlStatementParser,
        malformedParser,
        request,
      ),
    );
    expect(malformedResult).toMatchObject({
      analysis: {
        reason: "malformed-output",
        retryable: false,
        status: "failed",
      },
      state: "analyzed",
    });

    const validParser = createSqlStatementParser(
      authority.authority,
      async () =>
        createUnsupportedParserAnalysis(
          "backend-capability",
          "x",
          authority.authority,
        ),
    );
    await expect(
      Promise.resolve(
        invokeWithUnknown(
          runSqlStatementParser,
          {},
          request,
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid-request" });
    await expect(
      Promise.resolve(
        invokeWithUnknown(
          runSqlStatementParser,
          validParser,
          { signal: new AbortController().signal, text: "x" },
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid-request" });
  });

  it("rejects authentic evidence for different statement text", async () => {
    const authority = createParserAuthority();
    const request = createSqlStatementParseRequest(
      "x",
      new AbortController().signal,
    );
    const analyses = [
      createDirectParsedAnalysis(
        authority.conformance,
        createSqlSyntaxArtifact(
          "query",
          "xx",
          authority.authority,
        ),
      ),
      createCompatibilityParsedAnalysis(
        createSqlSyntaxArtifact(
          "query",
          "xx",
          authority.authority,
        ),
        ["dialect-compatibility"],
      ),
      createInvalidParserAnalysis(authority.conformance, [
        createSqlParserDiagnostic(
          "bad",
          null,
          "xx",
          authority.authority,
        ),
      ]),
      createDirectParsedAnalysis(
        authority.conformance,
        createSqlSyntaxArtifact(
          "query",
          "y",
          authority.authority,
        ),
      ),
      createCompatibilityParsedAnalysis(
        createSqlSyntaxArtifact(
          "query",
          "y",
          authority.authority,
        ),
        ["dialect-compatibility"],
      ),
      createInvalidParserAnalysis(authority.conformance, [
        createSqlParserDiagnostic(
          "bad",
          null,
          "y",
          authority.authority,
        ),
      ]),
    ];

    for (const analysis of analyses) {
      const parser = createSqlStatementParser(
        authority.authority,
        async () => analysis,
      );
      expect(await runSqlStatementParser(parser, request)).toMatchObject({
        analysis: {
          reason: "malformed-output",
          retryable: false,
          status: "failed",
        },
        state: "analyzed",
      });
    }
  });

  it("rejects conformance from another parser authority", async () => {
    const parserAuthority = createParserAuthority();
    const otherAuthority = createParserAuthority();
    const request = createSqlStatementParseRequest(
      "x",
      new AbortController().signal,
    );
    const analyses = [
      createDirectParsedAnalysis(
        otherAuthority.conformance,
        createSqlSyntaxArtifact(
          "query",
          "x",
          otherAuthority.authority,
        ),
      ),
      createCompatibilityParsedAnalysis(
        createSqlSyntaxArtifact(
          "query",
          "x",
          otherAuthority.authority,
        ),
        ["dialect-compatibility"],
      ),
      createInvalidParserAnalysis(otherAuthority.conformance, [
        createSqlParserDiagnostic(
          "bad",
          null,
          "x",
          otherAuthority.authority,
        ),
      ]),
      createUnsupportedParserAnalysis(
        "compatibility-rejected",
        "x",
        otherAuthority.authority,
      ),
      createFailedParserAnalysis(
        "backend-failure",
        "failed",
        true,
        "x",
        otherAuthority.authority,
      ),
    ];

    expectContractError(
      () =>
        createDirectParsedAnalysis(
          parserAuthority.conformance,
          createSqlSyntaxArtifact(
            "query",
            "x",
            otherAuthority.authority,
          ),
        ),
      "invalid-analysis",
    );

    for (const analysis of analyses) {
      const parser = createSqlStatementParser(
        parserAuthority.authority,
        async () => analysis,
      );
      expect(await runSqlStatementParser(parser, request)).toMatchObject({
        analysis: {
          reason: "malformed-output",
          status: "failed",
        },
        state: "analyzed",
      });
    }
  });

  it("accepts matching direct, compatibility, and invalid evidence", async () => {
    const authority = createParserAuthority();
    const request = createSqlStatementParseRequest(
      "x",
      new AbortController().signal,
    );
    const analyses = [
      createDirectParsedAnalysis(
        authority.conformance,
        createSqlSyntaxArtifact(
          "query",
          "x",
          authority.authority,
        ),
      ),
      createCompatibilityParsedAnalysis(
        createSqlSyntaxArtifact(
          "query",
          "x",
          authority.authority,
        ),
        ["dialect-compatibility"],
      ),
      createInvalidParserAnalysis(authority.conformance, [
        createSqlParserDiagnostic(
          "bad",
          null,
          "x",
          authority.authority,
        ),
      ]),
    ];

    for (const analysis of analyses) {
      const parser = createSqlStatementParser(
        authority.authority,
        async () => analysis,
      );
      expect(
        (await runSqlStatementParser(parser, request)).analysis,
      ).toBe(analysis);
    }
  });

  it("normalizes synchronous throws and rejections without raw errors", async () => {
    const authority = createParserAuthority();
    const request = createSqlStatementParseRequest(
      "x",
      new AbortController().signal,
    );
    const callbacks = [
      () => {
        throw new Error("secret sync error");
      },
      async () => {
        throw new Error("secret async error");
      },
    ];

    for (const callback of callbacks) {
      const parser = createSqlStatementParser(
        authority.authority,
        callback,
      );
      const state = await runSqlStatementParser(parser, request);
      expect(state.analysis).toMatchObject({
        message: "SQL parser backend failed",
        reason: "backend-failure",
        retryable: true,
        status: "failed",
      });
      if (state.analysis.status === "failed") {
        expect(state.analysis.message).not.toContain("secret");
      }
    }

    const malformedParser = createSqlStatementParser(
      authority.authority,
      async () => {
        throw new SqlSyntaxContractError(
          "invalid-analysis",
          "secret malformed output",
        );
      },
    );
    const malformed = await runSqlStatementParser(
      malformedParser,
      request,
    );
    expect(malformed.analysis).toMatchObject({
      message: "SQL parser returned malformed normalized output",
      reason: "malformed-output",
      retryable: false,
      status: "failed",
    });
  });
});
