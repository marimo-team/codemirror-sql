import { bench, describe } from "vitest";
import {
  createSqlQueryBindingModel,
  MAX_QUERY_BINDING_BLOCKS,
  MAX_QUERY_BINDINGS,
  MAX_QUERY_BINDING_SCOPES,
  MAX_QUERY_VISIBILITY_REGIONS,
  resolveSqlRelationQualifier,
  visibleSqlRelationBindingsAt,
} from "../query-binding-model.js";
import type { SqlIdentifierComponent } from "../types.js";

const BINDING_COUNT = 1_000;
const TEXT = "x".repeat(10 * 1_024);
const AUTHORITY = {};

function component(value: string): SqlIdentifierComponent {
  return { quoted: false, value };
}

const bindings = Array.from({ length: BINDING_COUNT }, (_, index) => ({
  alias: null,
  owner: 0,
  range: { from: index, to: index + 1 },
  source: {
    kind: "named",
    path: [component(`relation_${index}`)],
  },
}));

const scopes = [
  { addedBinding: null, parentScope: null },
  ...bindings.map((_binding, index) => ({
    addedBinding: index,
    parentScope: index,
  })),
];

const input = {
  bindings,
  blocks: [
    {
      baseScope: 0,
      kind: "select",
      parentBlock: null,
      range: { from: 0, to: TEXT.length },
    },
  ],
  coverage: {
    queryBlocks: "complete",
    relationBindings: "complete",
    visibility: "complete",
  },
  issues: [],
  regions: [
    {
      block: 0,
      kind: "select-list",
      range: { from: 0, to: TEXT.length },
      scope: BINDING_COUNT,
    },
  ],
  scopes,
  statementRange: { from: 0, to: TEXT.length },
};

const model = createSqlQueryBindingModel(TEXT, AUTHORITY, input);

const MAXIMUM_TEXT = "x".repeat(MAX_QUERY_VISIBILITY_REGIONS * 2);
const maximumBlocks = Array.from(
  { length: MAX_QUERY_BINDING_BLOCKS },
  (_, index) => ({
    baseScope: 0,
    kind: "select",
    parentBlock: index === 0 ? null : index - 1,
    range: { from: 0, to: MAXIMUM_TEXT.length },
  }),
);
const maximumBindings = Array.from(
  { length: MAX_QUERY_BINDINGS },
  (_, index) => ({
    alias: null,
    owner: index % MAX_QUERY_BINDING_BLOCKS,
    range: { from: 0, to: 1 },
    source: {
      kind: "named",
      path: [component(`relation_${index}`)],
    },
  }),
);
const maximumScopes: {
  addedBinding: number | null;
  parentScope: number | null;
}[] = [
  { addedBinding: null, parentScope: null },
  ...maximumBindings.map((_binding, index) => ({
    addedBinding: index,
    parentScope: index,
  })),
];
while (maximumScopes.length < MAX_QUERY_BINDING_SCOPES) {
  maximumScopes.push({
    addedBinding: null,
    parentScope: maximumScopes.length - 1,
  });
}
const maximumInput = {
  bindings: maximumBindings,
  blocks: maximumBlocks,
  coverage: {
    queryBlocks: "complete",
    relationBindings: "complete",
    visibility: "complete",
  },
  issues: [],
  regions: Array.from(
    { length: MAX_QUERY_VISIBILITY_REGIONS },
    (_, index) => ({
      block: MAX_QUERY_BINDING_BLOCKS - 1,
      kind: "where",
      range: { from: index * 2, to: index * 2 + 1 },
      scope: MAX_QUERY_BINDING_SCOPES - 1,
    }),
  ),
  scopes: maximumScopes,
  statementRange: { from: 0, to: MAXIMUM_TEXT.length },
};

function asciiEqual(
  left: SqlIdentifierComponent,
  right: SqlIdentifierComponent,
): boolean {
  return left.value === right.value;
}

describe("query binding model", () => {
  bench("validate 1,000 bindings in a 10 KiB statement", () => {
    createSqlQueryBindingModel(TEXT, AUTHORITY, input);
  });

  bench("validate maximum relationship dimensions", () => {
    createSqlQueryBindingModel(MAXIMUM_TEXT, AUTHORITY, maximumInput);
  });

  bench("walk 1,000 visible bindings", () => {
    visibleSqlRelationBindingsAt(model, 5_000);
  });

  bench("resolve the last of 1,000 qualifiers", () => {
    resolveSqlRelationQualifier(
      model,
      5_000,
      component("relation_999"),
      asciiEqual,
    );
  });
});
