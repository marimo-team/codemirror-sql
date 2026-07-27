import { describe, expect, it } from "vitest";
import {
  createSqlLanguageService,
  duckdbDialect,
} from "../index.js";

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ??
    Number.POSITIVE_INFINITY;
}

describe("language feature performance gates", () => {
  it("keeps warm local structure analysis below 150 ms p95", async () => {
    const statement = "select id, name\nfrom users\nwhere active = true;\n";
    const text = statement.repeat(Math.ceil(10_240 / statement.length))
      .slice(0, 10_240);
    const service = createSqlLanguageService({
      dialects: [duckdbDialect()],
    });
    const session = service.openDocument({
      context: { dialect: "duckdb" },
      text,
    });
    await session.documentSymbols().result;
    const samples: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const started = performance.now();
      const result = await session.documentSymbols().result;
      expect(result.status).toBe("ready");
      samples.push(performance.now() - started);
    }
    expect(percentile95(samples)).toBeLessThan(150);
    session.dispose();
    service.dispose();
  });

  it("aborts feature work for fifty disposed sessions", async () => {
    const signals: AbortSignal[] = [];
    const service = createSqlLanguageService({
      dialects: [duckdbDialect()],
      featureProviderBudgetMs: 1_000,
      featureProviders: [{
        id: "pending-engine",
        diagnostics: ({ signal }) => {
          signals.push(signal);
          return new Promise<never>(() => {});
        },
      }],
    });
    const sessions = Array.from({ length: 50 }, () =>
      service.openDocument({
        context: { dialect: "duckdb" },
        text: "select 1",
      }));
    const tasks = sessions.map((session) => session.diagnostics().result);
    await Promise.resolve();
    for (const session of sessions) session.dispose();
    const results = await Promise.all(tasks);

    expect(signals).toHaveLength(50);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(
      results.every(
        (result) =>
          result.status === "cancelled" && result.reason === "disposed",
      ),
    ).toBe(true);
    service.dispose();
  });
});
