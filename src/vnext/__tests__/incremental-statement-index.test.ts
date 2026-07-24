import { describe, expect, it } from "vitest";
import {
  BIGQUERY_SQL_LEXICAL_PROFILE,
  buildSqlStatementIndex,
  DREMIO_SQL_LEXICAL_PROFILE,
  DUCKDB_SQL_LEXICAL_PROFILE,
  MAX_SQL_STATEMENT_SLOTS,
  POSTGRESQL_SQL_LEXICAL_PROFILE,
  type SqlLexicalProfile,
  type SqlStatementIndex,
  type SqlStatementSlot,
  updateSqlStatementIndex,
} from "../statement-index.js";
import type { SqlTextChange } from "../types.js";

const PROFILES = [
  { name: "PostgreSQL", profile: POSTGRESQL_SQL_LEXICAL_PROFILE },
  { name: "DuckDB", profile: DUCKDB_SQL_LEXICAL_PROFILE },
  { name: "BigQuery", profile: BIGQUERY_SQL_LEXICAL_PROFILE },
  { name: "Dremio", profile: DREMIO_SQL_LEXICAL_PROFILE },
] as const;

function itemAt<Value>(items: readonly Value[], index: number): Value {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`Expected test item at index ${index}`);
  }
  return item;
}

function applyChanges(
  text: string,
  changes: readonly SqlTextChange[],
): string {
  let cursor = 0;
  const output: string[] = [];
  for (const change of changes) {
    output.push(text.slice(cursor, change.from), change.insert);
    cursor = change.to;
  }
  output.push(text.slice(cursor));
  return output.join("");
}

function replaceFirst(
  text: string,
  search: string,
  insert: string,
): SqlTextChange {
  const from = text.indexOf(search);
  if (from < 0) {
    throw new Error(`Expected ${JSON.stringify(search)} in test SQL`);
  }
  return { from, insert, to: from + search.length };
}

function replaceLast(
  text: string,
  search: string,
  insert: string,
): SqlTextChange {
  const from = text.lastIndexOf(search);
  if (from < 0) {
    throw new Error(`Expected ${JSON.stringify(search)} in test SQL`);
  }
  return { from, insert, to: from + search.length };
}

function expectDeepFrozen(index: SqlStatementIndex): void {
  expect(Object.isFrozen(index)).toBe(true);
  expect(Object.isFrozen(index.slots)).toBe(true);
  for (const slot of index.slots) {
    expect(Object.isFrozen(slot)).toBe(true);
    expect(Object.isFrozen(slot.extent)).toBe(true);
    expect(Object.isFrozen(slot.endState)).toBe(true);
    if (slot.boundaryQuality === "exact") {
      expect(Object.isFrozen(slot.source)).toBe(true);
      if (slot.terminator) {
        expect(Object.isFrozen(slot.terminator)).toBe(true);
      }
    }
  }
}

function expectIncrementalMatchesOracle(
  previousText: string,
  changes: readonly SqlTextChange[],
  profile: SqlLexicalProfile,
): {
  readonly nextIndex: SqlStatementIndex;
  readonly nextText: string;
  readonly previousIndex: SqlStatementIndex;
} {
  const previousIndex = buildSqlStatementIndex(previousText, profile);
  const nextText = applyChanges(previousText, changes);
  const nextIndex = updateSqlStatementIndex(
    previousIndex,
    nextText,
    changes,
    profile,
  );
  expect(nextIndex).toEqual(buildSqlStatementIndex(nextText, profile));
  expectDeepFrozen(nextIndex);
  return { nextIndex, nextText, previousIndex };
}

function expectSlot(
  slots: readonly SqlStatementSlot[],
  index: number,
): SqlStatementSlot {
  return itemAt(slots, index);
}

describe("incremental statement index lexical transitions", () => {
  const cases: readonly {
    readonly change: (text: string) => SqlTextChange;
    readonly name: string;
    readonly previousText: string;
    readonly profile: SqlLexicalProfile;
  }[] = [
    {
      change: (text) => replaceFirst(text, "b;", "b';"),
      name: "PostgreSQL closes an escape string",
      previousText: "SELECT E'a;b; SELECT 2",
      profile: POSTGRESQL_SQL_LEXICAL_PROFILE,
    },
    {
      change: (text) => replaceLast(text, "$tag$", ""),
      name: "PostgreSQL opens a tagged dollar quote",
      previousText: "SELECT $tag$a;b$tag$; SELECT 2",
      profile: POSTGRESQL_SQL_LEXICAL_PROFILE,
    },
    {
      change: (text) => ({
        from: text.length,
        insert: " */; SELECT 3",
        to: text.length,
      }),
      name: "DuckDB closes a nested block comment",
      previousText: "SELECT 1 /* outer /* inner */ ; SELECT 2",
      profile: DUCKDB_SQL_LEXICAL_PROFILE,
    },
    {
      change: (text) => replaceFirst(text, "$d$", ""),
      name: "DuckDB removes a dollar-quote opener",
      previousText: "SELECT $d$a;b$d$; SELECT 2",
      profile: DUCKDB_SQL_LEXICAL_PROFILE,
    },
    {
      change: (text) => ({
        from: text.length,
        insert: '"""; SELECT 3',
        to: text.length,
      }),
      name: "BigQuery closes a raw triple-quoted string",
      previousText: 'SELECT r"""a;b; SELECT 2',
      profile: BIGQUERY_SQL_LEXICAL_PROFILE,
    },
    {
      change: (text) => replaceFirst(text, "#", ""),
      name: "BigQuery removes a hash-comment opener",
      previousText: "SELECT 1 # hidden; still hidden\nSELECT 2",
      profile: BIGQUERY_SQL_LEXICAL_PROFILE,
    },
    {
      change: (text) => replaceFirst(text, "b;", "b';"),
      name: "Dremio closes a standard string",
      previousText: "SELECT 'a;b; SELECT 2",
      profile: DREMIO_SQL_LEXICAL_PROFILE,
    },
    {
      change: (text) => replaceFirst(text, "/*", ""),
      name: "Dremio removes a block-comment opener",
      previousText: "SELECT 1 /* hidden; */ SELECT 2; SELECT 3",
      profile: DREMIO_SQL_LEXICAL_PROFILE,
    },
  ];

  it.each(cases)("$name", ({ change, previousText, profile }) => {
    expectIncrementalMatchesOracle(previousText, [change(previousText)], profile);
  });
});

describe("incremental statement index edit boundaries", () => {
  it.each(PROFILES)(
    "handles empty documents, statement boundaries, and EOF for $name",
    ({ profile }) => {
      let text = "";
      let index = buildSqlStatementIndex(text, profile);
      const edits: readonly SqlTextChange[][] = [
        [{ from: 0, insert: ";", to: 0 }],
        [{ from: 1, insert: "SELECT 1;", to: 1 }],
        [{ from: 1, insert: "\n", to: 1 }],
        [{ from: 10, insert: "", to: 11 }],
        [{ from: 0, insert: "", to: 1 }],
      ];

      for (const changes of edits) {
        const nextText = applyChanges(text, changes);
        index = updateSqlStatementIndex(index, nextText, changes, profile);
        expect(index).toEqual(buildSqlStatementIndex(nextText, profile));
        text = nextText;
      }
    },
  );

  it.each(PROFILES)(
    "matches a full scan after ordered multi-edits for $name",
    ({ profile }) => {
      const text = "SELECT 1; SELECT 2; SELECT 3;";
      const changes: readonly SqlTextChange[] = [
        { from: 0, insert: "-- lead\n", to: 0 },
        {
          from: text.indexOf("2"),
          insert: "'x;y'",
          to: text.indexOf("2") + 1,
        },
        { from: text.length - 1, insert: "", to: text.length },
      ];
      expectIncrementalMatchesOracle(text, changes, profile);
    },
  );

  it("falls back to the oracle for inconsistent trusted-change metadata", () => {
    const profile = DUCKDB_SQL_LEXICAL_PROFILE;
    const previousText = "SELECT 1; SELECT 2";
    const previousIndex = buildSqlStatementIndex(previousText, profile);
    const nextText = "SELECT 10; SELECT 2";
    const inconsistentChanges = [
      { from: 7, insert: "10", to: 8 },
      { from: 4, insert: "x", to: 4 },
    ];
    const nextIndex = updateSqlStatementIndex(
      previousIndex,
      nextText,
      inconsistentChanges,
      profile,
    );
    expect(nextIndex).toEqual(buildSqlStatementIndex(nextText, profile));
  });
});

describe("incremental statement index opaque and bounded results", () => {
  it("transitions from a BigQuery procedural opaque suffix to exact slots", () => {
    const text = "SELECT 1; BEGIN WORK; SELECT 2";
    const change = replaceFirst(text, "BEGIN WORK", "SELECT 0");
    const { nextIndex, previousIndex } = expectIncrementalMatchesOracle(
      text,
      [change],
      BIGQUERY_SQL_LEXICAL_PROFILE,
    );
    expect(previousIndex.quality).toBe("opaque");
    expect(nextIndex.quality).toBe("exact");
  });

  it("transitions from exact PostgreSQL SQL to an opaque routine body", () => {
    const text =
      "CREATE FUNCTION f() RETURNS int LANGUAGE SQL RETURN 1; SELECT 2";
    const change = replaceFirst(text, "RETURN 1", "BEGIN ATOMIC SELECT 1");
    const { nextIndex, previousIndex } = expectIncrementalMatchesOracle(
      text,
      [change],
      POSTGRESQL_SQL_LEXICAL_PROFILE,
    );
    expect(previousIndex.quality).toBe("exact");
    expect(nextIndex.quality).toBe("opaque");
    expect(nextIndex.endState).toMatchObject({
      kind: "opaque",
      reason: "procedural-block",
    });
  });

  it("recomputes a BigQuery custom-delimiter opaque result", () => {
    const text = "SELECT 1; DELIMITER $$\nSELECT 2$$";
    const change = replaceFirst(text, "DELIMITER", "SELECT");
    const { nextIndex, previousIndex } = expectIncrementalMatchesOracle(
      text,
      [change],
      BIGQUERY_SQL_LEXICAL_PROFILE,
    );
    expect(previousIndex.quality).toBe("opaque");
    expect(nextIndex).toEqual(
      buildSqlStatementIndex(
        applyChanges(text, [change]),
        BIGQUERY_SQL_LEXICAL_PROFILE,
      ),
    );
  });

  it("matches the capped oracle when edits change a semicolon storm", () => {
    const text = ";".repeat(MAX_SQL_STATEMENT_SLOTS + 100);
    const changes = [
      { from: 1, insert: "SELECT 1;", to: 1 },
      {
        from: MAX_SQL_STATEMENT_SLOTS - 2,
        insert: "",
        to: MAX_SQL_STATEMENT_SLOTS + 2,
      },
    ];
    const { nextIndex, previousIndex } = expectIncrementalMatchesOracle(
      text,
      changes,
      DUCKDB_SQL_LEXICAL_PROFILE,
    );
    expect(previousIndex.slots).toHaveLength(MAX_SQL_STATEMENT_SLOTS);
    expect(nextIndex.slots).toHaveLength(MAX_SQL_STATEMENT_SLOTS);
    expect(nextIndex.endState).toMatchObject({
      kind: "opaque",
      reason: "resource-limit",
    });
  });

  it("recovers from a resource-limited suffix after separators are removed", () => {
    const text = ";".repeat(MAX_SQL_STATEMENT_SLOTS + 5);
    const changes = [
      {
        from: 0,
        insert: "",
        to: 10,
      },
    ];
    const { nextIndex, previousIndex } = expectIncrementalMatchesOracle(
      text,
      changes,
      DUCKDB_SQL_LEXICAL_PROFILE,
    );
    expect(previousIndex.quality).toBe("opaque");
    expect(nextIndex.quality).toBe("exact");
    expect(nextIndex.slots).toHaveLength(
      MAX_SQL_STATEMENT_SLOTS - 4,
    );
  });

  it("matches the resource-limited dollar-delimiter oracle", () => {
    const text = `SELECT 1; $${"a".repeat(300)}$payload`;
    const change = replaceFirst(text, "SELECT 1", "SELECT 100");
    const { nextIndex } = expectIncrementalMatchesOracle(
      text,
      [change],
      POSTGRESQL_SQL_LEXICAL_PROFILE,
    );
    expect(nextIndex.endState).toMatchObject({
      kind: "opaque",
      reason: "resource-limit",
    });
  });
});

describe("incremental statement index reuse", () => {
  it.each(PROFILES)(
    "returns the previous index for an unchanged $name document",
    ({ profile }) => {
      const text = "SELECT 1; SELECT 2";
      const previousIndex = buildSqlStatementIndex(text, profile);
      expect(updateSqlStatementIndex(previousIndex, text, [], profile)).toBe(
        previousIndex,
      );
    },
  );

  it("reuses unchanged prefix and zero-delta suffix slot identities", () => {
    const profile = DUCKDB_SQL_LEXICAL_PROFILE;
    const text = "SELECT 1; SELECT 2; SELECT 3";
    const change = replaceFirst(text, "2", "9");
    const { nextIndex, previousIndex } = expectIncrementalMatchesOracle(
      text,
      [change],
      profile,
    );
    expect(expectSlot(nextIndex.slots, 0)).toBe(
      expectSlot(previousIndex.slots, 0),
    );
    expect(expectSlot(nextIndex.slots, 1)).not.toBe(
      expectSlot(previousIndex.slots, 1),
    );
    expect(expectSlot(nextIndex.slots, 2)).toBe(
      expectSlot(previousIndex.slots, 2),
    );
  });

  it("creates deeply frozen shifted suffixes for non-zero deltas", () => {
    const profile = POSTGRESQL_SQL_LEXICAL_PROFILE;
    const text = "SELECT 1; SELECT 'unterminated";
    const change = replaceFirst(text, "1", "1000");
    const { nextIndex, previousIndex } = expectIncrementalMatchesOracle(
      text,
      [change],
      profile,
    );
    const previousSuffix = expectSlot(previousIndex.slots, 1);
    const nextSuffix = expectSlot(nextIndex.slots, 1);
    expect(nextSuffix).not.toBe(previousSuffix);
    expect(nextSuffix.extent.from).toBe(previousSuffix.extent.from + 3);
    expect(nextSuffix.extent.to).toBe(previousSuffix.extent.to + 3);
    expect(nextSuffix.endState).toMatchObject({
      from:
        previousSuffix.endState.kind === "unterminated"
          ? previousSuffix.endState.from + 3
          : undefined,
      kind: "unterminated",
    });
    expectDeepFrozen(nextIndex);
  });
});

describe("incremental statement index deterministic differential sequences", () => {
  it.each(PROFILES)(
    "matches the full oracle through randomized edits for $name",
    ({ name, profile }) => {
      let seed =
        0x51_7a_2d_09 ^
        Array.from(name).reduce(
          (value, character) => value + character.charCodeAt(0),
          0,
        );
      const next = (limit: number): number => {
        seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
        return seed % limit;
      };
      const fragments = [
        "",
        ";",
        "'",
        '"',
        "`",
        "$tag$",
        "/*",
        "*/",
        "--",
        "#",
        "\n",
        "\\",
        "BEGIN",
        " ATOMIC",
        "DELIMITER $$",
        "E'",
        "r'''",
        "𐐀",
      ] as const;

      let text =
        "SELECT E'a;b'; SELECT $tag$c;d$tag$; SELECT r'''e;f'''; " +
        "SELECT `g;h`; /* i;j */ SELECT 5";
      let index = buildSqlStatementIndex(text, profile);

      for (let iteration = 0; iteration < 120; iteration += 1) {
        const changeCount = 1 + next(3);
        const points = Array.from(
          { length: changeCount * 2 },
          () => next(text.length + 1),
        ).sort((left, right) => left - right);
        const changes: SqlTextChange[] = [];
        for (let changeIndex = 0; changeIndex < changeCount; changeIndex += 1) {
          const from = itemAt(points, changeIndex * 2);
          const to = itemAt(points, changeIndex * 2 + 1);
          const insert =
            text.length > 500
              ? ""
              : itemAt(fragments, next(fragments.length));
          changes.push({ from, insert, to });
        }

        const nextText = applyChanges(text, changes);
        index = updateSqlStatementIndex(index, nextText, changes, profile);
        expect(
          index,
          `${name} differential mismatch at iteration ${iteration}`,
        ).toEqual(buildSqlStatementIndex(nextText, profile));
        expectDeepFrozen(index);
        text = nextText;
      }
    },
  );
});
