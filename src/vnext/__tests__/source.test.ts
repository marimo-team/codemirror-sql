import { describe, expect, it } from "vitest";
import {
  createIdentitySqlSource,
  createMaskedSqlSource,
  mapAnalysisRangeToOriginal,
  mapOriginalRangeToAnalysis,
  MAX_SQL_EMBEDDED_REGIONS,
  MAX_SQL_SOURCE_LENGTH,
  normalizeSqlTextRange,
  SqlSourceError,
} from "../source.js";

function expectSourceError(
  code: SqlSourceError["code"],
  operation: () => unknown,
): void {
  try {
    operation();
  } catch (error) {
    if (!(error instanceof SqlSourceError)) {
      throw error;
    }
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`Expected SqlSourceError with code ${code}`);
}

describe("SQL text ranges", () => {
  it("normalizes frozen half-open UTF-16 ranges", () => {
    const input = { from: 1, to: 3 };
    const range = normalizeSqlTextRange(input, 3);

    expect(range).toEqual(input);
    expect(range).not.toBe(input);
    expect(Object.isFrozen(range)).toBe(true);
    expect(normalizeSqlTextRange({ from: 3, to: 3 }, 3)).toEqual({
      from: 3,
      to: 3,
    });
  });

  it.each([
    null,
    "",
    {},
    { from: 0 },
    { from: -1, to: 0 },
    { from: 1, to: 0 },
    { from: 0.5, to: 1 },
    { from: 0, to: 2 },
    { from: Number.NaN, to: 0 },
    { from: 0, to: Number.POSITIVE_INFINITY },
  ])("rejects malformed ranges %#", (range) => {
    expectSourceError("invalid-range", () => {
      normalizeSqlTextRange(range, 1);
    });
  });

  it.each([-1, 0.5, Number.NaN, MAX_SQL_SOURCE_LENGTH + 1])(
    "rejects invalid source length %s",
    (sourceLength) => {
      expectSourceError("invalid-range", () => {
        normalizeSqlTextRange({ from: 0, to: 0 }, sourceLength);
      });
    },
  );

  it("does not invoke accessors or proxy get traps", () => {
    let accessorInvoked = false;
    expectSourceError("invalid-source", () => {
      normalizeSqlTextRange(
        {
          get from() {
            accessorInvoked = true;
            return 0;
          },
          to: 0,
        },
        0,
      );
    });
    expect(accessorInvoked).toBe(false);

    let getInvoked = false;
    const range = new Proxy(
      { from: 0, to: 0 },
      {
        get(target, property, receiver) {
          getInvoked = true;
          return Reflect.get(target, property, receiver);
        },
      },
    );
    expect(normalizeSqlTextRange(range, 0)).toEqual({ from: 0, to: 0 });
    expect(getInvoked).toBe(false);
  });

  it("normalizes hostile proxy failures", () => {
    expectSourceError("invalid-source", () => {
      normalizeSqlTextRange(
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              throw new Error("hostile");
            },
          },
        ),
        0,
      );
    });
  });

  it("does not inspect arbitrary values thrown by proxies", () => {
    const hostileError = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("secondary");
        },
      },
    );
    expectSourceError("invalid-source", () => {
      normalizeSqlTextRange(
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              throw hostileError;
            },
          },
        ),
        0,
      );
    });
  });
});

describe("SQL source snapshots", () => {
  it("creates frozen identity snapshots", () => {
    const source = createIdentitySqlSource("SELECT 😀");

    expect(source.originalText).toBe("SELECT 😀");
    expect(source.analysisText).toBe(source.originalText);
    expect(source.embeddedRegions).toEqual([]);
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source.embeddedRegions)).toBe(true);
  });

  it("bounds and validates source text", () => {
    expectSourceError("invalid-source", () => {
      createIdentitySqlSource(42);
    });
    expectSourceError("invalid-source", () => {
      createIdentitySqlSource("x".repeat(MAX_SQL_SOURCE_LENGTH + 1));
    });
  });

  it("masks every non-newline UTF-16 code unit", () => {
    const originalText = "a😀\r\nb\uD800c";
    const source = createMaskedSqlSource(originalText, [
      { from: 1, language: "python", to: 7 },
    ]);

    expect(source.originalText).toBe(originalText);
    expect(source.analysisText).toBe("a  \r\n  c");
    expect(source.analysisText.length).toBe(originalText.length);
    expect(source.embeddedRegions).toEqual([
      { from: 1, language: "python", to: 7 },
    ]);
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source.embeddedRegions)).toBe(true);
    expect(Object.isFrozen(source.embeddedRegions[0])).toBe(true);
  });

  it("owns normalized embedded regions", () => {
    const first = { from: 0, language: "python", to: 1 };
    const regions = [first, { from: 2, language: "jinja", to: 3 }];
    const source = createMaskedSqlSource("abc", regions);

    first.from = 1;
    regions.push({ from: 1, language: "other", to: 2 });
    expect(source.embeddedRegions).toEqual([
      { from: 0, language: "python", to: 1 },
      { from: 2, language: "jinja", to: 3 },
    ]);
    expect(source.analysisText).toBe(" b ");
  });

  it.each([
    null,
    {},
    [42],
    [{ from: 0, language: "python", to: 0 }],
    [{ from: -1, language: "python", to: 1 }],
    [{ from: 0, language: "", to: 1 }],
    [{ from: 0, language: "x".repeat(257), to: 1 }],
    [
      { from: 1, language: "python", to: 2 },
      { from: 0, language: "python", to: 1 },
    ],
    [
      { from: 0, language: "python", to: 2 },
      { from: 1, language: "python", to: 3 },
    ],
  ])("rejects malformed embedded regions %#", (regions) => {
    expectSourceError("invalid-region", () => {
      createMaskedSqlSource("abc", regions);
    });
  });

  it("rejects sparse, oversized, and extended region arrays", () => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    expectSourceError("invalid-source", () => {
      createMaskedSqlSource("a", sparse);
    });

    const oversized: unknown[] = [];
    oversized.length = MAX_SQL_EMBEDDED_REGIONS + 1;
    expectSourceError("invalid-region", () => {
      createMaskedSqlSource("a", oversized);
    });

    const extended = [{ from: 0, language: "python", to: 1 }];
    Object.defineProperty(extended, "custom", { value: true });
    expectSourceError("invalid-region", () => {
      createMaskedSqlSource("a", extended);
    });
  });

  it("does not invoke region accessors or array get traps", () => {
    let accessorInvoked = false;
    expectSourceError("invalid-source", () => {
      createMaskedSqlSource("a", [
        {
          get from() {
            accessorInvoked = true;
            return 0;
          },
          language: "python",
          to: 1,
        },
      ]);
    });
    expect(accessorInvoked).toBe(false);

    expectSourceError("invalid-source", () => {
      createMaskedSqlSource("a", [
        {
          from: 0,
          get language() {
            accessorInvoked = true;
            return "python";
          },
          to: 1,
        },
      ]);
    });
    expect(accessorInvoked).toBe(false);

    let getInvoked = false;
    const regions = new Proxy([{ from: 0, language: "python", to: 1 }], {
      get(target, property, receiver) {
        getInvoked = true;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(createMaskedSqlSource("a", regions).analysisText).toBe(" ");
    expect(getInvoked).toBe(false);
  });

  it("normalizes hostile region proxy failures", () => {
    expectSourceError("invalid-source", () => {
      createMaskedSqlSource(
        "a",
        new Proxy(
          [],
          {
            ownKeys() {
              throw new Error("hostile");
            },
          },
        ),
      );
    });
  });

  it("normalizes hostile values thrown while inspecting regions", () => {
    const hostileError = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("secondary");
        },
      },
    );
    expectSourceError("invalid-source", () => {
      createMaskedSqlSource(
        "a",
        new Proxy(
          [],
          {
            ownKeys() {
              throw hostileError;
            },
          },
        ),
      );
    });
  });

  it("maps ranges with fresh frozen values", () => {
    const source = createMaskedSqlSource("a😀b", [
      { from: 1, language: "python", to: 3 },
    ]);
    const originalRange = { from: 1, to: 3 };
    const analysisRange = mapOriginalRangeToAnalysis(source, originalRange);
    const roundTrip = mapAnalysisRangeToOriginal(source, analysisRange);

    expect(analysisRange).toEqual(originalRange);
    expect(analysisRange).not.toBe(originalRange);
    expect(roundTrip).toEqual(originalRange);
    expect(roundTrip).not.toBe(analysisRange);
    expect(Object.isFrozen(analysisRange)).toBe(true);
    expect(Object.isFrozen(roundTrip)).toBe(true);
  });

  it("preserves masking invariants across deterministic random cases", () => {
    let state = 0x51_0f_aa_7d;
    const next = (limit: number): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state % limit;
    };
    const tokens = ["a", " ", "\r", "\n", "😀", "\uD800"];

    for (let iteration = 0; iteration < 250; iteration += 1) {
      let text = "";
      const tokenCount = next(50) + 1;
      for (let index = 0; index < tokenCount; index += 1) {
        const token = tokens[next(tokens.length)];
        if (token === undefined) {
          throw new Error("Random token index was out of bounds");
        }
        text += token;
      }

      const regions: Array<{
        from: number;
        language: string;
        to: number;
      }> = [];
      let cursor = 0;
      while (cursor < text.length) {
        cursor += next(4);
        if (cursor >= text.length) {
          break;
        }
        const to = Math.min(text.length, cursor + next(5) + 1);
        regions.push({ from: cursor, language: "embedded", to });
        cursor = to + next(3);
      }

      const source = createMaskedSqlSource(text, regions);
      expect(source.analysisText.length).toBe(text.length);
      for (let offset = 0; offset < text.length; offset += 1) {
        const masked = regions.some(
          (region) => region.from <= offset && offset < region.to,
        );
        const original = text.slice(offset, offset + 1);
        const expected =
          masked && original !== "\r" && original !== "\n" ? " " : original;
        expect(source.analysisText.slice(offset, offset + 1)).toBe(expected);
      }

      const from = next(text.length + 1);
      const to = from + next(text.length - from + 1);
      expect(
        mapAnalysisRangeToOriginal(
          source,
          mapOriginalRangeToAnalysis(source, { from, to }),
        ),
      ).toEqual({ from, to });
    }
  });

  it("masks newline-dense text at the source limit", () => {
    const text = "\r\n".repeat(MAX_SQL_SOURCE_LENGTH / 2);
    const start = performance.now();
    const source = createMaskedSqlSource(text, [
      { from: 0, language: "embedded", to: text.length },
    ]);
    const duration = performance.now() - start;

    expect(source.analysisText).toBe(text);
    expect(source.analysisText.length).toBe(text.length);
    expect(duration).toBeLessThan(2_000);
  });

  it("masks alternating text and the maximum region count", () => {
    const alternatingText = "x\n".repeat(512 * 1024);
    const alternatingStart = performance.now();
    const alternating = createMaskedSqlSource(alternatingText, [
      { from: 0, language: "embedded", to: alternatingText.length },
    ]);
    const alternatingDuration = performance.now() - alternatingStart;
    expect(alternating.analysisText).toBe(" \n".repeat(512 * 1024));

    const fragmentedText = "xy".repeat(MAX_SQL_EMBEDDED_REGIONS);
    const regions = Array.from(
      { length: MAX_SQL_EMBEDDED_REGIONS },
      (_, index) => ({
        from: index * 2,
        language: "embedded",
        to: index * 2 + 1,
      }),
    );
    const fragmentedStart = performance.now();
    const fragmented = createMaskedSqlSource(fragmentedText, regions);
    const fragmentedDuration = performance.now() - fragmentedStart;
    expect(fragmented.analysisText).toBe(" y".repeat(MAX_SQL_EMBEDDED_REGIONS));

    expect(alternatingDuration).toBeLessThan(2_000);
    expect(fragmentedDuration).toBeLessThan(2_000);
  });
});
