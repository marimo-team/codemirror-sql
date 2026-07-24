import { describe, expect, it } from "vitest";
import {
  bigQueryDialect,
  createSqlLanguageService,
  dremioDialect,
  duckdbDialect,
  postgresDialect,
  SqlSessionError,
} from "../index.js";
import { DefaultSqlLanguageService } from "../session.js";
import {
  BIGQUERY_SQL_LEXICAL_PROFILE,
  buildSqlStatementIndex,
  DREMIO_SQL_LEXICAL_PROFILE,
  DUCKDB_SQL_LEXICAL_PROFILE,
  POSTGRESQL_SQL_LEXICAL_PROFILE,
} from "../statement-index.js";
import type {
  SqlDocumentContext,
  SqlDocumentReplacement,
} from "../types.js";

interface TestContext extends SqlDocumentContext {
  readonly engine: string;
  readonly settings?: {
    readonly flags: readonly boolean[];
  };
}

const duckdb = duckdbDialect();
const postgres = postgresDialect();

function createService() {
  return new DefaultSqlLanguageService<TestContext>({
    dialects: [duckdb, postgres],
  });
}

function openSession(text = "SELECT * FROM users") {
  const service = createService();
  const session = service.openDocument({
    context: { dialect: "duckdb", engine: "local" },
    text,
  });
  return { service, session };
}

function expectSessionError(code: SqlSessionError["code"], callback: () => unknown) {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(SqlSessionError);
    expect((error as SqlSessionError).code).toBe(code);
    return;
  }
  throw new Error(`Expected SqlSessionError: ${code}`);
}

describe("dialect definitions", () => {
  it("creates immutable singleton definitions", () => {
    expect(duckdb).toEqual({
      displayName: "DuckDB",
      id: "duckdb",
    });
    expect(Object.isFrozen(duckdb)).toBe(true);
    expect(duckdbDialect()).toBe(duckdb);
    expect(postgresDialect()).toBe(postgres);
    expect(bigQueryDialect()).toBe(bigQueryDialect());
    expect(dremioDialect()).toBe(dremioDialect());
  });

  it("rejects duplicate IDs", () => {
    expectSessionError("duplicate-dialect", () => {
      createSqlLanguageService({
        dialects: [duckdb, duckdbDialect()],
      });
    });
  });

  it("rejects copied and fabricated definitions without invoking traps", () => {
    let invoked = false;
    expectSessionError("invalid-dialect", () => {
      createSqlLanguageService({
        dialects: [{ ...duckdb }],
      });
    });
    expectSessionError("invalid-dialect", () => {
      createSqlLanguageService({
        dialects: [{ displayName: "DuckDB", id: "duckdb" } as never],
      });
    });
    expectSessionError("invalid-dialect", () => {
      createSqlLanguageService({ dialects: [null as never] });
    });
    expectSessionError("invalid-dialect", () => {
      createSqlLanguageService({
        dialects: [
          new Proxy(duckdb, {
            get() {
              invoked = true;
              throw new Error("hostile");
            },
            getOwnPropertyDescriptor() {
              invoked = true;
              throw new Error("hostile");
            },
            ownKeys() {
              invoked = true;
              throw new Error("hostile");
            },
          },
          ) as never,
        ],
      });
    });
    expect(invoked).toBe(false);
  });
});

describe("statement-index session cache", () => {
  it("binds lexical behavior through authentic dialect handles", () => {
    const service = new DefaultSqlLanguageService<TestContext>({
      dialects: [
        bigQueryDialect(),
        dremioDialect(),
        duckdb,
        postgres,
      ],
    });
    const cases = [
      {
        dialect: "bigquery",
        profile: BIGQUERY_SQL_LEXICAL_PROFILE,
        text: "# hidden; still hidden\nSELECT r'''a;b''';",
      },
      {
        dialect: "dremio",
        profile: DREMIO_SQL_LEXICAL_PROFILE,
        text: "# code; SELECT $$a;b$$;",
      },
      {
        dialect: "duckdb",
        profile: DUCKDB_SQL_LEXICAL_PROFILE,
        text: "SELECT $$a;b$$; /* outer /* inner; */ done */",
      },
      {
        dialect: "postgresql",
        profile: POSTGRESQL_SQL_LEXICAL_PROFILE,
        text: "SELECT E'a\\';b'; SELECT $tag$c;d$tag$;",
      },
    ] as const;

    for (const testCase of cases) {
      const session = service.openDocument({
        context: {
          dialect: testCase.dialect,
          engine: "warehouse",
        },
        text: testCase.text,
      });
      expect(session.getStatementIndexForTesting()).toEqual(
        buildSqlStatementIndex(testCase.text, testCase.profile),
      );
    }
  });

  it("builds lazily and reuses the current cache", () => {
    const { session } = openSession("SELECT 1; SELECT 2");
    expect(session.cachedStatementIndexForTesting).toBeNull();

    const index = session.getStatementIndexForTesting();
    expect(session.cachedStatementIndexForTesting).toBe(index);
    expect(session.getStatementIndexForTesting()).toBe(index);
  });

  it("retains the index for unrelated context changes", () => {
    const { session } = openSession("SELECT 1; SELECT 2");
    const index = session.getStatementIndexForTesting();
    session.update({
      baseRevision: session.revision,
      context: { dialect: "duckdb", engine: "remote" },
    });
    expect(session.cachedStatementIndexForTesting).toBe(index);
  });

  it("invalidates the index when lexical profile identity changes", () => {
    const { session } = openSession("SELECT $$a;b$$;");
    const index = session.getStatementIndexForTesting();
    session.update({
      baseRevision: session.revision,
      context: { dialect: "postgresql", engine: "warehouse" },
    });
    expect(session.cachedStatementIndexForTesting).toBeNull();
    expect(session.getStatementIndexForTesting()).not.toBe(index);
  });

  it("reuses the index across no-op document mutations", () => {
    const { session } = openSession("SELECT 1");
    const initialSource = session.snapshotForTesting.source;
    const index = session.getStatementIndexForTesting();

    session.update({
      embeddedRegions: [],
      baseRevision: session.revision,
      document: { kind: "changes", changes: [] },
    });
    expect(session.snapshotForTesting.source).toBe(initialSource);
    expect(session.cachedStatementIndexForTesting).toBe(index);

    session.update({
      embeddedRegions: [],
      baseRevision: session.revision,
      document: { kind: "replace", text: "SELECT 1" },
    });
    expect(session.cachedStatementIndexForTesting).toBe(index);
  });

  it("updates incrementally to the full-scan oracle", () => {
    const { session } = openSession("SELECT 1; SELECT 2; SELECT 3");
    const previous = session.getStatementIndexForTesting();
    session.update({
      embeddedRegions: [],
      baseRevision: session.revision,
      document: {
        kind: "changes",
        changes: [{ from: 17, insert: "20", to: 18 }],
      },
    });

    const cached = session.cachedStatementIndexForTesting;
    expect(cached).not.toBeNull();
    expect(cached).toEqual(
      buildSqlStatementIndex(
        "SELECT 1; SELECT 20; SELECT 3",
        DUCKDB_SQL_LEXICAL_PROFILE,
      ),
    );
    expect(cached).not.toBe(previous);
    expect(cached?.slots[0]).toBe(previous.slots[0]);
  });

  it("clears changed replacements and preserves the cache on failure", () => {
    const { session } = openSession("SELECT 1");
    const index = session.getStatementIndexForTesting();
    const revision = session.revision;
    expectSessionError("stale-revision", () => {
      session.update({
        embeddedRegions: [],
        baseRevision: {} as never,
        document: { kind: "replace", text: "SELECT 2" },
      });
    });
    expect(session.revision).toBe(revision);
    expect(session.cachedStatementIndexForTesting).toBe(index);

    session.update({
      embeddedRegions: [],
      baseRevision: session.revision,
      document: { kind: "replace", text: "SELECT 2" },
    });
    expect(session.cachedStatementIndexForTesting).toBeNull();
  });

  it("releases the cache on disposal", () => {
    const { session } = openSession();
    session.getStatementIndexForTesting();
    session.dispose();
    expect(session.cachedStatementIndexForTesting).toBeNull();
    expectSessionError("session-disposed", () => {
      session.getStatementIndexForTesting();
    });
  });
});

describe("document revisions", () => {
  it("starts with a frozen current revision", () => {
    const { session } = openSession();
    expect(Object.isFrozen(session.revision)).toBe(true);
    expect(session.isCurrent(session.revision)).toBe(true);
  });

  it("advances monotonically, including A to B to A", () => {
    const { session } = openSession("A");
    const first = session.revision;
    const second = session.update({
      embeddedRegions: [],
      baseRevision: first,
      document: { kind: "replace", text: "B" },
    });
    const third = session.update({
      embeddedRegions: [],
      baseRevision: second,
      document: { kind: "replace", text: "A" },
    });

    expect(session.isCurrent(first)).toBe(false);
    expect(session.isCurrent(second)).toBe(false);
    expect(session.isCurrent(third)).toBe(true);
    expect(third).not.toBe(first);
  });

  it("never accepts another session's revision", () => {
    const first = openSession();
    const second = openSession();

    expect(first.session.isCurrent(second.session.revision)).toBe(false);
    expectSessionError("stale-revision", () => {
      first.session.update({
        embeddedRegions: [],
        baseRevision: second.session.revision,
        document: { kind: "replace", text: "SELECT 1" },
      });
    });
  });

  it("rejects fabricated revisions", () => {
    const { session } = openSession();
    expect(session.isCurrent({} as never)).toBe(false);
  });

  it("makes an empty accepted update a new revision", () => {
    const { session } = openSession();
    const first = session.revision;
    const second = session.update({
      embeddedRegions: [],
      baseRevision: first,
      document: { kind: "changes", changes: [] },
    });
    expect(second).not.toBe(first);
    expect(session.isCurrent(second)).toBe(true);
  });

  it("makes a same-text replacement a new revision", () => {
    const { session } = openSession("SELECT 1");
    const first = session.revision;
    const second = session.update({
      embeddedRegions: [],
      baseRevision: first,
      document: { kind: "replace", text: "SELECT 1" },
    });
    expect(second).not.toBe(first);
  });

  it("reuses source snapshots when text and regions are unchanged", () => {
    const { session } = openSession("SELECT 1");
    const initialSource = session.snapshotForTesting.source;
    expect(Object.isFrozen(initialSource)).toBe(true);
    expect(initialSource.analysisText).toBe(initialSource.originalText);

    session.update({
      baseRevision: session.revision,
      context: { dialect: "duckdb", engine: "remote" },
    });
    expect(session.snapshotForTesting.source).toBe(initialSource);

    session.update({
      embeddedRegions: [],
      baseRevision: session.revision,
      document: { kind: "changes", changes: [] },
    });
    expect(session.snapshotForTesting.source).toBe(initialSource);
    expect(session.snapshotForTesting.source.originalText).toBe("SELECT 1");
  });
});

describe("embedded-region session transactions", () => {
  it("opens omitted, empty, and masked sources with owned frozen regions", () => {
    const service = createService();
    const omitted = service.openDocument({
      context: { dialect: "duckdb", engine: "local" },
      text: "SELECT 1",
    });
    const empty = service.openDocument({
      context: { dialect: "duckdb", engine: "local" },
      embeddedRegions: [],
      text: "SELECT 1",
    });
    const region = { from: 14, language: "python", to: 18 };
    const regions = [region];
    const masked = service.openDocument({
      context: { dialect: "duckdb", engine: "local" },
      embeddedRegions: regions,
      text: "SELECT * FROM {df}",
    });

    region.from = 0;
    regions.length = 0;
    expect(omitted.snapshotForTesting.source.analysisText).toBe("SELECT 1");
    expect(empty.snapshotForTesting.source.analysisText).toBe("SELECT 1");
    expect(masked.snapshotForTesting.source).toMatchObject({
      analysisText: "SELECT * FROM     ",
      embeddedRegions: [{ from: 14, language: "python", to: 18 }],
      originalText: "SELECT * FROM {df}",
    });
    expect(Object.isFrozen(masked.snapshotForTesting.source)).toBe(true);
    expect(Object.isFrozen(masked.snapshotForTesting.source.embeddedRegions)).toBe(
      true,
    );
    expect(
      Object.isFrozen(masked.snapshotForTesting.source.embeddedRegions[0]),
    ).toBe(true);
  });

  it("indexes masked analysis rather than embedded SQL-like text", () => {
    const service = createService();
    const session = service.openDocument({
      context: { dialect: "duckdb", engine: "local" },
      embeddedRegions: [{ from: 7, language: "python", to: 12 }],
      text: "SELECT {x;y}; SELECT 2",
    });

    const source = session.snapshotForTesting.source;
    expect(session.getStatementIndexForTesting()).toEqual(
      buildSqlStatementIndex(
        source.analysisText,
        DUCKDB_SQL_LEXICAL_PROFILE,
      ),
    );
    expect(source.analysisText).toBe("SELECT      ; SELECT 2");
  });

  it("commits text, context, and post-edit regions in one revision", () => {
    const service = createService();
    const session = service.openDocument({
      context: { dialect: "duckdb", engine: "local" },
      embeddedRegions: [{ from: 14, language: "python", to: 18 }],
      text: "SELECT * FROM {df}",
    });
    const previous = session.revision;

    const revision = session.update({
      baseRevision: previous,
      context: { dialect: "postgresql", engine: "warehouse" },
      document: {
        changes: [{ from: 15, insert: "next_df", to: 17 }],
        kind: "changes",
      },
      embeddedRegions: [{ from: 14, language: "python", to: 23 }],
    });

    expect(revision).not.toBe(previous);
    expect(session.snapshotForTesting).toMatchObject({
      context: { dialect: "postgresql", engine: "warehouse" },
      source: {
        analysisText: "SELECT * FROM          ",
        embeddedRegions: [{ from: 14, language: "python", to: 23 }],
        originalText: "SELECT * FROM {next_df}",
      },
    });
  });

  it("supports region-only, context-plus-region, and explicit clear updates", () => {
    const { session } = openSession("SELECT * FROM {df}");
    const initial = session.snapshotForTesting;

    session.update({
      baseRevision: session.revision,
      embeddedRegions: [{ from: 14, language: "python", to: 18 }],
    });
    expect(session.snapshotForTesting.documentSequence).toBe(
      initial.documentSequence,
    );
    expect(session.snapshotForTesting.source.analysisText).toBe(
      "SELECT * FROM     ",
    );

    session.update({
      baseRevision: session.revision,
      context: { dialect: "duckdb", engine: "remote" },
      embeddedRegions: [{ from: 14, language: "jinja", to: 18 }],
    });
    expect(session.snapshotForTesting.context.engine).toBe("remote");
    expect(session.snapshotForTesting.source.embeddedRegions[0]?.language).toBe(
      "jinja",
    );

    session.update({
      baseRevision: session.revision,
      embeddedRegions: [],
    });
    expect(session.snapshotForTesting.source.analysisText).toBe(
      "SELECT * FROM {df}",
    );
  });

  it("owns update regions and advances every accepted source transaction", () => {
    const { session } = openSession("SELECT * FROM {df}");
    const region = { from: 14, language: "python", to: 18 };
    const regions = [region];
    const initial = session.snapshotForTesting;

    const firstRevision = session.update({
      baseRevision: initial.revision,
      embeddedRegions: regions,
    });
    const first = session.snapshotForTesting;
    expect(first.revision).toBe(firstRevision);
    expect(first.sourceSequence).toBe(initial.sourceSequence + 1);

    region.from = 0;
    region.language = "jinja";
    regions.length = 0;
    expect(first.source.embeddedRegions).toEqual([
      { from: 14, language: "python", to: 18 },
    ]);

    const secondRevision = session.update({
      baseRevision: firstRevision,
      embeddedRegions: [{ from: 14, language: "python", to: 18 }],
    });
    const second = session.snapshotForTesting;
    expect(secondRevision).not.toBe(firstRevision);
    expect(second.sourceSequence).toBe(first.sourceSequence + 1);
    expect(second.source).toBe(first.source);

    session.update({
      baseRevision: secondRevision,
      embeddedRegions: [{ from: 14, language: "jinja", to: 18 }],
    });
    session.update({
      baseRevision: session.revision,
      embeddedRegions: [{ from: 14, language: "python", to: 18 }],
    });
    expect(session.snapshotForTesting.source.embeddedRegions).toEqual([
      { from: 14, language: "python", to: 18 },
    ]);
  });

  it("validates complete regions against the resulting document", () => {
    const { session } = openSession("A");
    session.update({
      baseRevision: session.revision,
      document: { kind: "replace", text: "ABCDE" },
      embeddedRegions: [{ from: 1, language: "python", to: 5 }],
    });
    expect(session.snapshotForTesting.source.analysisText).toBe("A    ");

    const snapshot = session.snapshotForTesting;
    expectSessionError("invalid-update", () => {
      session.update({
        baseRevision: snapshot.revision,
        document: { kind: "replace", text: "A" },
        embeddedRegions: [{ from: 1, language: "python", to: 5 }],
      });
    });
    expect(session.snapshotForTesting).toBe(snapshot);
  });

  it("creates and removes template delimiters in atomic transactions", () => {
    const { session } = openSession("SELECT * FROM df");

    session.update({
      baseRevision: session.revision,
      document: {
        changes: [
          { from: 14, insert: "{", to: 14 },
          { from: 16, insert: "}", to: 16 },
        ],
        kind: "changes",
      },
      embeddedRegions: [{ from: 14, language: "python", to: 18 }],
    });
    expect(session.snapshotForTesting.source).toMatchObject({
      analysisText: "SELECT * FROM     ",
      originalText: "SELECT * FROM {df}",
    });

    session.update({
      baseRevision: session.revision,
      document: {
        changes: [
          { from: 14, insert: "", to: 15 },
          { from: 17, insert: "", to: 18 },
        ],
        kind: "changes",
      },
      embeddedRegions: [],
    });
    expect(session.snapshotForTesting.source).toMatchObject({
      analysisText: "SELECT * FROM df",
      embeddedRegions: [],
      originalText: "SELECT * FROM df",
    });
  });

  it("rolls back document, context, source, revision, and cache together", () => {
    const { session } = openSession("SELECT 1; SELECT 2");
    const index = session.getStatementIndexForTesting();
    const snapshot = session.snapshotForTesting;

    expectSessionError("invalid-update", () => {
      session.update({
        baseRevision: snapshot.revision,
        context: { dialect: "postgresql", engine: "warehouse" },
        document: { kind: "replace", text: "SELECT {x}" },
        embeddedRegions: [{ from: 7, language: "python", to: 100 }],
      });
    });
    expect(session.snapshotForTesting).toBe(snapshot);
    expect(session.cachedStatementIndexForTesting).toBe(index);

    expectSessionError("invalid-dialect", () => {
      session.update({
        baseRevision: snapshot.revision,
        context: { dialect: "unknown", engine: "warehouse" },
        document: { kind: "replace", text: "SELECT 2" },
        embeddedRegions: [],
      });
    });
    expect(session.snapshotForTesting).toBe(snapshot);
    expect(session.cachedStatementIndexForTesting).toBe(index);
  });

  it("checks stale revisions before inspecting candidate payloads", () => {
    const { session } = openSession("SELECT 1");
    const stale = session.revision;
    session.update({
      baseRevision: stale,
      context: { dialect: "duckdb", engine: "remote" },
    });
    let invoked = false;
    const update = {
      baseRevision: stale,
      get document() {
        invoked = true;
        return { kind: "replace", text: "SELECT 2" };
      },
      get embeddedRegions() {
        invoked = true;
        return [];
      },
    };

    expectSessionError("stale-revision", () => {
      session.update(update as never);
    });
    expect(invoked).toBe(false);
  });

  it("reuses equal analysis and invalidates changed masking", () => {
    const service = createService();
    const session = service.openDocument({
      context: { dialect: "duckdb", engine: "local" },
      embeddedRegions: [{ from: 7, language: "python", to: 12 }],
      text: "SELECT {x;y}; SELECT 2",
    });
    const index = session.getStatementIndexForTesting();

    session.update({
      baseRevision: session.revision,
      embeddedRegions: [{ from: 7, language: "jinja", to: 12 }],
    });
    expect(session.cachedStatementIndexForTesting).toBe(index);

    session.update({
      baseRevision: session.revision,
      embeddedRegions: [],
    });
    expect(session.cachedStatementIndexForTesting).toBeNull();
    expect(session.getStatementIndexForTesting()).toEqual(
      buildSqlStatementIndex(
        session.snapshotForTesting.source.analysisText,
        DUCKDB_SQL_LEXICAL_PROFILE,
      ),
    );
  });

  it("does not incrementally reuse original edits across masking", () => {
    const service = createService();
    const session = service.openDocument({
      context: { dialect: "duckdb", engine: "local" },
      embeddedRegions: [{ from: 7, language: "python", to: 12 }],
      text: "SELECT {x;y}; SELECT 2",
    });
    session.getStatementIndexForTesting();

    session.update({
      baseRevision: session.revision,
      document: {
        changes: [{ from: 8, insert: "xx", to: 9 }],
        kind: "changes",
      },
      embeddedRegions: [{ from: 7, language: "python", to: 13 }],
    });
    expect(session.cachedStatementIndexForTesting).toBeNull();
    expect(session.getStatementIndexForTesting()).toEqual(
      buildSqlStatementIndex(
        session.snapshotForTesting.source.analysisText,
        DUCKDB_SQL_LEXICAL_PROFILE,
      ),
    );
  });

  it("accepts structural supersets without inspecting host metadata", () => {
    const service = createService();
    let invoked = false;
    const input = {
      context: { dialect: "duckdb", engine: "local" },
      embeddedRegions: [
        { from: 0, hostNodeId: "cell-1", language: "python", to: 1 },
      ],
      get hostMetadata() {
        invoked = true;
        throw new Error("must stay opaque");
      },
      text: "x",
    };
    const session = service.openDocument(input);
    expect(session.snapshotForTesting.source.analysisText).toBe(" ");

    const update = {
      baseRevision: session.revision,
      embeddedRegions: [
        { from: 0, hostNodeId: "cell-2", language: "jinja", to: 1 },
      ],
      get hostMetadata() {
        invoked = true;
        throw new Error("must stay opaque");
      },
      [Symbol("host")]: true,
    };
    session.update(update);
    expect(session.snapshotForTesting.source.embeddedRegions).toEqual([
      { from: 0, language: "jinja", to: 1 },
    ]);
    expect(invoked).toBe(false);
  });

  it("rejects malformed open and update region contracts", () => {
    const { session } = openSession("SELECT 1");
    const snapshot = session.snapshotForTesting;
    expectSessionError("invalid-update", () => {
      session.update({
        baseRevision: session.revision,
        document: { kind: "replace", text: "SELECT 2" },
        embeddedRegions: undefined,
      } as never);
    });
    expectSessionError("invalid-update", () => {
      session.update({
        baseRevision: session.revision,
        document: { kind: "replace", text: "SELECT 2" },
      } as never);
    });
    expectSessionError("invalid-update", () => {
      session.update({
        kind: "document",
        baseRevision: session.revision,
        embeddedRegions: [],
      } as never);
    });
    expect(session.snapshotForTesting).toBe(snapshot);
  });

  it("keeps a valid outer region update after a rejected reentrant update", () => {
    const { session } = openSession("x");
    let nestedError: SqlSessionError | undefined;
    let attempted = false;
    const region = new Proxy(
      { from: 0, language: "python", to: 1 },
      {
        getOwnPropertyDescriptor(target, property) {
          if (property === "from" && !attempted) {
            attempted = true;
            try {
              session.update({
                baseRevision: session.revision,
                context: { dialect: "duckdb", engine: "nested" },
              });
            } catch (error) {
              if (error instanceof SqlSessionError) {
                nestedError = error;
              }
            }
          }
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      },
    );

    session.update({
      baseRevision: session.revision,
      embeddedRegions: [region],
    });
    expect(nestedError?.code).toBe("reentrant-update");
    expect(session.snapshotForTesting.source.analysisText).toBe(" ");
  });

  it("lets disposal dominate a hostile region failure", () => {
    const { session } = openSession("x");
    const snapshot = session.snapshotForTesting;
    const region = new Proxy(
      { from: 0, language: "python", to: 1 },
      {
        getOwnPropertyDescriptor(target, property) {
          if (property === "from") {
            session.dispose();
            throw new Error("hostile");
          }
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      },
    );

    expectSessionError("session-disposed", () => {
      session.update({
        baseRevision: session.revision,
        embeddedRegions: [region],
      });
    });
    expect(session.snapshotForTesting).toBe(snapshot);
    expect(session.cachedStatementIndexForTesting).toBeNull();
    expect(session.isCurrent(snapshot.revision)).toBe(false);
  });
});

describe("document changes", () => {
  it("applies ordered changes in pre-update coordinates", () => {
    const { session } = openSession("SELECT users.id FROM users");
    session.update({
      embeddedRegions: [],
      baseRevision: session.revision,
      document: {
        kind: "changes",
        changes: [
          { from: 7, insert: "customers", to: 12 },
          { from: 21, insert: "customers", to: 26 },
        ],
      },
    });

    expect(session.snapshotForTesting.source.originalText).toBe(
      "SELECT customers.id FROM customers",
    );
  });

  it("uses JavaScript UTF-16 offsets", () => {
    const { session } = openSession("A😀B");
    session.update({
      embeddedRegions: [],
      baseRevision: session.revision,
      document: {
        kind: "changes",
        changes: [{ from: 1, insert: "X", to: 3 }],
      },
    });
    expect(session.snapshotForTesting.source.originalText).toBe("AXB");
  });

  it("keeps same-position insertions ordered", () => {
    const { session } = openSession("AB");
    session.update({
      embeddedRegions: [],
      baseRevision: session.revision,
      document: {
        kind: "changes",
        changes: [
          { from: 1, insert: "1", to: 1 },
          { from: 1, insert: "2", to: 1 },
        ],
      },
    });
    expect(session.snapshotForTesting.source.originalText).toBe("A12B");
  });

  it("supports adjacent replacements and document boundaries", () => {
    const { session } = openSession("ABCDE");
    session.update({
      embeddedRegions: [],
      baseRevision: session.revision,
      document: {
        kind: "changes",
        changes: [
          { from: 0, insert: "X", to: 1 },
          { from: 1, insert: "Y", to: 3 },
          { from: 3, insert: "Z", to: 5 },
          { from: 5, insert: "!", to: 5 },
        ],
      },
    });
    expect(session.snapshotForTesting.source.originalText).toBe("XYZ!");
  });

  it("deletes the entire document", () => {
    const { session } = openSession("SELECT 1");
    session.update({
      embeddedRegions: [],
      baseRevision: session.revision,
      document: { kind: "changes", changes: [{ from: 0, insert: "", to: 8 }] },
    });
    expect(session.snapshotForTesting.source.originalText).toBe("");
  });

  it("allows edits at every UTF-16 boundary", () => {
    const { session } = openSession("A😀e\u0301\r\nZ\uD800");
    session.update({
      embeddedRegions: [],
      baseRevision: session.revision,
      document: {
        kind: "changes",
        changes: [
          { from: 2, insert: "X", to: 3 },
          { from: 5, insert: "", to: 6 },
          { from: 8, insert: "!", to: 8 },
        ],
      },
    });
    expect(session.snapshotForTesting.source.originalText).toBe(
      "A\uD83DXe\u0301\nZ!\uD800",
    );
  });

  it.each([
    { from: -1, insert: "", to: 0 },
    { from: 0, insert: "", to: -1 },
    { from: 0.5, insert: "", to: 1 },
    { from: Number.NaN, insert: "", to: 1 },
    { from: 0, insert: "", to: Number.POSITIVE_INFINITY },
    { from: Number.MAX_SAFE_INTEGER + 1, insert: "", to: 1 },
    { from: 2, insert: "", to: 1 },
    { from: 0, insert: "", to: 100 },
  ])("rejects invalid range $from..$to atomically", (change) => {
    const { session } = openSession("ABC");
    const revision = session.revision;

    expectSessionError("invalid-change", () => {
      session.update({
        embeddedRegions: [],
        baseRevision: revision,
        document: { kind: "changes", changes: [change] },
      });
    });

    expect(session.revision).toBe(revision);
    expect(session.snapshotForTesting.source.originalText).toBe("ABC");
  });

  it("rejects unordered and overlapping changes atomically", () => {
    const { session } = openSession("ABCDE");
    const revision = session.revision;
    expectSessionError("invalid-change", () => {
      session.update({
        embeddedRegions: [],
        baseRevision: revision,
        document: {
          kind: "changes",
          changes: [
            { from: 2, insert: "", to: 4 },
            { from: 1, insert: "", to: 2 },
          ],
        },
      });
    });
    expect(session.revision).toBe(revision);
    expect(session.snapshotForTesting.source.originalText).toBe("ABCDE");
  });

  it("rejects non-string inserts from JavaScript callers", () => {
    const { session } = openSession("ABC");
    expectSessionError("invalid-change", () => {
      session.update({
        embeddedRegions: [],
        baseRevision: session.revision,
        document: {
          kind: "changes",
          changes: [{ from: 1, insert: 42, to: 2 }],
        },
      } as never);
    });
  });

  it.each([
    { document: {} },
    { document: { kind: "changes", changes: [], text: "SELECT 1" } },
    { document: { kind: "changes", changes: "invalid" } },
    { document: { kind: "replace", text: 42 } },
    { document: "invalid" },
    { document: null },
  ])("rejects an ambiguous JavaScript mutation", ({ document }) => {
    const { session } = openSession("ABC");
    const revision = session.revision;
    expectSessionError("invalid-update", () => {
      session.update({ embeddedRegions: [], baseRevision: revision, document } as never);
    });
    expect(session.revision).toBe(revision);
    expect(session.snapshotForTesting.source.originalText).toBe("ABC");
  });

  it("rejects an empty JavaScript update", () => {
    const { session } = openSession("ABC");
    expectSessionError("invalid-update", () => {
      session.update({ baseRevision: session.revision } as never);
    });
  });

  it("rejects unknown update and document kinds", () => {
    const { session } = openSession("ABC");
    expectSessionError("invalid-update", () => {
      session.update({
        kind: "unknown",
        baseRevision: session.revision,
      } as never);
    });
    expectSessionError("invalid-update", () => {
      session.update({
        embeddedRegions: [],
        baseRevision: session.revision,
        document: { kind: "unknown" },
      } as never);
    });
    expectSessionError("invalid-update", () => {
      session.update({
        embeddedRegions: [],
        baseRevision: session.revision,
        document: { kind: "replace", text: "ABC", changes: [] },
      } as never);
    });
    expectSessionError("invalid-update", () => {
      session.update({
        baseRevision: session.revision,
        context: undefined,
      } as never);
    });
    expectSessionError("invalid-update", () => {
      session.update({
        baseRevision: session.revision,
        context: { dialect: "duckdb", engine: "local" },
        document: { kind: "replace", text: "lost" },
      } as never);
    });
  });

  it("normalizes proxy inspection failures and resets the update guard", () => {
    const { session } = openSession("ABC");
    const update = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("hostile");
        },
      },
    );
    expectSessionError("invalid-update", () => {
      session.update(update as never);
    });
    session.update({
      embeddedRegions: [],
      baseRevision: session.revision,
      document: { kind: "replace", text: "recovered" },
    });
    expect(session.snapshotForTesting.source.originalText).toBe("recovered");
  });

  it.each([null, "invalid", 42])(
    "rejects a non-object JavaScript update",
    (update) => {
      const { session } = openSession("ABC");
      expectSessionError("invalid-update", () => {
        session.update(update as never);
      });
    },
  );

  it("rejects missing and accessor update fields without invoking accessors", () => {
    const { session } = openSession("ABC");
    let invoked = false;
    const accessor = {
      get baseRevision() {
        invoked = true;
        return session.revision;
      },
      document: { kind: "replace", text: "changed" },
    };

    expectSessionError("invalid-update", () => {
      session.update({ document: { kind: "replace", text: "changed" } } as never);
    });
    expectSessionError("invalid-update", () => {
      session.update(accessor as never);
    });
    expect(invoked).toBe(false);
    expect(session.snapshotForTesting.source.originalText).toBe("ABC");
  });

  it("rejects accessor optional update fields", () => {
    const { session } = openSession("ABC");
    const revision = session.revision;
    let invoked = false;
    const update = {
      baseRevision: session.revision,
      document: { kind: "replace", text: "changed" },
      embeddedRegions: [],
      get context() {
        invoked = true;
        return { dialect: "postgresql", engine: "warehouse" };
      },
    };
    expectSessionError("invalid-update", () => {
      session.update(update as never);
    });
    expect(invoked).toBe(false);
    expect(session.revision).toBe(revision);
    expect(session.snapshotForTesting.source.originalText).toBe("ABC");
  });

  it("treats undefined optional state fields as omission", () => {
    const service = createService();
    const session = service.openDocument({
      context: { dialect: "duckdb", engine: "local" },
      embeddedRegions: undefined,
      text: "SELECT 1",
    });

    const contextRevision = session.update({
      baseRevision: session.revision,
      context: { dialect: "duckdb", engine: "warehouse" },
      embeddedRegions: undefined,
    });
    expect(session.revision).toBe(contextRevision);
    expect(session.snapshotForTesting.context.engine).toBe("warehouse");

    const documentRevision = session.update({
      baseRevision: session.revision,
      context: undefined,
      document: { kind: "replace", text: "SELECT 2" },
      embeddedRegions: [],
    });
    expect(session.revision).toBe(documentRevision);
    expect(session.snapshotForTesting.source.originalText).toBe("SELECT 2");
  });

  it("rejects accessor document fields without invoking them", () => {
    const { session } = openSession("ABC");
    let invoked = false;
    const document: SqlDocumentReplacement = {
      kind: "replace",
      get text() {
        invoked = true;
        return "changed";
      },
    };
    expectSessionError("invalid-update", () => {
      session.update({
        embeddedRegions: [],
        baseRevision: session.revision,
        document,
      });
    });
    expect(invoked).toBe(false);
  });

  it("rejects malformed JavaScript change entries", () => {
    const { session } = openSession("ABC");
    for (const change of [
      null,
      {},
      { from: 0, insert: "", to: 1, get extra() {
        return true;
      } },
    ]) {
      if (change && "from" in change) {
        Object.defineProperty(change, "from", { get: () => 0 });
      }
      expectSessionError("invalid-change", () => {
        session.update({
          embeddedRegions: [],
          baseRevision: session.revision,
          document: { kind: "changes", changes: [change] },
        } as never);
      });
    }
  });

  it("rejects reentrant updates without losing the outer transaction", () => {
    const { session } = openSession("ABC");
    const originalRevision = session.revision;
    let nestedError: SqlSessionError | undefined;
    let attempted = false;
    const target: SqlDocumentReplacement = {
      kind: "replace",
      text: "outer",
    };
    const document = new Proxy(
      target,
      {
        getOwnPropertyDescriptor(target, property) {
          if (property === "text" && !attempted) {
            attempted = true;
            try {
              session.update({
                embeddedRegions: [],
                baseRevision: originalRevision,
                document: { kind: "replace", text: "nested" },
              });
            } catch (error) {
              if (error instanceof SqlSessionError) {
                nestedError = error;
              }
            }
          }
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      },
    );

    const revision = session.update({
      embeddedRegions: [],
      baseRevision: originalRevision,
      document,
    });

    expect(nestedError?.code).toBe("reentrant-update");
    expect(session.isCurrent(revision)).toBe(true);
    expect(session.snapshotForTesting.source.originalText).toBe("outer");
  });

  it("cannot commit an update after reentrant disposal", () => {
    const { session } = openSession("ABC");
    const revision = session.revision;
    const target: SqlDocumentReplacement = {
      kind: "replace",
      text: "changed",
    };
    let disposed = false;
    const document = new Proxy(target, {
      getOwnPropertyDescriptor(value, property) {
        if (!disposed) {
          disposed = true;
          session.dispose();
        }
        return Reflect.getOwnPropertyDescriptor(value, property);
      },
    });

    expectSessionError("session-disposed", () => {
      session.update({
        embeddedRegions: [],
        baseRevision: revision,
        document,
      });
    });
    expect(session.isCurrent(revision)).toBe(false);
    expect(session.snapshotForTesting.source.originalText).toBe("ABC");
  });

  it("bounds fragmented and oversized document updates", () => {
    const { session } = openSession("");
    const tooManyChanges: { from: number; insert: string; to: number }[] = [];
    tooManyChanges.length = 10_001;
    expectSessionError("invalid-change", () => {
      session.update({
        embeddedRegions: [],
        baseRevision: session.revision,
        document: { kind: "changes", changes: tooManyChanges },
      });
    });

    expectSessionError("invalid-document", () => {
      session.update({
        embeddedRegions: [],
        baseRevision: session.revision,
        document: {
          kind: "changes",
          changes: [
            {
              from: 0,
              insert: "x".repeat(16 * 1024 * 1024 + 1),
              to: 0,
            },
          ],
        },
      });
    });
    expect(session.snapshotForTesting.source.originalText).toBe("");
  });
});

describe("document context", () => {
  it("owns and deeply freezes a structured clone", () => {
    const flags = [true];
    const context = {
      dialect: "duckdb",
      engine: "local",
      settings: { flags },
    } satisfies TestContext;
    const service = createService();
    const session = service.openDocument({ context, text: "" });

    flags.push(false);

    expect(session.snapshotForTesting.context).toEqual({
      dialect: "duckdb",
      engine: "local",
      settings: { flags: [true] },
    });
    expect(Object.isFrozen(session.snapshotForTesting.context)).toBe(true);
    expect(Object.isFrozen(session.snapshotForTesting.context.settings)).toBe(true);
    expect(Object.isFrozen(session.snapshotForTesting.context.settings?.flags)).toBe(
      true,
    );
  });

  it("accepts finite numeric and bigint context data", () => {
    const context = {
      dialect: "duckdb",
      engine: "local",
      generation: 2,
      identifier: 3n,
    };
    const session = new DefaultSqlLanguageService<typeof context>({
      dialects: [duckdb],
    }).openDocument({ context, text: "" });
    expect(session.snapshotForTesting.context.generation).toBe(2);
    expect(session.snapshotForTesting.context.identifier).toBe(3n);
  });

  it("preserves cycles and shared references in the owned clone", () => {
    interface GraphContext extends TestContext {
      left: { value: bigint };
      right: { value: bigint };
      self?: GraphContext;
    }

    const shared = { value: 1n };
    const context: GraphContext = {
      dialect: "duckdb",
      engine: "local",
      left: shared,
      right: shared,
    };
    context.self = context;

    const session = new DefaultSqlLanguageService<GraphContext>({
      dialects: [duckdb],
    }).openDocument({ context, text: "" });
    const owned = session.snapshotForTesting.context;

    expect(owned).not.toBe(context);
    expect(owned.left).toBe(owned.right);
    expect(owned.self).toBe(owned);
    expect(Object.isFrozen(owned.self)).toBe(true);
  });

  it("accepts null-prototype objects as plain data", () => {
    const metadata = Object.assign(Object.create(null), { value: "ok" });
    const context = { dialect: "duckdb", engine: "local", metadata };
    const session = new DefaultSqlLanguageService<typeof context>({
      dialects: [duckdb],
    }).openDocument({ context, text: "" });
    expect(session.snapshotForTesting.context.metadata.value).toBe("ok");
  });

  it("requires dialect to be an own context property", () => {
    const originalDialect = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "dialect",
    );
    Object.defineProperty(Object.prototype, "dialect", {
      configurable: true,
      value: "duckdb",
    });
    try {
      expectSessionError("invalid-dialect", () => {
        createService().openDocument({
          context: { engine: "local" } as TestContext,
          text: "",
        });
      });
    } finally {
      if (originalDialect) {
        Object.defineProperty(Object.prototype, "dialect", originalDialect);
      } else {
        Reflect.deleteProperty(Object.prototype, "dialect");
      }
    }
  });

  it("updates text and context atomically", () => {
    const { session } = openSession("SELECT 1");
    session.update({
      embeddedRegions: [],
      baseRevision: session.revision,
      context: { dialect: "postgresql", engine: "warehouse" },
      document: { kind: "replace", text: "SELECT 2" },
    });

    expect(session.snapshotForTesting).toMatchObject({
      context: { dialect: "postgresql", engine: "warehouse" },
      source: { originalText: "SELECT 2" },
    });

    const snapshot = session.snapshotForTesting;
    expectSessionError("invalid-update", () => {
      session.update({
        embeddedRegions: [],
        baseRevision: snapshot.revision,
        context: { dialect: "duckdb", engine: "remote" },
        document: { kind: "replace", text: 42 },
      } as never);
    });
    expect(session.snapshotForTesting).toBe(snapshot);
  });

  it("supports context-only updates", () => {
    const { session } = openSession("SELECT 1");
    session.update({
      baseRevision: session.revision,
      context: { dialect: "postgresql", engine: "warehouse" },
    });
    expect(session.snapshotForTesting.source.originalText).toBe("SELECT 1");
    expect(session.snapshotForTesting.context.dialect).toBe("postgresql");
  });

  it("retains the owned context for document-only updates", () => {
    const { session } = openSession();
    const context = session.snapshotForTesting.context;
    session.update({
      embeddedRegions: [],
      baseRevision: session.revision,
      document: { kind: "replace", text: "SELECT 1" },
    });
    expect(session.snapshotForTesting.context).toBe(context);
  });

  it("clones a supplied context again on every update", () => {
    const { session } = openSession();
    const context: TestContext = { dialect: "duckdb", engine: "local" };
    session.update({ baseRevision: session.revision, context });
    const firstOwned = session.snapshotForTesting.context;
    session.update({ baseRevision: session.revision, context });
    expect(session.snapshotForTesting.context).not.toBe(firstOwned);
  });

  it.each([
    {
      context: { dialect: "unknown", engine: "local" },
      error: "invalid-dialect",
    },
    {
      context: { dialect: "duckdb", engine: Number.NaN },
      error: "invalid-context",
    },
    {
      context: { dialect: "duckdb", engine: new Date() },
      error: "invalid-context",
    },
    {
      context: { dialect: "duckdb", engine: () => "local" },
      error: "invalid-context",
    },
  ])("rejects invalid context without mutation: $error", ({ context, error }) => {
    const { session } = openSession("SELECT 1");
    const revision = session.revision;
    expectSessionError(error as SqlSessionError["code"], () => {
      session.update({
        embeddedRegions: [],
        baseRevision: revision,
        context,
        document: { kind: "replace", text: "SELECT 2" },
      } as never);
    });
    expect(session.revision).toBe(revision);
    expect(session.snapshotForTesting.source.originalText).toBe("SELECT 1");
  });

  it("rejects accessors without invoking them", () => {
    let invoked = false;
    const context = {
      dialect: "duckdb",
      get engine() {
        invoked = true;
        return "local";
      },
    };

    expectSessionError("invalid-context", () => {
      createService().openDocument({ context, text: "" });
    });
    expect(invoked).toBe(false);
  });

  it("reports non-enumerable context properties accurately", () => {
    const context = { dialect: "duckdb" };
    Object.defineProperty(context, "engine", {
      enumerable: false,
      value: "local",
    });

    expect(() => {
      createService().openDocument({ context: context as TestContext, text: "" });
    }).toThrowError("SQL document context cannot contain non-enumerable properties");
  });

  it("rejects symbol keys", () => {
    const context = {
      dialect: "duckdb",
      engine: "local",
      [Symbol("hidden")]: true,
    };
    expectSessionError("invalid-context", () => {
      createService().openDocument({ context, text: "" });
    });
  });

  it("rejects custom array properties", () => {
    const flags = [true];
    Object.defineProperty(flags, "custom", { value: true });
    expectSessionError("invalid-context", () => {
      createService().openDocument({
        context: {
          dialect: "duckdb",
          engine: "local",
          settings: { flags },
        },
        text: "",
      });
    });
  });

  it("rejects malformed property descriptors from proxies", () => {
    const context = new Proxy(
      { dialect: "duckdb", engine: "local" },
      {
        getOwnPropertyDescriptor(target, property) {
          if (property === "engine") {
            return;
          }
          return Object.getOwnPropertyDescriptor(target, property);
        },
      },
    );
    expectSessionError("invalid-context", () => {
      createService().openDocument({ context, text: "" });
    });
  });

  it("does not read array length through a proxy", () => {
    let invoked = false;
    const flags = new Proxy([true], {
      get(target, property, receiver) {
        if (property === "length") {
          invoked = true;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expectSessionError("invalid-context", () => {
      createService().openDocument({
        context: {
          dialect: "duckdb",
          engine: "local",
          settings: { flags },
        },
        text: "",
      });
    });
    expect(invoked).toBe(false);
  });

  it("enforces depth for nested paths", () => {
    const root: Record<string, unknown> = {
      dialect: "duckdb",
      engine: "local",
    };
    let cursor: Record<string, unknown> = {};
    root.path = cursor;
    for (let index = 0; index < 150; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }

    expectSessionError("invalid-context", () => {
      createService().openDocument({ context: root, text: "" } as never);
    });
  });

  it("rejects non-object context from JavaScript", () => {
    expectSessionError("invalid-context", () => {
      createService().openDocument({ context: "duckdb", text: "" } as never);
    });
    expectSessionError("invalid-context", () => {
      createService().openDocument({ context: [], text: "" } as never);
    });
  });

  it("bounds aggregate context string data", () => {
    expectSessionError("invalid-context", () => {
      createService().openDocument({
        context: {
          dialect: "duckdb",
          engine: "x".repeat(1_000_001),
        },
        text: "",
      });
    });
  });

  it("bounds context array length and property-name data", () => {
    interface BoundedContext extends TestContext {
      readonly metadata?: Readonly<Record<string, boolean>>;
      readonly sparse?: readonly boolean[];
    }
    const service = new DefaultSqlLanguageService<BoundedContext>({
      dialects: [duckdb],
    });
    const sparse: boolean[] = [];
    sparse.length = 50_001;
    expectSessionError("invalid-context", () => {
      service.openDocument({
        context: {
          dialect: "duckdb",
          engine: "local",
          sparse,
        },
        text: "",
      });
    });

    const longKey = "k".repeat(1_000_001);
    expectSessionError("invalid-context", () => {
      service.openDocument({
        context: {
          dialect: "duckdb",
          engine: "local",
          metadata: { [longKey]: true },
        },
        text: "",
      });
    });
  });

  it("normalizes structured-clone failures", () => {
    const context = new Proxy(
      { dialect: "duckdb", engine: "local" },
      {},
    );
    expectSessionError("invalid-context", () => {
      createService().openDocument({ context, text: "" });
    });
  });

  it("checks a stale base before inspecting candidate context", () => {
    const { session } = openSession();
    const stale = session.revision;
    session.update({ embeddedRegions: [], baseRevision: stale, document: { kind: "replace", text: "SELECT 1" } });
    let inspected = false;
    const context = {
      dialect: "duckdb",
      get engine() {
        inspected = true;
        return "local";
      },
    };
    expectSessionError("stale-revision", () => {
      session.update({ baseRevision: stale, context });
    });
    expect(inspected).toBe(false);
  });
});

describe("lifecycle", () => {
  it("supports detached public operations", () => {
    const service = createService();
    const { openDocument } = service;
    const session = openDocument({
      context: { dialect: "duckdb", engine: "local" },
      text: "",
    });
    const { dispose, isCurrent, update } = session;
    const revision = update({
      embeddedRegions: [],
      baseRevision: session.revision,
      document: { kind: "replace", text: "SELECT 1" },
    });

    expect(isCurrent(revision)).toBe(true);
    dispose();
    expect(isCurrent(revision)).toBe(false);

    const disposeService = service.dispose;
    disposeService();
    expectSessionError("service-disposed", () => {
      openDocument({
        context: { dialect: "duckdb", engine: "local" },
        text: "",
      });
    });
  });

  it("makes session disposal idempotent and terminal", () => {
    const { session } = openSession();
    const revision = session.revision;
    session.dispose();
    session.dispose();

    expect(session.isCurrent(revision)).toBe(false);
    expectSessionError("session-disposed", () => {
      session.update({
        embeddedRegions: [],
        baseRevision: revision,
        document: { kind: "replace", text: "SELECT 1" },
      });
    });
  });

  it("service disposal closes sessions and is idempotent", () => {
    const service = createService();
    const first = service.openDocument({
      context: { dialect: "duckdb", engine: "one" },
      text: "",
    });
    const second = service.openDocument({
      context: { dialect: "postgresql", engine: "two" },
      text: "",
    });

    service.dispose();
    service.dispose();

    expect(first.isCurrent(first.revision)).toBe(false);
    expect(second.isCurrent(second.revision)).toBe(false);
    expectSessionError("service-disposed", () => {
      service.openDocument({
        context: { dialect: "duckdb", engine: "three" },
        text: "",
      });
    });
  });

  it("does not let a disposed session affect its service", () => {
    const service = createService();
    const first = service.openDocument({
      context: { dialect: "duckdb", engine: "one" },
      text: "",
    });
    first.dispose();

    const second = service.openDocument({
      context: { dialect: "duckdb", engine: "two" },
      text: "",
    });
    expect(second.isCurrent(second.revision)).toBe(true);
  });

  it("does not register a failed document open", () => {
    const service = createService();
    expectSessionError("invalid-dialect", () => {
      service.openDocument({
        context: { dialect: "unknown", engine: "local" },
        text: "",
      });
    });
    const valid = service.openDocument({
      context: { dialect: "duckdb", engine: "local" },
      text: "",
    });
    expect(valid.isCurrent(valid.revision)).toBe(true);
  });

  it("rejects non-string initial text from JavaScript", () => {
    expectSessionError("invalid-document", () => {
      createService().openDocument({
        context: { dialect: "duckdb", engine: "local" },
        text: 42,
      } as never);
    });
  });

  it("rejects malformed and oversized open inputs", () => {
    const service = createService();
    expectSessionError("invalid-document", () => {
      service.openDocument(null as never);
    });
    expectSessionError("invalid-document", () => {
      service.openDocument({ context: undefined, text: "" } as never);
    });
    expectSessionError("invalid-document", () => {
      service.openDocument({
        context: { dialect: "duckdb", engine: "local" },
        text: "x".repeat(16 * 1024 * 1024 + 1),
      });
    });
    expectSessionError("invalid-document", () => {
      service.openDocument(
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              throw new Error("hostile");
            },
          },
        ) as never,
      );
    });
  });

  it("rejects open inputs with accessors without invoking them", () => {
    const service = createService();
    let invoked = false;
    expectSessionError("invalid-document", () => {
      service.openDocument({
        context: { dialect: "duckdb", engine: "local" },
        get text() {
          invoked = true;
          return "SELECT 1";
        },
      });
    });
    expect(invoked).toBe(false);
  });

  it("cannot return a session after reentrant service disposal", () => {
    const service = createService();
    let disposed = false;
    const context = new Proxy(
      { dialect: "duckdb", engine: "local" },
      {
        ownKeys(target) {
          if (!disposed) {
            disposed = true;
            service.dispose();
          }
          return Reflect.ownKeys(target);
        },
      },
    );

    expectSessionError("service-disposed", () => {
      service.openDocument({ context, text: "SELECT 1" });
    });
    expectSessionError("service-disposed", () => {
      service.openDocument({
        context: { dialect: "duckdb", engine: "local" },
        text: "",
      });
    });
  });

  it("cannot return a session when the open-input proxy disposes the service", () => {
    const service = createService();
    let disposed = false;
    const input = new Proxy(
      {
        context: { dialect: "duckdb", engine: "local" },
        text: "SELECT 1",
      },
      {
        getOwnPropertyDescriptor(target, property) {
          if (!disposed) {
            disposed = true;
            service.dispose();
          }
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      },
    );

    expectSessionError("service-disposed", () => {
      service.openDocument(input);
    });
  });

  it.each([null, {}, { dialects: null }, { dialects: [] }])(
    "normalizes invalid service options",
    (options) => {
      expectSessionError("invalid-service-options", () => {
        createSqlLanguageService(options as never);
      });
    },
  );

  it("normalizes hostile service options", () => {
    expectSessionError("invalid-service-options", () => {
      createSqlLanguageService(
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              throw new Error("hostile");
            },
          },
        ) as never,
      );
    });
  });
});
