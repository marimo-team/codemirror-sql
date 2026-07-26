import { bench, describe } from "vitest";
import {
  normalizeNodeSqlParserQueryBindings,
} from "../node-sql-parser-query-bindings.js";

const RELATION_COUNT = 1_000;
const relations = Array.from(
  { length: RELATION_COUNT },
  (_, index) => `t${index} a${index}`,
);
const text = `SELECT a999.id FROM ${relations.join(", ")}`;
const root = {
  from: Array.from({ length: RELATION_COUNT }, (_, index) => ({
    as: `a${index}`,
    db: null,
    table: `t${index}`,
  })),
  type: "select",
};
const authority = {};

describe("node-sql-parser query binding normalization", () => {
  bench("normalizes 1,000 relations", () => {
    normalizeNodeSqlParserQueryBindings(
      root,
      text,
      authority,
      { compatibility: false, grammar: "postgresql" },
    );
  });
});
