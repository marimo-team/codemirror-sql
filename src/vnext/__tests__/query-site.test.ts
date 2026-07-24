import { describe, expect, it } from "vitest";
import {
  MAX_QUERY_SITE_DEPTH,
  MAX_QUERY_SITE_IDENTIFIER_LENGTH,
  MAX_QUERY_SITE_LEXEMES,
  MAX_QUERY_SITE_STATEMENT_LENGTH,
  recognizeSqlRelationQuerySite,
  type SqlDecodedQueryPath,
  type SqlQuerySiteDialect,
  type SqlQuerySiteResult,
} from "../query-site.js";
import {
  createIdentitySqlSource,
  createMaskedSqlSource,
  type SqlSourceSnapshot,
} from "../source.js";
import {
  BIGQUERY_SQL_LEXICAL_PROFILE,
  buildSqlStatementIndex,
  DUCKDB_SQL_LEXICAL_PROFILE,
  findSqlStatementSlot,
  POSTGRESQL_SQL_LEXICAL_PROFILE,
} from "../statement-index.js";

function decodeSegment(raw: string, prefix = false): {
  readonly quoted: boolean;
  readonly value: string;
  readonly recovered: boolean;
} | null {
  if (raw.startsWith("\"")) {
    const closed = raw.endsWith("\"") && raw.length > 1;
    if (!closed && !prefix) {
      return null;
    }
    const content = raw.slice(1, closed ? -1 : undefined);
    return {
      quoted: true,
      recovered: !closed,
      value: content.replaceAll("\"\"", "\""),
    };
  }
  if (raw.length === 0 && prefix) {
    return { quoted: false, recovered: false, value: "" };
  }
  return /^[\p{L}_][\p{L}\p{N}_]*$/u.test(raw)
    ? { quoted: false, recovered: false, value: raw }
    : null;
}

function decodeStandardPath(
  rawPath: string,
  cursorOffset: number,
): SqlDecodedQueryPath {
  const rawSegments = rawPath.split(".");
  const qualifier = [];
  let segmentFrom = 0;
  for (let index = 0; index < rawSegments.length - 1; index += 1) {
    const raw = rawSegments[index] ?? "";
    const decoded = decodeSegment(raw);
    if (!decoded) {
      return { reason: "invalid-identifier", status: "unavailable" };
    }
    qualifier.push({ quoted: decoded.quoted, value: decoded.value });
    segmentFrom += raw.length + 1;
  }
  const finalRaw = rawSegments[rawSegments.length - 1] ?? "";
  const cursorInFinal = cursorOffset - segmentFrom;
  if (cursorInFinal < 0 || cursorInFinal > finalRaw.length) {
    return { reason: "invalid-identifier", status: "unavailable" };
  }
  let prefixRaw = finalRaw.slice(0, cursorInFinal);
  if (finalRaw.startsWith("\"") && finalRaw.endsWith("\"")) {
    prefixRaw = `${prefixRaw}"`;
  }
  const prefix = decodeSegment(prefixRaw, true);
  if (!prefix) {
    return { reason: "invalid-identifier", status: "unavailable" };
  }
  return {
    finalSegment: {
      from: segmentFrom,
      to: segmentFrom + finalRaw.length,
    },
    prefix: { quoted: prefix.quoted, value: prefix.value },
    qualifier,
    quality:
      prefix.recovered ||
      (finalRaw.startsWith("\"") && !finalRaw.endsWith("\""))
        ? "recovered"
        : "exact",
    status: "decoded",
  };
}

const postgresDialect: SqlQuerySiteDialect = {
  decodeRelationPath: decodeStandardPath,
  lexicalProfile: POSTGRESQL_SQL_LEXICAL_PROFILE,
};

const duckdbDialect: SqlQuerySiteDialect = {
  decodeRelationPath: decodeStandardPath,
  lexicalProfile: DUCKDB_SQL_LEXICAL_PROFILE,
};

const bigQueryDialect: SqlQuerySiteDialect = {
  decodeRelationPath: (rawPath, cursorOffset) => {
    if (!rawPath.startsWith("`")) {
      return decodeStandardPath(rawPath, cursorOffset);
    }
    const closed = rawPath.endsWith("`") && rawPath.length > 1;
    const contentTo = closed ? rawPath.length - 1 : rawPath.length;
    const cursorInContent = Math.max(1, Math.min(cursorOffset, contentTo));
    const beforeCursor = rawPath.slice(1, cursorInContent);
    const values = beforeCursor.split(".");
    const prefix = values.pop() ?? "";
    const finalFrom = beforeCursor.lastIndexOf(".") + 2;
    return {
      finalSegment: { from: finalFrom, to: contentTo },
      prefix: { quoted: true, value: prefix },
      qualifier: values.map((value) => ({ quoted: true, value })),
      quality: closed ? "exact" : "recovered",
      status: "decoded",
    };
  },
  lexicalProfile: BIGQUERY_SQL_LEXICAL_PROFILE,
};

function markedSource(marked: string): {
  readonly position: number;
  readonly text: string;
} {
  const position = marked.indexOf("|");
  if (position < 0 || marked.indexOf("|", position + 1) >= 0) {
    throw new Error("Query fixture requires exactly one cursor marker");
  }
  return {
    position,
    text: marked.slice(0, position) + marked.slice(position + 1),
  };
}

function recognize(
  marked: string,
  options: {
    readonly dialect?: SqlQuerySiteDialect;
    readonly regions?: readonly {
      readonly from: number;
      readonly language: string;
      readonly to: number;
    }[];
  } = {},
): SqlQuerySiteResult {
  const { position, text } = markedSource(marked);
  const source: SqlSourceSnapshot = options.regions
    ? createMaskedSqlSource(text, options.regions)
    : createIdentitySqlSource(text);
  const dialect = options.dialect ?? postgresDialect;
  const index = buildSqlStatementIndex(
    source.analysisText,
    dialect.lexicalProfile,
  );
  const slot = findSqlStatementSlot(
    index,
    position,
    position === 0 ? "right" : "left",
  );
  return recognizeSqlRelationQuerySite(source, slot, position, dialect);
}

function expectReady(
  result: SqlQuerySiteResult,
): Extract<SqlQuerySiteResult, { readonly status: "ready" }> {
  expect(result.status).toBe("ready");
  if (result.status !== "ready") {
    throw new Error(`Expected ready, received ${result.status}`);
  }
  return result;
}

describe("partial SELECT relation query sites", () => {
  it.each([
    ["SELECT * FROM |", "from"],
    ["SELECT * FROM users u JOIN |", "join"],
    ["SELECT * FROM users LEFT OUTER JOIN |", "join"],
    ["SELECT * FROM users, |", "comma"],
    ["SELECT * FROM a JOIN b ON a.id = b.id JOIN |", "join"],
    ["SELECT (SELECT * FROM |)", "from"],
    ["SELECT * FROM (SELECT * FROM |) q", "from"],
    ["SELECT * FROM /* closed */ |", "from"],
  ] as const)("recognizes %s", (marked, anchor) => {
    const result = expectReady(recognize(marked));
    expect(result.anchor).toBe(anchor);
    expect(result.prefix).toEqual({ quoted: false, value: "" });
    expect(result.recognition).toEqual({ issues: [], quality: "exact" });
  });

  it("returns decoded paths and statement-relative replacement ranges", () => {
    const result = expectReady(recognize("  SELECT * FROM schema.us|"));
    expect(result.qualifier).toEqual([{ quoted: false, value: "schema" }]);
    expect(result.prefix).toEqual({ quoted: false, value: "us" });
    expect(result.typedPathRange).toMatchObject({ from: 16, to: 25 });
    expect(result.finalSegmentRange).toMatchObject({ from: 23, to: 25 });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.qualifier)).toBe(true);
    expect(Object.isFrozen(result.prefix)).toBe(true);
  });

  it("authenticates the complete token when the cursor is mid-prefix", () => {
    const result = expectReady(recognize("SELECT * FROM schema.us|ers"));
    expect(result.prefix.value).toBe("us");
    expect(result.typedPathRange).toMatchObject({ from: 14, to: 26 });
    expect(result.finalSegmentRange).toMatchObject({ from: 21, to: 26 });
  });

  it("recognizes a trailing-dot empty prefix", () => {
    const result = expectReady(recognize("SELECT * FROM schema.|"));
    expect(result.qualifier).toEqual([{ quoted: false, value: "schema" }]);
    expect(result.prefix).toEqual({ quoted: false, value: "" });
  });

  it("recovers an incomplete quoted final identifier", () => {
    const result = expectReady(
      recognize("SELECT * FROM \"schema\".\"us|", {
        dialect: postgresDialect,
      }),
    );
    expect(result.qualifier).toEqual([{ quoted: true, value: "schema" }]);
    expect(result.prefix).toEqual({ quoted: true, value: "us" });
    expect(result.recognition).toEqual({
      issues: ["incomplete-identifier"],
      quality: "recovered",
    });
  });

  it("delegates whole-path BigQuery quotes to the dialect", () => {
    const result = expectReady(
      recognize("SELECT * FROM `project.dataset.us|", {
        dialect: bigQueryDialect,
      }),
    );
    expect(result.qualifier).toEqual([
      { quoted: true, value: "project" },
      { quoted: true, value: "dataset" },
    ]);
    expect(result.prefix).toEqual({ quoted: true, value: "us" });
    expect(result.recognition.quality).toBe("recovered");
  });

  it("supports DuckDB independently of parser compatibility", () => {
    expect(expectReady(recognize("SELECT * FROM main.us|", {
      dialect: duckdbDialect,
    })).prefix.value).toBe("us");
  });

  it.each([
    "SELECT -- FROM is trivia\n * FROM |",
    "SELECT /* nested /* FROM */ comment */ * FROM |",
    "SELECT $tag$FROM$tag$ FROM |",
  ])("shares PostgreSQL lexical handling for %s", (marked) => {
    expect(recognize(marked).status).toBe("ready");
  });

  it.each([
    "SELECT # FROM is trivia\n * FROM |",
    "SELECT 'FROM' FROM |",
    "SELECT r'FROM' FROM |",
    "SELECT '''FROM''' FROM |",
    "SELECT \"\"\"FROM\"\"\" FROM |",
  ])("shares BigQuery lexical handling for %s", (marked) => {
    expect(recognize(marked, { dialect: bigQueryDialect }).status).toBe(
      "ready",
    );
  });

  it.each([
    "SELECT * FROM users AS u JOIN |",
    "SELECT * FROM users AS \"u\" JOIN |",
    "SELECT * FROM users \"u\" JOIN |",
    "SELECT * FROM users INNER JOIN |",
    "SELECT * FROM users CROSS JOIN |",
    "SELECT * FROM users NATURAL JOIN |",
    "SELECT * FROM users RIGHT OUTER JOIN |",
    "SELECT * FROM users FULL OUTER JOIN |",
  ])("supports explicit join transitions in %s", (marked) => {
    expect(expectReady(recognize(marked)).anchor).toBe("join");
  });
});

describe("fail-closed query-site behavior", () => {
  it.each([
    ["SELECT x IS DISTINCT FROM |", "inactive"],
    ["SELECT substring(x FROM |)", "inactive"],
    ["SELECT extract(YEAR FROM |)", "inactive"],
    ["DELETE FROM |", "inactive"],
    ["COPY x FROM |", "inactive"],
    ["SELECT * FROM users alias |", "inactive"],
    ["SELECT * FROM (|", "unavailable"],
    ["SELECT * FROM fn(|", "unavailable"],
    ["SELECT * FROM 'not a relation' JOIN |", "unavailable"],
    ["SELECT * FROM , |", "unavailable"],
    ["SELECT * FROM schema..|", "unavailable"],
    ["SELECT * FROM a UNION SELECT * FROM |", "unavailable"],
    ["SELECT * FROM a QUALIFY x JOIN |", "unavailable"],
  ] as const)("does not invent a site for %s", (marked, status) => {
    expect(recognize(marked).status).toBe(status);
  });

  it("distinguishes cursors inside comments and strings", () => {
    expect(recognize("SELECT * FROM /* he|re */ users")).toEqual({
      reason: "cursor-in-comment",
      status: "inactive",
    });
    expect(recognize("SELECT '|FROM users'")).toEqual({
      reason: "cursor-in-string",
      status: "inactive",
    });
    expect(recognize("SELECT /* unclosed|")).toEqual({
      reason: "ambiguous-query-site",
      status: "unavailable",
    });
    expect(recognize("SELECT 'unclosed|")).toEqual({
      reason: "ambiguous-query-site",
      status: "unavailable",
    });
  });

  it.each([
    "SELECT * FROM users WHERE value JOIN |",
    "SELECT * FROM users GROUP BY value JOIN |",
    "SELECT * FROM users HAVING value JOIN |",
    "SELECT * FROM users ORDER BY value JOIN |",
    "SELECT * FROM users LIMIT value JOIN |",
    "SELECT * FROM users OFFSET value JOIN |",
    "SELECT * FROM users FETCH value JOIN |",
  ])("closes supported relation state after a later clause in %s", (marked) => {
    expect(recognize(marked).status).toBe("inactive");
  });

  it.each([
    "SELECT * FROM users OUTER JOIN |",
    "SELECT * FROM users LEFT RIGHT JOIN |",
    "SELECT * FROM users LEFT potato JOIN |",
    "SELECT * FROM users a b JOIN |",
    "SELECT * FROM users EXCEPT SELECT * FROM |",
    "SELECT * FROM users INTERSECT SELECT * FROM |",
    "SELECT * FROM users WINDOW value JOIN |",
  ])("makes ambiguous transitions unavailable in %s", (marked) => {
    expect(recognize(marked).status).toBe("unavailable");
  });

  it("suppresses the three-word IS NOT DISTINCT FROM expression", () => {
    expect(recognize("SELECT x IS NOT DISTINCT FROM |").status).toBe(
      "inactive",
    );
  });

  it("handles cursor and range input boundaries explicitly", () => {
    const source = createIdentitySqlSource("SELECT * FROM ");
    const index = buildSqlStatementIndex(
      source.analysisText,
      postgresDialect.lexicalProfile,
    );
    const slot = index.slots[0]!;
    expect(
      recognizeSqlRelationQuerySite(
        source,
        slot,
        Number.NaN,
        postgresDialect,
      ),
    ).toEqual({
      reason: "not-relation-position",
      status: "inactive",
    });
    expect(
      recognizeSqlRelationQuerySite(source, slot, -1, postgresDialect),
    ).toEqual({
      reason: "not-relation-position",
      status: "inactive",
    });
    expect(recognize("SELECT|")).toEqual({
      reason: "not-relation-position",
      status: "inactive",
    });
    expect(recognize("(|x) SELECT * FROM ")).toEqual({
      reason: "not-select-query",
      status: "inactive",
    });
    expect(recognize("(+ x) |")).toEqual({
      reason: "not-select-query",
      status: "inactive",
    });
    expect(recognize("((SELECT * FROM x)) |")).toEqual({
      reason: "not-relation-position",
      status: "inactive",
    });
    expect(recognize("an_identifier_longer_than_sixteen|")).toEqual({
      reason: "not-select-query",
      status: "inactive",
    });
  });

  it("validates every dialect-decoder result before branding ranges", () => {
    const dialectWith = (
      decodeRelationPath: SqlQuerySiteDialect["decodeRelationPath"],
    ): SqlQuerySiteDialect => ({
      decodeRelationPath,
      lexicalProfile: POSTGRESQL_SQL_LEXICAL_PROFILE,
    });
    expect(
      recognize("SELECT * FROM x|", {
        dialect: dialectWith(() => ({
          reason: "undecodable-identifier",
          status: "unavailable",
        })),
      }),
    ).toEqual({
      reason: "ambiguous-query-site",
      status: "unavailable",
    });
    expect(
      recognize("SELECT * FROM x|", {
        dialect: dialectWith(() => ({
          finalSegment: { from: 0, to: 1 },
          prefix: { quoted: false, value: "x" },
          qualifier: Array.from({ length: 4 }, () => ({
            quoted: false,
            value: "q",
          })),
          quality: "exact",
          status: "decoded",
        })),
      }),
    ).toEqual({
      reason: "resource-limit",
      resource: "identifier-path",
      status: "unavailable",
    });
    expect(
      recognize("SELECT * FROM x|", {
        dialect: dialectWith(() => ({
          finalSegment: { from: -1, to: 1 },
          prefix: { quoted: false, value: "x" },
          qualifier: [],
          quality: "exact",
          status: "decoded",
        })),
      }),
    ).toEqual({
      reason: "ambiguous-query-site",
      status: "unavailable",
    });
  });

  it("reports opaque statement boundaries", () => {
    const { position, text } = markedSource("DELIMITER // SELECT * FROM |");
    const source = createIdentitySqlSource(text);
    const index = buildSqlStatementIndex(
      source.analysisText,
      POSTGRESQL_SQL_LEXICAL_PROFILE,
    );
    const result = recognizeSqlRelationQuerySite(
      source,
      findSqlStatementSlot(index, position, "left"),
      position,
      postgresDialect,
    );
    expect(result).toEqual({
      reason: "opaque-statement",
      status: "unavailable",
    });
  });
});

describe("embedded-region barriers", () => {
  it("leaves completion inside a region to the host language", () => {
    expect(
      recognize("SELECT * FROM {d|f}", {
        regions: [{ from: 14, language: "python", to: 18 }],
      }),
    ).toEqual({
      reason: "cursor-in-embedded-region",
      status: "inactive",
    });
  });

  it("recovers only after a visible supported anchor", () => {
    const joined = expectReady(
      recognize("SELECT * FROM {df} JOIN |", {
        regions: [{ from: 14, language: "python", to: 18 }],
      }),
    );
    expect(joined.recognition).toEqual({
      issues: ["opaque-template-context"],
      quality: "recovered",
    });

    const selected = expectReady(
      recognize("SELECT {expr} FROM |", {
        regions: [{ from: 7, language: "python", to: 13 }],
      }),
    );
    expect(selected.recognition.quality).toBe("recovered");

    const prefixed = expectReady(
      recognize("SELECT {expr} FROM us|", {
        regions: [{ from: 7, language: "python", to: 13 }],
      }),
    );
    expect(prefixed.recognition).toEqual({
      issues: ["opaque-template-context"],
      quality: "recovered",
    });
  });

  it("fails closed when a barrier occupies an alias position", () => {
    expect(
      recognize("SELECT * FROM users AS {x} JOIN |", {
        regions: [{ from: 23, language: "python", to: 26 }],
      }).status,
    ).toBe("unavailable");
    expect(
      recognize("{x} SELECT * FROM |", {
        regions: [{ from: 0, language: "python", to: 3 }],
      }).status,
    ).toBe("inactive");
  });

  it("keeps unsupported derived-relation continuations unavailable", () => {
    expect(
      recognize("SELECT * FROM users (x) JOIN |").status,
    ).toBe("unavailable");
  });

  it("never authenticates a path across a barrier", () => {
    expect(
      recognize("SELECT * FROM sch{x}.us|", {
        regions: [{ from: 17, language: "python", to: 20 }],
      }).status,
    ).not.toBe("ready");
  });
});

describe("query-site resource limits", () => {
  it("bounds the active statement", () => {
    const marked = `SELECT * FROM ${"x".repeat(
      MAX_QUERY_SITE_STATEMENT_LENGTH,
    )}|`;
    expect(recognize(marked)).toEqual({
      reason: "resource-limit",
      resource: "active-statement",
      status: "unavailable",
    });
  });

  it("bounds lexical work and parenthesis depth", () => {
    const tokens = `SELECT ${"x+".repeat(MAX_QUERY_SITE_LEXEMES / 2 + 1)} FROM |`;
    expect(recognize(tokens)).toEqual({
      reason: "resource-limit",
      resource: "lexical-token",
      status: "unavailable",
    });
    const nested = `${"(".repeat(MAX_QUERY_SITE_DEPTH + 1)}SELECT * FROM |`;
    expect(recognize(nested)).toEqual({
      reason: "resource-limit",
      resource: "parenthesis-depth",
      status: "unavailable",
    });
  });

  it("bounds path depth and decoded identifier length", () => {
    expect(recognize("SELECT * FROM a.b.c.d.e|")).toEqual({
      reason: "resource-limit",
      resource: "identifier-path",
      status: "unavailable",
    });
    expect(
      recognize(`SELECT * FROM ${"x".repeat(
        MAX_QUERY_SITE_IDENTIFIER_LENGTH + 1,
      )}|`),
    ).toEqual({
      reason: "resource-limit",
      resource: "identifier-segment",
      status: "unavailable",
    });
  });
});

describe("query-site invariants", () => {
  it("keeps every ready range inside its exact statement under fuzzed input", () => {
    let state = 0x5eed1234;
    const random = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    const alphabet = [
      " ",
      "\n",
      "'",
      "\"",
      "$",
      "(",
      ")",
      ",",
      ".",
      "/",
      "-",
      "*",
      "_",
      "a",
      "F",
      "0",
      "😀",
    ];

    for (let fixture = 0; fixture < 200; fixture += 1) {
      let text = "";
      const length = 32 + (random() % 160);
      for (let index = 0; index < length; index += 1) {
        text += alphabet[random() % alphabet.length];
      }
      const source = createIdentitySqlSource(text);
      const index = buildSqlStatementIndex(
        source.analysisText,
        postgresDialect.lexicalProfile,
      );
      for (let sample = 0; sample < 3; sample += 1) {
        const position = random() % (text.length + 1);
        const slot = findSqlStatementSlot(
          index,
          position,
          position === 0 ? "right" : "left",
        );
        const result = recognizeSqlRelationQuerySite(
          source,
          slot,
          position,
          postgresDialect,
        );
        if (result.status !== "ready" || slot.boundaryQuality !== "exact") {
          continue;
        }
        const statementLength = slot.source.to - slot.source.from;
        expect(result.typedPathRange.from).toBeGreaterThanOrEqual(0);
        expect(result.typedPathRange.to).toBeLessThanOrEqual(statementLength);
        expect(result.finalSegmentRange.from).toBeGreaterThanOrEqual(
          result.typedPathRange.from,
        );
        expect(result.finalSegmentRange.to).toBeLessThanOrEqual(
          result.typedPathRange.to,
        );
        expect(Object.isFrozen(result.recognition.issues)).toBe(true);
      }
    }
  });

  it("is invariant to supported keyword casing and closed leading trivia", () => {
    const variants = [
      "SELECT * FROM schema.us|",
      "select * from schema.us|",
      "SeLeCt * FrOm schema.us|",
      "-- lead\nSELECT /* select */ * FROM schema.us|",
    ];
    const results = variants.map((variant) => expectReady(recognize(variant)));
    for (const result of results) {
      expect(result.qualifier).toEqual([{ quoted: false, value: "schema" }]);
      expect(result.prefix).toEqual({ quoted: false, value: "us" });
      expect(result.recognition.quality).toBe("exact");
    }
  });
});
