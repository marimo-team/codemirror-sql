import { describe, expect, it } from "vitest";
import {
  createSqlLanguageService,
  defineSqlDialect,
  SqlSessionError,
} from "../index.js";
import { DefaultSqlLanguageService } from "../session.js";
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

const duckdb = defineSqlDialect({
  displayName: "DuckDB",
  id: "duckdb",
});
const postgres = defineSqlDialect({
  displayName: "PostgreSQL",
  id: "postgres",
});

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
  it("creates immutable definitions", () => {
    expect(duckdb).toEqual({ displayName: "DuckDB", id: "duckdb" });
    expect(Object.isFrozen(duckdb)).toBe(true);
  });

  it.each([
    [{ displayName: "DuckDB", id: " " }, "SQL dialect id must contain 1 to 256"],
    [
      { displayName: " ", id: "duckdb" },
      "SQL dialect display name must contain 1 to 1024",
    ],
  ])("rejects invalid definitions", (definition, message) => {
    expect(() => defineSqlDialect(definition)).toThrow(message);
  });

  it("rejects duplicate IDs", () => {
    expectSessionError("duplicate-dialect", () => {
      createSqlLanguageService({
        dialects: [duckdb, { displayName: "Other", id: "duckdb" }],
      });
    });
  });

  it("normalizes malformed definitions without invoking accessors", () => {
    let invoked = false;
    expectSessionError("invalid-dialect", () => {
      defineSqlDialect({
        displayName: "DuckDB",
        get id() {
          invoked = true;
          return "duckdb";
        },
      });
    });
    expect(invoked).toBe(false);
    expectSessionError("invalid-dialect", () => {
      defineSqlDialect({ displayName: "DuckDB", id: 42 } as never);
    });
    expectSessionError("invalid-dialect", () => {
      defineSqlDialect(null as never);
    });
    expectSessionError("invalid-dialect", () => {
      defineSqlDialect(
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

  it("returns only normalized dialect fields", () => {
    const extendedDefinition = {
      displayName: "DuckDB",
      id: "duckdb",
      internal: true,
    };
    const definition = defineSqlDialect(extendedDefinition);
    expect(definition).toEqual({ displayName: "DuckDB", id: "duckdb" });
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
      kind: "document",
      baseRevision: first,
      document: { kind: "replace", text: "B" },
    });
    const third = session.update({
      kind: "document",
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
        kind: "document",
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
      kind: "document",
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
      kind: "document",
      baseRevision: first,
      document: { kind: "replace", text: "SELECT 1" },
    });
    expect(second).not.toBe(first);
  });
});

describe("document changes", () => {
  it("applies ordered changes in pre-update coordinates", () => {
    const { session } = openSession("SELECT users.id FROM users");
    session.update({
      kind: "document",
      baseRevision: session.revision,
      document: {
        kind: "changes",
        changes: [
          { from: 7, insert: "customers", to: 12 },
          { from: 21, insert: "customers", to: 26 },
        ],
      },
    });

    expect(session.snapshotForTesting.text).toBe(
      "SELECT customers.id FROM customers",
    );
  });

  it("uses JavaScript UTF-16 offsets", () => {
    const { session } = openSession("A😀B");
    session.update({
      kind: "document",
      baseRevision: session.revision,
      document: {
        kind: "changes",
        changes: [{ from: 1, insert: "X", to: 3 }],
      },
    });
    expect(session.snapshotForTesting.text).toBe("AXB");
  });

  it("keeps same-position insertions ordered", () => {
    const { session } = openSession("AB");
    session.update({
      kind: "document",
      baseRevision: session.revision,
      document: {
        kind: "changes",
        changes: [
          { from: 1, insert: "1", to: 1 },
          { from: 1, insert: "2", to: 1 },
        ],
      },
    });
    expect(session.snapshotForTesting.text).toBe("A12B");
  });

  it("supports adjacent replacements and document boundaries", () => {
    const { session } = openSession("ABCDE");
    session.update({
      kind: "document",
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
    expect(session.snapshotForTesting.text).toBe("XYZ!");
  });

  it("deletes the entire document", () => {
    const { session } = openSession("SELECT 1");
    session.update({
      kind: "document",
      baseRevision: session.revision,
      document: { kind: "changes", changes: [{ from: 0, insert: "", to: 8 }] },
    });
    expect(session.snapshotForTesting.text).toBe("");
  });

  it("allows edits at every UTF-16 boundary", () => {
    const { session } = openSession("A😀e\u0301\r\nZ\uD800");
    session.update({
      kind: "document",
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
    expect(session.snapshotForTesting.text).toBe("A\uD83DXe\u0301\nZ!\uD800");
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
        kind: "document",
        baseRevision: revision,
        document: { kind: "changes", changes: [change] },
      });
    });

    expect(session.revision).toBe(revision);
    expect(session.snapshotForTesting.text).toBe("ABC");
  });

  it("rejects unordered and overlapping changes atomically", () => {
    const { session } = openSession("ABCDE");
    const revision = session.revision;
    expectSessionError("invalid-change", () => {
      session.update({
        kind: "document",
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
    expect(session.snapshotForTesting.text).toBe("ABCDE");
  });

  it("rejects non-string inserts from JavaScript callers", () => {
    const { session } = openSession("ABC");
    expectSessionError("invalid-change", () => {
      session.update({
        kind: "document",
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
      session.update({ kind: "document", baseRevision: revision, document } as never);
    });
    expect(session.revision).toBe(revision);
    expect(session.snapshotForTesting.text).toBe("ABC");
  });

  it("rejects an empty JavaScript update", () => {
    const { session } = openSession("ABC");
    expectSessionError("invalid-update", () => {
      session.update({ kind: "document", baseRevision: session.revision } as never);
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
        kind: "document",
        baseRevision: session.revision,
        document: { kind: "unknown" },
      } as never);
    });
    expectSessionError("invalid-update", () => {
      session.update({
        kind: "document",
        baseRevision: session.revision,
        document: { kind: "replace", text: "ABC", changes: [] },
      } as never);
    });
    expectSessionError("invalid-update", () => {
      session.update({
        kind: "context",
        baseRevision: session.revision,
        context: undefined,
      } as never);
    });
    expectSessionError("invalid-update", () => {
      session.update({
        kind: "context",
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
      kind: "document",
      baseRevision: session.revision,
      document: { kind: "replace", text: "recovered" },
    });
    expect(session.snapshotForTesting.text).toBe("recovered");
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
    expect(session.snapshotForTesting.text).toBe("ABC");
  });

  it("rejects undefined and accessor optional update fields", () => {
    const { session } = openSession("ABC");
    const revision = session.revision;
    expectSessionError("invalid-update", () => {
      session.update({
        kind: "document",
        baseRevision: revision,
        context: undefined,
        document: { kind: "replace", text: "changed" },
      } as never);
    });
    expect(session.revision).toBe(revision);
    expect(session.snapshotForTesting.text).toBe("ABC");

    let invoked = false;
    const update = {
      baseRevision: session.revision,
      get document() {
        invoked = true;
        return { text: "changed" };
      },
    };
    expectSessionError("invalid-update", () => {
      session.update(update as never);
    });
    expect(invoked).toBe(false);
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
        kind: "document",
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
          kind: "document",
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
                kind: "document",
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
      kind: "document",
      baseRevision: originalRevision,
      document,
    });

    expect(nestedError?.code).toBe("reentrant-update");
    expect(session.isCurrent(revision)).toBe(true);
    expect(session.snapshotForTesting.text).toBe("outer");
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
        kind: "document",
        baseRevision: revision,
        document,
      });
    });
    expect(session.isCurrent(revision)).toBe(false);
    expect(session.snapshotForTesting.text).toBe("ABC");
  });

  it("bounds fragmented and oversized document updates", () => {
    const { session } = openSession("");
    const tooManyChanges: { from: number; insert: string; to: number }[] = [];
    tooManyChanges.length = 10_001;
    expectSessionError("invalid-change", () => {
      session.update({
        kind: "document",
        baseRevision: session.revision,
        document: { kind: "changes", changes: tooManyChanges },
      });
    });

    expectSessionError("invalid-document", () => {
      session.update({
        kind: "document",
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
    expect(session.snapshotForTesting.text).toBe("");
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

  it("updates text and context atomically", () => {
    const { session } = openSession("SELECT 1");
    session.update({
      kind: "document",
      baseRevision: session.revision,
      context: { dialect: "postgres", engine: "warehouse" },
      document: { kind: "replace", text: "SELECT 2" },
    });

    expect(session.snapshotForTesting).toMatchObject({
      context: { dialect: "postgres", engine: "warehouse" },
      text: "SELECT 2",
    });
  });

  it("supports context-only updates", () => {
    const { session } = openSession("SELECT 1");
    session.update({
      kind: "context",
      baseRevision: session.revision,
      context: { dialect: "postgres", engine: "warehouse" },
    });
    expect(session.snapshotForTesting.text).toBe("SELECT 1");
    expect(session.snapshotForTesting.context.dialect).toBe("postgres");
  });

  it("retains the owned context for document-only updates", () => {
    const { session } = openSession();
    const context = session.snapshotForTesting.context;
    session.update({
      kind: "document",
      baseRevision: session.revision,
      document: { kind: "replace", text: "SELECT 1" },
    });
    expect(session.snapshotForTesting.context).toBe(context);
  });

  it("clones a supplied context again on every update", () => {
    const { session } = openSession();
    const context: TestContext = { dialect: "duckdb", engine: "local" };
    session.update({ kind: "context", baseRevision: session.revision, context });
    const firstOwned = session.snapshotForTesting.context;
    session.update({ kind: "context", baseRevision: session.revision, context });
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
        kind: "document",
        baseRevision: revision,
        context,
        document: { kind: "replace", text: "SELECT 2" },
      } as never);
    });
    expect(session.revision).toBe(revision);
    expect(session.snapshotForTesting.text).toBe("SELECT 1");
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
    session.update({ kind: "document", baseRevision: stale, document: { kind: "replace", text: "SELECT 1" } });
    let inspected = false;
    const context = {
      dialect: "duckdb",
      get engine() {
        inspected = true;
        return "local";
      },
    };
    expectSessionError("stale-revision", () => {
      session.update({ kind: "context", baseRevision: stale, context });
    });
    expect(inspected).toBe(false);
  });
});

describe("lifecycle", () => {
  it("makes session disposal idempotent and terminal", () => {
    const { session } = openSession();
    const revision = session.revision;
    session.dispose();
    session.dispose();

    expect(session.isCurrent(revision)).toBe(false);
    expectSessionError("session-disposed", () => {
      session.update({
        kind: "document",
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
      context: { dialect: "postgres", engine: "two" },
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
