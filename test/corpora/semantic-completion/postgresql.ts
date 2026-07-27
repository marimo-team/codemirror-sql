import type { SemanticCompletionCase } from "./types.js";

export const postgresqlSemanticCompletion = [
  {
    category: "valid",
    expectedIncomplete: false,
    expectedLabels: ["user_id"],
    sql: "WITH c AS (SELECT id AS user_id) SELECT c.| FROM c",
  },
  {
    category: "invalid",
    expectedIncomplete: true,
    expectedLabels: ["safe_name"],
    sql: "WITH c AS (SELECT id AS safe_name, upper(name) FROM) SELECT c.| FROM c",
  },
  {
    category: "incomplete",
    expectedIncomplete: false,
    expectedLabels: ["user_id"],
    sql: "WITH c AS (SELECT id AS user_id) SELECT c.us| FROM c",
  },
  {
    category: "templated",
    expectedIncomplete: true,
    expectedLabels: ["computed"],
    sql: "WITH c AS (SELECT {python} AS computed) SELECT c.| FROM c",
    template: "{python}",
  },
  {
    category: "multi-statement",
    expectedIncomplete: false,
    expectedLabels: ["second_id"],
    sql: "SELECT 1; WITH c AS (SELECT id AS second_id) SELECT c.| FROM c",
  },
] as const satisfies readonly SemanticCompletionCase[];
