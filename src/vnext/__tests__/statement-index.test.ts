import { describe, expect, it } from "vitest";
import {
  BIGQUERY_SQL_LEXICAL_PROFILE,
  buildSqlStatementIndex,
  DREMIO_SQL_LEXICAL_PROFILE,
  DUCKDB_SQL_LEXICAL_PROFILE,
  findSqlStatementSlot,
  MAX_SQL_STATEMENT_SLOTS,
  POSTGRESQL_SQL_LEXICAL_PROFILE,
  type SqlLexicalProfile,
  type SqlStatementIndex,
  type SqlStatementSlot,
} from "../statement-index.js";
import { createMaskedSqlSource } from "../source.js";

function ranges(index: SqlStatementIndex) {
  return index.slots.map((slot) => {
    if (slot.boundaryQuality === "opaque") {
      return {
        extent: [slot.extent.from, slot.extent.to],
        quality: slot.boundaryQuality,
        reason: slot.endState.reason,
      };
    }
    return {
      extent: [slot.extent.from, slot.extent.to],
      hasCode: slot.hasCode,
      quality: slot.boundaryQuality,
      source: [slot.source.from, slot.source.to],
      terminator: slot.terminator
        ? [slot.terminator.from, slot.terminator.to]
        : null,
    };
  });
}

function exactSlot(slot: SqlStatementSlot) {
  expect(slot.boundaryQuality).toBe("exact");
  if (slot.boundaryQuality === "opaque") {
    throw new Error("Expected an exact SQL statement slot");
  }
  return slot;
}

function itemAt<Value>(items: readonly Value[], index: number): Value {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`Expected test item at index ${index}`);
  }
  return item;
}

function expectPartition(text: string, index: SqlStatementIndex): void {
  expect(index.slots.length).toBeGreaterThan(0);
  let cursor = 0;
  for (const slot of index.slots) {
    expect(slot.extent.from).toBe(cursor);
    expect(slot.extent.to).toBeGreaterThanOrEqual(slot.extent.from);
    expect(slot.extent.to).toBeLessThanOrEqual(text.length);
    expect(Object.isFrozen(slot)).toBe(true);
    expect(Object.isFrozen(slot.extent)).toBe(true);
    if (slot.boundaryQuality === "exact") {
      expect(slot.source.from).toBe(slot.extent.from);
      expect(slot.source.to).toBeLessThanOrEqual(slot.extent.to);
      if (slot.terminator) {
        expect(slot.terminator.from).toBe(slot.source.to);
        expect(slot.terminator.to).toBe(slot.extent.to);
        expect(text.slice(slot.terminator.from, slot.terminator.to)).toBe(";");
      } else {
        expect(slot.source.to).toBe(slot.extent.to);
      }
    }
    cursor = slot.extent.to;
  }
  expect(cursor).toBe(text.length);
  expect(Object.isFrozen(index)).toBe(true);
  expect(Object.isFrozen(index.slots)).toBe(true);
}

describe("statement partition", () => {
  it.each([
    [
      "",
      [
        {
          extent: [0, 0],
          hasCode: false,
          quality: "exact",
          source: [0, 0],
          terminator: null,
        },
      ],
    ],
    [
      "SELECT 1",
      [
        {
          extent: [0, 8],
          hasCode: true,
          quality: "exact",
          source: [0, 8],
          terminator: null,
        },
      ],
    ],
    [
      "SELECT 1;",
      [
        {
          extent: [0, 9],
          hasCode: true,
          quality: "exact",
          source: [0, 8],
          terminator: [8, 9],
        },
        {
          extent: [9, 9],
          hasCode: false,
          quality: "exact",
          source: [9, 9],
          terminator: null,
        },
      ],
    ],
    [
      "SELECT 1; \r\n -- next\n SELECT 2",
      [
        {
          extent: [0, 9],
          hasCode: true,
          quality: "exact",
          source: [0, 8],
          terminator: [8, 9],
        },
        {
          extent: [9, 30],
          hasCode: true,
          quality: "exact",
          source: [9, 30],
          terminator: null,
        },
      ],
    ],
    [
      ";;",
      [
        {
          extent: [0, 1],
          hasCode: false,
          quality: "exact",
          source: [0, 0],
          terminator: [0, 1],
        },
        {
          extent: [1, 2],
          hasCode: false,
          quality: "exact",
          source: [1, 1],
          terminator: [1, 2],
        },
        {
          extent: [2, 2],
          hasCode: false,
          quality: "exact",
          source: [2, 2],
          terminator: null,
        },
      ],
    ],
  ])("partitions %j without trimming or copying semantics", (text, expected) => {
    const index = buildSqlStatementIndex(text, DUCKDB_SQL_LEXICAL_PROFILE);
    expect(ranges(index)).toEqual(expected);
    expectPartition(text, index);
  });

  it("keeps trailing trivia in a following empty-code slot", () => {
    const text = "SELECT 1; \n/* after */";
    const index = buildSqlStatementIndex(text, DUCKDB_SQL_LEXICAL_PROFILE);
    expect(ranges(index)).toEqual([
      {
        extent: [0, 9],
        hasCode: true,
        quality: "exact",
        source: [0, 8],
        terminator: [8, 9],
      },
      {
        extent: [9, text.length],
        hasCode: false,
        quality: "exact",
        source: [9, text.length],
        terminator: null,
      },
    ]);
  });

  it("preserves UTF-16 coordinates around astral and lone-surrogate text", () => {
    const text = "SELECT '🦆;\ud800';\r\nSELECT 2";
    const index = buildSqlStatementIndex(text, DUCKDB_SQL_LEXICAL_PROFILE);
    expect(index.slots).toHaveLength(2);
    expect(exactSlot(itemAt(index.slots, 0)).terminator?.from).toBe(13);
    expect(exactSlot(itemAt(index.slots, 1)).source.from).toBe(14);
    expectPartition(text, index);
  });
});

describe("cursor affinity", () => {
  it("selects the requested side of a shared boundary", () => {
    const text = "SELECT 1;SELECT 2";
    const index = buildSqlStatementIndex(text, DUCKDB_SQL_LEXICAL_PROFILE);

    expect(findSqlStatementSlot(index, 0, "left")).toBe(index.slots[0]);
    expect(findSqlStatementSlot(index, 0, "right")).toBe(index.slots[0]);
    expect(findSqlStatementSlot(index, 8, "left")).toBe(index.slots[0]);
    expect(findSqlStatementSlot(index, 9, "left")).toBe(index.slots[0]);
    expect(findSqlStatementSlot(index, 9, "right")).toBe(index.slots[1]);
    expect(findSqlStatementSlot(index, text.length, "left")).toBe(index.slots[1]);
    expect(findSqlStatementSlot(index, text.length, "right")).toBe(index.slots[1]);
  });

  it("distinguishes EOF after a terminator from EOF in an open statement", () => {
    const terminated = buildSqlStatementIndex(
      "SELECT 1;",
      DUCKDB_SQL_LEXICAL_PROFILE,
    );
    expect(findSqlStatementSlot(terminated, 9, "left")).toBe(terminated.slots[0]);
    expect(findSqlStatementSlot(terminated, 9, "right")).toBe(terminated.slots[1]);

    const open = buildSqlStatementIndex("SELECT 1", DUCKDB_SQL_LEXICAL_PROFILE);
    expect(findSqlStatementSlot(open, 8, "left")).toBe(open.slots[0]);
    expect(findSqlStatementSlot(open, 8, "right")).toBe(open.slots[0]);
  });

  it("validates internal positions", () => {
    const index = buildSqlStatementIndex("", DUCKDB_SQL_LEXICAL_PROFILE);
    expect(() => findSqlStatementSlot(index, -1, "left")).toThrow(RangeError);
    expect(() => findSqlStatementSlot(index, 1, "right")).toThrow(RangeError);
    expect(() => findSqlStatementSlot(index, Number.NaN, "right")).toThrow(
      RangeError,
    );
    expect(() =>
      Reflect.apply(findSqlStatementSlot, undefined, [index, 0, "center"]),
    ).toThrow(TypeError);
  });
});

describe("comments", () => {
  it.each([
    "SELECT 1 -- ; hidden\r\n;SELECT 2",
    "SELECT 1 /* ; hidden */;SELECT 2",
    "/* comment only ; */;",
  ])("ignores protected semicolons in %j", (text) => {
    const index = buildSqlStatementIndex(text, DUCKDB_SQL_LEXICAL_PROFILE);
    expect(index.slots).toHaveLength(2);
    expectPartition(text, index);
  });

  it("supports nested PostgreSQL and DuckDB block comments", () => {
    const text = "SELECT 1 /* outer /* ; inner */ ; outer */; SELECT 2";
    for (const profile of [
      POSTGRESQL_SQL_LEXICAL_PROFILE,
      DUCKDB_SQL_LEXICAL_PROFILE,
    ]) {
      const index = buildSqlStatementIndex(text, profile);
      expect(index.slots).toHaveLength(2);
      expect(exactSlot(itemAt(index.slots, 0)).terminator?.from).toBe(42);
    }
  });

  it("supports BigQuery hash comments and its non-nesting block comments", () => {
    const hash = buildSqlStatementIndex(
      "SELECT 1 # ; hidden\n;SELECT 2",
      BIGQUERY_SQL_LEXICAL_PROFILE,
    );
    expect(hash.slots).toHaveLength(2);

    const nonNested = buildSqlStatementIndex(
      "/* outer /* inner */;SELECT 2",
      BIGQUERY_SQL_LEXICAL_PROFILE,
    );
    expect(nonNested.slots).toHaveLength(2);
  });

  it("does not borrow BigQuery hash comments in other profiles", () => {
    const index = buildSqlStatementIndex(
      "SELECT 1 # ; SELECT 2",
      DUCKDB_SQL_LEXICAL_PROFILE,
    );
    expect(index.slots).toHaveLength(2);
  });
});

describe("PostgreSQL and DuckDB literals", () => {
  it.each([
    "SELECT 'a;''b';SELECT 2",
    'SELECT "a;""b";SELECT 2',
    "SELECT E'a\\';b';SELECT 2",
    "SELECT $$a;b$$;SELECT 2",
    "SELECT $tag$a;$$;b$tag$;SELECT 2",
  ])("protects semicolons in %j", (text) => {
    for (const profile of [
      POSTGRESQL_SQL_LEXICAL_PROFILE,
      DUCKDB_SQL_LEXICAL_PROFILE,
    ]) {
      const index = buildSqlStatementIndex(text, profile);
      expect(index.slots).toHaveLength(2);
      expect(index.quality).toBe("exact");
      expectPartition(text, index);
    }
  });

  it("requires a legal token boundary and case-matched dollar tag", () => {
    const attached = buildSqlStatementIndex(
      "SELECT value$tag$a;b$tag$;SELECT 2",
      POSTGRESQL_SQL_LEXICAL_PROFILE,
    );
    expect(attached.slots.length).toBeGreaterThan(2);

    const mismatched = buildSqlStatementIndex(
      "SELECT $tag$a;b$TAG$;SELECT 2",
      POSTGRESQL_SQL_LEXICAL_PROFILE,
    );
    expect(mismatched.slots).toHaveLength(1);
    expect(mismatched.endState).toMatchObject({
      construct: "dollar-quoted-string",
      kind: "unterminated",
    });
  });

  it("uses conservative Unicode rules for dollar tags and boundaries", () => {
    for (const text of [
      "SELECT $é$a;b$é$;SELECT 2",
      "SELECT $e\u0301$a;b$e\u0301$;SELECT 2",
      "SELECT $𐐀$a;b$𐐀$;SELECT 2",
      "SELECT $🦆$a;b$🦆$;SELECT 2",
      "SELECT $—$a;b$—$;SELECT 2",
      "SELECT $\u0301$a;b$\u0301$;SELECT 2",
    ]) {
      for (const profile of [
        POSTGRESQL_SQL_LEXICAL_PROFILE,
        DUCKDB_SQL_LEXICAL_PROFILE,
      ]) {
        const index = buildSqlStatementIndex(text, profile);
        expect(index.slots).toHaveLength(2);
        expect(index.quality).toBe("exact");
      }
    }

    for (const text of [
      "SELECT é$tag$a;b$tag$;SELECT 2",
      "SELECT e\u0301$tag$a;b$tag$;SELECT 2",
      "SELECT 𐐀$tag$a;b$tag$;SELECT 2",
      "SELECT 🦆$tag$a;b$tag$;SELECT 2",
    ]) {
      for (const profile of [
        POSTGRESQL_SQL_LEXICAL_PROFILE,
        DUCKDB_SQL_LEXICAL_PROFILE,
      ]) {
        const index = buildSqlStatementIndex(text, profile);
        expect(index.slots).toHaveLength(3);
        expect(exactSlot(itemAt(index.slots, 0)).terminator?.from).toBe(
          text.indexOf(";"),
        );
      }
    }
  });

  it("does not apply E-string backslash escaping to an attached identifier", () => {
    for (const text of [
      "SELECT nameE'a\\';SELECT 2",
      "SELECT éE'a\\';SELECT 2",
      "SELECT e\u0301E'a\\';SELECT 2",
      "SELECT 𐐀E'a\\';SELECT 2",
      "SELECT 🦆E'a\\';SELECT 2",
    ]) {
      for (const profile of [
        POSTGRESQL_SQL_LEXICAL_PROFILE,
        DUCKDB_SQL_LEXICAL_PROFILE,
      ]) {
        const index = buildSqlStatementIndex(text, profile);
        expect(index.slots).toHaveLength(2);
      }
    }

    const reviewedReproduction = "SELECT éE'a\\';b';SELECT 2";
    const index = buildSqlStatementIndex(
      reviewedReproduction,
      POSTGRESQL_SQL_LEXICAL_PROFILE,
    );
    expect(exactSlot(itemAt(index.slots, 0)).terminator?.from).toBe(
      reviewedReproduction.indexOf(";"),
    );
  });
});

describe("BigQuery literals", () => {
  it.each([
    "SELECT 'a\\';b';SELECT 2",
    'SELECT "a\\";b";SELECT 2',
    "SELECT '''a;\n'b''';SELECT 2",
    'SELECT """a;\n"b""";SELECT 2',
    "SELECT r'a\\';SELECT 2",
    "SELECT br'''a\\;b''';SELECT 2",
    "SELECT rb\"a\\;b\";SELECT 2",
    "SELECT `project;a`;SELECT 2",
    "SELECT `project\\`;a`;SELECT 2",
  ])("protects semicolons in %j", (text) => {
    const index = buildSqlStatementIndex(text, BIGQUERY_SQL_LEXICAL_PROFILE);
    expect(index.slots).toHaveLength(2);
    expect(index.quality).toBe("exact");
    expectPartition(text, index);
  });

  it("does not borrow BigQuery literal forms in Dremio", () => {
    const index = buildSqlStatementIndex(
      "SELECT `a;b`;SELECT 2",
      DREMIO_SQL_LEXICAL_PROFILE,
    );
    expect(index.slots).toHaveLength(3);
  });
});

describe("Dremio compatibility profile", () => {
  it.each([
    "SELECT 'a;''b';SELECT 2",
    'SELECT "a;""b";SELECT 2',
    "SELECT 1 -- ; hidden\n;SELECT 2",
    "SELECT 1 /* ; hidden */;SELECT 2",
  ])("protects verified lexical form %j", (text) => {
    const index = buildSqlStatementIndex(text, DREMIO_SQL_LEXICAL_PROFILE);
    expect(index.slots).toHaveLength(2);
    expect(index.quality).toBe("exact");
  });

  it.each([
    ["SELECT 'a;b", "single-quoted-string"],
    ['SELECT "a;b', "double-quoted-identifier"],
    ["SELECT 1 /* a;b", "block-comment"],
  ])("reports incomplete form %j", (text, construct) => {
    const index = buildSqlStatementIndex(text, DREMIO_SQL_LEXICAL_PROFILE);
    expect(index.slots).toHaveLength(1);
    expect(index.endState).toMatchObject({ construct, kind: "unterminated" });
  });
});

describe("opaque boundaries", () => {
  it.each([
    ["DELIMITER $$\nSELECT 1$$", "custom-delimiter"],
    ["IF condition THEN\n SELECT 1;\nEND IF;", "procedural-block"],
    ["LOOP\n SELECT 1;\nEND LOOP;", "procedural-block"],
    ["WHILE condition DO\n SELECT 1;\nEND WHILE;", "procedural-block"],
    ["REPEAT\n SELECT 1;\nUNTIL done\nEND REPEAT;", "procedural-block"],
    ["FOR item IN (SELECT 1) DO\n SELECT item;\nEND FOR;", "procedural-block"],
    ["BEGIN\n SELECT 1;\nEND;", "procedural-block"],
    ["label: BEGIN\n SELECT 1;\nEND;", "procedural-block"],
    ["label: FOR x IN (SELECT 1) DO\n SELECT x;\nEND FOR;", "procedural-block"],
    ["é: FOR x IN (SELECT 1) DO\n SELECT x;\nEND FOR;", "procedural-block"],
    ["𐐀: LOOP\n SELECT 1;\nEND LOOP;", "procedural-block"],
    ["`label`: LOOP\n SELECT 1;\nEND LOOP;", "procedural-block"],
    ["`label`: FOR x IN (SELECT 1) DO\n SELECT x;\nEND FOR;", "procedural-block"],
    ["CREATE PROCEDURE p() BEGIN SELECT 1; END", "procedural-block"],
    ["CREATE TEMP PROCEDURE p() BEGIN SELECT 1; END", "procedural-block"],
    ["CREATE OR REPLACE TEMP PROCEDURE p() BEGIN SELECT 1; END", "procedural-block"],
    ["BEGIN WORK;", "procedural-block"],
  ])("fails closed for %j", (text, reason) => {
    const index = buildSqlStatementIndex(text, BIGQUERY_SQL_LEXICAL_PROFILE);
    expect(index.quality).toBe("opaque");
    expect(index.slots).toHaveLength(1);
    expect(ranges(index)[0]).toMatchObject({
      extent: [0, text.length],
      quality: "opaque",
      reason,
    });
    expectPartition(text, index);
  });

  it.each(["BEGIN;", "BEGIN TRANSACTION;"])(
    "keeps documented transaction form %j exact",
    (text) => {
      const index = buildSqlStatementIndex(text, BIGQUERY_SQL_LEXICAL_PROFILE);
      expect(index.quality).toBe("exact");
      expect(index.slots).toHaveLength(2);
    },
  );

  it("preserves exact preceding slots before an opaque suffix", () => {
    const text = "SELECT 1; IF condition THEN SELECT 2; END IF;";
    const index = buildSqlStatementIndex(text, BIGQUERY_SQL_LEXICAL_PROFILE);
    expect(index.slots).toHaveLength(2);
    expect(itemAt(index.slots, 0).boundaryQuality).toBe("exact");
    expect(itemAt(index.slots, 1).boundaryQuality).toBe("opaque");
    expectPartition(text, index);
  });

  it.each([
    `CREATE FUNCTION f() RETURNS TABLE(x int)
LANGUAGE SQL
BEGIN /* body */ ATOMIC
  SELECT 1;
  SELECT 2;
END;
SELECT 3`,
    `CREATE OR REPLACE PROCEDURE p()
LANGUAGE SQL
BEGIN ATOMIC
  INSERT INTO t VALUES (1);
END;
SELECT 2`,
  ])("fails closed for PostgreSQL BEGIN ATOMIC routine bodies", (text) => {
    const index = buildSqlStatementIndex(
      text,
      POSTGRESQL_SQL_LEXICAL_PROFILE,
    );
    expect(index.quality).toBe("opaque");
    expect(index.slots).toHaveLength(1);
    expect(index.endState).toMatchObject({
      kind: "opaque",
      reason: "procedural-block",
    });
  });

  it.each([
    `CREATE FUNCTION begin.atomic()
RETURNS int
LANGUAGE SQL
RETURN 1;
SELECT 2`,
    `CREATE FUNCTION f(begin atomic)
RETURNS int
LANGUAGE SQL
RETURN 1;
SELECT 2`,
  ])("does not confuse routine header identifiers with BEGIN ATOMIC", (text) => {
    const index = buildSqlStatementIndex(
      text,
      POSTGRESQL_SQL_LEXICAL_PROFILE,
    );
    expect(index.quality).toBe("exact");
    expect(index.slots).toHaveLength(2);
    expect(exactSlot(itemAt(index.slots, 0)).terminator?.from).toBe(
      text.indexOf(";"),
    );
  });

  it("caps materialized slots under a semicolon storm", () => {
    const text = ";".repeat(MAX_SQL_STATEMENT_SLOTS + 100);
    const index = buildSqlStatementIndex(text, DUCKDB_SQL_LEXICAL_PROFILE);
    expect(index.slots).toHaveLength(MAX_SQL_STATEMENT_SLOTS);
    expect(index.quality).toBe("opaque");
    expect(index.slots.at(-1)).toMatchObject({
      boundaryQuality: "opaque",
      endState: { kind: "opaque", reason: "resource-limit" },
    });
    expectPartition(text, index);
  });

  it("bounds dollar-quote delimiter retention", () => {
    const text = `$${"a".repeat(300)}$payload`;
    const index = buildSqlStatementIndex(text, POSTGRESQL_SQL_LEXICAL_PROFILE);
    expect(index.quality).toBe("opaque");
    expect(index.endState).toMatchObject({
      kind: "opaque",
      reason: "resource-limit",
    });
  });

  it("does not degrade a long dollar-prefixed identifier without a delimiter", () => {
    const text = `$${"a".repeat(300)};SELECT 2`;
    const index = buildSqlStatementIndex(text, POSTGRESQL_SQL_LEXICAL_PROFILE);
    expect(index.quality).toBe("exact");
    expect(index.slots).toHaveLength(2);
  });
});

describe("incomplete input", () => {
  it.each([
    ["SELECT 'a;b", "single-quoted-string"],
    ['SELECT "a;b', "double-quoted-identifier"],
    ["SELECT $$a;b", "dollar-quoted-string"],
    ["SELECT 1 /* a;b", "block-comment"],
  ])("reports %s without exposing internal semicolons", (text, construct) => {
    const index = buildSqlStatementIndex(text, POSTGRESQL_SQL_LEXICAL_PROFILE);
    expect(index.slots).toHaveLength(1);
    expect(index.quality).toBe("exact");
    expect(index.endState).toMatchObject({
      construct,
      kind: "unterminated",
    });
    expectPartition(text, index);
  });

  it.each([
    ["SELECT `a;b", "backtick-quoted-identifier"],
    ["SELECT '''a;b", "triple-single-quoted-string"],
    ['SELECT """a;b', "triple-double-quoted-string"],
    ['SELECT "a;b', "double-quoted-string"],
  ])("reports BigQuery %s", (text, construct) => {
    const index = buildSqlStatementIndex(text, BIGQUERY_SQL_LEXICAL_PROFILE);
    expect(index.endState).toMatchObject({
      construct,
      kind: "unterminated",
    });
    expect(index.slots).toHaveLength(1);
  });

  it("fails closed when a regular BigQuery string crosses a line", () => {
    for (const text of [
      "SELECT 'a\n;b';SELECT 2",
      "SELECT 'a\\\n;b';SELECT 2",
      'SELECT "a\\\r\n;b";SELECT 2',
    ]) {
      const index = buildSqlStatementIndex(text, BIGQUERY_SQL_LEXICAL_PROFILE);
      expect(index.slots).toHaveLength(1);
      expect(index.endState).toMatchObject({
        kind: "unterminated",
      });
    }
  });

  it("keeps a comment-only unterminated slot code-free", () => {
    const index = buildSqlStatementIndex(
      "/* comment ;",
      DUCKDB_SQL_LEXICAL_PROFILE,
    );
    expect(exactSlot(itemAt(index.slots, 0)).hasCode).toBe(false);
  });
});

describe("source masking", () => {
  it("indexes analysis text while retaining original UTF-16 coordinates", () => {
    const originalText = 'SELECT * FROM {fn("a;b")}; SELECT 2';
    const embeddedFrom = originalText.indexOf("{");
    const embeddedTo = originalText.indexOf("}") + 1;
    const source = createMaskedSqlSource(originalText, [
      { from: embeddedFrom, language: "python", to: embeddedTo },
    ]);
    const index = buildSqlStatementIndex(
      source.analysisText,
      DUCKDB_SQL_LEXICAL_PROFILE,
    );

    expect(index.slots).toHaveLength(2);
    expect(exactSlot(itemAt(index.slots, 0)).terminator?.from).toBe(25);
    expect(source.originalText.slice(0, 26)).toBe(
      'SELECT * FROM {fn("a;b")};',
    );
    expectPartition(originalText, index);
  });
});

describe("deterministic properties", () => {
  it("never promotes protected generated semicolons to terminators", () => {
    const cases: readonly [
      SqlLexicalProfile,
      (payload: string) => string,
    ][] = [
      [POSTGRESQL_SQL_LEXICAL_PROFILE, (payload) => `'${payload}'`],
      [POSTGRESQL_SQL_LEXICAL_PROFILE, (payload) => `"${payload}"`],
      [POSTGRESQL_SQL_LEXICAL_PROFILE, (payload) => `$tag$${payload}$tag$`],
      [DUCKDB_SQL_LEXICAL_PROFILE, (payload) => `E'${payload}'`],
      [DUCKDB_SQL_LEXICAL_PROFILE, (payload) => `$d$${payload}$d$`],
      [BIGQUERY_SQL_LEXICAL_PROFILE, (payload) => `'${payload}'`],
      [BIGQUERY_SQL_LEXICAL_PROFILE, (payload) => `"""${payload}"""`],
      [BIGQUERY_SQL_LEXICAL_PROFILE, (payload) => `r'${payload}'`],
      [BIGQUERY_SQL_LEXICAL_PROFILE, (payload) => `\`${payload}\``],
      [DREMIO_SQL_LEXICAL_PROFILE, (payload) => `'${payload}'`],
      [DREMIO_SQL_LEXICAL_PROFILE, (payload) => `"${payload}"`],
    ];

    for (let length = 0; length < 40; length += 1) {
      const payload = `${"a".repeat(length)};${"b".repeat(39 - length)}`;
      for (const [profile, protect] of cases) {
        const text = `SELECT ${protect(payload)};SELECT 2`;
        const index = buildSqlStatementIndex(text, profile);
        expect(index.slots).toHaveLength(2);
        expect(exactSlot(itemAt(index.slots, 0)).terminator?.from).toBe(
          text.lastIndexOf(";"),
        );
      }
    }
  });

  it("always returns a total frozen partition and total cursor lookup", () => {
    let seed = 0x12_34_56_78;
    const next = (limit: number) => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed % limit;
    };
    const alphabet = [
      0,
      9,
      10,
      13,
      32,
      34,
      35,
      36,
      39,
      42,
      45,
      47,
      59,
      65,
      92,
      96,
      0xd800,
      0xdc00,
    ];
    const profiles: readonly SqlLexicalProfile[] = [
      POSTGRESQL_SQL_LEXICAL_PROFILE,
      DUCKDB_SQL_LEXICAL_PROFILE,
      BIGQUERY_SQL_LEXICAL_PROFILE,
      DREMIO_SQL_LEXICAL_PROFILE,
    ];

    for (let iteration = 0; iteration < 250; iteration += 1) {
      const codes = Array.from(
        { length: next(80) },
        () => itemAt(alphabet, next(alphabet.length)),
      );
      const text = String.fromCharCode(...codes);
      const index = buildSqlStatementIndex(
        text,
        itemAt(profiles, next(profiles.length)),
      );
      expectPartition(text, index);
      for (let position = 0; position <= text.length; position += 1) {
        expect(findSqlStatementSlot(index, position, "left")).toBeDefined();
        expect(findSqlStatementSlot(index, position, "right")).toBeDefined();
      }
      expect(
        ranges(buildSqlStatementIndex(text, itemAt(profiles, 0))),
      ).toEqual(
        ranges(buildSqlStatementIndex(text, itemAt(profiles, 0))),
      );
    }
  });

  it("scans a full-size plain document without proportional temporary records", () => {
    const text = "x".repeat(16 * 1024 * 1024);
    const index = buildSqlStatementIndex(text, DUCKDB_SQL_LEXICAL_PROFILE);
    expect(index.slots).toHaveLength(1);
    expect(exactSlot(itemAt(index.slots, 0)).source.to).toBe(text.length);
  });
});
