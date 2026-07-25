import { describe, expect, it } from "vitest";
import {
  createSqlQueryBindingModel,
  isSqlQueryBindingModel,
  isSqlQueryBindingModelError,
  MAX_QUERY_BINDING_BLOCKS,
  resolveSqlRelationQualifier,
  sqlQueryBindingModelMatches,
  visibleSqlRelationBindingsAt,
  type SqlQueryBindingModel,
  type SqlQueryBindingModelErrorCode,
} from "../query-binding-model.js";
import type { SqlIdentifierComponent } from "../types.js";

const SQL =
  "SELECT a.id FROM users AS a JOIN teams t ON a.team_id=t.id WHERE a.id>0";

function component(value: string, quoted = false) {
  return { quoted, value };
}

function range(from: number, to: number) {
  return { from, to };
}

function completeCoverage() {
  return {
    queryBlocks: "complete",
    relationBindings: "complete",
    visibility: "complete",
  };
}

function fixture(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    bindings: [
      {
        alias: {
          explicit: true,
          name: component("a"),
          range: range(26, 27),
        },
        owner: 0,
        range: range(17, 27),
        source: {
          kind: "named",
          path: [component("users")],
        },
      },
      {
        alias: {
          explicit: false,
          name: component("t"),
          range: range(39, 40),
        },
        owner: 0,
        range: range(33, 40),
        source: {
          kind: "named",
          path: [component("public"), component("teams")],
        },
      },
    ],
    blocks: [
      {
        baseScope: 0,
        kind: "select",
        parentBlock: null,
        range: range(0, SQL.length),
      },
    ],
    coverage: completeCoverage(),
    issues: [],
    regions: [
      {
        block: 0,
        kind: "select-list",
        range: range(7, 11),
        scope: 2,
      },
      {
        block: 0,
        kind: "join-condition",
        range: range(44, 59),
        scope: 2,
      },
      {
        block: 0,
        kind: "where",
        range: range(66, SQL.length),
        scope: 2,
      },
    ],
    scopes: [
      { addedBinding: null, parentScope: null },
      { addedBinding: 0, parentScope: 0 },
      { addedBinding: 1, parentScope: 1 },
    ],
    statementRange: range(0, SQL.length),
    ...overrides,
  };
}

function model(
  overrides: Readonly<Record<string, unknown>> = {},
  authority: object = {},
): SqlQueryBindingModel {
  return createSqlQueryBindingModel(SQL, authority, fixture(overrides));
}

function asciiEqual(
  left: SqlIdentifierComponent,
  right: SqlIdentifierComponent,
): boolean {
  if (left.quoted || right.quoted) {
    return left.quoted === right.quoted && left.value === right.value;
  }
  return left.value.toLowerCase() === right.value.toLowerCase();
}

function expectError(
  operation: () => unknown,
  code: SqlQueryBindingModelErrorCode,
): void {
  try {
    operation();
  } catch (error) {
    expect(isSqlQueryBindingModelError(error)).toBe(true);
    if (isSqlQueryBindingModelError(error)) {
      expect(error.code).toBe(code);
    }
    return;
  }
  throw new Error("Expected a query binding model error");
}

describe("query binding model authentication", () => {
  it("creates a deeply immutable model bound to exact source and authority", () => {
    const authority = {};
    const input = fixture();
    const result = createSqlQueryBindingModel(SQL, authority, input);

    expect(isSqlQueryBindingModel(result)).toBe(true);
    expect(isSqlQueryBindingModel(input)).toBe(false);
    expect(sqlQueryBindingModelMatches(result, SQL, authority)).toBe(true);
    expect(sqlQueryBindingModelMatches(result, `${SQL} `, authority)).toBe(false);
    expect(sqlQueryBindingModelMatches(result, SQL, {})).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.blocks)).toBe(true);
    expect(Object.isFrozen(result.blocks[0])).toBe(true);
    expect(Object.isFrozen(result.bindings[0]?.source)).toBe(true);
    expect(Object.isFrozen(result.bindings[0]?.alias?.name)).toBe(true);
  });

  it("does not authenticate structural imitations", () => {
    const imitation = fixture();
    expect(isSqlQueryBindingModel(null)).toBe(false);
    expect(isSqlQueryBindingModel(1)).toBe(false);
    expect(isSqlQueryBindingModel(imitation)).toBe(false);
    expect(
      sqlQueryBindingModelMatches(imitation, SQL, {}),
    ).toBe(false);
    expect(isSqlQueryBindingModelError(new Error("no"))).toBe(false);
    expect(sqlQueryBindingModelMatches(null, SQL, {})).toBe(false);
  });
});

describe("query binding visibility", () => {
  it("walks persistent scopes in declaration order", () => {
    const result = visibleSqlRelationBindingsAt(model(), 8);
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.region.kind).toBe("select-list");
      expect(
        result.bindings.map((binding) => binding.alias?.name.value),
      ).toEqual(["a", "t"]);
      expect(result.coverage).toBe("complete");
      expect(result.issues).toEqual([]);
    }
  });

  it("uses half-open regions and rejects invalid requests", () => {
    const authenticated = model();
    expect(visibleSqlRelationBindingsAt(authenticated, 11)).toEqual({
      reason: "outside-visibility-region",
      status: "unavailable",
    });
    expect(visibleSqlRelationBindingsAt(authenticated, 44).status).toBe("ready");
    expect(visibleSqlRelationBindingsAt(authenticated, SQL.length)).toEqual({
      reason: "outside-visibility-region",
      status: "unavailable",
    });
    expect(visibleSqlRelationBindingsAt(authenticated, -1)).toEqual({
      reason: "invalid-model",
      status: "unavailable",
    });
    expect(visibleSqlRelationBindingsAt(authenticated, 1.5)).toEqual({
      reason: "invalid-model",
      status: "unavailable",
    });
    expect(
      visibleSqlRelationBindingsAt(fixture(), 8),
    ).toEqual({ reason: "invalid-model", status: "unavailable" });
  });

  it("combines relation and visibility coverage", () => {
    for (const coverage of [
      {
        queryBlocks: "partial",
        relationBindings: "complete",
        visibility: "complete",
      },
      {
        queryBlocks: "complete",
        relationBindings: "partial",
        visibility: "complete",
      },
      {
        queryBlocks: "complete",
        relationBindings: "complete",
        visibility: "partial",
      },
    ]) {
      const result = visibleSqlRelationBindingsAt(model({ coverage }), 8);
      expect(result.status === "ready" && result.coverage).toBe(
        coverage.queryBlocks === "partial" ? "complete" : "partial",
      );
    }
  });
});

describe("query binding qualifier resolution", () => {
  it("resolves aliases and makes an alias hide the base name", () => {
    const authenticated = model();
    const alias = resolveSqlRelationQualifier(
      authenticated,
      8,
      component("A"),
      asciiEqual,
    );
    expect(alias.status).toBe("resolved");
    if (alias.status === "resolved") {
      expect(alias.binding.alias?.name.value).toBe("a");
      expect(alias.coverage).toBe("complete");
    }
    expect(
      resolveSqlRelationQualifier(
        authenticated,
        8,
        component("users"),
        asciiEqual,
      ),
    ).toEqual({ status: "no-match" });
    expect(
      resolveSqlRelationQualifier(
        authenticated,
        8,
        component("TEAMS"),
        asciiEqual,
      ).status,
    ).toBe("no-match");
  });

  it("uses the last named path component and a CTE name without aliases", () => {
    const bindings = [
      {
        alias: null,
        owner: 0,
        range: range(17, 22),
        source: {
          kind: "named",
          path: [component("public"), component("users")],
        },
      },
      {
        alias: null,
        owner: 0,
        range: range(33, 40),
        source: {
          declarationRange: range(0, 4),
          kind: "cte",
          name: component("teams"),
        },
      },
    ];
    const authenticated = model({ bindings });
    expect(
      resolveSqlRelationQualifier(
        authenticated,
        8,
        component("users"),
        asciiEqual,
      ).status,
    ).toBe("resolved");
    expect(
      resolveSqlRelationQualifier(
        authenticated,
        8,
        component("teams"),
        asciiEqual,
      ).status,
    ).toBe("resolved");
  });

  it("reports ambiguity and partial evidence explicitly", () => {
    const bindings = [
      fixture().bindings[0],
      {
        ...fixture().bindings[1],
        alias: {
          explicit: false,
          name: component("a"),
          range: range(39, 40),
        },
      },
    ];
    const ambiguous = resolveSqlRelationQualifier(
      model({ bindings }),
      8,
      component("a"),
      asciiEqual,
    );
    expect(ambiguous.status).toBe("ambiguous");
    if (ambiguous.status === "ambiguous") {
      expect(ambiguous.bindings).toHaveLength(2);
      expect(Object.isFrozen(ambiguous.bindings)).toBe(true);
    }

    const coverage = {
      queryBlocks: "complete",
      relationBindings: "partial",
      visibility: "complete",
    };
    const partial = model({ coverage });
    const found = resolveSqlRelationQualifier(
      partial,
      8,
      component("a"),
      asciiEqual,
    );
    expect(found.status === "resolved" && found.coverage).toBe("partial");
    expect(
      resolveSqlRelationQualifier(
        partial,
        8,
        component("missing"),
        asciiEqual,
      ),
    ).toEqual({ reason: "partial-coverage", status: "unavailable" });
  });

  it("propagates unavailable visibility and ignores unqualified derived sources", () => {
    const blocks = [
      fixture().blocks[0],
      {
        baseScope: 0,
        kind: "select",
        parentBlock: 0,
        range: range(17, 22),
      },
    ];
    const bindings = [
      {
        alias: null,
        owner: 0,
        range: range(17, 22),
        source: { block: 1, kind: "derived" },
      },
      fixture().bindings[1],
    ];
    const authenticated = model({ bindings, blocks });
    expect(
      resolveSqlRelationQualifier(
        authenticated,
        12,
        component("t"),
        asciiEqual,
      ),
    ).toEqual({
      reason: "outside-visibility-region",
      status: "unavailable",
    });
    expect(
      resolveSqlRelationQualifier(
        authenticated,
        8,
        component("anything"),
        asciiEqual,
      ),
    ).toEqual({ status: "no-match" });
  });
});

describe("query binding model validation", () => {
  it("rejects invalid source and authority inputs", () => {
    expectError(
      () => createSqlQueryBindingModel(1, {}, fixture()),
      "invalid-source",
    );
    expectError(
      () => createSqlQueryBindingModel("", {}, fixture()),
      "invalid-source",
    );
    expectError(
      () =>
        createSqlQueryBindingModel(
          "x".repeat(16 * 1024 + 1),
          {},
          fixture(),
        ),
      "resource-limit",
    );
    expectError(
      () =>
        createSqlQueryBindingModel(
          SQL,
          null,
          fixture(),
        ),
      "invalid-authority",
    );
  });

  it.each([
    ["null input", null],
    ["missing fields", {}],
    ["no blocks", fixture({ blocks: [] })],
    ["no scopes", fixture({ scopes: [] })],
    [
      "wrong statement extent",
      fixture({ statementRange: range(0, SQL.length - 1) }),
    ],
    [
      "empty statement extent",
      fixture({ statementRange: range(0, 0) }),
    ],
    [
      "unsupported coverage",
      fixture({
        coverage: {
          ...completeCoverage(),
          visibility: "unknown",
        },
      }),
    ],
    ["non-array blocks", fixture({ blocks: {} })],
  ])("rejects %s", (_name, input) => {
    expectError(
      () => createSqlQueryBindingModel(SQL, {}, input),
      "invalid-model",
    );
  });

  it("rejects resource excess and sparse arrays", () => {
    expectError(
      () =>
        createSqlQueryBindingModel(
          SQL,
          {},
          fixture({
            blocks: Array.from(
              { length: MAX_QUERY_BINDING_BLOCKS + 1 },
              () => fixture().blocks[0],
            ),
          }),
        ),
      "resource-limit",
    );
    const sparse: unknown[] = [];
    sparse.length = 1;
    expectError(
      () =>
        createSqlQueryBindingModel(
          SQL,
          {},
          fixture({ blocks: sparse }),
        ),
      "invalid-model",
    );
  });

  it("never invokes accessors", () => {
    let calls = 0;
    const hostile = fixture();
    Object.defineProperty(hostile, "blocks", {
      enumerable: true,
      get() {
        calls += 1;
        return [];
      },
    });
    expectError(
      () => createSqlQueryBindingModel(SQL, {}, hostile),
      "invalid-model",
    );
    expect(calls).toBe(0);
  });

  it("rejects malformed primitive fields without coercion", () => {
    const invalidCases: readonly Readonly<Record<string, unknown>>[] = [
      {
        bindings: [
          {
            ...fixture().bindings[0],
            alias: {
              ...fixture().bindings[0]?.alias,
              explicit: "yes",
            },
          },
          fixture().bindings[1],
        ],
      },
      {
        blocks: [
          { ...fixture().blocks[0], kind: 1 },
        ],
      },
      {
        blocks: [
          { ...fixture().blocks[0], baseScope: -1 },
        ],
      },
      {
        blocks: [
          { ...fixture().blocks[0], baseScope: 0.5 },
        ],
      },
      {
        regions: [
          {
            ...fixture().regions[0],
            range: range(11, 7),
          },
        ],
      },
      {
        regions: [
          {
            ...fixture().regions[0],
            range: range(7, 7),
          },
        ],
      },
    ];
    for (const invalidCase of invalidCases) {
      expectError(() => model(invalidCase), "invalid-model");
    }
  });

  it("rejects arrays whose length cannot be inspected as data", () => {
    const hostileArray = new Proxy([], {
      getOwnPropertyDescriptor(target, key) {
        if (key === "length") {
          return {
            configurable: false,
            enumerable: false,
            value: "one",
            writable: true,
          };
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expectError(
      () => model({ blocks: hostileArray }),
      "invalid-model",
    );
  });

  it("normalizes proxy and inspection failures", () => {
    const hostile = new Proxy(fixture(), {
      getOwnPropertyDescriptor() {
        throw new Error("hostile trap");
      },
    });
    expectError(
      () => createSqlQueryBindingModel(SQL, {}, hostile),
      "invalid-model",
    );
  });

  it.each([
    [
      "forward block parent",
      {
        blocks: [
          {
            baseScope: 0,
            kind: "select",
            parentBlock: 1,
            range: range(0, SQL.length),
          },
          {
            baseScope: 0,
            kind: "select",
            parentBlock: null,
            range: range(0, SQL.length),
          },
        ],
      },
    ],
    [
      "child outside parent",
      {
        blocks: [
          {
            baseScope: 0,
            kind: "select",
            parentBlock: null,
            range: range(0, 20),
          },
          {
            baseScope: 0,
            kind: "select",
            parentBlock: 0,
            range: range(19, 30),
          },
        ],
      },
    ],
    [
      "forward scope parent",
      {
        scopes: [
          { addedBinding: null, parentScope: 1 },
          { addedBinding: null, parentScope: null },
        ],
      },
    ],
    [
      "repeated binding in scope chain",
      {
        scopes: [
          { addedBinding: 0, parentScope: null },
          { addedBinding: 0, parentScope: 0 },
          { addedBinding: 1, parentScope: 1 },
        ],
      },
    ],
    [
      "overlapping visibility",
      {
        regions: [
          {
            block: 0,
            kind: "select-list",
            range: range(7, 20),
            scope: 2,
          },
          {
            block: 0,
            kind: "where",
            range: range(19, 22),
            scope: 2,
          },
        ],
      },
    ],
    [
      "unordered visibility",
      {
        regions: [
          {
            block: 0,
            kind: "where",
            range: range(66, 70),
            scope: 2,
          },
          {
            block: 0,
            kind: "select-list",
            range: range(7, 11),
            scope: 2,
          },
        ],
      },
    ],
  ])("rejects %s", (_name, overrides) => {
    expectError(
      () => model(overrides),
      "invalid-model",
    );
  });

  it("rejects invalid binding ownership and source relationships", () => {
    const outside = [
      {
        ...fixture().bindings[0],
        range: range(0, SQL.length),
      },
      fixture().bindings[1],
    ];
    const narrowBlock = [
      {
        ...fixture().blocks[0],
        range: range(5, SQL.length),
      },
    ];
    expectError(() => model({ bindings: outside, blocks: narrowBlock }), "invalid-model");

    const blocks = [
      fixture().blocks[0],
      {
        baseScope: 0,
        kind: "select",
        parentBlock: null,
        range: range(17, 22),
      },
    ];
    const bindings = [
      {
        ...fixture().bindings[0],
        source: { block: 1, kind: "derived" },
      },
      fixture().bindings[1],
    ];
    expectError(() => model({ bindings, blocks }), "invalid-model");
  });

  it("requires partial relation coverage for unknown sources", () => {
    const bindings = [
      {
        ...fixture().bindings[0],
        source: {
          kind: "unknown",
          reason: "unsupported-relation-source",
        },
      },
      fixture().bindings[1],
    ];
    expectError(() => model({ bindings }), "invalid-model");
    const coverage = {
      ...completeCoverage(),
      relationBindings: "partial",
    };
    expect(model({ bindings, coverage }).bindings[0]?.source.kind).toBe(
      "unknown",
    );
  });

  it("rejects malformed identifiers, paths, ranges, aliases, enums, and indexes", () => {
    const cases: readonly Readonly<Record<string, unknown>>[] = [
      {
        bindings: [
          {
            ...fixture().bindings[0],
            source: { kind: "named", path: [] },
          },
          fixture().bindings[1],
        ],
      },
      {
        bindings: [
          {
            ...fixture().bindings[0],
            source: {
              kind: "named",
              path: [component("\ud800")],
            },
          },
          fixture().bindings[1],
        ],
      },
      {
        bindings: [
          {
            ...fixture().bindings[0],
            alias: {
              explicit: true,
              name: component("a"),
              range: range(28, 29),
            },
          },
          fixture().bindings[1],
        ],
      },
      {
        bindings: [
          { ...fixture().bindings[0], owner: 99 },
          fixture().bindings[1],
        ],
      },
      {
        bindings: [
          {
            ...fixture().bindings[0],
            source: { kind: "mystery" },
          },
          fixture().bindings[1],
        ],
      },
      {
        blocks: [
          { ...fixture().blocks[0], kind: "values" },
        ],
      },
      {
        regions: [
          { ...fixture().regions[0], kind: "window" },
        ],
      },
      {
        issues: [{ code: "mystery", range: range(0, 1) }],
      },
      {
        scopes: [
          { addedBinding: 99, parentScope: null },
        ],
      },
    ];
    for (let index = 0; index < cases.length; index += 1) {
      const overrides = cases[index];
      if (!overrides) {
        throw new Error("Malformed fixture table contains a hole");
      }
      expectError(() => model(overrides), "invalid-model");
    }
  });

  it("accepts every closed issue and unknown reason", () => {
    const codes = [
      "ambiguous-alias",
      "duplicate-alias",
      "opaque-template-context",
      "parser-compatibility",
      "recursive-cte-uncertainty",
      "resource-limit",
      "unknown-correlation",
      "unsupported-clause",
      "unsupported-relation-source",
    ];
    const coverage = {
      queryBlocks: "partial",
      relationBindings: "partial",
      visibility: "partial",
    };
    const issues = codes.map((code, index) => ({
      code,
      range: range(index, index + 1),
    }));
    expect(model({ coverage, issues }).issues).toHaveLength(codes.length);

    for (const reason of [
      "opaque-template-context",
      "unknown-correlation",
      "unsupported-relation-source",
    ]) {
      const bindings = [
        {
          ...fixture().bindings[0],
          source: { kind: "unknown", reason },
        },
        fixture().bindings[1],
      ];
      expect(model({ bindings, coverage }).bindings[0]?.source).toEqual({
        kind: "unknown",
        reason,
      });
    }
  });

  it("accepts well-formed surrogate pairs and rejects lone trailing surrogates", () => {
    const validBindings = [
      {
        ...fixture().bindings[0],
        source: {
          kind: "named",
          path: [component("relation_\ud83d\ude80")],
        },
      },
      fixture().bindings[1],
    ];
    expect(model({ bindings: validBindings }).bindings[0]?.source.kind).toBe(
      "named",
    );
    const invalidBindings = [
      {
        ...fixture().bindings[0],
        source: {
          kind: "named",
          path: [component("\udc00")],
        },
      },
      fixture().bindings[1],
    ];
    expectError(() => model({ bindings: invalidBindings }), "invalid-model");
  });

  it("rejects a region assigned outside its query block", () => {
    const blocks = [
      fixture().blocks[0],
      {
        baseScope: 0,
        kind: "select",
        parentBlock: 0,
        range: range(17, 22),
      },
    ];
    const regions = [
      {
        block: 1,
        kind: "select-list",
        range: range(7, 11),
        scope: 2,
      },
    ];
    expectError(() => model({ blocks, regions }), "invalid-model");
  });

  it("allows parent correlation but rejects local or sibling bindings in entry scopes", () => {
    const correlatedBlocks = [
      fixture().blocks[0],
      {
        baseScope: 1,
        kind: "select",
        parentBlock: 0,
        range: range(44, 59),
      },
    ];
    const correlatedRegions = [
      {
        block: 1,
        kind: "where",
        range: range(45, 50),
        scope: 1,
      },
    ];
    expect(
      model({
        blocks: correlatedBlocks,
        regions: correlatedRegions,
      }).blocks[1]?.baseScope,
    ).toBe(1);

    const localEntryBlocks = [
      { ...fixture().blocks[0], baseScope: 1 },
    ];
    expectError(
      () => model({ blocks: localEntryBlocks }),
      "invalid-model",
    );

    const siblingBlocks = [
      fixture().blocks[0],
      {
        baseScope: 0,
        kind: "select",
        parentBlock: 0,
        range: range(17, 22),
      },
      {
        baseScope: 0,
        kind: "select",
        parentBlock: 0,
        range: range(33, 40),
      },
    ];
    const siblingBindings = [
      {
        alias: null,
        owner: 1,
        range: range(17, 22),
        source: { kind: "named", path: [component("left_child")] },
      },
      {
        alias: null,
        owner: 0,
        range: range(33, 40),
        source: { kind: "named", path: [component("root_relation")] },
      },
    ];
    const siblingScopes = [
      { addedBinding: null, parentScope: null },
      { addedBinding: 0, parentScope: 0 },
      { addedBinding: 1, parentScope: 0 },
    ];
    const siblingRegions = [
      {
        block: 2,
        kind: "select-list",
        range: range(34, 38),
        scope: 1,
      },
    ];
    expectError(
      () =>
        model({
          bindings: siblingBindings,
          blocks: siblingBlocks,
          regions: siblingRegions,
          scopes: siblingScopes,
        }),
      "invalid-model",
    );
  });

  it("rejects overlapping sibling query blocks", () => {
    const blocks = [
      fixture().blocks[0],
      {
        baseScope: 0,
        kind: "select",
        parentBlock: 0,
        range: range(17, 30),
      },
      {
        baseScope: 0,
        kind: "select",
        parentBlock: 0,
        range: range(20, 40),
      },
    ];
    expectError(() => model({ blocks }), "invalid-model");
  });

  it("preserves invariants across generated scope chains", () => {
    for (let count = 1; count <= 32; count += 1) {
      const text = "x".repeat(Math.max(count, 2));
      const bindings = Array.from({ length: count }, (_, index) => ({
        alias: null,
        owner: 0,
        range: range(index, index + 1),
        source: {
          kind: "named",
          path: [component(`r${index}`)],
        },
      }));
      const scopes = [
        { addedBinding: null, parentScope: null },
        ...bindings.map((_binding, index) => ({
          addedBinding: index,
          parentScope: index,
        })),
      ];
      const generated = createSqlQueryBindingModel(text, {}, {
        bindings,
        blocks: [
          {
            baseScope: 0,
            kind: "select",
            parentBlock: null,
            range: range(0, text.length),
          },
        ],
        coverage: completeCoverage(),
        issues: [],
        regions: [
          {
            block: 0,
            kind: "other",
            range: range(0, text.length),
            scope: count,
          },
        ],
        scopes,
        statementRange: range(0, text.length),
      });
      const visible = visibleSqlRelationBindingsAt(generated, 0);
      expect(visible.status === "ready" && visible.bindings).toHaveLength(count);
    }
  });
});
