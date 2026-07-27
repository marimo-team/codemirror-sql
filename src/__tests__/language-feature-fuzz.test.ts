import { describe, expect, test } from "vitest";
import {
  createSqlLanguageService,
  duckdbDialect,
} from "../index.js";

function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("deterministic language feature fuzzing", () => {
  test("keeps local structure ranges valid across hostile incomplete text", async () => {
    const random = generator(0x5eed_2026);
    const fragments = [
      "select", " from ", "(", ")", ";", "\n", "/*", "*/", "'",
      "\"", "-- comment\n", "{python}", "with x as (", " union all ",
    ];
    const service = createSqlLanguageService({
      dialects: [duckdbDialect()],
    });
    for (let iteration = 0; iteration < 250; iteration += 1) {
      let text = "";
      const count = 1 + Math.floor(random() * 30);
      for (let index = 0; index < count; index += 1) {
        text += fragments[Math.floor(random() * fragments.length)] ?? "";
      }
      const session = service.openDocument({
        context: { dialect: "duckdb" },
        text,
      });
      const [symbols, folds] = await Promise.all([
        session.documentSymbols().result,
        session.foldingRanges().result,
      ]);
      expect(symbols.status).toBe("ready");
      expect(folds.status).toBe("ready");
      if (symbols.status === "ready") {
        for (const symbol of symbols.value) {
          expect(symbol.range.from).toBeGreaterThanOrEqual(0);
          expect(symbol.range.to).toBeLessThanOrEqual(text.length);
          expect(symbol.selectionRange.from).toBeGreaterThanOrEqual(
            symbol.range.from,
          );
          expect(symbol.selectionRange.to).toBeLessThanOrEqual(symbol.range.to);
        }
      }
      if (folds.status === "ready") {
        for (const fold of folds.value) {
          expect(fold.from).toBeGreaterThanOrEqual(0);
          expect(fold.to).toBeLessThanOrEqual(text.length);
          expect(fold.from).toBeLessThanOrEqual(fold.to);
        }
      }
      session.dispose();
    }
    service.dispose();
  });
});
