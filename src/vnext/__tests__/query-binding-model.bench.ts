import { bench, describe } from "vitest";
import {
  createSqlQueryBindingModel,
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
