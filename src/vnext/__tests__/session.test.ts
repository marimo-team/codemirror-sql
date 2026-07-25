import { describe, expect, it, vi } from "vitest";
import {
  bigQueryDialect,
  createSqlLanguageService,
  dremioDialect,
  duckdbDialect,
  postgresDialect,
  SqlSessionError,
} from "../index.js";
import {
  DefaultSqlLanguageService,
  getSqlRelationDialectRuntime,
} from "../session.js";
import {
  BIGQUERY_SQL_RELATION_DIALECT,
  DREMIO_SQL_RELATION_DIALECT,
  DUCKDB_SQL_RELATION_DIALECT,
  POSTGRESQL_SQL_RELATION_DIALECT,
} from "../relation-dialect.js";
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
  SqlRevision,
} from "../types.js";
import type {
  SqlCatalogInvalidation,
  SqlRelationCatalogProvider,
  SqlSessionChangeEvent,
} from "../relation-completion-types.js";

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

  it("authenticates one coherent relation runtime per built-in handle", () => {
    for (const [dialect, relationDialect] of [
      [bigQueryDialect(), BIGQUERY_SQL_RELATION_DIALECT],
      [dremioDialect(), DREMIO_SQL_RELATION_DIALECT],
      [duckdbDialect(), DUCKDB_SQL_RELATION_DIALECT],
      [postgresDialect(), POSTGRESQL_SQL_RELATION_DIALECT],
    ] as const) {
      expect(getSqlRelationDialectRuntime(dialect)).toBe(
        relationDialect,
      );
      expect(relationDialect.querySite.lexicalProfile).toBe(
        relationDialect.cteLayout.lexicalProfile,
      );
    }
    expect(
      getSqlRelationDialectRuntime({
        displayName: "DuckDB",
        id: "duckdb",
      }),
    ).toBeNull();
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

describe("relation completion session integration", () => {
  function catalogProvider(
    search: SqlRelationCatalogProvider["search"],
    subscribe?: SqlRelationCatalogProvider["subscribe"],
  ): SqlRelationCatalogProvider {
    return subscribe
      ? { id: "test-catalog", search, subscribe }
      : { id: "test-catalog", search };
  }

  it("completes visible CTEs without a catalog provider", async () => {
    const { service, session } = openSession(
      "WITH source_data AS (SELECT 1) SELECT * FROM sou",
    );
    const result = await session.complete({
      position: 48,
      trigger: { kind: "invoked" },
    });
    expect(result).toMatchObject({
      refreshToken: null,
      status: "ready",
      value: {
        items: [
          {
            edit: { from: 45, insert: "source_data", to: 48 },
            label: "source_data",
            relationKind: "cte",
          },
        ],
      },
    });
    service.dispose();
  });

  it("composes a validated catalog page through the public session", async () => {
    const service = createSqlLanguageService<TestContext>({
      catalog: catalogProvider(async () => ({
        coverage: { kind: "complete" },
        epoch: { generation: 0, token: "initial" },
        relations: [
          {
            canonicalPath: [
              {
                quoted: false,
                role: "catalog",
                value: "memory",
              },
              {
                quoted: false,
                role: "schema",
                value: "main",
              },
              {
                quoted: false,
                role: "relation",
                value: "users",
              },
            ],
            completionPathStart: 2,
            entityId: "users",
            matchQuality: "exact",
            relationKind: "table",
          },
        ],
        status: "ready",
      })),
      dialects: [duckdb],
    });
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:1" },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM us",
    });
    await expect(
      session.complete({
        position: 16,
        trigger: { kind: "invoked" },
      }),
    ).resolves.toMatchObject({
      sources: [
        {
          coverage: "complete",
          outcome: "ready",
          providerId: "test-catalog",
        },
      ],
      status: "ready",
      value: {
        isIncomplete: false,
        items: [
          {
            edit: { from: 14, insert: "users", to: 16 },
            label: "users",
            provenance: {
              entityId: "users",
              providerId: "test-catalog",
            },
          },
        ],
      },
    });
    service.dispose();
  });

  it("keeps completion edits in absolute UTF-16 document coordinates", async () => {
    const service = createSqlLanguageService<TestContext>({
      catalog: catalogProvider(async () => ({
        coverage: { kind: "complete" },
        epoch: { generation: 0, token: "initial" },
        relations: [
          {
            canonicalPath: [
              {
                quoted: false,
                role: "relation",
                value: "users",
              },
            ],
            completionPathStart: 0,
            entityId: "users",
            matchQuality: "exact",
            relationKind: "table",
          },
        ],
        status: "ready",
      })),
      dialects: [duckdb],
    });
    const text = "SELECT '😀'; SELECT * FROM us";
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:1" },
        dialect: "duckdb",
        engine: "local",
      },
      text,
    });
    const result = await session.complete({
      position: text.length,
      trigger: { kind: "invoked" },
    });
    expect(result).toMatchObject({
      status: "ready",
      value: {
        items: [
          {
            edit: {
              from: text.length - 2,
              insert: "users",
              to: text.length,
            },
            kind: "relation",
          },
        ],
      },
    });
    expect(result).toMatchObject({ refreshToken: null });
    service.dispose();
  });

  it("uses absolute coordinates after a masked embedded region", async () => {
    const service = createSqlLanguageService<TestContext>({
      catalog: catalogProvider(async () => ({
        coverage: { kind: "complete" },
        epoch: { generation: 0, token: "initial" },
        relations: [
          {
            canonicalPath: [
              {
                quoted: false,
                role: "relation",
                value: "users",
              },
            ],
            completionPathStart: 0,
            entityId: "users",
            matchQuality: "exact",
            relationKind: "table",
          },
        ],
        status: "ready",
      })),
      dialects: [duckdb],
    });
    const text = "SELECT * FROM {df}; SELECT * FROM us";
    const embeddedFrom = text.indexOf("{df}");
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:1" },
        dialect: "duckdb",
        engine: "local",
      },
      embeddedRegions: [
        {
          from: embeddedFrom,
          language: "python",
          to: embeddedFrom + 4,
        },
      ],
      text,
    });
    const result = await session.complete({
      position: text.length,
      trigger: { kind: "invoked" },
    });
    expect(result).toMatchObject({
      status: "ready",
      value: {
        items: [
          {
            edit: {
              from: text.length - 2,
              insert: "users",
              to: text.length,
            },
          },
        ],
      },
    });
    service.dispose();
  });

  it("reports terminal loading with a bounded completion intent", async () => {
    const service = createSqlLanguageService<TestContext>({
      catalog: catalogProvider(async () => ({
        epoch: { generation: 0, token: "loading" },
        status: "loading",
      })),
      dialects: [duckdb],
    });
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:1" },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    const result = await session.complete({
      position: 14,
      trigger: { kind: "invoked" },
    });
    expect(result).toMatchObject({
      status: "ready",
      value: {
        isIncomplete: true,
        issues: [
          {
            reason: "catalog-loading",
            remainingIntentLeaseMs:
              1_000,
          },
        ],
      },
    });
    if (result.status !== "ready") {
      throw new Error("Expected a ready completion");
    }
    expect(result.refreshToken).not.toBeNull();
    expect(Object.isFrozen(result.refreshToken)).toBe(true);
    const second = await session.complete({
      position: 14,
      trigger: { kind: "invoked" },
    });
    expect(second).toMatchObject({
      status: "ready",
      value: {
        issues: [{ reason: "catalog-loading" }],
      },
    });
    if (second.status !== "ready") {
      throw new Error("Expected a ready completion");
    }
    expect(second.refreshToken).not.toBe(result.refreshToken);
    service.dispose();
  });

  it("returns on the soft budget and emits one availability revision", async () => {
    let resolveSearch:
      | ((
          response: Awaited<
            ReturnType<SqlRelationCatalogProvider["search"]>
          >,
        ) => void)
      | undefined;
    const searchResult = new Promise<
      Awaited<ReturnType<SqlRelationCatalogProvider["search"]>>
    >((resolve) => {
      resolveSearch = resolve;
    });
    const service = createSqlLanguageService<TestContext>({
      catalog: catalogProvider(() => searchResult),
      completion: { catalogResponseBudgetMs: 0 },
      dialects: [duckdb],
    });
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:1" },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    const events: SqlSessionChangeEvent[] = [];
    session.onDidChange((event) => {
      events.push(event);
    });
    const result = await session.complete({
      position: 14,
      trigger: { kind: "invoked" },
    });
    expect(result).toMatchObject({
      status: "ready",
      value: {
        issues: [{ reason: "catalog-loading" }],
      },
    });
    if (result.status !== "ready" || result.refreshToken === null) {
      throw new Error("Expected a refreshable ready completion");
    }
    resolveSearch?.({
      coverage: { kind: "complete" },
      epoch: { generation: 0, token: "initial" },
      relations: [],
      status: "ready",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reason: "catalog-availability",
    });
    expect(events[0]?.refreshToken).toBe(result.refreshToken);
    service.dispose();
  });

  it("correlates terminal loading with catalog invalidation during its lease", async () => {
    let invalidate:
      | ((event: SqlCatalogInvalidation) => void)
      | undefined;
    const service = createSqlLanguageService<TestContext>({
      catalog: catalogProvider(
        async () => ({
          epoch: { generation: 0, token: "loading" },
          status: "loading",
        }),
        (_scope, listener) => {
          invalidate = listener;
          return () => undefined;
        },
      ),
      dialects: [duckdb],
    });
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:1" },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    const events: SqlSessionChangeEvent[] = [];
    session.onDidChange((event) => {
      events.push(event);
    });
    const result = await session.complete({
      position: 14,
      trigger: { kind: "invoked" },
    });
    if (result.status !== "ready" || result.refreshToken === null) {
      throw new Error("Expected a refreshable ready completion");
    }
    invalidate?.({
      epoch: { generation: 1, token: "ready" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: "catalog" });
    expect(events[0]?.refreshToken).toBe(result.refreshToken);
    service.dispose();
  });

  it("does not correlate catalog invalidation after a terminal lease expires", async () => {
    vi.useFakeTimers();
    let service:
      | ReturnType<typeof createSqlLanguageService<TestContext>>
      | undefined;
    try {
      let invalidate:
        | ((event: SqlCatalogInvalidation) => void)
        | undefined;
      service = createSqlLanguageService<TestContext>({
        catalog: catalogProvider(
          async () => ({
            epoch: { generation: 0, token: "loading" },
            status: "loading",
          }),
          (_scope, listener) => {
            invalidate = listener;
            return () => undefined;
          },
        ),
        dialects: [duckdb],
      });
      const session = service.openDocument({
        context: {
          catalog: { scope: "connection:1" },
          dialect: "duckdb",
          engine: "local",
        },
        text: "SELECT * FROM ",
      });
      const events: SqlSessionChangeEvent[] = [];
      session.onDidChange((event) => {
        events.push(event);
      });
      const result = await session.complete({
        position: 14,
        trigger: { kind: "invoked" },
      });
      expect(result).toMatchObject({
        status: "ready",
        value: {
          issues: [{ remainingIntentLeaseMs: 1_000 }],
        },
      });
      await vi.advanceTimersByTimeAsync(1_000);
      invalidate?.({
        epoch: { generation: 1, token: "ready" },
      });
      expect(events).toEqual([
        expect.objectContaining({
          reason: "catalog",
          refreshToken: null,
        }),
      ]);
    } finally {
      service?.dispose();
      vi.useRealTimers();
    }
  });

  it("does not correlate catalog invalidation after a soft lease expires", async () => {
    vi.useFakeTimers();
    let service:
      | ReturnType<typeof createSqlLanguageService<TestContext>>
      | undefined;
    try {
      let invalidate:
        | ((event: SqlCatalogInvalidation) => void)
        | undefined;
      service = createSqlLanguageService<TestContext>({
        catalog: catalogProvider(
          () =>
            new Promise(() => {
              // The refresh lease owns this unsettled search.
            }),
          (_scope, listener) => {
            invalidate = listener;
            return () => undefined;
          },
        ),
        completion: { catalogResponseBudgetMs: 0 },
        dialects: [duckdb],
      });
      const session = service.openDocument({
        context: {
          catalog: { scope: "connection:1" },
          dialect: "duckdb",
          engine: "local",
        },
        text: "SELECT * FROM ",
      });
      const events: SqlSessionChangeEvent[] = [];
      session.onDidChange((event) => {
        events.push(event);
      });
      const task = session.complete({
        position: 14,
        trigger: { kind: "invoked" },
      });
      await vi.advanceTimersByTimeAsync(0);
      const result = await task;
      expect(result).toMatchObject({
        refreshToken: task.refreshToken,
        status: "ready",
        value: {
          issues: [{ reason: "catalog-loading" }],
        },
      });
      if (result.status !== "ready") {
        throw new Error("Expected a ready completion");
      }
      const loading = result.value.issues.find(
        (issue) => issue.reason === "catalog-loading",
      );
      if (!loading || loading.reason !== "catalog-loading") {
        throw new Error("Expected a loading issue");
      }
      expect(loading.remainingIntentLeaseMs).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(
        Math.ceil(loading.remainingIntentLeaseMs),
      );
      invalidate?.({
        epoch: { generation: 1, token: "ready" },
      });
      expect(events).toEqual([
        expect.objectContaining({
          reason: "catalog",
          refreshToken: null,
        }),
      ]);
    } finally {
      service?.dispose();
      vi.useRealTimers();
    }
  });

  it("correlates catalog invalidation during a soft lease", async () => {
    let invalidate:
      | ((event: SqlCatalogInvalidation) => void)
      | undefined;
    const service = createSqlLanguageService<TestContext>({
      catalog: catalogProvider(
        () =>
          new Promise(() => {
            // Catalog invalidation settles the retained intent.
          }),
        (_scope, listener) => {
          invalidate = listener;
          return () => undefined;
        },
      ),
      completion: { catalogResponseBudgetMs: 0 },
      dialects: [duckdb],
    });
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:1" },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    const events: SqlSessionChangeEvent[] = [];
    session.onDidChange((event) => {
      events.push(event);
    });
    const task = session.complete({
      position: 14,
      trigger: { kind: "invoked" },
    });
    await expect(task).resolves.toMatchObject({
      refreshToken: task.refreshToken,
      status: "ready",
      value: {
        issues: [{ reason: "catalog-loading" }],
      },
    });
    invalidate?.({
      epoch: { generation: 1, token: "ready" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.refreshToken).toBe(task.refreshToken);
    service.dispose();
  });

  it("supersedes an older same-key request without restarting work", async () => {
    let searchCount = 0;
    let resolveSearch:
      | ((
          response: Awaited<
            ReturnType<SqlRelationCatalogProvider["search"]>
          >,
        ) => void)
      | undefined;
    const searchResult = new Promise<
      Awaited<ReturnType<SqlRelationCatalogProvider["search"]>>
    >((resolve) => {
      resolveSearch = resolve;
    });
    const service = createSqlLanguageService<TestContext>({
      catalog: catalogProvider(() => {
        searchCount += 1;
        return searchResult;
      }),
      dialects: [duckdb],
    });
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:1" },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    const first = session.complete({
      position: 14,
      trigger: { kind: "invoked" },
    });
    await Promise.resolve();
    const second = session.complete({
      position: 14,
      trigger: { kind: "invoked" },
    });
    resolveSearch?.({
      coverage: { kind: "complete" },
      epoch: { generation: 0, token: "initial" },
      relations: [],
      status: "ready",
    });
    await expect(first).resolves.toMatchObject({
      reason: "superseded",
      status: "cancelled",
    });
    await expect(second).resolves.toMatchObject({
      status: "ready",
    });
    expect(searchCount).toBe(1);
    service.dispose();
  });

  it("does not supersede valid work for a malformed request", async () => {
    let resolveSearch:
      | ((
          response: Awaited<
            ReturnType<SqlRelationCatalogProvider["search"]>
          >,
        ) => void)
      | undefined;
    const searchResult = new Promise<
      Awaited<ReturnType<SqlRelationCatalogProvider["search"]>>
    >((resolve) => {
      resolveSearch = resolve;
    });
    const service = createSqlLanguageService<TestContext>({
      catalog: catalogProvider(() => searchResult),
      dialects: [duckdb],
    });
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:1" },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    const valid = session.complete({
      position: 14,
      trigger: { kind: "invoked" },
    });
    await expect(
      session.complete({
        position: 14,
        trigger: {
          character: ".",
          kind: "invoked",
        },
      } as never),
    ).rejects.toMatchObject({
      code: "invalid-completion-request",
    });
    resolveSearch?.({
      coverage: { kind: "complete" },
      epoch: { generation: 0, token: "initial" },
      relations: [],
      status: "ready",
    });
    await expect(valid).resolves.toMatchObject({
      status: "ready",
    });
    service.dispose();
  });

  it("supersedes pending work when a higher catalog epoch arrives", async () => {
    let invalidate:
      | ((event: SqlCatalogInvalidation) => void)
      | undefined;
    const service = createSqlLanguageService<TestContext>({
      catalog: catalogProvider(
        () =>
          new Promise(() => {
            // Intentionally unsettled; invalidation owns cancellation.
          }),
        (_scope, listener) => {
          invalidate = listener;
          return () => undefined;
        },
      ),
      dialects: [duckdb],
    });
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:1" },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    const events: SqlSessionChangeEvent[] = [];
    session.onDidChange((event) => {
      events.push(event);
    });
    const result = session.complete({
      position: 14,
      trigger: { kind: "invoked" },
    });
    invalidate?.({
      epoch: { generation: 1, token: "changed" },
    });
    await expect(result).resolves.toMatchObject({
      reason: "superseded",
      status: "cancelled",
    });
    expect(events).toEqual([
      expect.objectContaining({
        reason: "catalog",
        refreshToken: result.refreshToken,
      }),
    ]);
    service.dispose();
  });

  it("settles pending completion on caller abort, update, and disposal", async () => {
    const createPendingSession = () => {
      const service = createSqlLanguageService<TestContext>({
        catalog: catalogProvider(
          () =>
            new Promise(() => {
              // Intentionally unsettled; session cancellation owns completion.
            }),
        ),
        dialects: [duckdb],
      });
      const session = service.openDocument({
        context: {
          catalog: { scope: "connection:1" },
          dialect: "duckdb",
          engine: "local",
        },
        text: "SELECT * FROM ",
      });
      return { service, session };
    };

    const caller = createPendingSession();
    const controller = new AbortController();
    const callerResult = caller.session.complete({
      position: 14,
      signal: controller.signal,
      trigger: { kind: "invoked" },
    });
    controller.abort();
    await expect(callerResult).resolves.toMatchObject({
      reason: "caller",
      status: "cancelled",
    });
    caller.service.dispose();

    const updated = createPendingSession();
    const updatedResult = updated.session.complete({
      position: 14,
      trigger: { kind: "invoked" },
    });
    updated.session.update({
      baseRevision: updated.session.revision,
      context: {
        catalog: { scope: "connection:1" },
        dialect: "duckdb",
        engine: "remote",
      },
    });
    await expect(updatedResult).resolves.toMatchObject({
      reason: "superseded",
      status: "cancelled",
    });
    updated.service.dispose();

    const disposed = createPendingSession();
    const disposedResult = disposed.session.complete({
      position: 14,
      trigger: { kind: "invoked" },
    });
    disposed.session.dispose();
    await expect(disposedResult).resolves.toMatchObject({
      reason: "disposed",
      status: "cancelled",
    });
    disposed.service.dispose();
  });

  it("replaces catalog ownership when the scope changes", async () => {
    const scopes: string[] = [];
    const service = createSqlLanguageService<TestContext>({
      catalog: catalogProvider(async (request) => {
        scopes.push(request.scope);
        return {
          coverage: { kind: "complete" },
          epoch: { generation: 0, token: request.scope },
          relations: [],
          status: "ready",
        };
      }),
      dialects: [duckdb],
    });
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:1" },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    await session.complete({
      position: 14,
      trigger: { kind: "invoked" },
    });
    session.update({
      baseRevision: session.revision,
      context: {
        catalog: { scope: "connection:2" },
        dialect: "duckdb",
        engine: "local",
      },
    });
    await session.complete({
      position: 14,
      trigger: { kind: "invoked" },
    });
    expect(scopes).toEqual(["connection:1", "connection:2"]);
    service.dispose();
  });

  it("advances revision and isolates listeners on catalog invalidation", () => {
    let invalidate:
      | ((event: SqlCatalogInvalidation) => void)
      | undefined;
    const service = createSqlLanguageService<TestContext>({
      catalog: catalogProvider(
        async () => ({
          coverage: { kind: "complete" },
          epoch: { generation: 0, token: "initial" },
          relations: [],
          status: "ready",
        }),
        (_scope, listener) => {
          invalidate = listener;
          return () => undefined;
        },
      ),
      dialects: [duckdb],
    });
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:1" },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    const previous = session.revision;
    const events: string[] = [];
    session.onDidChange((event) => {
      events.push(event.reason);
      throw new Error("isolated");
    });
    session.onDidChange((event) => {
      events.push(`${event.reason}:second`);
    });
    invalidate?.({
      epoch: { generation: 1, token: "changed" },
    });
    expect(session.revision).not.toBe(previous);
    expect(events).toEqual(["catalog", "catalog:second"]);
    service.dispose();
  });

  it("stops a stale catalog event after a listener updates the session", () => {
    let invalidate:
      | ((event: SqlCatalogInvalidation) => void)
      | undefined;
    const service = createSqlLanguageService<TestContext>({
      catalog: catalogProvider(
        async () => ({
          coverage: { kind: "complete" },
          epoch: { generation: 0, token: "initial" },
          relations: [],
          status: "ready",
        }),
        (_scope, listener) => {
          invalidate = listener;
          return () => undefined;
        },
      ),
      dialects: [duckdb],
    });
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:1" },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    const events: SqlRevision[] = [];
    session.onDidChange((event) => {
      events.push(event.revision);
      session.update({
        baseRevision: event.revision,
        context: {
          catalog: { scope: "connection:1" },
          dialect: "duckdb",
          engine: "remote",
        },
      });
    });
    session.onDidChange((event) => {
      events.push(event.revision);
    });

    invalidate?.({
      epoch: { generation: 1, token: "changed" },
    });

    expect(events).toHaveLength(1);
    expect(session.revision).not.toBe(events[0]);
    service.dispose();
  });

  it("does not deliver an outer catalog event after nested invalidation", () => {
    let invalidate:
      | ((event: SqlCatalogInvalidation) => void)
      | undefined;
    const service = createSqlLanguageService<TestContext>({
      catalog: catalogProvider(
        async () => ({
          coverage: { kind: "complete" },
          epoch: { generation: 0, token: "initial" },
          relations: [],
          status: "ready",
        }),
        (_scope, listener) => {
          invalidate = listener;
          return () => undefined;
        },
      ),
      dialects: [duckdb],
    });
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:1" },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    const events: SqlRevision[] = [];
    let nested = false;
    session.onDidChange((event) => {
      events.push(event.revision);
      if (!nested) {
        nested = true;
        invalidate?.({
          epoch: { generation: 2, token: "nested" },
        });
      }
    });
    session.onDidChange((event) => {
      events.push(event.revision);
    });

    invalidate?.({
      epoch: { generation: 1, token: "outer" },
    });

    expect(events).toHaveLength(4);
    expect(events[0]).toBe(events[1]);
    expect(events[1]).not.toBe(events[2]);
    expect(events[2]).toBe(events[3]);
    expect(session.revision).toBe(events[2]);
    service.dispose();
  });

  it("keeps duplicate listener subscriptions independent", () => {
    let invalidate:
      | ((event: SqlCatalogInvalidation) => void)
      | undefined;
    const service = createSqlLanguageService<TestContext>({
      catalog: catalogProvider(
        async () => ({
          coverage: { kind: "complete" },
          epoch: { generation: 0, token: "initial" },
          relations: [],
          status: "ready",
        }),
        (_scope, listener) => {
          invalidate = listener;
          return () => undefined;
        },
      ),
      dialects: [duckdb],
    });
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:1" },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    const events: string[] = [];
    const listener = (event: SqlSessionChangeEvent): void => {
      events.push(event.reason);
    };
    const first = session.onDidChange(listener);
    const second = session.onDidChange(listener);

    first.dispose();
    invalidate?.({
      epoch: { generation: 1, token: "first" },
    });
    expect(events).toEqual(["catalog"]);

    second.dispose();
    invalidate?.({
      epoch: { generation: 2, token: "second" },
    });
    expect(events).toEqual(["catalog"]);
    service.dispose();
  });

  it("validates completion configuration and request input", async () => {
    expectSessionError("invalid-service-options", () => {
      createSqlLanguageService({
        completion: { catalogResponseBudgetMs: 51 },
        dialects: [duckdb],
      });
    });
    const { service, session } = openSession();
    await expect(
      session.complete(null as never),
    ).rejects.toMatchObject({
      code: "invalid-completion-request",
    });
    service.dispose();
  });

  it("rejects catalog context without a configured provider atomically", () => {
    const service = createSqlLanguageService<TestContext>({
      dialects: [duckdb],
    });
    expectSessionError("invalid-context", () => {
      service.openDocument({
        context: {
          catalog: { scope: "connection:1" },
          dialect: "duckdb",
          engine: "local",
        },
        text: "SELECT * FROM ",
      });
    });
    const session = service.openDocument({
      context: {
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    const revision = session.revision;
    expectSessionError("invalid-context", () => {
      session.update({
        baseRevision: revision,
        context: {
          catalog: { scope: "connection:1" },
          dialect: "duckdb",
          engine: "local",
        },
      });
    });
    expect(session.revision).toBe(revision);
    service.dispose();
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

describe("public statement boundaries", () => {
  it("projects exact boundaries with explicit cursor affinity", () => {
    const { session } = openSession("SELECT 1;SELECT 2");

    const left = session.statementBoundaryAt({
      affinity: "left",
      position: 9,
    });
    const right = session.statementBoundaryAt({
      affinity: "right",
      position: 9,
    });

    expect(left).toEqual({
      boundary: {
        boundaryQuality: "exact",
        code: { from: 0, to: 8 },
        endState: { kind: "normal" },
        extent: { from: 0, to: 9 },
        hasCode: true,
        source: { from: 0, to: 8 },
        terminator: { from: 8, to: 9 },
      },
      revision: session.revision,
    });
    expect(right.boundary).toEqual({
      boundaryQuality: "exact",
      code: { from: 9, to: 17 },
      endState: { kind: "normal" },
      extent: { from: 9, to: 17 },
      hasCode: true,
      source: { from: 9, to: 17 },
      terminator: null,
    });
    expect(Object.isFrozen(left)).toBe(true);
    expect(Object.isFrozen(left.boundary)).toBe(true);
    expect(Object.isFrozen(left.boundary.extent)).toBe(true);
    if (left.boundary.boundaryQuality === "exact") {
      expect(Object.isFrozen(left.boundary.code)).toBe(true);
      expect(Object.isFrozen(left.boundary.source)).toBe(true);
      expect(Object.isFrozen(left.boundary.terminator)).toBe(true);
      expect(Object.isFrozen(left.boundary.endState)).toBe(true);
    }
  });

  it("distinguishes empty, consecutive, and terminal boundaries", () => {
    const empty = openSession("").session.statementBoundaryAt({
      affinity: "right",
      position: 0,
    });
    expect(empty.boundary).toMatchObject({
      boundaryQuality: "exact",
      extent: { from: 0, to: 0 },
      hasCode: false,
    });

    const { session } = openSession("SELECT 1;;");
    expect(session.statementBoundaryAt({
      affinity: "left",
      position: 9,
    }).boundary).toMatchObject({
      hasCode: true,
      terminator: { from: 8, to: 9 },
    });
    expect(session.statementBoundaryAt({
      affinity: "right",
      position: 9,
    }).boundary).toMatchObject({
      hasCode: false,
      terminator: { from: 9, to: 10 },
    });
    expect(session.statementBoundaryAt({
      affinity: "left",
      position: 10,
    }).boundary).toMatchObject({
      extent: { from: 9, to: 10 },
      hasCode: false,
    });
    expect(session.statementBoundaryAt({
      affinity: "right",
      position: 10,
    }).boundary).toMatchObject({
      extent: { from: 10, to: 10 },
      hasCode: false,
    });
  });

  it("preserves explicit no-code and unterminated states", () => {
    const comment = openSession("/* comment */").session.statementBoundaryAt({
      affinity: "right",
      position: 0,
    });
    expect(comment.boundary).toMatchObject({
      boundaryQuality: "exact",
      hasCode: false,
      source: { from: 0, to: 13 },
    });

    const unterminated = openSession("SELECT '🦆").session.statementBoundaryAt({
      affinity: "left",
      position: 10,
    });
    expect(unterminated.boundary).toMatchObject({
      boundaryQuality: "exact",
      endState: {
        construct: "single-quoted-string",
        from: 7,
        kind: "unterminated",
      },
    });

    const text = "  /* lead */ SELECT 1 /* tail */  ";
    const trimmed = openSession(text).session.statementBoundaryAt({
      affinity: "right",
      position: 0,
    });
    expect(trimmed.boundary).toMatchObject({
      code: {
        from: text.indexOf("SELECT"),
        to: text.indexOf(" /* tail */"),
      },
      source: { from: 0, to: text.length },
    });
  });

  it("reports original coordinates across masked host regions", () => {
    const service = createService();
    const text = "SELECT {x;y};SELECT 2";
    const session = service.openDocument({
      context: { dialect: "duckdb", engine: "local" },
      embeddedRegions: [{
        from: 7,
        language: "python",
        to: 12,
      }],
      text,
    });

    expect(session.statementBoundaryAt({
      affinity: "left",
      position: 13,
    }).boundary).toMatchObject({
      extent: { from: 0, to: 13 },
      source: { from: 0, to: 12 },
      terminator: { from: 12, to: 13 },
    });
    expect(session.statementBoundaryAt({
      affinity: "right",
      position: 13,
    }).boundary).toMatchObject({
      extent: { from: 13, to: text.length },
      source: { from: 13, to: text.length },
    });
  });

  it("reports opaque boundaries without executable source", () => {
    const text =
      "CREATE FUNCTION f() RETURNS int LANGUAGE SQL BEGIN ATOMIC SELECT 1; END;";
    const { session } = openSession(text);
    session.update({
      baseRevision: session.revision,
      context: { dialect: "postgresql", engine: "warehouse" },
    });
    const result = session.statementBoundaryAt({
      affinity: "right",
      position: 32,
    });

    expect(result.boundary).toEqual({
      boundaryQuality: "opaque",
      extent: { from: 0, to: text.length },
      reason: "procedural-block",
    });
    expect("source" in result.boundary).toBe(false);
  });

  it("projects custom-delimiter and resource-limit opacity", () => {
    const service = createSqlLanguageService<TestContext>({
      dialects: [bigQueryDialect()],
    });
    const custom = service.openDocument({
      context: { dialect: "bigquery", engine: "warehouse" },
      text: "DELIMITER $$\nSELECT 1$$",
    });
    expect(custom.statementBoundaryAt({
      affinity: "right",
      position: 0,
    }).boundary).toMatchObject({
      boundaryQuality: "opaque",
      reason: "custom-delimiter",
    });

    const text = ";".repeat(10_001);
    const limited = service.openDocument({
      context: { dialect: "bigquery", engine: "warehouse" },
      text,
    });
    expect(limited.statementBoundaryAt({
      affinity: "right",
      position: text.length,
    }).boundary).toMatchObject({
      boundaryQuality: "opaque",
      reason: "resource-limit",
    });
  });

  it("returns the current revision after atomic updates", () => {
    const { session } = openSession("SELECT 1");
    const previous = session.statementBoundaryAt({
      affinity: "left",
      position: 8,
    });
    session.update({
      baseRevision: session.revision,
      document: {
        changes: [{ from: 7, insert: "20", to: 8 }],
        kind: "changes",
      },
      embeddedRegions: [],
    });

    const current = session.statementBoundaryAt({
      affinity: "left",
      position: 9,
    });
    expect(current.revision).toBe(session.revision);
    expect(current.revision).not.toBe(previous.revision);
    expect(current.boundary).toMatchObject({
      source: { from: 0, to: 9 },
    });
  });

  it("returns every boundary intersecting a viewport range", () => {
    const text = ";SELECT 1;/* trailing */";
    const { session } = openSession(text);
    const result = session.statementBoundariesIntersecting({
      from: 0,
      to: text.length,
    });

    expect(result.revision).toBe(session.revision);
    expect(result.boundaries).toHaveLength(3);
    expect(result.boundaries.map((boundary) =>
      boundary.boundaryQuality === "exact" && boundary.hasCode
    )).toEqual([false, true, false]);
    expect(result.boundaries[1]).toMatchObject({
      code: { from: 1, to: 9 },
      extent: { from: 1, to: 10 },
      source: { from: 1, to: 9 },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.boundaries)).toBe(true);
    expect(session.statementBoundariesIntersecting({
      from: 1,
      to: 1,
    }).boundaries).toEqual([]);
  });

  it("validates requests and rejects disposed sessions", () => {
    const { session } = openSession("SELECT 1");
    for (const request of [
      null,
      {},
      { affinity: "center", position: 0 },
      { affinity: "left", position: -1 },
      { affinity: "left", position: Number.NaN },
      { affinity: "right", position: 9 },
    ]) {
      expectSessionError("invalid-statement-boundary-request", () => {
        session.statementBoundaryAt(request as never);
      });
    }
    let getterCalls = 0;
    expectSessionError("invalid-statement-boundary-request", () => {
      session.statementBoundaryAt(
        Object.defineProperty(
          { affinity: "left" },
          "position",
          {
            get: () => {
              getterCalls += 1;
              return 0;
            },
          },
        ) as never,
      );
    });
    expect(getterCalls).toBe(0);
    expectSessionError("invalid-statement-boundary-request", () => {
      session.statementBoundaryAt(
        Object.create({ affinity: "left", position: 0 }) as never,
      );
    });
    expectSessionError("invalid-statement-boundary-request", () => {
      session.statementBoundaryAt(new Proxy({}, {
        getOwnPropertyDescriptor: () => {
          throw new Error("host descriptor trap");
        },
      }) as never);
    });
    for (const range of [
      null,
      {},
      { from: -1, to: 0 },
      { from: 2, to: 1 },
      { from: 0, to: 9 },
    ]) {
      expectSessionError("invalid-statement-boundary-request", () => {
        session.statementBoundariesIntersecting(range as never);
      });
    }
    session.dispose();
    expectSessionError("session-disposed", () => {
      session.statementBoundaryAt({ affinity: "left", position: 0 });
    });
    expectSessionError("session-disposed", () => {
      session.statementBoundariesIntersecting({ from: 0, to: 0 });
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
      document: undefined,
      embeddedRegions: undefined,
    });
    expect(session.revision).toBe(contextRevision);
    expect(session.snapshotForTesting.context.engine).toBe("warehouse");

    const regionRevision = session.update({
      baseRevision: session.revision,
      context: undefined,
      document: undefined,
      embeddedRegions: [{ from: 7, language: "python", to: 8 }],
    });
    expect(session.revision).toBe(regionRevision);
    expect(session.snapshotForTesting.source.embeddedRegions).toEqual([
      { from: 7, language: "python", to: 8 },
    ]);

    const replacementRevision = session.update({
      baseRevision: session.revision,
      context: undefined,
      document: { kind: "replace", text: "SELECT 2" },
      embeddedRegions: [],
    });
    expect(session.revision).toBe(replacementRevision);
    expect(session.snapshotForTesting.source.originalText).toBe("SELECT 2");

    expectSessionError("invalid-update", () => {
      session.update({
        baseRevision: session.revision,
        context: undefined,
        document: undefined,
        embeddedRegions: undefined,
      } as never);
    });
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

describe("session coverage hardening", () => {
  const readyCatalog: SqlRelationCatalogProvider = {
    id: "coverage-catalog",
    search: async () => ({
      coverage: { kind: "complete" },
      epoch: { generation: 0, token: "initial" },
      relations: [],
      status: "ready",
    }),
  };

  function catalogService(
    provider: SqlRelationCatalogProvider = readyCatalog,
  ) {
    return createSqlLanguageService<TestContext>({
      catalog: provider,
      dialects: [duckdb, postgres],
    });
  }

  it.each([
    { scope: "" },
    { scope: "x".repeat(513) },
    { scope: 1 },
    { scope: "valid", searchPath: "main" },
    {
      scope: "valid",
      searchPath: Array.from({ length: 33 }, () => [
        { quoted: false, value: "main" },
      ]),
    },
    { scope: "valid", searchPath: ["main"] },
    { scope: "valid", searchPath: [[]] },
    {
      scope: "valid",
      searchPath: [
        Array.from({ length: 5 }, () => ({
          quoted: false,
          value: "main",
        })),
      ],
    },
    { scope: "valid", searchPath: [[null]] },
    {
      scope: "valid",
      searchPath: [[{ quoted: false, value: 1 }]],
    },
    {
      scope: "valid",
      searchPath: [[{ quoted: false, value: "" }]],
    },
    {
      scope: "valid",
      searchPath: [
        [{ quoted: false, value: "x".repeat(257) }],
      ],
    },
    {
      scope: "valid",
      searchPath: [[{ quoted: "no", value: "main" }]],
    },
  ])("rejects invalid catalog context %# atomically", (catalog) => {
    const service = catalogService();
    expectSessionError("invalid-context", () => {
      service.openDocument({
        context: {
          catalog,
          dialect: "duckdb",
          engine: "local",
        } as never,
        text: "SELECT 1",
      });
    });
    service.dispose();
  });

  it.each([
    { position: Number.NaN, trigger: { kind: "invoked" } },
    { position: -1, trigger: { kind: "invoked" } },
    { position: 9, trigger: { kind: "invoked" } },
    { position: 0, trigger: null },
    { position: 0, trigger: { kind: "unknown" } },
    {
      position: 0,
      trigger: { character: 1, kind: "trigger-character" },
    },
    {
      position: 0,
      trigger: { character: "", kind: "trigger-character" },
    },
    {
      position: 0,
      trigger: { character: "ab", kind: "trigger-character" },
    },
    {
      position: 0,
      trigger: { character: "😀x", kind: "trigger-character" },
    },
    {
      position: 0,
      signal: {},
      trigger: { kind: "invoked" },
    },
  ])("rejects malformed completion request %#", async (request) => {
    const { service, session } = openSession("SELECT 1");
    await expect(
      session.complete(request as never),
    ).rejects.toMatchObject({
      code: "invalid-completion-request",
    });
    service.dispose();
  });

  it("accepts a one-code-point trigger and rejects listeners after disposal", async () => {
    const { service, session } = openSession(
      "SELECT * FROM ",
    );
    await expect(
      session.complete({
        position: 14,
        trigger: { character: "😀", kind: "trigger-character" },
      }),
    ).resolves.toMatchObject({ status: "ready" });
    expectSessionError("invalid-completion-request", () => {
      session.onDidChange(null as never);
    });
    const subscription = session.onDidChange(() => {});
    subscription.dispose();
    subscription.dispose();
    session.dispose();
    expectSessionError("session-disposed", () => {
      session.onDidChange(() => {});
    });
    await expect(
      session.complete({
        position: 0,
        trigger: { kind: "invoked" },
      }),
    ).rejects.toMatchObject({ code: "session-disposed" });
    service.dispose();
  });

  it.each([
    {
      reason: "opaque-statement",
      text: "DELIMITER $$",
    },
    {
      reason: "resource-limit",
      text: `SELECT * FROM ${" ".repeat(65_537)}`,
    },
    {
      reason: "inactive",
      text: "SELECT 1",
    },
  ] as const)("returns $reason local unavailability", async ({ reason, text }) => {
    const service = createSqlLanguageService<TestContext>({
      dialects: [postgres],
    });
    const session = service.openDocument({
      context: { dialect: "postgresql", engine: "local" },
      text,
    });
    await expect(
      session.complete({
        position: text.length,
        trigger: { kind: "invoked" },
      }),
    ).resolves.toMatchObject({
      reason,
      retryable: false,
      status: "unavailable",
    });
    service.dispose();
  });

  it.each([
    null,
    "bad",
    { catalogResponseBudgetMs: "fast" },
    { catalogResponseBudgetMs: Number.NaN },
    { catalogResponseBudgetMs: -1 },
  ])("rejects invalid completion options %#", (completion) => {
    expectSessionError("invalid-service-options", () => {
      createSqlLanguageService({
        completion,
        dialects: [duckdb],
      } as never);
    });
  });

  it("rejects a malformed catalog provider", () => {
    expectSessionError("invalid-service-options", () => {
      createSqlLanguageService({
        catalog: { id: "", search: async () => ({}) },
        dialects: [duckdb],
      } as never);
    });
  });

  it.each([
    {
      expectedIssue: "catalog-failed",
      response: {
        code: "unavailable",
        epoch: { generation: 0, token: "failed" },
        retry: "next-request",
        status: "failed",
      },
    },
    {
      expectedIssue: "catalog-malformed",
      response: {
        coverage: { kind: "complete" },
        epoch: { generation: 0, token: "bad" },
        relations: [{ bad: true }],
        status: "ready",
      },
    },
  ])("maps catalog outcome $expectedIssue", async ({
    expectedIssue,
    response,
  }) => {
    const service = catalogService({
      id: `catalog-${expectedIssue}`,
      search: async () => response as never,
    });
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:coverage" },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    await expect(
      session.complete({
        position: 14,
        trigger: { kind: "invoked" },
      }),
    ).resolves.toMatchObject({
      status: "ready",
      value: {
        issues: [{ reason: expectedIssue }],
      },
    });
    service.dispose();
  });

  it("maps provider rejection and already-aborted requests", async () => {
    const service = catalogService({
      id: "rejecting",
      search: async () => {
        throw new Error("private provider failure");
      },
    });
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:coverage" },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    await expect(
      session.complete({
        position: 14,
        trigger: { kind: "invoked" },
      }),
    ).resolves.toMatchObject({
      status: "ready",
      value: { issues: [{ reason: "catalog-failed" }] },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      session.complete({
        position: 14,
        signal: controller.signal,
        trigger: { kind: "invoked" },
      }),
    ).resolves.toMatchObject({
      reason: "caller",
      status: "cancelled",
    });
    service.dispose();
  });

  it("expires terminal loading intent and clears it idempotently", async () => {
    vi.useFakeTimers();
    let service:
      | ReturnType<typeof createSqlLanguageService<TestContext>>
      | undefined;
    try {
      service = catalogService({
        id: "loading",
        search: async () => ({
          epoch: { generation: 0, token: "loading" },
          status: "loading",
        }),
      });
      const session = service.openDocument({
        context: {
          catalog: { scope: "connection:coverage" },
          dialect: "duckdb",
          engine: "local",
        },
        text: "SELECT * FROM ",
      });
      const revision = session.revision;
      const events: string[] = [];
      session.onDidChange((event) => {
        events.push(event.reason);
      });
      await expect(session.complete({
        position: 14,
        trigger: { kind: "invoked" },
      })).resolves.toMatchObject({
        status: "ready",
        value: {
          issues: [
            {
              reason: "catalog-loading",
              remainingIntentLeaseMs: 1_000,
            },
          ],
        },
      });
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(vi.getTimerCount()).toBe(1);
      expect(session.revision).toBe(revision);
      expect(events).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(session.revision).toBe(revision);
      expect(events).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      session.update({
        baseRevision: session.revision,
        context: {
          catalog: { scope: "connection:coverage" },
          dialect: "duckdb",
          engine: "changed",
        },
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      service?.dispose();
      vi.useRealTimers();
    }
  });

  it("enforces context node and property aggregate limits", () => {
    const service = createService();
    expectSessionError("invalid-context", () => {
      service.openDocument({
        context: {
          dialect: "duckdb",
          engine: "local",
          nodes: Array.from({ length: 10_001 }, () => ({})),
        } as never,
        text: "",
      });
    });
    const manyProperties = Object.fromEntries(
      Array.from({ length: 50_001 }, (_, index) => [
        `p${index}`,
        null,
      ]),
    );
    expectSessionError("invalid-context", () => {
      service.openDocument({
        context: {
          dialect: "duckdb",
          engine: "local",
          manyProperties,
        } as never,
        text: "",
      });
    });
    service.dispose();
  });

  it("keeps listener subscriptions independently disposable during dispatch", () => {
    let invalidate:
      | ((event: SqlCatalogInvalidation) => void)
      | undefined;
    const service = catalogService({
      ...readyCatalog,
      subscribe: (_scope, listener) => {
        invalidate = listener;
        return () => undefined;
      },
    });
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:listeners" },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT 1",
    });
    const calls: string[] = [];
    let second = session.onDidChange(() => {
      calls.push("second");
    });
    const first = session.onDidChange(() => {
      calls.push("first");
      second.dispose();
    });
    second.dispose();
    second = session.onDidChange(() => {
      calls.push("second");
    });
    invalidate?.({
      epoch: { generation: 1, token: "changed" },
    });
    expect(calls).toEqual(["first"]);
    first.dispose();
    service.dispose();
  });

  it.each(["update", "dispose"] as const)(
    "releases a retained refresh intent on %s",
    async (action) => {
      let aborted = 0;
      const service = createSqlLanguageService<TestContext>({
        catalog: {
          id: `pending-${action}`,
          search: async (_request, signal) =>
            new Promise((resolve) => {
              signal.addEventListener(
                "abort",
                () => {
                  aborted += 1;
                  resolve({
                    epoch: { generation: 0, token: "late" },
                    status: "loading",
                  });
                },
                { once: true },
              );
            }),
        },
        completion: { catalogResponseBudgetMs: 0 },
        dialects: [duckdb],
      });
      const session = service.openDocument({
        context: {
          catalog: { scope: `connection:${action}` },
          dialect: "duckdb",
          engine: "local",
        },
        text: "SELECT * FROM ",
      });
      await expect(
        session.complete({
          position: 14,
          trigger: { kind: "invoked" },
        }),
      ).resolves.toMatchObject({
        status: "ready",
        value: {
          issues: [{ reason: "catalog-loading" }],
        },
      });
      if (action === "update") {
        session.update({
          baseRevision: session.revision,
          context: {
            catalog: { scope: `connection:${action}` },
            dialect: "duckdb",
            engine: "changed",
          },
        });
      } else {
        session.dispose();
      }
      await Promise.resolve();
      expect(aborted).toBe(1);
      service.dispose();
    },
  );

  it("hands a retained intent to a different-key completion", async () => {
    const aborted: string[] = [];
    const service = createSqlLanguageService<TestContext>({
      catalog: {
        id: "different-key",
        search: async (request, signal) =>
          new Promise((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted.push(request.prefix.value);
                resolve({
                  epoch: { generation: 0, token: "late" },
                  status: "loading",
                });
              },
              { once: true },
            );
          }),
      },
      completion: { catalogResponseBudgetMs: 0 },
      dialects: [duckdb],
    });
    const text = "SELECT * FROM a; SELECT * FROM b";
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:different-key" },
        dialect: "duckdb",
        engine: "local",
      },
      text,
    });
    await session.complete({
      position: text.indexOf("a;") + 1,
      trigger: { kind: "invoked" },
    });
    await session.complete({
      position: text.length,
      trigger: { kind: "invoked" },
    });
    await Promise.resolve();
    expect(aborted).toContain("a");
    service.dispose();
  });

  it("maps synchronous provider budget exhaustion to catalog timeout", async () => {
    const service = catalogService({
      id: "synchronous-timeout",
      search: async () => {
        const deadline = performance.now() + 10;
        while (performance.now() < deadline) {
          // Deliberately exceed the coordinator's synchronous budget.
        }
        return {
          coverage: { kind: "complete" },
          epoch: { generation: 0, token: "late" },
          relations: [],
          status: "ready",
        };
      },
    });
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:sync-timeout" },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    await expect(
      session.complete({
        position: 14,
        trigger: { kind: "invoked" },
      }),
    ).resolves.toMatchObject({
      status: "ready",
      value: { issues: [{ reason: "catalog-timeout" }] },
    });
    service.dispose();
  });

  it("rejects non-string and unknown dialect context values", () => {
    const service = createService();
    for (const dialect of [1, "unknown"]) {
      expectSessionError("invalid-dialect", () => {
        service.openDocument({
          context: { dialect, engine: "local" } as never,
          text: "",
        });
      });
    }
    service.dispose();
  });

  it.each([
    ["SELECT * FROM users ON ", "unsupported-query-site"],
    [
      "SELECT * FROM users NATURAL WHERE ",
      "ambiguous-query-site",
    ],
  ])("maps query-site uncertainty in %s", async (text, reason) => {
    const service = createSqlLanguageService<TestContext>({
      dialects: [postgres],
    });
    const session = service.openDocument({
      context: { dialect: "postgresql", engine: "local" },
      text,
    });
    await expect(
      session.complete({
        position: text.length,
        trigger: { kind: "invoked" },
      }),
    ).resolves.toMatchObject({
      reason,
      retryable: false,
      status: "unavailable",
    });
    service.dispose();
  });

  it("cancels previous active work when the replacement site is inactive", async () => {
    const service = createSqlLanguageService<TestContext>({
      catalog: {
        id: "inactive-replacement",
        search: async () =>
          new Promise(() => {
            // Cancelled by the second completion.
          }),
      },
      dialects: [duckdb],
    });
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:inactive-replacement" },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    const first = session.complete({
      position: 14,
      trigger: { kind: "invoked" },
    });
    await Promise.resolve();
    await expect(
      session.complete({
        position: 0,
        trigger: { kind: "invoked" },
      }),
    ).resolves.toMatchObject({
      reason: "inactive",
      status: "unavailable",
    });
    await expect(first).resolves.toMatchObject({
      reason: "superseded",
      status: "cancelled",
    });
    service.dispose();
  });

  it("cancels a retained intent when the replacement site is inactive", async () => {
    let aborts = 0;
    const service = createSqlLanguageService<TestContext>({
      catalog: {
        id: "intent-inactive-replacement",
        search: async (_request, signal) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () => {
              aborts += 1;
              resolve({
                epoch: { generation: 0, token: "late" },
                status: "loading",
              });
            });
          }),
      },
      completion: { catalogResponseBudgetMs: 0 },
      dialects: [duckdb],
    });
    const session = service.openDocument({
      context: {
        catalog: {
          scope: "connection:intent-inactive-replacement",
        },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    await session.complete({
      position: 14,
      trigger: { kind: "invoked" },
    });
    await session.complete({
      position: 0,
      trigger: { kind: "invoked" },
    });
    await Promise.resolve();
    expect(aborts).toBe(1);
    service.dispose();
  });

  it("preserves FIFO nested dispatch across shared-scope sessions", () => {
    let invalidate:
      | ((event: SqlCatalogInvalidation) => void)
      | undefined;
    const service = catalogService({
      ...readyCatalog,
      subscribe: (_scope, listener) => {
        invalidate = listener;
        return () => undefined;
      },
    });
    const open = () =>
      service.openDocument({
        context: {
          catalog: { scope: "connection:shared-dispatch" },
          dialect: "duckdb",
          engine: "local",
        },
        text: "SELECT 1",
      });
    const first = open();
    const second = open();
    const events: string[] = [];
    first.onDidChange(() => {
      events.push("first");
      if (events.length === 1) {
        invalidate?.({
          epoch: { generation: 2, token: "nested" },
        });
      }
    });
    second.onDidChange(() => {
      events.push("second");
    });
    invalidate?.({
      epoch: { generation: 1, token: "outer" },
    });
    expect(events).toEqual([
      "first",
      "second",
      "first",
      "second",
    ]);
    service.dispose();
  });

  it("fails catalog ownership closed after live-scope capacity", async () => {
    const service = catalogService();
    const sessions = Array.from({ length: 129 }, (_, index) =>
      service.openDocument({
        context: {
          catalog: { scope: `connection:capacity:${index}` },
          dialect: "duckdb",
          engine: "local",
        },
        text: "SELECT * FROM ",
      }),
    );
    await expect(
      sessions[128]!.complete({
        position: 14,
        trigger: { kind: "invoked" },
      }),
    ).resolves.toMatchObject({
      status: "ready",
      value: {
        issues: [{ reason: "catalog-overloaded" }],
      },
    });
    service.dispose();
  });

  it("accepts omitted and explicit-undefined completion budgets", () => {
    const first = createSqlLanguageService({
      completion: {},
      dialects: [duckdb],
    });
    const second = createSqlLanguageService({
      completion: { catalogResponseBudgetMs: undefined },
      dialects: [duckdb],
    });
    first.dispose();
    second.dispose();
  });

  it("contains synchronous invalidation while replacing a refresh intent", async () => {
    let invalidate:
      | ((event: SqlCatalogInvalidation) => void)
      | undefined;
    let searchCount = 0;
    const service = createSqlLanguageService<TestContext>({
      catalog: {
        id: "reentrant-invalidation",
        search: async () => {
          searchCount += 1;
          if (searchCount === 1) {
            return new Promise(() => {
              // Retained as the first completion's refresh intent.
            });
          }
          invalidate?.({
            epoch: { generation: 1, token: "synchronous" },
          });
          return {
            coverage: { kind: "complete" },
            epoch: { generation: 1, token: "synchronous" },
            relations: [],
            status: "ready",
          };
        },
        subscribe: (_scope, listener) => {
          invalidate = listener;
          return () => undefined;
        },
      },
      completion: { catalogResponseBudgetMs: 0 },
      dialects: [duckdb],
    });
    const text = "SELECT * FROM a; SELECT * FROM b";
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:reentrant" },
        dialect: "duckdb",
        engine: "local",
      },
      text,
    });
    const events: SqlSessionChangeEvent[] = [];
    session.onDidChange((event) => {
      events.push(event);
    });
    await session.complete({
      position: text.indexOf("a;") + 1,
      trigger: { kind: "invoked" },
    });
    const replacement = session.complete({
      position: text.length,
      trigger: { kind: "invoked" },
    });
    expect(replacement).toBeInstanceOf(Promise);
    expect(Object.isFrozen(replacement)).toBe(true);
    await expect(replacement).resolves.toMatchObject({
      reason: "superseded",
      status: "cancelled",
    });
    expect(searchCount).toBe(2);
    expect(events).toHaveLength(1);
    expect(events[0]?.refreshToken).toBe(
      replacement.refreshToken,
    );
    service.dispose();
  });

  it("contains a synchronous document update from provider search", async () => {
    let session:
      | ReturnType<ReturnType<typeof catalogService>["openDocument"]>
      | undefined;
    const service = catalogService({
      id: "reentrant-update",
      search: async () => {
        if (session) {
          session.update({
            baseRevision: session.revision,
            context: {
              catalog: { scope: "connection:reentrant-update" },
              dialect: "duckdb",
              engine: "updated",
            },
          });
        }
        return {
          coverage: { kind: "complete" },
          epoch: { generation: 0, token: "initial" },
          relations: [],
          status: "ready",
        };
      },
    });
    session = service.openDocument({
      context: {
        catalog: { scope: "connection:reentrant-update" },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    await expect(
      session.complete({
        position: 14,
        trigger: { kind: "invoked" },
      }),
    ).resolves.toMatchObject({
      reason: "superseded",
      status: "cancelled",
    });
    service.dispose();
  });

  it("ignores a hostile late abort callback after completion", async () => {
    let searchCount = 0;
    let resolveSecond:
      | ((
          response: Awaited<
            ReturnType<SqlRelationCatalogProvider["search"]>
          >,
        ) => void)
      | undefined;
    let secondSignal: AbortSignal | undefined;
    const secondResult = new Promise<
      Awaited<ReturnType<SqlRelationCatalogProvider["search"]>>
    >((resolve) => {
      resolveSecond = resolve;
    });
    const service = catalogService({
      id: "late-abort",
      search: async (_request, signal) => {
        searchCount += 1;
        if (searchCount === 1) {
          return {
            coverage: { kind: "complete" },
            epoch: { generation: 0, token: "initial" },
            relations: [],
            status: "ready",
          };
        }
        secondSignal = signal;
        return secondResult;
      },
    });
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:late-abort" },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    const controller = new AbortController();
    let captured:
      | EventListenerOrEventListenerObject
      | undefined;
    const nativeAdd = controller.signal.addEventListener.bind(
      controller.signal,
    );
    Object.defineProperty(controller.signal, "addEventListener", {
      configurable: true,
      value: (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: AddEventListenerOptions,
      ) => {
        if (type === "abort") captured = listener;
        nativeAdd(type, listener, options);
      },
    });
    await session.complete({
      position: 14,
      signal: controller.signal,
      trigger: { kind: "invoked" },
    });
    session.update({
      baseRevision: session.revision,
      document: {
        kind: "replace",
        text: "SELECT * FROM u",
      },
      embeddedRegions: [],
    });
    const current = session.complete({
      position: 15,
      trigger: { kind: "invoked" },
    });
    await Promise.resolve();
    if (typeof captured === "function") {
      captured(new Event("abort"));
    } else {
      captured?.handleEvent(new Event("abort"));
    }
    expect(secondSignal?.aborted).toBe(false);
    resolveSecond?.({
      coverage: { kind: "complete" },
      epoch: { generation: 0, token: "initial" },
      relations: [],
      status: "ready",
    });
    await expect(current).resolves.toMatchObject({
      status: "ready",
    });
    service.dispose();
  });

  it("normalizes a hostile range-inspection failure", () => {
    const { service, session } = openSession("");
    const hostileChange = new Proxy(
      { from: 0, insert: "x", to: 0 },
      {
        getOwnPropertyDescriptor() {
          throw new Error("hostile range");
        },
      },
    );
    expectSessionError("invalid-change", () => {
      session.update({
        baseRevision: session.revision,
        document: {
          changes: [hostileChange],
          kind: "changes",
        },
        embeddedRegions: [],
      });
    });
    service.dispose();
  });

  it("accepts a host timer whose opaque handle is null", async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    const nativeClearTimeout = globalThis.clearTimeout;
    let scheduled = 0;
    const cleared: unknown[] = [];
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      value: () => {
        scheduled += 1;
        return null;
      },
      writable: true,
    });
    Object.defineProperty(globalThis, "clearTimeout", {
      configurable: true,
      value: (handle: unknown) => {
        cleared.push(handle);
        scheduled -= 1;
      },
      writable: true,
    });
    try {
      const service = catalogService();
      const session = service.openDocument({
        context: {
          catalog: { scope: "connection:null-timer" },
          dialect: "duckdb",
          engine: "local",
        },
        text: "SELECT * FROM ",
      });
      await expect(
        session.complete({
          position: 14,
          trigger: { kind: "invoked" },
        }),
      ).resolves.toMatchObject({ status: "ready" });
      expect(cleared).toContain(null);
      service.dispose();
      expect(scheduled).toBe(0);

      const loadingService = catalogService({
        id: "null-loading-timer",
        search: async () => ({
          epoch: { generation: 0, token: "loading" },
          status: "loading",
        }),
      });
      const loadingSession = loadingService.openDocument({
        context: {
          catalog: { scope: "connection:null-loading-timer" },
          dialect: "duckdb",
          engine: "local",
        },
        text: "SELECT * FROM ",
      });
      await expect(loadingSession.complete({
        position: 14,
        trigger: { kind: "invoked" },
      })).resolves.toMatchObject({
        status: "ready",
        value: {
          issues: [{ reason: "catalog-loading" }],
        },
      });
      const clearedBeforeDispose = cleared.length;
      loadingService.dispose();
      expect(cleared.length).toBeGreaterThan(clearedBeforeDispose);
      expect(cleared.at(-1)).toBe(null);
      expect(scheduled).toBe(0);
    } finally {
      Object.defineProperty(globalThis, "setTimeout", {
        configurable: true,
        value: nativeSetTimeout,
        writable: true,
      });
      Object.defineProperty(globalThis, "clearTimeout", {
        configurable: true,
        value: nativeClearTimeout,
        writable: true,
      });
    }
  });

  it("handles synchronous terminal-intent timer completion", async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    const nativeClearTimeout = globalThis.clearTimeout;
    const cleared: unknown[] = [];
    let synchronousCalls = 0;
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      value: (
        callback: TimerHandler,
        delay?: number,
        ...arguments_: unknown[]
      ) => {
        if (delay === 1_000) {
          synchronousCalls += 1;
          if (typeof callback === "function") {
            Reflect.apply(callback, undefined, arguments_);
          }
          return null;
        }
        return nativeSetTimeout(callback, delay, ...arguments_);
      },
      writable: true,
    });
    Object.defineProperty(globalThis, "clearTimeout", {
      configurable: true,
      value: (handle: ReturnType<typeof setTimeout>) => {
        cleared.push(handle);
        nativeClearTimeout(handle);
      },
      writable: true,
    });
    try {
      const service = catalogService({
        id: "synchronous-intent-timer",
        search: async () => ({
          epoch: { generation: 0, token: "loading" },
          status: "loading",
        }),
      });
      const session = service.openDocument({
        context: {
          catalog: { scope: "connection:synchronous-intent-timer" },
          dialect: "duckdb",
          engine: "local",
        },
        text: "SELECT * FROM ",
      });
      await expect(session.complete({
        position: 14,
        trigger: { kind: "invoked" },
      })).resolves.toMatchObject({
        refreshToken: null,
        status: "ready",
        value: {
          issues: [
            {
              reason: "catalog-loading",
              remainingIntentLeaseMs: 0,
            },
          ],
        },
      });
      expect(synchronousCalls).toBe(1);
      expect(cleared).toContain(null);
      service.dispose();
    } finally {
      Object.defineProperty(globalThis, "setTimeout", {
        configurable: true,
        value: nativeSetTimeout,
        writable: true,
      });
      Object.defineProperty(globalThis, "clearTimeout", {
        configurable: true,
        value: nativeClearTimeout,
        writable: true,
      });
    }
  });

  it("handles synchronous soft-intent timer completion", async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    const nativeClearTimeout = globalThis.clearTimeout;
    const cleared: unknown[] = [];
    let responseTimerSeen = false;
    let positiveTimersAfterResponse = 0;
    let synchronousCalls = 0;
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      value: (
        callback: TimerHandler,
        delay?: number,
        ...arguments_: unknown[]
      ) => {
        if (delay === 0) {
          responseTimerSeen = true;
        } else if (
          responseTimerSeen &&
          typeof delay === "number" &&
          delay > 0
        ) {
          positiveTimersAfterResponse += 1;
          if (positiveTimersAfterResponse === 1) {
            synchronousCalls += 1;
            if (typeof callback === "function") {
              Reflect.apply(callback, undefined, arguments_);
            }
            return null;
          }
        }
        return nativeSetTimeout(callback, delay, ...arguments_);
      },
      writable: true,
    });
    Object.defineProperty(globalThis, "clearTimeout", {
      configurable: true,
      value: (handle: ReturnType<typeof setTimeout>) => {
        cleared.push(handle);
        nativeClearTimeout(handle);
      },
      writable: true,
    });
    try {
      const service = createSqlLanguageService<TestContext>({
        catalog: {
          id: "synchronous-soft-timer",
          search: () =>
            new Promise(() => {
              // The synthetic soft-intent timer owns settlement.
            }),
        },
        completion: { catalogResponseBudgetMs: 0 },
        dialects: [duckdb],
      });
      const session = service.openDocument({
        context: {
          catalog: { scope: "connection:synchronous-soft-timer" },
          dialect: "duckdb",
          engine: "local",
        },
        text: "SELECT * FROM ",
      });
      await expect(session.complete({
        position: 14,
        trigger: { kind: "invoked" },
      })).resolves.toMatchObject({
        refreshToken: null,
        status: "ready",
        value: {
          issues: [
            {
              reason: "catalog-loading",
              remainingIntentLeaseMs: 0,
            },
          ],
        },
      });
      expect(synchronousCalls).toBe(1);
      expect(cleared).toContain(null);
      service.dispose();
    } finally {
      Object.defineProperty(globalThis, "setTimeout", {
        configurable: true,
        value: nativeSetTimeout,
        writable: true,
      });
      Object.defineProperty(globalThis, "clearTimeout", {
        configurable: true,
        value: nativeClearTimeout,
        writable: true,
      });
    }
  });

  it("ignores a cleared soft-intent timer callback", async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    let responseTimerSeen = false;
    let staleCallback: (() => void) | undefined;
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      value: (
        callback: TimerHandler,
        delay?: number,
        ...arguments_: unknown[]
      ) => {
        if (delay === 0) {
          responseTimerSeen = true;
        } else if (
          responseTimerSeen &&
          staleCallback === undefined &&
          typeof callback === "function"
        ) {
          staleCallback = () => {
            Reflect.apply(callback, undefined, arguments_);
          };
        }
        return nativeSetTimeout(callback, delay, ...arguments_);
      },
      writable: true,
    });
    try {
      const service = createSqlLanguageService<TestContext>({
        catalog: {
          id: "stale-soft-timer",
          search: () =>
            new Promise(() => {
              // Session lifecycle owns this unsettled search.
            }),
        },
        completion: { catalogResponseBudgetMs: 0 },
        dialects: [duckdb],
      });
      const session = service.openDocument({
        context: {
          catalog: { scope: "connection:stale-soft-timer" },
          dialect: "duckdb",
          engine: "local",
        },
        text: "SELECT * FROM ",
      });
      await session.complete({
        position: 14,
        trigger: { kind: "invoked" },
      });
      expect(staleCallback).toBeTypeOf("function");
      const replacement = session.complete({
        position: 14,
        trigger: { kind: "invoked" },
      });
      staleCallback?.();
      session.dispose();
      await expect(replacement).resolves.toMatchObject({
        reason: "disposed",
        status: "cancelled",
      });
      service.dispose();
    } finally {
      Object.defineProperty(globalThis, "setTimeout", {
        configurable: true,
        value: nativeSetTimeout,
        writable: true,
      });
    }
  });

  it("does not let a stale intent callback erase a newer timer", async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    const nativeClearTimeout = globalThis.clearTimeout;
    const callbacks: Array<() => void> = [];
    const handles: object[] = [];
    const cleared: number[] = [];
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      value: (
        callback: TimerHandler,
        delay?: number,
        ...arguments_: unknown[]
      ) => {
        if (delay !== 1_000) {
          return nativeSetTimeout(callback, delay, ...arguments_);
        }
        if (typeof callback !== "function") {
          throw new Error("Intent timer callback must be a function");
        }
        callbacks.push(() => {
          Reflect.apply(callback, undefined, arguments_);
        });
        const handle = Object.freeze({ id: handles.length });
        handles.push(handle);
        return handle;
      },
      writable: true,
    });
    Object.defineProperty(globalThis, "clearTimeout", {
      configurable: true,
      value: (handle: unknown) => {
        const index = handles.findIndex(
          (candidate) => candidate === handle,
        );
        if (index >= 0) {
          cleared.push(index);
        } else {
          Reflect.apply(nativeClearTimeout, globalThis, [handle]);
        }
      },
      writable: true,
    });
    try {
      const service = catalogService({
        id: "stale-intent-timer",
        search: async () => ({
          epoch: { generation: 0, token: "loading" },
          status: "loading",
        }),
      });
      const session = service.openDocument({
        context: {
          catalog: { scope: "connection:stale-intent-timer" },
          dialect: "duckdb",
          engine: "local",
        },
        text: "SELECT * FROM ",
      });
      await session.complete({
        position: 14,
        trigger: { kind: "invoked" },
      });
      await session.complete({
        position: 14,
        trigger: { kind: "invoked" },
      });
      expect(callbacks).toHaveLength(2);
      expect(cleared).toContain(0);

      callbacks[0]?.();
      session.dispose();

      expect(cleared).toContain(1);
      service.dispose();
    } finally {
      Object.defineProperty(globalThis, "setTimeout", {
        configurable: true,
        value: nativeSetTimeout,
        writable: true,
      });
      Object.defineProperty(globalThis, "clearTimeout", {
        configurable: true,
        value: nativeClearTimeout,
        writable: true,
      });
    }
  });

  it("consumes settlement racing the soft response timer", async () => {
    let resolveSearch:
      | ((
          response: Awaited<
            ReturnType<SqlRelationCatalogProvider["search"]>
          >,
        ) => void)
      | undefined;
    const searchResult = new Promise<
      Awaited<ReturnType<SqlRelationCatalogProvider["search"]>>
    >((resolve) => {
      resolveSearch = resolve;
    });
    const nativeSetTimeout = globalThis.setTimeout;
    let injected = false;
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      value: (
        callback: TimerHandler,
        delay?: number,
        ...arguments_: unknown[]
      ) =>
        nativeSetTimeout(
          (...timerArguments: unknown[]) => {
            if (delay === 0 && !injected) {
              injected = true;
              resolveSearch?.({
                coverage: { kind: "complete" },
                epoch: { generation: 0, token: "initial" },
                relations: [],
                status: "ready",
              });
            }
            if (typeof callback === "function") {
              Reflect.apply(callback, undefined, timerArguments);
            }
          },
          delay,
          ...arguments_,
        ),
      writable: true,
    });
    try {
      const service = createSqlLanguageService<TestContext>({
        catalog: {
          id: "settlement-race",
          search: async () => searchResult,
        },
        completion: { catalogResponseBudgetMs: 0 },
        dialects: [duckdb],
      });
      const session = service.openDocument({
        context: {
          catalog: { scope: "connection:settlement-race" },
          dialect: "duckdb",
          engine: "local",
        },
        text: "SELECT * FROM ",
      });
      const events: string[] = [];
      session.onDidChange((event) => {
        events.push(event.reason);
      });
      await expect(session.complete({
        position: 14,
        trigger: { kind: "invoked" },
      })).resolves.toMatchObject({
        sources: [
          {
            coverage: "complete",
            outcome: "ready",
            providerId: "settlement-race",
          },
        ],
        status: "ready",
        value: {
          isIncomplete: false,
          issues: [],
        },
      });
      expect(events).toEqual([]);
      service.dispose();
    } finally {
      Object.defineProperty(globalThis, "setTimeout", {
        configurable: true,
        value: nativeSetTimeout,
        writable: true,
      });
    }
  });

  it("fails catalog ownership closed after per-scope membership capacity", async () => {
    const service = catalogService();
    const sessions = Array.from({ length: 257 }, () =>
      service.openDocument({
        context: {
          catalog: { scope: "connection:membership-capacity" },
          dialect: "duckdb",
          engine: "local",
        },
        text: "SELECT * FROM ",
      }),
    );
    await expect(
      sessions[256]!.complete({
        position: 14,
        trigger: { kind: "invoked" },
      }),
    ).resolves.toMatchObject({
      status: "ready",
      value: {
        issues: [{ reason: "catalog-overloaded" }],
      },
    });
    service.dispose();
  });

  it("forwards a validated ordered catalog search path", async () => {
    let observed:
      | Parameters<SqlRelationCatalogProvider["search"]>[0]
      | undefined;
    const service = catalogService({
      id: "search-path",
      search: async (request) => {
        observed = request;
        return {
          coverage: { kind: "complete" },
          epoch: { generation: 0, token: "initial" },
          relations: [],
          status: "ready",
        };
      },
    });
    const searchPath = [
      [
        { quoted: false, value: "memory" },
        { quoted: true, value: "Main Schema" },
      ],
    ] as const;
    const session = service.openDocument({
      context: {
        catalog: {
          scope: "connection:search-path",
          searchPath,
        },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    await session.complete({
      position: 14,
      trigger: { kind: "invoked" },
    });
    expect(observed?.searchPaths).toEqual(searchPath);
    expect(observed?.searchPaths).not.toBe(searchPath);
    service.dispose();
  });

  it("contains reentrant completion during signal registration", async () => {
    const service = createSqlLanguageService<TestContext>({
      catalog: {
        id: "reentrant-signal",
        search: async () =>
          new Promise(() => {
            // Settled by session disposal.
          }),
      },
      completion: { catalogResponseBudgetMs: 0 },
      dialects: [duckdb],
    });
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:reentrant-signal" },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    await session.complete({
      position: 14,
      trigger: { kind: "invoked" },
    });
    const controller = new AbortController();
    let nested:
      | ReturnType<typeof session.complete>
      | undefined;
    const nativeAdd = controller.signal.addEventListener.bind(
      controller.signal,
    );
    Object.defineProperty(controller.signal, "addEventListener", {
      configurable: true,
      value: (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: AddEventListenerOptions,
      ) => {
        if (!nested) {
          nested = session.complete({
            position: 14,
            trigger: { kind: "invoked" },
          });
        }
        nativeAdd(type, listener, options);
      },
    });
    await expect(
      session.complete({
        position: 0,
        signal: controller.signal,
        trigger: { kind: "invoked" },
      }),
    ).resolves.toMatchObject({
      reason: "superseded",
      status: "cancelled",
    });
    service.dispose();
    await expect(nested).resolves.toMatchObject({
      reason: "disposed",
      status: "cancelled",
    });
  });

  it("publishes the task token before reentrant signal invalidation", async () => {
    let invalidate:
      | ((event: SqlCatalogInvalidation) => void)
      | undefined;
    const service = createSqlLanguageService<TestContext>({
      catalog: {
        id: "signal-invalidation",
        search: async () => ({
          coverage: { kind: "complete" },
          epoch: { generation: 0, token: "initial" },
          relations: [],
          status: "ready",
        }),
        subscribe: (_scope, listener) => {
          invalidate = listener;
          return () => undefined;
        },
      },
      dialects: [duckdb],
    });
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:signal-invalidation" },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    const controller = new AbortController();
    let task:
      | ReturnType<typeof session.complete>
      | undefined;
    let matchedPublishedToken = false;
    session.onDidChange((event) => {
      matchedPublishedToken =
        task !== undefined &&
        event.refreshToken === task.refreshToken;
    });
    const nativeAdd = controller.signal.addEventListener.bind(
      controller.signal,
    );
    Object.defineProperty(controller.signal, "addEventListener", {
      configurable: true,
      value: (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: AddEventListenerOptions,
      ) => {
        invalidate?.({
          epoch: { generation: 1, token: "signal" },
        });
        nativeAdd(type, listener, options);
      },
    });
    task = session.complete({
      position: 14,
      signal: controller.signal,
      trigger: { kind: "invoked" },
    });
    await expect(task).resolves.toMatchObject({
      reason: "superseded",
      status: "cancelled",
    });
    expect(matchedPublishedToken).toBe(true);
    service.dispose();
  });

  it("handles abort reentrancy during signal registration", async () => {
    const service = catalogService({
      id: "signal-abort",
      search: async () =>
        new Promise(() => {
          // Abort occurs before provider invocation.
        }),
    });
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:signal-abort" },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    const controller = new AbortController();
    const nativeAdd = controller.signal.addEventListener.bind(
      controller.signal,
    );
    Object.defineProperty(controller.signal, "addEventListener", {
      configurable: true,
      value: (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: AddEventListenerOptions,
      ) => {
        nativeAdd(type, listener, options);
        controller.abort();
      },
    });
    await expect(session.complete({
      position: 14,
      signal: controller.signal,
      trigger: { kind: "invoked" },
    })).resolves.toMatchObject({
      reason: "caller",
      status: "cancelled",
    });
    service.dispose();
  });

  it("rechecks abort after signal registration", async () => {
    let searchCount = 0;
    const service = catalogService({
      id: "signal-abort-before-registration",
      search: async () => {
        searchCount += 1;
        return {
          coverage: { kind: "complete" },
          epoch: { generation: 0, token: "initial" },
          relations: [],
          status: "ready",
        };
      },
    });
    const session = service.openDocument({
      context: {
        catalog: {
          scope: "connection:signal-abort-before-registration",
        },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    const controller = new AbortController();
    const nativeAdd = controller.signal.addEventListener.bind(
      controller.signal,
    );
    Object.defineProperty(controller.signal, "addEventListener", {
      configurable: true,
      value: (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: AddEventListenerOptions,
      ) => {
        controller.abort();
        nativeAdd(type, listener, options);
      },
    });
    await expect(session.complete({
      position: 14,
      signal: controller.signal,
      trigger: { kind: "invoked" },
    })).resolves.toMatchObject({
      reason: "caller",
      status: "cancelled",
    });
    expect(searchCount).toBe(0);
    service.dispose();
  });

  it.each(["before", "after"] as const)(
    "preserves a nested completion when the signal becomes aborted %s registration",
    async (phase) => {
      let searchCount = 0;
      const service = catalogService({
        id: `signal-aborted-getter-${phase}`,
        search: async () => {
          searchCount += 1;
          return {
            coverage: { kind: "complete" },
            epoch: { generation: 0, token: "initial" },
            relations: [],
            status: "ready",
          };
        },
      });
      const session = service.openDocument({
        context: {
          catalog: {
            scope: `connection:signal-aborted-getter-${phase}`,
          },
          dialect: "duckdb",
          engine: "local",
        },
        text: "SELECT * FROM ",
      });
      const controller = new AbortController();
      let reads = 0;
      let nested:
        | ReturnType<typeof session.complete>
        | undefined;
      Object.defineProperty(controller.signal, "aborted", {
        configurable: true,
        get: () => {
          reads += 1;
          if (
            !nested &&
            (phase === "before" || reads === 2)
          ) {
            nested = session.complete({
              position: 14,
              trigger: { kind: "invoked" },
            });
            return true;
          }
          return false;
        },
      });

      const outer = session.complete({
        position: 14,
        signal: controller.signal,
        trigger: { kind: "invoked" },
      });
      await expect(outer).resolves.toMatchObject({
        reason: "superseded",
        status: "cancelled",
      });
      await expect(nested).resolves.toMatchObject({
        status: "ready",
      });
      expect(searchCount).toBe(1);
      service.dispose();
    },
  );

  it("cleans up when signal registration throws", async () => {
    let generation = 0;
    let invalidate:
      | ((event: SqlCatalogInvalidation) => void)
      | undefined;
    const service = catalogService({
      id: "throwing-signal-add",
      search: async () => ({
        coverage: { kind: "complete" },
        epoch: {
          generation,
          token: `generation:${generation}`,
        },
        relations: [],
        status: "ready",
      }),
      subscribe: (_scope, listener) => {
        invalidate = listener;
        return () => undefined;
      },
    });
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:throwing-signal-add" },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    const events: SqlSessionChangeEvent[] = [];
    session.onDidChange((event) => {
      events.push(event);
    });
    const controller = new AbortController();
    Object.defineProperty(controller.signal, "addEventListener", {
      configurable: true,
      value: () => {
        throw new Error("registration failed");
      },
    });
    await expect(session.complete({
      position: 14,
      signal: controller.signal,
      trigger: { kind: "invoked" },
    })).rejects.toThrow("registration failed");
    generation = 1;
    invalidate?.({
      epoch: { generation, token: `generation:${generation}` },
    });
    expect(events).toEqual([
      expect.objectContaining({
        reason: "catalog",
        refreshToken: null,
      }),
    ]);
    await expect(session.complete({
      position: 14,
      trigger: { kind: "invoked" },
    })).resolves.toMatchObject({
      refreshToken: null,
      status: "ready",
    });
    const reentrantController = new AbortController();
    Object.defineProperty(
      reentrantController.signal,
      "addEventListener",
      {
        configurable: true,
        value: () => {
          generation = 2;
          invalidate?.({
            epoch: {
              generation,
              token: `generation:${generation}`,
            },
          });
          throw new Error("reentrant registration failed");
        },
      },
    );
    const reentrantTask = session.complete({
      position: 14,
      signal: reentrantController.signal,
      trigger: { kind: "invoked" },
    });
    await expect(reentrantTask).rejects.toThrow(
      "reentrant registration failed",
    );
    expect(events[1]?.refreshToken).toBe(
      reentrantTask.refreshToken,
    );
    generation = 3;
    invalidate?.({
      epoch: { generation, token: `generation:${generation}` },
    });
    expect(events[2]).toMatchObject({
      reason: "catalog",
      refreshToken: null,
    });
    await expect(session.complete({
      position: 14,
      trigger: { kind: "invoked" },
    })).resolves.toMatchObject({
      refreshToken: null,
      status: "ready",
    });
    service.dispose();
  });

  it("cleans up when the signal aborted getter throws", async () => {
    let generation = 0;
    let invalidate:
      | ((event: SqlCatalogInvalidation) => void)
      | undefined;
    const service = catalogService({
      id: "throwing-signal-aborted",
      search: async () => ({
        coverage: { kind: "complete" },
        epoch: {
          generation,
          token: `generation:${generation}`,
        },
        relations: [],
        status: "ready",
      }),
      subscribe: (_scope, listener) => {
        invalidate = listener;
        return () => undefined;
      },
    });
    const session = service.openDocument({
      context: {
        catalog: {
          scope: "connection:throwing-signal-aborted",
        },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    const events: SqlSessionChangeEvent[] = [];
    session.onDidChange((event) => {
      events.push(event);
    });
    const controller = new AbortController();
    Object.defineProperty(controller.signal, "aborted", {
      configurable: true,
      get: () => {
        throw new Error("aborted read failed");
      },
    });
    await expect(session.complete({
      position: 14,
      signal: controller.signal,
      trigger: { kind: "invoked" },
    })).rejects.toThrow("aborted read failed");
    generation = 1;
    invalidate?.({
      epoch: { generation, token: `generation:${generation}` },
    });
    expect(events).toEqual([
      expect.objectContaining({
        reason: "catalog",
        refreshToken: null,
      }),
    ]);
    await expect(session.complete({
      position: 14,
      trigger: { kind: "invoked" },
    })).resolves.toMatchObject({
      refreshToken: null,
      status: "ready",
    });
    service.dispose();
  });

  it("contains signal cleanup failures after making the task inert", async () => {
    let generation = 0;
    let invalidate:
      | ((event: SqlCatalogInvalidation) => void)
      | undefined;
    const service = catalogService({
      id: "throwing-signal-remove",
      search: async () => ({
        coverage: { kind: "complete" },
        epoch: {
          generation,
          token: `generation:${generation}`,
        },
        relations: [],
        status: "ready",
      }),
      subscribe: (_scope, listener) => {
        invalidate = listener;
        return () => undefined;
      },
    });
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:throwing-signal-remove" },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    const events: SqlSessionChangeEvent[] = [];
    session.onDidChange((event) => {
      events.push(event);
    });
    const controller = new AbortController();
    Object.defineProperty(controller.signal, "removeEventListener", {
      configurable: true,
      value: () => {
        throw new Error("cleanup failed");
      },
    });
    await expect(session.complete({
      position: 14,
      signal: controller.signal,
      trigger: { kind: "invoked" },
    })).resolves.toMatchObject({
      refreshToken: null,
      status: "ready",
    });
    generation = 1;
    invalidate?.({
      epoch: { generation, token: `generation:${generation}` },
    });
    expect(events).toEqual([
      expect.objectContaining({
        reason: "catalog",
        refreshToken: null,
      }),
    ]);
    await expect(session.complete({
      position: 14,
      trigger: { kind: "invoked" },
    })).resolves.toMatchObject({
      refreshToken: null,
      status: "ready",
    });
    service.dispose();
  });

  it("stops catalog event delivery when a listener disposes the session", () => {
    let invalidate:
      | ((event: SqlCatalogInvalidation) => void)
      | undefined;
    const service = catalogService({
      id: "dispose-listener",
      search: async () => ({
        coverage: { kind: "complete" },
        epoch: { generation: 0, token: "initial" },
        relations: [],
        status: "ready",
      }),
      subscribe: (_scope, listener) => {
        invalidate = listener;
        return () => undefined;
      },
    });
    const session = service.openDocument({
      context: {
        catalog: { scope: "connection:dispose-listener" },
        dialect: "duckdb",
        engine: "local",
      },
      text: "SELECT * FROM ",
    });
    const events: string[] = [];
    session.onDidChange((event) => {
      events.push(event.reason);
      session.dispose();
    });
    session.onDidChange((event) => {
      events.push(`${event.reason}:late`);
    });

    invalidate?.({
      epoch: { generation: 1, token: "changed" },
    });

    expect(events).toEqual(["catalog"]);
    service.dispose();
  });
});
