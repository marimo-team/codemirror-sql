import { describe, expect, it } from "vitest";
import {
  MAX_QUERY_SITE_DEPTH,
  MAX_QUERY_SITE_IDENTIFIER_LENGTH,
  MAX_QUERY_SITE_LEXEMES,
  MAX_QUERY_SITE_PATH_COMPONENTS,
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
  return /^[\p{L}_][\p{L}\p{N}_$]*$/u.test(raw)
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

function classifyRelationAlias(
  rawAlias: string,
  quoted: boolean,
):
  | {
      readonly status: "identifier";
      readonly value: string;
    }
  | {
      readonly status: "unsupported";
    } {
  if (quoted) {
    const delimiter = rawAlias.at(0) ?? "";
    const value = rawAlias
      .slice(1, -1)
      .replaceAll(`${delimiter}${delimiter}`, delimiter);
    return value.length > 0
      ? { status: "identifier", value }
      : { status: "unsupported" };
  }
  const word = rawAlias.toLowerCase();
  const unsupported =
    word === "assert_rows_modified" ||
    word === "as" ||
    word === "cross" ||
    word === "except" ||
    word === "fetch" ||
    word === "for" ||
    word === "from" ||
    word === "full" ||
    word === "group" ||
    word === "having" ||
    word === "inner" ||
    word === "intersect" ||
    word === "join" ||
    word === "lateral" ||
    word === "left" ||
    word === "limit" ||
    word === "match_recognize" ||
    word === "natural" ||
    word === "on" ||
    word === "offset" ||
    word === "order" ||
    word === "outer" ||
    word === "pivot" ||
    word === "qualify" ||
    word === "right" ||
    word === "select" ||
    word === "tablesample" ||
    word === "unpivot" ||
    word === "union" ||
    word === "using" ||
    word === "where" ||
    word === "window";
  return unsupported
    ? { status: "unsupported" }
    : { status: "identifier", value: rawAlias };
}

const postgresDialect: SqlQuerySiteDialect = {
  classifyRelationAlias,
  decodeRelationPath: decodeStandardPath,
  lexicalProfile: POSTGRESQL_SQL_LEXICAL_PROFILE,
  maximumPathDepth: 4,
  supportsNaturalJoin: true,
};

const duckdbDialect: SqlQuerySiteDialect = {
  classifyRelationAlias,
  decodeRelationPath: decodeStandardPath,
  lexicalProfile: DUCKDB_SQL_LEXICAL_PROFILE,
  maximumPathDepth: 16,
  supportsNaturalJoin: true,
};

const bigQueryDialect: SqlQuerySiteDialect = {
  classifyRelationAlias,
  decodeRelationPath: (rawPath, cursorOffset) => {
    if (!rawPath.startsWith("`")) {
      if (!rawPath.includes("-")) {
        return decodeStandardPath(rawPath, cursorOffset);
      }
      const segments = rawPath.split(".");
      const finalRaw = segments.pop() ?? "";
      const segmentFrom = rawPath.length - finalRaw.length;
      const cursorInFinal = cursorOffset - segmentFrom;
      if (
        cursorInFinal < 0 ||
        cursorInFinal > finalRaw.length ||
        !/^[\p{L}_][\p{L}\p{N}_-]*$/u.test(segments[0] ?? "") ||
        segments.slice(1).some((segment) => !decodeSegment(segment))
      ) {
        return { reason: "invalid-identifier", status: "unavailable" };
      }
      const prefix = decodeSegment(finalRaw.slice(0, cursorInFinal), true);
      if (!prefix) {
        return { reason: "invalid-identifier", status: "unavailable" };
      }
      return {
        finalSegment: { from: segmentFrom, to: rawPath.length },
        prefix: { quoted: prefix.quoted, value: prefix.value },
        qualifier: segments.map((value) => ({ quoted: false, value })),
        quality: "exact",
        status: "decoded",
      };
    }
    const closed = rawPath.endsWith("`") && rawPath.length > 1;
    const contentTo = closed ? rawPath.length - 1 : rawPath.length;
    const content = rawPath.slice(1, contentTo);
    const lastDot = content.lastIndexOf(".");
    const finalFrom = lastDot + 2;
    const cursorInContent = Math.min(cursorOffset, contentTo) - 1;
    if (cursorInContent < finalFrom - 1) {
      return { reason: "invalid-identifier", status: "unavailable" };
    }
    const qualifier =
      lastDot < 0
        ? []
        : content
            .slice(0, lastDot)
            .split(".")
            .map((value) => ({ quoted: true, value }));
    const prefix = content.slice(finalFrom - 1, cursorInContent);
    return {
      finalSegment: { from: finalFrom, to: rawPath.length },
      prefix: { quoted: true, value: prefix },
      qualifier,
      quality: closed ? "exact" : "recovered",
      status: "decoded",
    };
  },
  lexicalProfile: BIGQUERY_SQL_LEXICAL_PROFILE,
  maximumPathDepth: 3,
  supportsNaturalJoin: false,
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
    ["SELECT * FROM |, other", "from"],
    ["SELECT * FROM a, |, b", "comma"],
    ["SELECT * FROM a JOIN |, b", "join"],
    ["SELECT * FROM a JOIN b ON a.id = b.id JOIN |", "join"],
    ["SELECT * FROM a JOIN b ON true LEFT JOIN |", "join"],
    ["SELECT * FROM a JOIN b ON true LEFT OUTER JOIN |", "join"],
    ["SELECT * FROM a JOIN b ON true RIGHT OUTER JOIN |", "join"],
    ["SELECT * FROM a JOIN b ON true FULL OUTER JOIN |", "join"],
    [
      "SELECT * FROM a JOIN b ON LEFT(a.name, 1) = 'x' LEFT JOIN |",
      "join",
    ],
    [
      "SELECT * FROM a JOIN b ON RIGHT(a.name, 1) = 'x' CROSS JOIN |",
      "join",
    ],
    ["SELECT * FROM a JOIN b ON a.id=b.id, |", "comma"],
    ["SELECT * FROM a JOIN b USING(id), |", "comma"],
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

  it("authenticates the complete path before returning a replacement", () => {
    expect(recognize("SELECT * FROM sch|ema.users").status).toBe(
      "unavailable",
    );
    expect(recognize("SELECT * FROM schema|.users").status).toBe(
      "unavailable",
    );
    const result = expectReady(recognize("SELECT * FROM schema.|users"));
    expect(result.prefix).toEqual({ quoted: false, value: "" });
    expect(result.typedPathRange).toMatchObject({ from: 14, to: 26 });
  });

  it("recognizes a trailing-dot empty prefix", () => {
    const result = expectReady(recognize("SELECT * FROM schema.|"));
    expect(result.qualifier).toEqual([{ quoted: false, value: "schema" }]);
    expect(result.prefix).toEqual({ quoted: false, value: "" });
  });

  it.each([
    "SELECT * FROM schema.| JOIN other ON true",
    "SELECT * FROM schema.| WHERE true",
    "SELECT * FROM schema.| /*c*/ JOIN other ON true",
    "SELECT * FROM schema.|)",
    "SELECT * FROM schema.|, other",
  ])("recognizes a trailing-dot site before an authenticated suffix in %s", (marked) => {
    const result = expectReady(recognize(marked));
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
    expect(
      recognize("SELECT * FROM `project.|dataset.us`", {
        dialect: bigQueryDialect,
      }).status,
    ).toBe("unavailable");
    expect(
      recognize("SELECT * FROM `project.dataset.us`|", {
        dialect: bigQueryDialect,
      }).status,
    ).toBe("ready");
  });

  it("supports DuckDB independently of parser compatibility", () => {
    expect(expectReady(recognize("SELECT * FROM main.us|", {
      dialect: duckdbDialect,
    })).prefix.value).toBe("us");
  });

  it("collects a bounded dialect-neutral identifier superset", () => {
    expect(
      expectReady(recognize("SELECT * FROM foo$use|r")).prefix.value,
    ).toBe("foo$use");
    expect(
      expectReady(
        recognize("SELECT * FROM my-project.dataset.ta|", {
          dialect: bigQueryDialect,
        }),
      ).qualifier,
    ).toEqual([
      { quoted: false, value: "my-project" },
      { quoted: false, value: "dataset" },
    ]);
    expect(
      recognize("SELECT * FROM a.b.c.d.e.f|", {
        dialect: duckdbDialect,
      }).status,
    ).toBe("ready");
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
    "SELECT 'one''two' FROM |",
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
    "SELECT * FROM users AS \"LEFT\" JOIN |",
    "SELECT * FROM users \"u\" JOIN |",
    "SELECT * FROM users INNER JOIN |",
    "SELECT * FROM users CROSS JOIN |",
    "SELECT * FROM users NATURAL JOIN |",
    "SELECT * FROM users NATURAL INNER JOIN |",
    "SELECT * FROM users NATURAL LEFT JOIN |",
    "SELECT * FROM users NATURAL LEFT OUTER JOIN |",
    "SELECT * FROM users NATURAL RIGHT JOIN |",
    "SELECT * FROM users NATURAL RIGHT OUTER JOIN |",
    "SELECT * FROM users NATURAL FULL JOIN |",
    "SELECT * FROM users NATURAL FULL OUTER JOIN |",
    "SELECT * FROM users RIGHT OUTER JOIN |",
    "SELECT * FROM users FULL OUTER JOIN |",
  ])("supports explicit join transitions in %s", (marked) => {
    expect(expectReady(recognize(marked)).anchor).toBe("join");
  });

  it("keeps NATURAL JOIN support dialect-owned", () => {
    expect(
      recognize("SELECT * FROM users NATURAL LEFT OUTER JOIN |", {
        dialect: duckdbDialect,
      }).status,
    ).toBe("ready");
    for (const marked of [
      "SELECT * FROM users NATURAL JOIN |",
      "SELECT * FROM users NATURAL INNER JOIN |",
      "SELECT * FROM users NATURAL LEFT OUTER JOIN |",
      "SELECT * FROM users NATURAL RIGHT JOIN |",
      "SELECT * FROM users NATURAL FULL JOIN |",
    ]) {
      expect(
        recognize(marked, { dialect: bigQueryDialect }).status,
      ).toBe("unavailable");
    }

    const malformedDialect: SqlQuerySiteDialect = {
      ...postgresDialect,
    };
    Object.defineProperty(malformedDialect, "supportsNaturalJoin", {
      value: "yes",
    });
    expect(
      recognize("SELECT * FROM users JOIN |", {
        dialect: malformedDialect,
      }).status,
    ).toBe("unavailable");
  });
});

describe("fail-closed query-site behavior", () => {
  it.each([
    ["SELECT x IS DISTINCT FROM |", "inactive"],
    ["SELECT substring(x FROM |)", "inactive"],
    ["SELECT extract(YEAR FROM |)", "inactive"],
    ["\"prefix\" SELECT * FROM |", "inactive"],
    [". SELECT * FROM |", "inactive"],
    [", SELECT * FROM |", "inactive"],
    ["(SELECT 1) SELECT * FROM |", "inactive"],
    ["((SELECT 1)) SELECT * FROM |", "inactive"],
    ["DELETE FROM |", "inactive"],
    ["COPY x FROM |", "inactive"],
    ["SELECT * FROM users alias |", "inactive"],
    ["SELECT * FROM|", "inactive"],
    ["SELECT * FROM users JOIN|", "inactive"],
    ["SELECT * FROM (|", "unavailable"],
    ["SELECT * FROM fn(|", "unavailable"],
    ["SELECT * FROM fn|()", "unavailable"],
    ["SELECT * FROM fn| ()", "unavailable"],
    ["SELECT * FROM users| (x)", "unavailable"],
    ["SELECT * FROM sch|ema . users", "unavailable"],
    ["SELECT * FROM sch|ema /*c*/ . users", "unavailable"],
    ["SELECT * FROM LATERAL users JOIN |", "unavailable"],
    ["SELECT * FROM users LATERAL JOIN |", "unavailable"],
    ["SELECT * FROM users ON true JOIN |", "unavailable"],
    ["SELECT * FROM a CROSS JOIN b ON true JOIN |", "unavailable"],
    ["SELECT * FROM a NATURAL JOIN b USING(x) JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON x ON y JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b USING(x) USING(y) JOIN |", "unavailable"],
    [
      "SELECT * FROM a JOIN b ON true CROSS JOIN c ON true JOIN |",
      "unavailable",
    ],
    [
      "SELECT * FROM a JOIN b ON true NATURAL JOIN c USING(x) JOIN |",
      "unavailable",
    ],
    ["SELECT * FROM a JOIN b ON true LEFT, |", "unavailable"],
    ["SELECT * FROM a JOIN b ON true NATURAL, |", "unavailable"],
    ["SELECT * FROM a JOIN b ON true OUTER JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON true LEFT RIGHT JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON true LEFT potato JOIN |", "unavailable"],
    ["SELECT * FROM a LEFT, |", "unavailable"],
    ["SELECT * FROM a NATURAL, |", "unavailable"],
    ["SELECT * FROM a NATURAL CROSS JOIN |", "unavailable"],
    ["SELECT * FROM a LEFT NATURAL JOIN |", "unavailable"],
    ["SELECT * FROM a NATURAL OUTER JOIN |", "unavailable"],
    [
      "SELECT * FROM a NATURAL LEFT JOIN b ON true JOIN |",
      "unavailable",
    ],
    ["SELECT * FROM a LEFT /*x*/, |", "unavailable"],
    ["SELECT * FROM users + JOIN |", "unavailable"],
    ["SELECT * FROM users 'garbage' JOIN |", "unavailable"],
    ["SELECT * FROM users . junk JOIN |", "unavailable"],
    ["SELECT * FROM a JOIN b ON [x, y], |", "unavailable"],
    ["SELECT * FROM users TABLESAMPLE JOIN |", "unavailable"],
    ["SELECT * FROM users AS TABLESAMPLE JOIN |", "unavailable"],
    ["SELECT * FROM users AS LEFT JOIN |", "unavailable"],
    ["SELECT * FROM users AS CROSS JOIN |", "unavailable"],
    ["SELECT * FROM users AS NATURAL JOIN |", "unavailable"],
    ["SELECT * FROM users AS INNER JOIN |", "unavailable"],
    ["SELECT * FROM 'not a relation' JOIN |", "unavailable"],
    ["SELECT * FROM , |", "unavailable"],
    ["SELECT * FROM schema..|", "unavailable"],
    ["SELECT * FROM a UNION SELECT * FROM |", "unavailable"],
    ["SELECT * FROM a QUALIFY x JOIN |", "unavailable"],
  ] as const)("does not invent a site for %s", (marked, status) => {
    expect(recognize(marked).status).toBe(status);
  });

  it("rejects a BigQuery quoted prefix before SELECT", () => {
    expect(
      recognize("`prefix` SELECT * FROM |", {
        dialect: bigQueryDialect,
      }).status,
    ).toBe("inactive");
  });

  it.each([
    "SELECT * FROM users ASSERT_ROWS_MODIFIED JOIN |",
    "SELECT * FROM users AS ASSERT_ROWS_MODIFIED JOIN |",
    "SELECT * FROM users PIVOT JOIN |",
    "SELECT * FROM users UNPIVOT JOIN |",
    "SELECT * FROM users FOR JOIN |",
    "SELECT * FROM users MATCH_RECOGNIZE JOIN |",
  ])("fails closed for a BigQuery relation continuation in %s", (marked) => {
    expect(
      recognize(marked, { dialect: bigQueryDialect }).status,
    ).toBe("unavailable");
  });

  it("fails closed when dialect continuation policy is malformed", () => {
    const throwingDialect: SqlQuerySiteDialect = {
      ...postgresDialect,
      classifyRelationAlias: () => {
        throw new Error("classification failed");
      },
    };
    expect(
      recognize("SELECT * FROM users alias |", {
        dialect: throwingDialect,
      }).status,
    ).toBe("unavailable");

    const malformedDialect: SqlQuerySiteDialect = {
      ...postgresDialect,
    };
    Object.defineProperty(malformedDialect, "classifyRelationAlias", {
      value: () => "bogus",
    });
    expect(
      recognize("SELECT * FROM users alias |", {
        dialect: malformedDialect,
      }).status,
    ).toBe("unavailable");

    const inherited = Object.create({
      status: "identifier",
      value: "alias",
    });
    const accessor = Object.create(null);
    Object.defineProperties(accessor, {
      status: { get: () => "identifier" },
      value: { get: () => "alias" },
    });
    const throwingProxy = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error("prototype unavailable");
        },
      },
    );
    for (const result of [inherited, accessor, throwingProxy]) {
      const invalidShapeDialect: SqlQuerySiteDialect = {
        ...postgresDialect,
      };
      Object.defineProperty(
        invalidShapeDialect,
        "classifyRelationAlias",
        {
          value: () => result,
        },
      );
      expect(
        recognize("SELECT * FROM users alias JOIN |", {
          dialect: invalidShapeDialect,
        }).status,
      ).toBe("unavailable");
    }

    for (const value of [
      "",
      "x".repeat(MAX_QUERY_SITE_IDENTIFIER_LENGTH + 1),
    ]) {
      const invalidDecodedDialect: SqlQuerySiteDialect = {
        ...postgresDialect,
        classifyRelationAlias: () => ({
          status: "identifier",
          value,
        }),
      };
      expect(
        recognize("SELECT * FROM users alias JOIN |", {
          dialect: invalidDecodedDialect,
        }).status,
      ).toBe("unavailable");
    }
  });

  it("routes quoted aliases through the dialect policy with their role", () => {
    const calls: {
      rawAlias: string;
      quoted: boolean;
      role: "explicit-alias" | "implicit-alias";
    }[] = [];
    const dialect: SqlQuerySiteDialect = {
      ...postgresDialect,
      classifyRelationAlias: (rawAlias, quoted, role) => {
        calls.push({ quoted, rawAlias, role });
        return rawAlias === '"blocked"'
          ? { status: "unsupported" }
          : { status: "identifier", value: rawAlias.toLowerCase() };
      },
    };
    expect(
      recognize("SELECT * FROM users CamelAlias JOIN |", {
        dialect,
      }).status,
    ).toBe("ready");
    expect(
      recognize('SELECT * FROM users "blocked" JOIN |', {
        dialect,
      }).status,
    ).toBe("unavailable");
    expect(
      recognize('SELECT * FROM users AS "blocked" JOIN |', {
        dialect,
      }).status,
    ).toBe("unavailable");
    expect(calls).toEqual([
      {
        quoted: false,
        rawAlias: "CamelAlias",
        role: "implicit-alias",
      },
      {
        quoted: true,
        rawAlias: '"blocked"',
        role: "implicit-alias",
      },
      {
        quoted: true,
        rawAlias: '"blocked"',
        role: "explicit-alias",
      },
    ]);
  });

  it("never substitutes an empty word for an oversized alias token", () => {
    const alias = "x".repeat(MAX_QUERY_SITE_IDENTIFIER_LENGTH + 1);
    expect(
      recognize(`SELECT * FROM users ${alias} JOIN |`).status,
    ).toBe("unavailable");
    expect(
      recognize(`SELECT * FROM users AS ${alias} JOIN |`).status,
    ).toBe("unavailable");
  });

  it.each([
    'SELECT * FROM users "" JOIN |',
    'SELECT * FROM users AS "" JOIN |',
  ])("rejects an empty PostgreSQL quoted alias in %s", (marked) => {
    expect(recognize(marked).status).toBe("unavailable");
  });

  it.each([
    "SELECT * FROM users `` JOIN |",
    "SELECT * FROM users AS `` JOIN |",
  ])("rejects an empty BigQuery quoted alias in %s", (marked) => {
    expect(
      recognize(marked, { dialect: bigQueryDialect }).status,
    ).toBe("unavailable");
  });

  it("bounds explicit and implicit quoted aliases", () => {
    const alias = `"${"x".repeat(
      MAX_QUERY_SITE_IDENTIFIER_LENGTH + 1,
    )}"`;
    expect(
      recognize(`SELECT * FROM users ${alias} JOIN |`).status,
    ).toBe("unavailable");
    expect(
      recognize(`SELECT * FROM users AS ${alias} JOIN |`).status,
    ).toBe("unavailable");
  });

  it("bounds the decoded alias instead of its escaped source token", () => {
    const alias = `"${'""'.repeat(
      MAX_QUERY_SITE_IDENTIFIER_LENGTH,
    )}"`;
    expect(alias.length).toBe(
      MAX_QUERY_SITE_IDENTIFIER_LENGTH * 2 + 2,
    );
    expect(
      recognize(`SELECT * FROM users ${alias} JOIN |`).status,
    ).toBe("ready");
    expect(
      recognize(`SELECT * FROM users AS ${alias} JOIN |`).status,
    ).toBe("ready");
  });

  it.each([
    'SELECT * FROM users LEFT "alias" JOIN |',
    'SELECT * FROM users NATURAL "alias" JOIN |',
    'SELECT * FROM a JOIN b ON true LEFT "alias" JOIN |',
    "SELECT * FROM a JOIN b ON true LEFT . JOIN |",
    "SELECT * FROM a JOIN b ON true LEFT 'x' JOIN |",
    "SELECT * FROM a JOIN b ON true NATURAL 'x' JOIN |",
    "SELECT * FROM a JOIN b ON true LEFT + JOIN |",
  ])("does not launder a pending join modifier through %s", (marked) => {
    expect(recognize(marked).status).toBe("unavailable");
  });

  it.each([
    "SELECT * FROM users alias(garbage +) JOIN |",
    "SELECT * FROM users MATCH_RECOGNIZE(garbage) JOIN |",
  ])("does not launder a parenthesized relation suffix in %s", (marked) => {
    expect(recognize(marked).status).toBe("unavailable");
  });

  it.each([
    "SELECT * FROM users AS + alias JOIN |",
    "SELECT * FROM users AS . alias JOIN |",
    "SELECT * FROM users AS , alias JOIN |",
    "SELECT * FROM users AS 'junk' alias JOIN |",
  ])("does not skip invalid explicit-alias grammar in %s", (marked) => {
    expect(recognize(marked).status).toBe("unavailable");
  });

  it.each([
    "SELECT * FROM users AS WHERE JOIN |",
    "SELECT * FROM users AS FROM JOIN |",
    "SELECT * FROM users AS AS JOIN |",
    "SELECT * FROM users AS SELECT JOIN |",
    "SELECT * FROM users AS OFFSET JOIN |",
    "SELECT * FROM users AS UNION JOIN |",
    "SELECT * FROM users AS QUALIFY JOIN |",
    "SELECT * FROM users AS LATERAL JOIN |",
  ])("classifies a structural word in explicit-alias state for %s", (marked) => {
    expect(recognize(marked).status).toBe("unavailable");
  });

  it.each([
    "SELECT 'on|e''two' FROM users",
    "SELECT 'one''tw|o' FROM users",
  ])("keeps adjacent BigQuery strings opaque at %s", (marked) => {
    expect(recognize(marked, { dialect: bigQueryDialect })).toEqual({
      reason: "cursor-in-string",
      status: "inactive",
    });
  });

  it("fails closed when an embedded region is adjacent to a path", () => {
    const marked = "SELECT * FROM u|s{x}";
    const regionFrom = marked.indexOf("{x}");
    expect(
      recognize(marked, {
        regions: [
          { from: regionFrom - 1, language: "template", to: regionFrom + 2 },
        ],
      }).status,
    ).toBe("unavailable");
  });

  it.each([
    ["SELECT -- {x} FROM |", postgresDialect, "inactive"],
    ["SELECT # {x} FROM |", bigQueryDialect, "inactive"],
    ["SELECT \"ab{x} FROM |", postgresDialect, "unavailable"],
    ["SELECT `ab{x} FROM |", bigQueryDialect, "unavailable"],
  ] as const)(
    "preserves lexical state across a masked region in %s",
    (marked, dialect, status) => {
      const regionFrom = marked.indexOf("{x}");
      expect(
        recognize(marked, {
          dialect,
          regions: [
            { from: regionFrom, language: "template", to: regionFrom + 3 },
          ],
        }).status,
      ).toBe(status);
    },
  );

  it.each([
    "SELECT (SELECT {x}) FROM |",
    "SELECT * FROM users JOIN orders ON (SELECT {x}) JOIN |",
    "{x} (SELECT * FROM |)",
  ])("retains embedded-region evidence across nested frames in %s", (marked) => {
    const regionFrom = marked.indexOf("{x}");
    const result = expectReady(
      recognize(marked, {
        regions: [
          { from: regionFrom, language: "template", to: regionFrom + 3 },
        ],
      }),
    );
    expect(result.recognition).toEqual({
      issues: ["opaque-template-context"],
      quality: "recovered",
    });
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
    expect(recognize("SELECT * FROM -- comment|")).toEqual({
      reason: "cursor-in-comment",
      status: "inactive",
    });
    expect(recognize("SELECT * FROM -- comment|\n")).toEqual({
      reason: "cursor-in-comment",
      status: "inactive",
    });
    expect(recognize("SELECT * FROM -- comment\n|").status).toBe("ready");
    expect(recognize("SELECT * FROM /* comment */|").status).toBe(
      "ready",
    );
    expect(
      recognize("SELECT * FROM # comment|", {
        dialect: bigQueryDialect,
      }),
    ).toEqual({
      reason: "cursor-in-comment",
      status: "inactive",
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
    "SELECT * FROM users alias . JOIN |",
    "SELECT * FROM users alias + JOIN |",
    "SELECT * FROM users \"one\" \"two\" JOIN |",
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
      classifyRelationAlias,
      decodeRelationPath,
      lexicalProfile: POSTGRESQL_SQL_LEXICAL_PROFILE,
      maximumPathDepth: 4,
      supportsNaturalJoin: true,
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

    const validDecoded = (): Extract<
      SqlDecodedQueryPath,
      { readonly status: "decoded" }
    > => ({
      finalSegment: { from: 0, to: 1 },
      prefix: { quoted: false, value: "x" },
      qualifier: [],
      quality: "exact",
      status: "decoded",
    });
    const malformedResults: SqlQuerySiteDialect["decodeRelationPath"][] = [
      () => {
        throw new Error("decoder failed");
      },
      () => {
        const decoded = validDecoded();
        Object.setPrototypeOf(decoded, []);
        return decoded;
      },
      () => {
        const decoded = validDecoded();
        Object.defineProperty(decoded, "status", { value: "bogus" });
        return decoded;
      },
      () => {
        const decoded = validDecoded();
        Object.defineProperties(decoded, {
          reason: { value: "bogus" },
          status: { value: "unavailable" },
        });
        return decoded;
      },
      () => {
        const decoded = validDecoded();
        Object.defineProperty(decoded, "quality", { value: "bogus" });
        return decoded;
      },
      () => {
        const decoded = validDecoded();
        Object.defineProperty(decoded, "qualifier", { value: { length: 0 } });
        return decoded;
      },
      () => {
        const decoded = validDecoded();
        const qualifier = [{ quoted: false, value: "schema" }];
        Reflect.deleteProperty(qualifier, "0");
        Object.defineProperty(decoded, "qualifier", { value: qualifier });
        return decoded;
      },
      () => {
        const decoded = validDecoded();
        const component = { quoted: false, value: "schema" };
        Object.defineProperty(component, "quoted", { value: "false" });
        Object.defineProperty(decoded, "qualifier", {
          value: [component],
        });
        return decoded;
      },
      () => {
        const decoded = validDecoded();
        Object.defineProperty(decoded, "prefix", { value: null });
        return decoded;
      },
      () => {
        const decoded = validDecoded();
        Object.setPrototypeOf(decoded.finalSegment, []);
        return decoded;
      },
      () => {
        const decoded = validDecoded();
        Object.defineProperty(decoded.finalSegment, "to", { value: "1" });
        return decoded;
      },
      () => {
        const decoded = validDecoded();
        Object.defineProperty(decoded.finalSegment, "from", {
          get: () => {
            throw new Error("accessed decoder getter");
          },
        });
        return decoded;
      },
    ];
    for (const decodeRelationPath of malformedResults) {
      expect(
        recognize("SELECT * FROM x|", {
          dialect: dialectWith(decodeRelationPath),
        }),
      ).toEqual({
        reason: "ambiguous-query-site",
        status: "unavailable",
      });
    }

    expect(
      recognize("SELECT * FROM x|", {
        dialect: dialectWith(() => ({
          ...validDecoded(),
          qualifier: [
            {
              quoted: false,
              value: "x".repeat(MAX_QUERY_SITE_IDENTIFIER_LENGTH + 1),
            },
          ],
        })),
      }),
    ).toEqual({
      reason: "resource-limit",
      resource: "identifier-segment",
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
    const exact = `SELECT * FROM ${" ".repeat(
      MAX_QUERY_SITE_STATEMENT_LENGTH - "SELECT * FROM ".length,
    )}|`;
    expect(recognize(exact).status).toBe("ready");
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
    const exactTokens = `SELECT ${"x+".repeat(
      MAX_QUERY_SITE_LEXEMES / 2 - 1,
    )} FROM |`;
    expect(recognize(exactTokens).status).toBe("ready");
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
    expect(
      recognize(`${"(".repeat(MAX_QUERY_SITE_DEPTH)}SELECT * FROM |`).status,
    ).toBe("ready");
  });

  it("bounds path depth and decoded identifier length", () => {
    expect(recognize("SELECT * FROM a.b.c.d|").status).toBe("ready");
    expect(recognize("SELECT * FROM a.b.c.d.e|")).toEqual({
      reason: "resource-limit",
      resource: "identifier-path",
      status: "unavailable",
    });
    expect(
      recognize(`SELECT * FROM ${"x".repeat(
        MAX_QUERY_SITE_IDENTIFIER_LENGTH,
      )}|`).status,
    ).toBe("ready");
    expect(
      recognize(`SELECT * FROM ${"x".repeat(
        MAX_QUERY_SITE_IDENTIFIER_LENGTH + 1,
      )}|`),
    ).toEqual({
      reason: "resource-limit",
      resource: "identifier-segment",
      status: "unavailable",
    });

    const globalPath = Array.from(
      { length: MAX_QUERY_SITE_PATH_COMPONENTS },
      () => "a",
    ).join(".");
    const globalDialect: SqlQuerySiteDialect = {
      ...postgresDialect,
      maximumPathDepth: MAX_QUERY_SITE_PATH_COMPONENTS,
    };
    expect(
      recognize(`SELECT * FROM ${globalPath}|`, {
        dialect: globalDialect,
      }).status,
    ).toBe("ready");
    expect(
      recognize("SELECT * FROM a|", {
        dialect: {
          ...globalDialect,
          maximumPathDepth: MAX_QUERY_SITE_PATH_COMPONENTS + 1,
        },
      }).status,
    ).toBe("unavailable");
  });
});

describe("query-site invariants", () => {
  it("does not split astral or lone-surrogate cursor ranges", () => {
    expect(recognize("SELECT * FROM \ud801|\udc00name").status).toBe(
      "unavailable",
    );
    const astral = expectReady(recognize("SELECT * FROM \ud801\udc00na|me"));
    expect(astral.typedPathRange).toMatchObject({ from: 14, to: 20 });
    expect(recognize("SELECT * FROM \ud801|name").status).toBe(
      "unavailable",
    );
  });

  it("remains bounded with the maximum embedded-region count", () => {
    const body = "x ".repeat(10_000);
    const marked = `SELECT ${body}FROM |`;
    const regions = Array.from({ length: 10_000 }, (_, index) => ({
      from: "SELECT ".length + index * 2,
      language: "template",
      to: "SELECT ".length + index * 2 + 1,
    }));
    const result = expectReady(recognize(marked, { regions }));
    expect(result.recognition).toEqual({
      issues: ["opaque-template-context"],
      quality: "recovered",
    });
  });

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
