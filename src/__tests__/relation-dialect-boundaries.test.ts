import { describe, expect, it } from "vitest";
import {
  BIGQUERY_SQL_RELATION_DIALECT,
  DREMIO_SQL_RELATION_DIALECT,
  DUCKDB_SQL_RELATION_DIALECT,
  POSTGRESQL_SQL_RELATION_DIALECT,
} from "../relation-dialect.js";

const INVALID_IDENTIFIER = {
  reason: "invalid-identifier",
  status: "unavailable",
};
const UNSUPPORTED_PATH = {
  reason: "illegal-role-sequence",
  status: "unsupported",
};

function identifier(value: string, quoted = false) {
  return { quoted, value };
}

describe("relation dialect boundary behavior", () => {
  it("rejects malformed standard quoted identifiers at every boundary", () => {
    const decode =
      POSTGRESQL_SQL_RELATION_DIALECT.completion.decodeIdentifier;
    for (const token of [
      "\"\"",
      "\"nul\0name\"",
      "\"bad\"quote\"",
      `"${"x".repeat(257)}"`,
      "\"\ud800\"",
      "\"\udc00\"",
    ]) {
      expect(decode(token, "complete")).toEqual(INVALID_IDENTIFIER);
    }
    expect(decode("\"a😀z\"", "complete")).toMatchObject({
      component: { quoted: true, value: "a😀z" },
      status: "decoded",
    });
  });

  it("accepts all BigQuery escape classes and rejects invalid values", () => {
    const decode =
      BIGQUERY_SQL_RELATION_DIALECT.completion.decodeIdentifier;
    expect(
      decode(
        "`\\\"\\'\\?\\\\\\`\\a\\b\\f\\n\\r\\t\\v\\101\\x42\\X43\\u0044\\U0001F600`",
        "complete",
      ),
    ).toMatchObject({
      component: {
        quoted: true,
        value: "\"'?\\`\u0007\b\f\n\r\t\vABCD😀",
      },
      quality: "exact",
      status: "decoded",
    });
    for (const token of [
      "``",
      "`line\nbreak`",
      "`line\rbreak`",
      "`nul\0byte`",
      "`trailing\\`",
      "`\\8`",
      "`\\xGG`",
      "`\\u0g00`",
      "`\\U0000D800`",
      `\`${"x".repeat(257)}\``,
    ]) {
      expect(decode(token, "complete")).toEqual(INVALID_IDENTIFIER);
    }
    expect(decode("`ends\\\\`", "complete")).toMatchObject({
      component: { quoted: true, value: "ends\\" },
      status: "decoded",
    });
    expect(decode("`\\777`", "complete")).toMatchObject({
      component: { quoted: true, value: "ǿ" },
      status: "decoded",
    });
  });

  it("bounds hostile raw identifier inputs before decoding", () => {
    const oversized = "x".repeat(100_000);
    expect(
      POSTGRESQL_SQL_RELATION_DIALECT.completion.decodeIdentifier(
        `"${oversized}`,
        "completion-prefix",
      ),
    ).toEqual(INVALID_IDENTIFIER);
    expect(
      BIGQUERY_SQL_RELATION_DIALECT.completion.decodeIdentifier(
        `\`${oversized}`,
        "completion-prefix",
      ),
    ).toEqual(INVALID_IDENTIFIER);
  });

  it("keeps classification fail-closed across raw runtime calls", () => {
    const query =
      POSTGRESQL_SQL_RELATION_DIALECT.querySite
        .classifyIdentifierToken;
    const cte =
      POSTGRESQL_SQL_RELATION_DIALECT.cteLayout
        .classifyIdentifierToken;

    expect(
      Reflect.apply(query, undefined, [null, false, "explicit-alias"]),
    ).toEqual({ status: "unsupported" });
    expect(
      Reflect.apply(query, undefined, ["users", "false", "explicit-alias"]),
    ).toEqual({ status: "unsupported" });
    expect(
      Reflect.apply(query, undefined, ["users", false, "bad-role"]),
    ).toEqual({ status: "unsupported" });
    expect(query("Users", false, "explicit-alias")).toEqual({
      status: "identifier",
      value: "Users",
    });
    expect(query("Users", false, "using-column")).toEqual({
      status: "identifier",
      value: "Users",
    });
    expect(query("\"Users\"", false, "implicit-alias")).toEqual({
      status: "unsupported",
    });
    expect(query("Éclair", false, "implicit-alias")).toEqual({
      status: "identifier",
      value: "Éclair",
    });

    expect(
      Reflect.apply(cte, undefined, [null, false, "cte-name"]),
    ).toEqual({ status: "unsupported" });
    expect(
      Reflect.apply(cte, undefined, ["users", "false", "cte-name"]),
    ).toEqual({ status: "unsupported" });
    expect(
      Reflect.apply(cte, undefined, ["users", false, "bad-role"]),
    ).toEqual({ status: "unsupported" });
    expect(cte("not", false, "cte-column")).toEqual({
      status: "unsupported",
    });
    expect(cte("Users", false, "cte-column")).toMatchObject({
      status: "identifier",
      value: { component: { quoted: false, value: "Users" } },
    });
    expect(cte("\"Users\"", false, "cte-name")).toEqual({
      status: "unsupported",
    });
  });
});

describe("relation path boundary behavior", () => {
  it("handles quoted cursor edges and rejects malformed qualifiers", () => {
    const decode =
      POSTGRESQL_SQL_RELATION_DIALECT.querySite.decodeRelationPath;
    expect(decode("\"Users\"", 0)).toMatchObject({
      finalSegment: { from: 0, to: 7 },
      prefix: { quoted: true, value: "" },
      quality: "exact",
      status: "decoded",
    });
    expect(decode("\"a\"\"b\".us", 9)).toMatchObject({
      prefix: { value: "us" },
      qualifier: [{ quoted: true, value: "a\"b" }],
      status: "decoded",
    });
    expect(decode("public.\"unterminated.users", 26)).toMatchObject({
      prefix: { quoted: true, value: "unterminated.users" },
      qualifier: [{ value: "public" }],
      quality: "recovered",
      status: "decoded",
    });
    for (const path of [
      "public.us\"ers",
      "\"public\"x.users",
      "select.users",
      "\ud800.users",
    ]) {
      expect(decode(path, path.length)).toEqual(INVALID_IDENTIFIER);
    }
  });

  it("enforces BigQuery bare-component and dash rules", () => {
    const decode =
      BIGQUERY_SQL_RELATION_DIALECT.querySite.decodeRelationPath;
    for (const path of [
      "-project.dataset.users",
      "project-.dataset.users",
      "project--x.dataset.users",
      "select.dataset.users",
      `${"x".repeat(257)}.dataset.users`,
      "\ud800.dataset.users",
    ]) {
      expect(decode(path, path.length)).toEqual(INVALID_IDENTIFIER);
    }
    expect(decode("project-123.dataset.us", 22)).toMatchObject({
      prefix: { value: "us" },
      qualifier: [
        { value: "project-123" },
        { value: "dataset" },
      ],
      status: "decoded",
    });
  });

  it("decodes every whole-backtick escape class in path components", () => {
    const decode =
      BIGQUERY_SQL_RELATION_DIALECT.querySite.decodeRelationPath;
    for (const [path, values] of [
      ["`\\141.\\x62.\\u0063`", ["a", "b", "c"]],
      ["`\\X61.\\U00000062.c`", ["a", "b", "c"]],
      ["`a\\?.b.c`", ["a?", "b", "c"]],
    ] as const) {
      const result = decode(path, path.length);
      expect(result.status).toBe("decoded");
      if (result.status === "decoded") {
        expect([
          ...result.qualifier.map((item) => item.value),
          result.prefix.value,
        ]).toEqual(values);
      }
    }
  });

  it("rejects malformed whole-backtick paths and invalid cursor regions", () => {
    const decode =
      BIGQUERY_SQL_RELATION_DIALECT.querySite.decodeRelationPath;
    for (const [path, cursor] of [
      ["`a..b`", 6],
      ["`a.b.`", 6],
      ["`a.b.c.d`", 9],
      ["`a.b.c`", 0],
      ["`a.b.c`", 2],
      ["`\\xGG.b.c`", 11],
      ["`a.b.\\xGG`", 11],
      ["`a`junk", 7],
    ] as const) {
      expect(decode(path, cursor)).toEqual(INVALID_IDENTIFIER);
    }
    expect(decode("`a.b\\`", 6)).toMatchObject({
      prefix: { quoted: true, value: "b`" },
      qualifier: [{ quoted: true, value: "a" }],
      quality: "recovered",
      status: "decoded",
    });
  });

  it("fails closed for non-string and hostile path inputs", () => {
    const decode =
      DREMIO_SQL_RELATION_DIALECT.querySite.decodeRelationPath;
    expect(
      Reflect.apply(decode, undefined, [null, 0]),
    ).toEqual(INVALID_IDENTIFIER);
    expect(
      Reflect.apply(decode, undefined, ["users", "5"]),
    ).toEqual(INVALID_IDENTIFIER);
    expect(
      decode("x".repeat(100_000), 100_000),
    ).toEqual(INVALID_IDENTIFIER);
  });
});

describe("comparison and prefix boundaries", () => {
  it("covers exact, short-prefix, and mixed quoting decisions", () => {
    const postgres = POSTGRESQL_SQL_RELATION_DIALECT.completion;
    expect(
      postgres.compareCteIdentifiers(
        identifier("Users", true),
        identifier("Users", true),
      ),
    ).toBe("equal");
    expect(
      postgres.cteIdentifierMatchesPrefix(
        identifier("Users"),
        identifier(""),
      ),
    ).toBe("match");
    expect(
      postgres.cteIdentifierMatchesPrefix(
        identifier("Users", true),
        identifier("Use", true),
      ),
    ).toBe("match");
    expect(
      postgres.cteIdentifierMatchesPrefix(
        identifier("us"),
        identifier("users"),
      ),
    ).toBe("no-match");
    expect(
      postgres.cteIdentifierMatchesPrefix(
        identifier("É", true),
        identifier("Éclair", true),
      ),
    ).toBe("no-match");

    const duckdb = DUCKDB_SQL_RELATION_DIALECT.completion;
    expect(
      duckdb.cteIdentifierMatchesPrefix(
        identifier("Users"),
        identifier(""),
      ),
    ).toBe("match");
    expect(
      duckdb.cteIdentifierMatchesPrefix(
        identifier("Users"),
        identifier("Use"),
      ),
    ).toBe("match");
    expect(
      duckdb.cteIdentifierMatchesPrefix(
        identifier("us"),
        identifier("users"),
      ),
    ).toBe("no-match");
  });

  it("rejects every malformed comparison component shape", () => {
    const runtime = DUCKDB_SQL_RELATION_DIALECT.completion;
    for (const malformed of [
      null,
      "users",
      {},
      { quoted: "false", value: "users" },
      { quoted: false, value: 1 },
      { quoted: false, value: "" },
      { quoted: false, value: "x".repeat(257) },
      { quoted: false, value: "nul\0name" },
      { quoted: false, value: "\udc00" },
    ]) {
      expect(
        Reflect.apply(runtime.compareCteIdentifiers, undefined, [
          malformed,
          identifier("users"),
        ]),
      ).toBe("unknown");
    }
    expect(
      Reflect.apply(runtime.cteIdentifierMatchesPrefix, undefined, [
        identifier("users"),
        { quoted: false, value: 1 },
      ]),
    ).toBe("unknown");
  });

  it("snapshots comparison getters once", () => {
    let reads = 0;
    const stateful = {
      get quoted() {
        return false;
      },
      get value() {
        reads += 1;
        if (reads > 1) {
          throw new Error("value was read twice");
        }
        return "Users";
      },
    };
    expect(
      Reflect.apply(
        DUCKDB_SQL_RELATION_DIALECT.completion
          .compareCteIdentifiers,
        undefined,
        [stateful, identifier("users")],
      ),
    ).toBe("equal");
    expect(reads).toBe(1);
  });
});

describe("relation rendering boundaries", () => {
  it("escapes every BigQuery control and delimiter class", () => {
    const rendered =
      BIGQUERY_SQL_RELATION_DIALECT.completion.renderRelationPath([
        {
          quoted: true,
          role: "relation",
          value: "`\\\u0007\b\t\n\v\f\r\u0001\u007f",
        },
      ]);
    expect(rendered).toEqual({
      status: "rendered",
      text: "`\\`\\\\\\a\\b\\t\\n\\v\\f\\r\\x01\\x7f`",
    });
  });

  it("accepts only dialect-legal role sequences", () => {
    expect(
      BIGQUERY_SQL_RELATION_DIALECT.completion.renderRelationPath([
        { quoted: false, role: "dataset", value: "analytics" },
        { quoted: false, role: "relation", value: "events" },
      ]).status,
    ).toBe("rendered");
    expect(
      BIGQUERY_SQL_RELATION_DIALECT.completion.renderRelationPath([
        { quoted: false, role: "relation", value: "events-2026" },
      ]),
    ).toEqual({ status: "rendered", text: "events-2026" });
    expect(
      DREMIO_SQL_RELATION_DIALECT.completion.renderRelationPath([
        { quoted: false, role: "schema", value: "folder" },
        { quoted: false, role: "schema", value: "nested" },
        { quoted: false, role: "relation", value: "events" },
      ]).status,
    ).toBe("rendered");

    for (const [render, path] of [
      [
        POSTGRESQL_SQL_RELATION_DIALECT.completion.renderRelationPath,
        [{ quoted: false, role: "schema", value: "public" }],
      ],
      [
        DUCKDB_SQL_RELATION_DIALECT.completion.renderRelationPath,
        [
          { quoted: false, role: "schema", value: "main" },
          { quoted: false, role: "catalog", value: "memory" },
          { quoted: false, role: "relation", value: "events" },
        ],
      ],
      [
        DREMIO_SQL_RELATION_DIALECT.completion.renderRelationPath,
        [
          { quoted: false, role: "catalog", value: "source" },
          { quoted: false, role: "project", value: "bad" },
          { quoted: false, role: "relation", value: "events" },
        ],
      ],
    ] as const) {
      expect(Reflect.apply(render, undefined, [path])).toEqual(
        UNSUPPORTED_PATH,
      );
    }
  });

  it("fails closed for malformed and hostile rendering inputs", () => {
    const render =
      POSTGRESQL_SQL_RELATION_DIALECT.completion.renderRelationPath;
    for (const path of [
      null,
      "users",
      [null],
      ["users"],
      [{ quoted: false, role: 1, value: "users" }],
      [{ quoted: "false", role: "relation", value: "users" }],
      [{ quoted: false, role: "relation", value: 1 }],
      [{ quoted: false, role: "relation", value: "" }],
      [{ quoted: false, role: "relation", value: "x".repeat(257) }],
      [{ quoted: false, role: "relation", value: "nul\0name" }],
      [{ quoted: false, role: "relation", value: "\ud800" }],
    ]) {
      expect(Reflect.apply(render, undefined, [path])).toEqual(
        UNSUPPORTED_PATH,
      );
    }

    const hostile = new Proxy([], {
      get() {
        throw new Error("hostile path");
      },
    });
    expect(
      Reflect.apply(render, undefined, [hostile]),
    ).toEqual(UNSUPPORTED_PATH);
  });

  it("uses bounded indexing and snapshots rendered component getters", () => {
    const path: [
      {
        readonly quoted: false;
        readonly role: "relation";
        readonly value: "users";
      },
    ] = [
      {
        quoted: false,
        role: "relation",
        value: "users",
      },
    ];
    Object.defineProperty(path, Symbol.iterator, {
      value: function* () {
        while (true) {
          yield path[0];
        }
      },
    });
    expect(
      POSTGRESQL_SQL_RELATION_DIALECT.completion
        .renderRelationPath(path),
    ).toEqual({ status: "rendered", text: "users" });

    let reads = 0;
    const stateful = {
      get quoted() {
        return false;
      },
      get role() {
        return "relation";
      },
      get value() {
        reads += 1;
        if (reads > 1) {
          throw new Error("value was read twice");
        }
        return "users";
      },
    };
    expect(
      Reflect.apply(
        POSTGRESQL_SQL_RELATION_DIALECT.completion
          .renderRelationPath,
        undefined,
        [[stateful]],
      ),
    ).toEqual({ status: "rendered", text: "users" });
    expect(reads).toBe(1);
  });
});
