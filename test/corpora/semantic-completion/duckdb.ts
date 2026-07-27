import type { SemanticCompletionCase } from "./types.js";

export const duckDbSemanticCompletion = [
  {
    category: "valid",
    expectedIncomplete: false,
    expectedLabels: ["first_id"],
    sql: "SELECT d.| FROM (SELECT id AS first_id) d",
  },
  {
    category: "invalid",
    expectedIncomplete: true,
    expectedLabels: ["known_id"],
    sql: "SELECT d.| FROM (SELECT id AS known_id, count() +) d",
  },
  {
    category: "incomplete",
    expectedIncomplete: false,
    expectedLabels: ["first_id"],
    sql: "SELECT d.fi| FROM (SELECT id AS first_id) d",
  },
  {
    category: "templated",
    expectedIncomplete: true,
    expectedLabels: ["dynamic_id"],
    sql: "SELECT d.| FROM (SELECT {python} AS dynamic_id) d",
    template: "{python}",
  },
  {
    category: "multi-statement",
    expectedIncomplete: false,
    expectedLabels: ["first_name"],
    sql: "SELECT 1; SELECT d.| FROM (SELECT id AS first_name UNION ALL SELECT id AS later_name) d",
  },
] as const satisfies readonly SemanticCompletionCase[];
