import { describe, expect, it } from "vitest";
import {
  analyzeSqlCteLayout,
  type SqlCteLayout,
} from "../cte-layout.js";
import {
  BIGQUERY_SQL_RELATION_DIALECT,
  DREMIO_SQL_RELATION_DIALECT,
  DUCKDB_SQL_RELATION_DIALECT,
  POSTGRESQL_SQL_RELATION_DIALECT,
  type SqlRelationDialectRuntime,
} from "../relation-dialect.js";
import type {
  SqlCanonicalRelationPath,
  SqlIdentifierDecodeResult,
} from "../relation-completion-types.js";
import {
  createIdentitySqlSource,
} from "../source.js";
import {
  buildSqlStatementIndex,
} from "../statement-index.js";
import type { SqlIdentifierComponent } from "../types.js";

const RUNTIMES = Object.freeze({
  bigquery: BIGQUERY_SQL_RELATION_DIALECT,
  dremio: DREMIO_SQL_RELATION_DIALECT,
  duckdb: DUCKDB_SQL_RELATION_DIALECT,
  postgresql: POSTGRESQL_SQL_RELATION_DIALECT,
});

function decoded(
  result: SqlIdentifierDecodeResult,
): Extract<SqlIdentifierDecodeResult, { readonly status: "decoded" }> {
  expect(result.status).toBe("decoded");
  if (result.status !== "decoded") {
    throw new Error("Expected a decoded identifier");
  }
  return result;
}

function readyPath(
  runtime: SqlRelationDialectRuntime,
  text: string,
  position = text.length,
) {
  const result = runtime.querySite.decodeRelationPath(text, position);
  expect(result.status).toBe("decoded");
  if (result.status !== "decoded") {
    throw new Error("Expected a decoded relation path");
  }
  return result;
}

function component(
  value: string,
  quoted = false,
): SqlIdentifierComponent {
  return { quoted, value };
}

function analyze(
  runtime: SqlRelationDialectRuntime,
  text: string,
): SqlCteLayout {
  const source = createIdentitySqlSource(text);
  const slot = buildSqlStatementIndex(
    source.analysisText,
    runtime.querySite.lexicalProfile,
  ).slots[0];
  expect(slot?.boundaryQuality).toBe("exact");
  if (!slot || slot.boundaryQuality !== "exact") {
    throw new Error("Expected one exact SQL statement");
  }
  return analyzeSqlCteLayout(source, slot, runtime.cteLayout);
}

function expectDeepFrozenRuntime(
  runtime: SqlRelationDialectRuntime,
): void {
  expect(Object.isFrozen(runtime)).toBe(true);
  expect(Object.isFrozen(runtime.completion)).toBe(true);
  expect(Object.isFrozen(runtime.cteLayout)).toBe(true);
  expect(Object.isFrozen(runtime.cteLayout.grammar)).toBe(true);
  expect(Object.isFrozen(runtime.querySite)).toBe(true);
}

describe("built-in relation dialect runtime", () => {
  it("owns stable, deeply frozen, coherent views", () => {
    for (const runtime of Object.values(RUNTIMES)) {
      expectDeepFrozenRuntime(runtime);
      expect(runtime.cteLayout.lexicalProfile).toBe(
        runtime.querySite.lexicalProfile,
      );
      expect(runtime.cteLayout.compareCteIdentifiers).toBe(
        runtime.completion.compareCteIdentifiers,
      );
    }
    expect(POSTGRESQL_SQL_RELATION_DIALECT).toBe(
      POSTGRESQL_SQL_RELATION_DIALECT,
    );
  });

  it("records the closed dialect capability matrix", () => {
    expect(POSTGRESQL_SQL_RELATION_DIALECT.querySite).toMatchObject({
      maximumPathDepth: 2,
      supportsNaturalJoin: true,
    });
    expect(POSTGRESQL_SQL_RELATION_DIALECT.cteLayout.grammar).toEqual({
      declaredColumns: true,
      materialization: true,
      maximumDeclarationsPerFrame: 256,
      recursive: true,
    });
    expect(DUCKDB_SQL_RELATION_DIALECT.querySite).toMatchObject({
      maximumPathDepth: 3,
      supportsNaturalJoin: true,
    });
    expect(DUCKDB_SQL_RELATION_DIALECT.cteLayout.grammar).toEqual({
      declaredColumns: true,
      materialization: true,
      maximumDeclarationsPerFrame: 256,
      recursive: true,
    });
    expect(BIGQUERY_SQL_RELATION_DIALECT.querySite).toMatchObject({
      maximumPathDepth: 3,
      supportsNaturalJoin: false,
    });
    expect(BIGQUERY_SQL_RELATION_DIALECT.cteLayout.grammar).toEqual({
      declaredColumns: false,
      materialization: false,
      maximumDeclarationsPerFrame: 256,
      recursive: true,
    });
    expect(DREMIO_SQL_RELATION_DIALECT.querySite).toMatchObject({
      maximumPathDepth: 32,
      supportsNaturalJoin: false,
    });
    expect(DREMIO_SQL_RELATION_DIALECT.cteLayout.grammar).toEqual({
      declaredColumns: true,
      materialization: false,
      maximumDeclarationsPerFrame: 1,
      recursive: false,
    });
  });
});

describe("identifier decoding and classification", () => {
  it.each([
    ["postgresql", POSTGRESQL_SQL_RELATION_DIALECT],
    ["duckdb", DUCKDB_SQL_RELATION_DIALECT],
    ["dremio", DREMIO_SQL_RELATION_DIALECT],
  ] as const)("decodes standard identifiers for %s", (_name, runtime) => {
    expect(
      decoded(
        runtime.completion.decodeIdentifier("Users", "complete"),
      ),
    ).toMatchObject({
      component: { quoted: false, value: "Users" },
      quality: "exact",
    });
    expect(
      decoded(
        runtime.completion.decodeIdentifier(
          "\"User \"\"Events\"\"\"",
          "complete",
        ),
      ),
    ).toMatchObject({
      component: { quoted: true, value: "User \"Events\"" },
      quality: "exact",
    });
    expect(
      decoded(
        runtime.completion.decodeIdentifier(
          "\"line\nname\"",
          "complete",
        ),
      ).component,
    ).toEqual({ quoted: true, value: "line\nname" });
    expect(
      decoded(
        runtime.completion.decodeIdentifier(
          "\"User",
          "completion-prefix",
        ),
      ),
    ).toMatchObject({
      component: { quoted: true, value: "User" },
      quality: "recovered",
    });
    expect(
      decoded(
        runtime.completion.decodeIdentifier(
          "\"",
          "completion-prefix",
        ),
      ),
    ).toMatchObject({
      component: { quoted: true, value: "" },
      quality: "recovered",
    });
    expect(
      runtime.completion.decodeIdentifier("\"User", "complete"),
    ).toEqual({
      reason: "invalid-identifier",
      status: "unavailable",
    });
  });

  it("keeps PostgreSQL dollar identifiers dialect-specific", () => {
    expect(
      POSTGRESQL_SQL_RELATION_DIALECT.completion.decodeIdentifier(
        "user$id",
        "complete",
      ).status,
    ).toBe("decoded");
    expect(
      DUCKDB_SQL_RELATION_DIALECT.completion.decodeIdentifier(
        "user$id",
        "complete",
      ).status,
    ).toBe("unavailable");
  });

  it("keeps BigQuery bare identifiers ASCII-only", () => {
    for (const token of ["Éclair", "😀", "\u00a0name"]) {
      expect(
        BIGQUERY_SQL_RELATION_DIALECT.completion.decodeIdentifier(
          token,
          "complete",
        ),
      ).toEqual({
        reason: "invalid-identifier",
        status: "unavailable",
      });
    }
    expect(
      POSTGRESQL_SQL_RELATION_DIALECT.completion.decodeIdentifier(
        "Éclair",
        "complete",
      ).status,
    ).toBe("decoded");
    expect(
      BIGQUERY_SQL_RELATION_DIALECT.completion.renderRelationPath([
        {
          quoted: false,
          role: "relation",
          value: "Éclair",
        },
      ]),
    ).toEqual({ status: "rendered", text: "`Éclair`" });
  });

  it("preserves DuckDB's high-bit bare identifier behavior", () => {
    for (const token of ["Éclair", "🦆", "\u00a0name", "名字"]) {
      expect(
        DUCKDB_SQL_RELATION_DIALECT.completion.decodeIdentifier(
          token,
          "complete",
        ).status,
      ).toBe("decoded");
      expect(
        DUCKDB_SQL_RELATION_DIALECT.completion.renderRelationPath([
          {
            quoted: false,
            role: "relation",
            value: token,
          },
        ]),
      ).toEqual({ status: "rendered", text: token });
    }
  });

  it("uses Dremio's Unicode letter and number rules for bare names", () => {
    for (const token of ["Éclair", "名字", "_é2"]) {
      expect(
        DREMIO_SQL_RELATION_DIALECT.completion.decodeIdentifier(
          token,
          "complete",
        ).status,
      ).toBe("decoded");
    }
    for (const token of ["🦆", "\u00a0name"]) {
      expect(
        DREMIO_SQL_RELATION_DIALECT.completion.decodeIdentifier(
          token,
          "complete",
        ).status,
      ).toBe("unavailable");
      expect(
        DREMIO_SQL_RELATION_DIALECT.completion.renderRelationPath([
          {
            quoted: false,
            role: "relation",
            value: token,
          },
        ]),
      ).toEqual({
        status: "rendered",
        text: `"${token}"`,
      });
    }
  });

  it("decodes the documented BigQuery identifier escapes", () => {
    expect(
      decoded(
        BIGQUERY_SQL_RELATION_DIALECT.completion.decodeIdentifier(
          "`line\\nquote\\`slash\\\\A\\x42\\u0043\\U00000044`",
          "complete",
        ),
      ),
    ).toMatchObject({
      component: {
        quoted: true,
        value: "line\nquote`slash\\ABCD",
      },
      quality: "exact",
    });
    expect(
      decoded(
        BIGQUERY_SQL_RELATION_DIALECT.completion.decodeIdentifier(
          "`partial",
          "completion-prefix",
        ),
      ),
    ).toMatchObject({
      component: { quoted: true, value: "partial" },
      quality: "recovered",
    });
    expect(
      readyPath(BIGQUERY_SQL_RELATION_DIALECT, "`"),
    ).toMatchObject({
      prefix: { quoted: true, value: "" },
      quality: "recovered",
    });
    for (const token of [
      "`bad\\q`",
      "`bad\\x4`",
      "`bad\\uD800`",
      "`bad\\U00110000`",
      "`\\000`",
    ]) {
      expect(
        BIGQUERY_SQL_RELATION_DIALECT.completion.decodeIdentifier(
          token,
          "complete",
        ).status,
      ).toBe("unavailable");
    }
  });

  it("rejects reserved, malformed, oversized, and ill-formed names", () => {
    for (const [name, runtime] of Object.entries(RUNTIMES)) {
      for (const token of [
        "",
        "select",
        "1table",
        "has space",
        "\ud800",
        "a".repeat(257),
      ]) {
        expect(
          runtime.completion.decodeIdentifier(token, "complete")
            .status,
          `${name}: ${JSON.stringify(token)}`,
        ).toBe("unavailable");
      }
      expect(
        decoded(
          runtime.completion.decodeIdentifier(
            "",
            "completion-prefix",
          ),
        ).component,
      ).toEqual({ quoted: false, value: "" });
    }
  });

  it("uses the same decoder for query and CTE token classification", () => {
    for (const runtime of Object.values(RUNTIMES)) {
      expect(
        runtime.querySite.classifyIdentifierToken(
          "select",
          false,
          "implicit-alias",
        ),
      ).toEqual({ status: "unsupported" });
      expect(
        runtime.cteLayout.classifyIdentifierToken(
          "select",
          false,
          "cte-name",
        ),
      ).toEqual({ status: "unsupported" });
      expect(
        runtime.querySite.classifyIdentifierToken(
          runtime === BIGQUERY_SQL_RELATION_DIALECT
            ? "`select`"
            : "\"select\"",
          true,
          "using-column",
        ),
      ).toMatchObject({
        status: "identifier",
        value: "select",
      });
    }
  });

  it("rejects control words only where they are structurally ambiguous", () => {
    const query =
      BIGQUERY_SQL_RELATION_DIALECT.querySite
        .classifyIdentifierToken;
    expect(query("pivot", false, "implicit-alias")).toEqual({
      status: "unsupported",
    });
    expect(query("pivot", false, "explicit-alias")).toEqual({
      status: "identifier",
      value: "pivot",
    });
    expect(query("pivot", false, "using-column")).toEqual({
      status: "identifier",
      value: "pivot",
    });
    expect(
      POSTGRESQL_SQL_RELATION_DIALECT.querySite
        .classifyIdentifierToken(
          "pivot",
          false,
          "implicit-alias",
        ),
    ).toEqual({
      status: "identifier",
      value: "pivot",
    });

    const cte =
      POSTGRESQL_SQL_RELATION_DIALECT.cteLayout
        .classifyIdentifierToken;
    expect(cte("materialized", false, "cte-name").status).toBe(
      "identifier",
    );
    expect(cte("materialized", false, "cte-column").status).toBe(
      "identifier",
    );
  });

  it("uses dialect-specific reserved-word tables", () => {
    expect(
      POSTGRESQL_SQL_RELATION_DIALECT.completion.decodeIdentifier(
        "abs",
        "complete",
      ).status,
    ).toBe("decoded");
    for (const [runtime, word, renderedText] of [
      [
        POSTGRESQL_SQL_RELATION_DIALECT,
        "authorization",
        "\"authorization\"",
      ],
      [DUCKDB_SQL_RELATION_DIALECT, "describe", "\"describe\""],
      [BIGQUERY_SQL_RELATION_DIALECT, "graph_table", "`graph_table`"],
      [DREMIO_SQL_RELATION_DIALECT, "abs", "\"abs\""],
    ] as const) {
      expect(
        runtime.completion.decodeIdentifier(word, "complete").status,
      ).toBe("unavailable");
      expect(
        runtime.completion.renderRelationPath([
          {
            quoted: false,
            role: "relation",
            value: word,
          },
        ]),
      ).toEqual({
        status: "rendered",
        text: renderedText,
      });
    }
  });

  it("keeps the CTE raw bound coherent with BigQuery escapes", () => {
    const escaped = "\\U00000041".repeat(256);
    const layout = analyze(
      BIGQUERY_SQL_RELATION_DIALECT,
      `WITH \`${escaped}\` AS (SELECT 1) SELECT 1`,
    );
    expect(layout.status).toBe("ready");
    if (layout.status !== "unavailable") {
      expect(layout.declarations[0]?.name.value).toBe("A".repeat(256));
    }
  });
});

describe("relation path decoding", () => {
  it.each([
    ["postgresql", POSTGRESQL_SQL_RELATION_DIALECT],
    ["duckdb", DUCKDB_SQL_RELATION_DIALECT],
    ["dremio", DREMIO_SQL_RELATION_DIALECT],
  ] as const)("preserves quoted dots for %s", (_name, runtime) => {
    expect(readyPath(runtime, "\"my.schema\".us")).toMatchObject({
      finalSegment: { from: 12, to: 14 },
      prefix: { quoted: false, value: "us" },
      qualifier: [{ quoted: true, value: "my.schema" }],
      quality: "exact",
    });
  });

  it("decodes a cursor inside the final quoted token", () => {
    const text = "public.\"Users\"";
    const cursor = text.indexOf("ers");
    expect(
      readyPath(POSTGRESQL_SQL_RELATION_DIALECT, text, cursor),
    ).toMatchObject({
      finalSegment: { from: 7, to: text.length },
      prefix: { quoted: true, value: "Us" },
      qualifier: [{ quoted: false, value: "public" }],
      quality: "exact",
    });
  });

  it("recovers only the final incomplete quoted component", () => {
    expect(
      readyPath(POSTGRESQL_SQL_RELATION_DIALECT, "public.\"Us"),
    ).toMatchObject({
      prefix: { quoted: true, value: "Us" },
      qualifier: [{ quoted: false, value: "public" }],
      quality: "recovered",
    });
  });

  it("supports a trailing empty final segment", () => {
    expect(
      readyPath(POSTGRESQL_SQL_RELATION_DIALECT, "public."),
    ).toMatchObject({
      finalSegment: { from: 7, to: 7 },
      prefix: { quoted: false, value: "" },
      qualifier: [{ quoted: false, value: "public" }],
    });
  });

  it("rejects invalid offsets, malformed paths, and excess depth", () => {
    const decoder =
      POSTGRESQL_SQL_RELATION_DIALECT.querySite.decodeRelationPath;
    for (const [text, position] of [
      ["public.users", -1],
      ["public.users", 0.5],
      ["public.users", Number.NaN],
      ["public.users", 13],
      ["a..b", 4],
      ["a.b.c", 5],
      ["\"a\"x.b", 6],
      [".users", 6],
    ] as const) {
      expect(decoder(text, position).status).toBe("unavailable");
    }
  });

  it("supports BigQuery dashed-first and whole-backtick paths", () => {
    expect(
      readyPath(
        BIGQUERY_SQL_RELATION_DIALECT,
        "my-project.dataset.ta",
      ),
    ).toMatchObject({
      prefix: { quoted: false, value: "ta" },
      qualifier: [
        { quoted: false, value: "my-project" },
        { quoted: false, value: "dataset" },
      ],
    });
    expect(
      readyPath(
        BIGQUERY_SQL_RELATION_DIALECT,
        "`my-project.dataset.ta`",
        "`my-project.dataset.ta".length,
      ),
    ).toMatchObject({
      finalSegment: { from: 20, to: 23 },
      prefix: { quoted: true, value: "ta" },
      qualifier: [
        { quoted: true, value: "my-project" },
        { quoted: true, value: "dataset" },
      ],
      quality: "exact",
    });
    expect(
      readyPath(
        BIGQUERY_SQL_RELATION_DIALECT,
        "`project.with.dot`.ta",
      ),
    ).toMatchObject({
      prefix: { quoted: false, value: "ta" },
      qualifier: [{ quoted: true, value: "project.with.dot" }],
    });
    expect(
      readyPath(
        BIGQUERY_SQL_RELATION_DIALECT,
        "abc5.GROUP",
      ),
    ).toMatchObject({
      prefix: { quoted: false, value: "GROUP" },
      qualifier: [{ quoted: false, value: "abc5" }],
    });
    expect(
      BIGQUERY_SQL_RELATION_DIALECT.querySite.decodeRelationPath(
        "GROUP",
        5,
      ).status,
    ).toBe("unavailable");
  });

  it("rejects a BigQuery dash outside the first path component", () => {
    for (const text of [
      "project.my-dataset.table",
      "project.dataset.my-table",
      "table-287a",
      "table-",
    ]) {
      expect(
        BIGQUERY_SQL_RELATION_DIALECT.querySite.decodeRelationPath(
          text,
          text.length,
        ).status,
      ).toBe("unavailable");
    }
  });

  it("recovers an incomplete BigQuery whole-backtick path", () => {
    expect(
      readyPath(
        BIGQUERY_SQL_RELATION_DIALECT,
        "`project.dataset.ta",
      ),
    ).toMatchObject({
      prefix: { quoted: true, value: "ta" },
      qualifier: [
        { quoted: true, value: "project" },
        { quoted: true, value: "dataset" },
      ],
      quality: "recovered",
    });
  });
});

describe("CTE equality and prefix policy", () => {
  it("implements PostgreSQL quoted and unquoted resolution", () => {
    const runtime = POSTGRESQL_SQL_RELATION_DIALECT.completion;
    expect(
      runtime.compareCteIdentifiers(
        component("Users"),
        component("users"),
      ),
    ).toBe("equal");
    expect(
      runtime.compareCteIdentifiers(
        component("users", true),
        component("USERS"),
      ),
    ).toBe("equal");
    expect(
      runtime.compareCteIdentifiers(
        component("Users", true),
        component("users"),
      ),
    ).toBe("distinct");
    expect(
      runtime.compareCteIdentifiers(
        component("É"),
        component("é"),
      ),
    ).toBe("unknown");
    expect(
      runtime.cteIdentifierMatchesPrefix(
        component("Users"),
        component("us"),
      ),
    ).toBe("match");
    expect(
      runtime.cteIdentifierMatchesPrefix(
        component("Users", true),
        component("us"),
      ),
    ).toBe("no-match");
    expect(
      runtime.cteIdentifierMatchesPrefix(
        component("Éclair"),
        component("é"),
      ),
    ).toBe("unknown");
  });

  it("keeps DuckDB ASCII comparison fully decidable", () => {
    const runtime = DUCKDB_SQL_RELATION_DIALECT.completion;
    expect(
      runtime.compareCteIdentifiers(
        component("Users", true),
        component("users"),
      ),
    ).toBe("equal");
    expect(
      runtime.compareCteIdentifiers(
        component("É"),
        component("é"),
      ),
    ).toBe("distinct");
    expect(
      runtime.cteIdentifierMatchesPrefix(
        component("Éclair", true),
        component("é"),
      ),
    ).toBe("no-match");
  });

  it.each([
    ["bigquery", BIGQUERY_SQL_RELATION_DIALECT],
    ["dremio", DREMIO_SQL_RELATION_DIALECT],
  ] as const)(
    "uses conservative non-ASCII comparison for %s",
    (_name, dialect) => {
      const runtime = dialect.completion;
      expect(
        runtime.compareCteIdentifiers(
          component("Users", true),
          component("users"),
        ),
      ).toBe("equal");
      expect(
        runtime.compareCteIdentifiers(
          component("É"),
          component("É", true),
        ),
      ).toBe("equal");
      expect(
        runtime.compareCteIdentifiers(
          component("É"),
          component("é"),
        ),
      ).toBe("unknown");
      expect(
        runtime.cteIdentifierMatchesPrefix(
          component("Éclair"),
          component("é"),
        ),
      ).toBe("unknown");
    },
  );

  it("fails closed for malformed comparison inputs", () => {
    expect(
      Reflect.apply(
        POSTGRESQL_SQL_RELATION_DIALECT.completion
          .compareCteIdentifiers,
        undefined,
        [null, component("users")],
      ),
    ).toBe("unknown");
    expect(
      POSTGRESQL_SQL_RELATION_DIALECT.completion
        .compareCteIdentifiers(component(""), component("")),
    ).toBe("unknown");
    expect(
      DUCKDB_SQL_RELATION_DIALECT.completion
        .cteIdentifierMatchesPrefix(
          component("\ud800"),
          component("u"),
        ),
    ).toBe("unknown");
    const hostile = new Proxy(component("users"), {
      get() {
        throw new Error("hostile");
      },
    });
    expect(
      POSTGRESQL_SQL_RELATION_DIALECT.completion
        .compareCteIdentifiers(hostile, component("users")),
    ).toBe("unknown");
    expect(
      POSTGRESQL_SQL_RELATION_DIALECT.completion
        .cteIdentifierMatchesPrefix(hostile, component("u")),
    ).toBe("unknown");
    const malformedDecode = Reflect.apply(
      POSTGRESQL_SQL_RELATION_DIALECT.completion.decodeIdentifier,
      undefined,
      [null, "complete"],
    );
    expect(malformedDecode).toEqual({
      reason: "invalid-identifier",
      status: "unavailable",
    });
  });
});

describe("safe role-aware rendering", () => {
  it("renders PostgreSQL relation suffixes and rejects catalog roles", () => {
    const relation = [
      { quoted: false, role: "relation", value: "users" },
    ] satisfies SqlCanonicalRelationPath;
    const schemaRelation = [
      { quoted: false, role: "schema", value: "public" },
      { quoted: true, role: "relation", value: "User Events" },
    ] satisfies SqlCanonicalRelationPath;
    const catalogRelation = [
      { quoted: false, role: "catalog", value: "warehouse" },
      { quoted: false, role: "relation", value: "users" },
    ] satisfies SqlCanonicalRelationPath;
    expect(
      POSTGRESQL_SQL_RELATION_DIALECT.completion
        .renderRelationPath(relation),
    ).toEqual({ status: "rendered", text: "users" });
    expect(
      POSTGRESQL_SQL_RELATION_DIALECT.completion
        .renderRelationPath(schemaRelation),
    ).toEqual({
      status: "rendered",
      text: "public.\"User Events\"",
    });
    expect(
      POSTGRESQL_SQL_RELATION_DIALECT.completion
        .renderRelationPath(catalogRelation),
    ).toEqual({
      reason: "illegal-role-sequence",
      status: "unsupported",
    });
  });

  it("renders every closed DuckDB qualification shape", () => {
    const paths = [
      [
        { quoted: false, role: "relation", value: "users" },
      ],
      [
        { quoted: false, role: "schema", value: "main" },
        { quoted: false, role: "relation", value: "users" },
      ],
      [
        { quoted: false, role: "catalog", value: "memory" },
        { quoted: false, role: "relation", value: "users" },
      ],
      [
        { quoted: false, role: "catalog", value: "memory" },
        { quoted: false, role: "schema", value: "main" },
        { quoted: false, role: "relation", value: "users" },
      ],
    ] as const;
    expect(
      paths.map((path) =>
        DUCKDB_SQL_RELATION_DIALECT.completion
          .renderRelationPath(path).status,
      ),
    ).toEqual(["rendered", "rendered", "rendered", "rendered"]);
  });

  it("renders BigQuery roles with role-specific dash handling", () => {
    const path = [
      { quoted: false, role: "project", value: "my-project" },
      { quoted: false, role: "dataset", value: "analytics" },
      { quoted: true, role: "relation", value: "select`events" },
    ] satisfies SqlCanonicalRelationPath;
    expect(
      BIGQUERY_SQL_RELATION_DIALECT.completion
        .renderRelationPath(path),
    ).toEqual({
      status: "rendered",
      text: "my-project.analytics.`select\\`events`",
    });
    const illegal = [
      { quoted: false, role: "project", value: "my-project" },
      { quoted: false, role: "relation", value: "events" },
    ] satisfies SqlCanonicalRelationPath;
    expect(
      BIGQUERY_SQL_RELATION_DIALECT.completion
        .renderRelationPath(illegal).status,
    ).toBe("unsupported");
  });

  it("renders a bounded Dremio source and folder hierarchy", () => {
    const path = [
      { quoted: false, role: "catalog", value: "Samples" },
      {
        quoted: true,
        role: "schema",
        value: "samples.dremio.com",
      },
      { quoted: false, role: "schema", value: "folder" },
      {
        quoted: true,
        role: "relation",
        value: "NYC \"trips\"",
      },
    ] satisfies SqlCanonicalRelationPath;
    expect(
      DREMIO_SQL_RELATION_DIALECT.completion
        .renderRelationPath(path),
    ).toEqual({
      status: "rendered",
      text:
        "Samples.\"samples.dremio.com\".\"folder\"." +
        "\"NYC \"\"trips\"\"\"",
    });
  });

  it("quotes reserved words even when provider spelling is bare", () => {
    const path = [
      { quoted: false, role: "relation", value: "select" },
    ] satisfies SqlCanonicalRelationPath;
    expect(
      POSTGRESQL_SQL_RELATION_DIALECT.completion
        .renderRelationPath(path),
    ).toEqual({ status: "rendered", text: "\"select\"" });
    expect(
      BIGQUERY_SQL_RELATION_DIALECT.completion
        .renderRelationPath(path),
    ).toEqual({ status: "rendered", text: "`select`" });
  });

  it("round-trips rendered paths through the query decoder", () => {
    const cases = [
      {
        path: [
          { quoted: false, role: "schema", value: "public" },
          {
            quoted: true,
            role: "relation",
            value: "User.Events",
          },
        ] satisfies SqlCanonicalRelationPath,
        runtime: POSTGRESQL_SQL_RELATION_DIALECT,
      },
      {
        path: [
          { quoted: false, role: "catalog", value: "memory" },
          { quoted: false, role: "schema", value: "main" },
          { quoted: false, role: "relation", value: "users" },
        ] satisfies SqlCanonicalRelationPath,
        runtime: DUCKDB_SQL_RELATION_DIALECT,
      },
      {
        path: [
          { quoted: false, role: "project", value: "my-project" },
          { quoted: false, role: "dataset", value: "analytics" },
          {
            quoted: true,
            role: "relation",
            value: "event`stream",
          },
        ] satisfies SqlCanonicalRelationPath,
        runtime: BIGQUERY_SQL_RELATION_DIALECT,
      },
      {
        path: [
          { quoted: false, role: "catalog", value: "Samples" },
          {
            quoted: true,
            role: "schema",
            value: "samples.dremio.com",
          },
          { quoted: false, role: "relation", value: "trips" },
        ] satisfies SqlCanonicalRelationPath,
        runtime: DREMIO_SQL_RELATION_DIALECT,
      },
    ];
    for (const { path, runtime } of cases) {
      const rendered = runtime.completion.renderRelationPath(path);
      expect(rendered.status).toBe("rendered");
      if (rendered.status !== "rendered") {
        throw new Error("Expected a rendered path");
      }
      const decodedPath = readyPath(runtime, rendered.text);
      expect([
        ...decodedPath.qualifier.map((item) => item.value),
        decodedPath.prefix.value,
      ]).toEqual(path.map((item) => item.value));
    }
  });

  it("returns frozen results and fails closed on malformed paths", () => {
    const valid = [
      { quoted: false, role: "relation", value: "users" },
    ] satisfies SqlCanonicalRelationPath;
    const rendered =
      POSTGRESQL_SQL_RELATION_DIALECT.completion
        .renderRelationPath(valid);
    expect(Object.isFrozen(rendered)).toBe(true);
    expect(
      Reflect.apply(
        POSTGRESQL_SQL_RELATION_DIALECT.completion
          .renderRelationPath,
        undefined,
        [[]],
      ),
    ).toEqual({
      reason: "illegal-role-sequence",
      status: "unsupported",
    });
  });
});

describe("recognizer integration", () => {
  it.each([
    ["postgresql", POSTGRESQL_SQL_RELATION_DIALECT, "\"Recent\""],
    ["duckdb", DUCKDB_SQL_RELATION_DIALECT, "\"Recent\""],
    ["bigquery", BIGQUERY_SQL_RELATION_DIALECT, "`Recent`"],
    ["dremio", DREMIO_SQL_RELATION_DIALECT, "\"Recent\""],
  ] as const)(
    "feeds one coherent runtime into CTE analysis for %s",
    (_name, runtime, cteName) => {
      const text =
        `WITH ${cteName} AS (SELECT 1) ` +
        `SELECT * FROM ${cteName}`;
      const layout = analyze(runtime, text);
      expect(layout.status).not.toBe("unavailable");
      if (layout.status === "unavailable") {
        throw new Error("Expected CTE layout evidence");
      }
      expect(layout.declarations).toHaveLength(1);
      expect(layout.declarations[0]?.name.value).toBe("Recent");
    },
  );

  it("accepts contextual materialized CTE and column names", () => {
    const layout = analyze(
      POSTGRESQL_SQL_RELATION_DIALECT,
      "WITH materialized(materialized) AS (SELECT 1) " +
        "SELECT * FROM materialized",
    );
    expect(layout.status).not.toBe("unavailable");
    if (layout.status === "unavailable") {
      throw new Error("Expected CTE layout evidence");
    }
    expect(layout.declarations[0]).toMatchObject({
      name: { value: "materialized" },
    });
  });
});
