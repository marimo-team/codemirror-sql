# vNext Session Primitives

Status: experimental walking skeleton  
Import: `@marimo-team/codemirror-sql/vnext`

This entry point currently provides document ownership, atomic text/context
updates, opaque revisions, dialect registration, and lifecycle management. It
does not yet provide parsing, completion, diagnostics, hover, or navigation.
Those methods will be added only with working vertical slices.

## Example

```ts
import {
  createSqlLanguageService,
  defineSqlDialect,
  type SqlDocumentContext,
} from "@marimo-team/codemirror-sql/vnext";

interface AppSqlContext extends SqlDocumentContext {
  readonly engine: string;
}

const service = createSqlLanguageService<AppSqlContext>({
  dialects: [
    defineSqlDialect({ id: "duckdb", displayName: "DuckDB" }),
  ],
});

const session = service.openDocument({
  text: "SELECT * FROM users",
  context: { dialect: "duckdb", engine: "local" },
});

const revision = session.update({
  kind: "document",
  baseRevision: session.revision,
  document: {
    kind: "changes",
    changes: [{ from: 14, to: 19, insert: "customers" }],
  },
});

if (session.isCurrent(revision)) {
  // Results produced for this revision may still be applied.
}

session.dispose();
service.dispose();
```

Use `{ kind: "replace", text }` for full replacement and
`{ kind: "context", baseRevision, context }` for a context-only update.

## Contract

- Every accepted update creates a new frozen, service-issued revision.
- `baseRevision` is checked by identity and cannot come from another session.
- Incremental ranges are ordered, non-overlapping, half-open UTF-16 offsets in
  the pre-update document.
- Text and context are validated completely before the session snapshot changes.
- Context is structured-cloned and recursively frozen. Accepted values are
  finite primitives, arrays, and string-keyed plain objects. Cycles and shared
  references are retained. Accessors, symbols, functions, class instances,
  typed collections, and non-finite numbers are rejected.
- Public service and session operations remain bound when passed as callbacks
  or destructured.
- Session and service disposal are idempotent and terminal.
- Synchronous public failures use `SqlSessionError` and a stable `code`; caught
  platform errors are not exposed as causes.

The safety envelope currently permits at most 10,000 changes in one update, a
16 Mi-code-unit document, 1,000 registered dialects, and bounded context graph
depth, size, properties, and string data. These are defensive walking-skeleton
limits, not release performance claims.

The `/vnext` name is provisional until the packaging ADR fixes the next-major
subpath layout.
