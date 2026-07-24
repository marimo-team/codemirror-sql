# vNext Session Primitives

Status: experimental walking skeleton  
Import: `@marimo-team/codemirror-sql/vnext`

This entry point currently provides document ownership, atomic text/context
updates, opaque revisions, dialect registration, and lifecycle management. It
does not yet provide parsing, completion, diagnostics, hover, or navigation.
Those methods will be added only with working vertical slices.

See [source coordinates](./source-coordinates.md) for the shared UTF-16 range
contract and the internal immutable source-snapshot model.

## Example

```ts
import {
  createSqlLanguageService,
  duckdbDialect,
  type SqlDocumentContext,
} from "@marimo-team/codemirror-sql/vnext";

interface AppSqlContext extends SqlDocumentContext {
  readonly engine: string;
}

const dialect = duckdbDialect();
const service = createSqlLanguageService<AppSqlContext>({
  dialects: [dialect],
});

const session = service.openDocument({
  text: "SELECT * FROM users",
  context: { dialect: dialect.id, engine: "local" },
});

const revision = session.update({
  baseRevision: session.revision,
  document: {
    kind: "changes",
    changes: [{ from: 14, to: 19, insert: "customers" }],
  },
  embeddedRegions: [],
});

if (session.isCurrent(revision)) {
  // Results produced for this revision may still be applied.
}

session.dispose();
service.dispose();
```

Use `{ kind: "replace", text }` for full replacement and
`{ baseRevision, context }` for a context-only update. Every document mutation
also supplies the complete embedded-region set for its resulting text. A
region-only transaction can replace or clear that set without a fake text edit.

## Dialect registration

`duckdbDialect()`, `postgresDialect()`, `bigQueryDialect()`, and
`dremioDialect()` return frozen, opaque built-in handles. Each factory returns
the same singleton on repeated calls. The service resolves a handle through
package-owned runtime metadata, so a copied, serialized, fabricated, or
different-package-instance handle is rejected.

Handles are local service configuration, not transport data. Document context
contains only the handle's serializable string `id`; a worker or separate
package instance must call its own built-in factory rather than receive a
handle through cloning or messaging. The ID selects a registered handle but
does not itself infer lexical behavior.

## Contract

- Every accepted update creates a new frozen, service-issued revision.
- `baseRevision` is checked by identity and cannot come from another session.
- Incremental ranges are ordered, non-overlapping, half-open UTF-16 offsets in
  the pre-update document.
- Text, context, and embedded regions are validated completely before the
  session snapshot changes.
- Context is structured-cloned and recursively frozen. Accepted values are
  finite primitives, arrays, and string-keyed plain objects. Cycles and shared
  references are retained. Accessors, symbols, functions, class instances,
  typed collections, and non-finite numbers are rejected.
- Public service and session operations remain bound when passed as callbacks
  or destructured.
- Session and service disposal are idempotent and terminal.
- Synchronous public failures use `SqlSessionError` and a stable `code`; caught
  platform errors are not exposed as causes.

The internal statement index is built lazily per session. Context-only updates
reuse it when the lexical-profile identity is unchanged. Source-changing
transactions use a separate source sequence, so region-only changes cannot
reuse a stale index. A no-op document update or same-text replacement advances
the public revision and document sequence but can reuse the index. Trusted
incremental identity-source changes update a populated cache; a changed
replacement, profile change, or changed masked source without verified
analysis-coordinate changes clears it for a later full build. Invalid updates
leave both the session snapshot and cache unchanged, and disposal clears the
cache.

The safety envelope currently permits at most 10,000 changes in one update, a
16 Mi-code-unit document, 1,000 registered dialects, and bounded context graph
depth, size, properties, and string data. These are defensive walking-skeleton
limits, not release performance claims.

The `/vnext` name is provisional until the packaging ADR fixes the next-major
subpath layout.
