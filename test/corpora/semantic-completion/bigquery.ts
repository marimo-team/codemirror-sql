import type { SemanticCompletionCase } from "./types.js";

export const bigQuerySemanticCompletion = [
  {
    category: "valid",
    expectedIncomplete: false,
    expectedLabels: ["Display Name"],
    sql: "WITH c AS (SELECT name AS `Display Name`) SELECT c.| FROM c",
  },
  {
    category: "invalid",
    expectedIncomplete: true,
    expectedLabels: ["safe_id"],
    sql: "WITH c AS (SELECT id AS safe_id, STRUCT() AS) SELECT c.| FROM c",
  },
  {
    category: "incomplete",
    expectedIncomplete: false,
    expectedLabels: ["project_id"],
    sql: "WITH c AS (SELECT id AS project_id) SELECT c.proj| FROM c",
  },
  {
    category: "templated",
    expectedIncomplete: true,
    expectedLabels: ["metric"],
    sql: "WITH c AS (SELECT {python} AS metric) SELECT c.| FROM c",
    template: "{python}",
  },
  {
    category: "multi-statement",
    expectedIncomplete: false,
    expectedLabels: ["event_id"],
    sql: "SELECT 1; WITH c AS (SELECT id AS event_id) SELECT c.| FROM c",
  },
] as const satisfies readonly SemanticCompletionCase[];
