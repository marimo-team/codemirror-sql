import { afterEach, describe, expect, it } from "vitest";
import {
  createSqlLanguageService,
  duckdbDialect,
  type SqlLanguageService,
} from "../index.js";

const services: SqlLanguageService<{
  readonly dialect: string;
}>[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
});

function percentile95(samples: readonly number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? Infinity;
}

describe("semantic completion performance gates", () => {
  it("keeps warm 10 KiB CTE output completion below 50 ms p95", async () => {
    const projections = Array.from(
      { length: 200 },
      (_, index) => `source_${index} AS output_${index}`,
    ).join(", ");
    const prefix =
      `WITH c AS (SELECT ${projections} FROM physical) ` +
      "SELECT c.output_ FROM c ";
    const padding = `/*${"x".repeat(10 * 1024 - prefix.length - 2)}*/`;
    const text = prefix + padding;
    const position = text.indexOf("output_ FROM") + "output_".length;
    const service = createSqlLanguageService({
      dialects: [duckdbDialect()],
    });
    services.push(service);
    const session = service.openDocument({
      context: { dialect: "duckdb" },
      text,
    });
    const request = {
      position,
      trigger: { kind: "invoked" as const },
    };
    await session.complete(request);
    const samples: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const startedAt = performance.now();
      const result = await session.complete(request);
      samples.push(performance.now() - startedAt);
      expect(result.status).toBe("ready");
      if (result.status === "ready") {
        expect(result.value.items).toHaveLength(200);
      }
    }
    expect(percentile95(samples)).toBeLessThan(50);
  });

  it("keeps repeated CTE inference cached and aggregate output bounded", async () => {
    const projections = Array.from(
      { length: 64 },
      (_, index) => `source_${index} AS output_${index}`,
    ).join(", ");
    const relations = Array.from(
      { length: 65 },
      (_, index) => `c AS c_${index}`,
    ).join(", ");
    const text =
      `WITH c AS (SELECT ${projections} FROM physical) ` +
      `SELECT  FROM ${relations}`;
    const position =
      text.indexOf("SELECT  FROM") + "SELECT ".length;
    const service = createSqlLanguageService({
      dialects: [duckdbDialect()],
    });
    services.push(service);
    const session = service.openDocument({
      context: { dialect: "duckdb" },
      text,
    });
    const request = {
      position,
      trigger: { kind: "invoked" as const },
    };
    await session.complete(request);
    const samples: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      const startedAt = performance.now();
      const result = await session.complete(request);
      samples.push(performance.now() - startedAt);
      expect(result.status).toBe("ready");
      if (result.status === "ready") {
        expect(result.value.items).toHaveLength(4_096);
        expect(result.value.isIncomplete).toBe(true);
      }
    }
    expect(percentile95(samples)).toBeLessThan(50);
  });
});
