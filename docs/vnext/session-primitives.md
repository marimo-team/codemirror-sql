# vNext Session Primitives

Status: experimental walking skeleton  
Import: `@marimo-team/codemirror-sql/vnext`

This entry point provides document ownership, atomic text/context updates,
opaque revisions, dialect registration, lifecycle management, and
parser-independent relation completion. Diagnostics, hover, navigation, and
general expression completion are not yet available.

CodeMirror consumers should use the separate
[vNext CodeMirror adapter](./codemirror-adapter.md).

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

## Relation completion

Completion works without a catalog for visible CTEs. A service can also own one
shared asynchronous relation-catalog provider:

```ts
const service = createSqlLanguageService<AppSqlContext>({
  catalog: {
    id: "app-catalog",
    search: async (request, signal) => {
      signal.throwIfAborted();
      return {
        coverage: { kind: "complete" },
        epoch: { generation: 0, token: "initial" },
        relations: [],
        status: "ready",
      };
    },
  },
  completion: { catalogResponseBudgetMs: 40 },
  dialects: [duckdbDialect()],
});

const session = service.openDocument({
  context: {
    dialect: "duckdb",
    engine: "local",
    catalog: { scope: "connection-incarnation:1" },
  },
  text: "SELECT * FROM ",
});

let completionRefreshToken: SqlCompletionRefreshToken | null = null;
const subscription = session.onDidChange(({ refreshToken }) => {
  if (
    refreshToken !== null &&
    refreshToken === completionRefreshToken
  ) {
    // Ask the editor adapter to request completion again.
  }
});

const completionTask = session.complete({
  position: 14,
  trigger: { kind: "invoked" },
});
completionRefreshToken = completionTask.refreshToken;
const result = await completionTask;

if (result.status === "ready" && session.isCurrent(result.revision)) {
  completionRefreshToken = result.refreshToken;
  for (const item of result.value.items) {
    // Apply item.edit in the original document's UTF-16 coordinates.
  }
}

subscription.dispose();
session.dispose();
service.dispose();
```

The catalog `scope` identifies a live connection incarnation, not a reusable
display name. Search responses distinguish complete, partial, paginated,
loading, and failed evidence. A ready result can therefore be incomplete; its
closed `issues` explain why, while `sources` reports catalog outcomes without
exposing provider errors or internal epochs.

The interactive catalog wait is bounded from the start of `complete()`. When
the budget expires, the session returns local evidence with a
`catalog-loading` issue, a checked remaining intent lease, and an opaque
`refreshToken`. Compatible readiness advances the session revision and emits
`catalog-availability` with that exact token. A higher provider epoch emits
`catalog` with the token only while the same soft or terminal loading intent
remains leased; otherwise its token is `null`.

Consumers compare refresh tokens by identity. A matching token is necessary,
not sufficient, to request completion again: the document, selection, context,
and adapter-owned intent must also remain unchanged. Tokens are in-process,
non-serializable control identities; they expose no provider epoch, query, or
work identity. The completion task exposes its token synchronously before
provider work starts, so consumers can latch a matching catalog event that
races the result. Ready results retain that token only while
`catalog-loading` has an unexpired lease; all other ready results use `null`.
Consumers apply only results whose revision remains current.

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
- Public envelopes, edits, changes, and regions are structural inputs. The
  service copies only their declared own data fields; additional host metadata
  remains opaque and is never invoked. Removed or contradictory discriminants
  are explicitly forbidden rather than treating every object as exact.
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
