# ADR 0001: Shared Language Service and Per-Document Sessions

Status: accepted  
Date: 2026-07-24

## Context

The v0.x public API exposes mutable parser and analyzer implementations.
Parsers receive arbitrary CodeMirror `EditorState`, features can use different
parser and schema configurations, and asynchronous work has no common revision
or cancellation contract.

Marimo demonstrates the resulting pressure:

- It subclasses `NodeSqlParser` to mix local parsing with remote validation.
- The subclass stores focus, timer, and validation state on the parser.
- Replacing a debounce timer can leave the earlier promise unsettled.
- DuckDB `parse()` and `validateSql()` deliberately report different evidence.
- Connection, dialect, schema, and Python-template completion are wired through
  separate paths.
- Many editor instances can share configuration while requiring independent
  mutable state.

The next major may break compatibility. The API should therefore model the
actual lifecycle instead of preserving these implementation classes.

## Decision

vNext has one shareable, framework-independent `SqlLanguageService` and one
disposable `SqlDocumentSession` per open document/editor.

The service owns providers, workers, shared bounded caches, and immutable
dialect/catalog resources. A session owns document and context revisions,
request generations, relevant subscriptions, cancellation, and
current-document caches. The CodeMirror adapter owns editor focus, visibility,
debounce, dispatch, and session disposal.

Shared providers contain no request-local mutable state.

## Stable introductory shape

The target consumer shape is:

```ts
interface MarimoSqlContext extends SqlDocumentContext {
  readonly engine: string;
  readonly sqlMode: "default" | "validate";
}

const duckdb = duckdbDialect();

const service = createSqlLanguageService<MarimoSqlContext>({
  dialects: [duckdb, postgresDialect(), bigQueryDialect()],
  syntax: nodeSqlParserSyntax(),
  catalog: marimoCatalogProvider,
  validators: [
    marimoValidationProvider({
      authority: "authoritative",
      granularity: "document",
      input: "original",
    }),
  ],
});

const session = service.openDocument({
  text: "SELECT * FROM users",
  context: {
    dialect: duckdb.id,
    engine: "__marimo__",
    sqlMode: "validate",
  },
});

const completion = await session.complete({
  position: 19,
  trigger: { kind: "invoked" },
  signal,
});

if (
  completion.status === "ready" &&
  session.isCurrent(completion.revision)
) {
  render(completion.value.items);
}

session.dispose();
service.dispose();
```

`syntax` is an opaque module accepted by the stable service factory. Its parser
and semantic-model SPI is not stable in this ADR. Official adapters can use an
experimental subpath until two materially different backends validate the
normalized artifacts. The first internal boundary is specified by
[ADR 0002](./0002-normalized-syntax-contract.md).

## Document context

The service is generic over a host context that extends the standard document
context:

```ts
interface SqlDocumentContext {
  readonly dialect: SqlDialectId;
  readonly catalog?: {
    readonly scope: string;
    readonly searchPath?: readonly (readonly {
      readonly value: string;
      readonly quoted: boolean;
    }[])[];
  };
}
```

Search paths are ordered component paths rather than dot-joined strings.
Consequently a quoted identifier containing a dot is never confused with two
path components. ADR 0005 keeps the exact public spelling provisional until
the catalog vertical slice and consumer fixtures pass.

The service resolves dialect IDs through its immutable registry and rejects
unknown or duplicate IDs. Duplicate registration is rejected even when the
definitions appear equivalent. The built-in dialect factories return frozen
opaque singletons backed by package-owned `WeakMap` metadata; repeated calls to
one factory return the same handle and internal configuration identity. A
copied, serialized, fabricated, or different-package-instance handle is
rejected.

Dialect handles are in-process service configuration and do not cross cloning,
worker, or provider boundaries. Serializable context contains only the
registered handle's string ID. Another realm or package instance reconstructs
configuration with its own built-in factory. IDs perform registry lookup but
never infer lexical behavior.

Hosts can add fields such as engine or SQL mode. Contexts must be
structured-cloneable plain data. On open/update, the session creates and owns a
structured clone before accepting the change. Clone failure rejects the
complete operation without mutation. The accepted snapshot is recursively
frozen and is the only context observed by providers. Caller mutation therefore
cannot change an in-flight request. Providers never read ambient editor state.

The session updates text, context, and embedded regions atomically:

```ts
session.update({
  kind: "document",
  baseRevision: session.revision,
  document: {
    kind: "changes",
    changes: [{ from: 14, to: 19, insert: "customers" }],
  },
  context: nextContext,
  embeddedRegions: nextEmbeddedRegions,
});
```

A full-text replacement is available for simple consumers. Incremental changes
are ordered, non-overlapping, absolute UTF-16 ranges in the current document.
The service validates the base revision, every edit, and the complete region
set for the resulting text before mutating state. Text, context, and regions
commit atomically.

A context-only update is valid, preserves the current region set, and also
requires `baseRevision`. Accepted updates always create a new revision,
including an `A → B → A` text cycle, so a previous result never becomes current
again. A stale base rejects the complete update without partial mutation.

## Revision and applicability

The public revision is an opaque immutable service-generated token. Callers
cannot construct one or supply their own version number.

Internally, the session snapshot associated with the revision tracks:

- Monotonic sequence
- Document revision
- Context and template revision

Relevant environment/catalog epochs will join that snapshot when those
subsystems are implemented. The revision token itself remains only an opaque
immutable identity; it does not duplicate snapshot metadata.

The public model is deliberately global per session: any accepted text,
context, template, relevant catalog, or provider-configuration invalidation
advances the session revision and makes every earlier public result stale.
Selective invalidation refers only to internal cache reuse; for example, a
catalog change can retain statement parse artifacts. If feature-specific
applicability is later required, it gets a separately named token.

Consumers use only:

```ts
session.isCurrent(result.revision);
```

Every request captures one revision, and every result carries it. A session
change settles prior public requests as cancelled/superseded once provider
invocation has returned control, even if an underlying promise ignores
cancellation. A ready result can become stale after settlement, so currency is
checked again immediately before application.

## Ranges

The stable range is an ergonomic readonly object:

```ts
interface SqlTextRange {
  readonly from: number;
  readonly to: number;
}
```

All public ranges are absolute original-document UTF-16 half-open coordinates.
They satisfy:

```text
0 <= from <= to <= document.length
```

Line and column values are derived presentation data. Internally, absolute
document offsets and statement-relative offsets use distinct branded types.

Statement lookup uses explicit cursor affinity at boundaries and EOF. It must
not reintroduce the v0.x inclusive-end behavior.

The first statement-index implementation is an internal synchronous full-scan
oracle. Exact slot extents partition the analysis text, terminators associate
left, and trivia after a terminator associates with the following slot. Empty
documents and terminal delimiters retain explicit empty slots. Lookup requires
left or right affinity and uses binary search.

The index does not contain statement text, line numbers, inferred kinds, parser
validity, or AST data. It materializes at most 10,000 slots and collapses an
unscanned remainder into an opaque slot on resource limits or unsupported
delimiter/procedural constructs. Opaque slots cannot be passed to later parsing
as exact source. Dialect lexical behavior uses internal configuration identity,
never a caller-controlled dialect ID.

The full scanner remains the correctness oracle. Incremental indexing restarts
conservatively at the old slot at or to the left of the earliest trusted
analysis-coordinate change and converges only at an exact terminated boundary
mapped to an unchanged old suffix. It reuses the unchanged prefix and either
reuses or shifts the suffix. Inconsistent metadata falls back to the full
oracle; absent convergence scans through EOF, and resource or
unsupported-syntax opacity remains fail-closed.

## Request outcomes

Every session feature request settles with the same top-level union:

```ts
type SqlRequestResult<T> =
  | {
      readonly status: "ready";
      readonly revision: SqlRevision;
      readonly value: T;
      readonly sources: readonly SqlProviderReport[];
    }
  | {
      readonly status: "unavailable";
      readonly revision: SqlRevision;
      readonly reason: SqlUnavailableReason;
      readonly retryable: boolean;
    }
  | {
      readonly status: "cancelled";
      readonly revision: SqlRevision;
      readonly reason: "caller" | "superseded" | "disposed";
    }
  | {
      readonly status: "failed";
      readonly revision: SqlRevision;
      readonly failure: SqlServiceFailure;
    };
```

SQL invalidity is a ready analysis result containing diagnostics, not a service
failure. Unsupported syntax can be opaque or partial. Provider rejection,
timeout, malformed output, and cancellation remain distinguishable.

Feature-specific values describe their own completeness. For example,
completion uses `isIncomplete`, while diagnostics carry coverage, authority,
and document/statement scope. One generic completeness flag is not used to
mean unrelated things.

If one provider fails but useful local evidence exists, the top-level result
can remain ready with a failed provider report. Top-level failed means no
usable answer could be produced.

Raw `Error` and parser/provider payloads do not cross the stable boundary.

## Feature methods

Explicit methods are preferred over one generic `request({ kind })` API:

```ts
interface SqlDocumentSession<Context extends SqlDocumentContext> {
  readonly revision: SqlRevision;

  readonly update: (update: SqlDocumentUpdate<Context>) => SqlRevision;

  readonly complete: (
    request: SqlCompletionRequest,
  ) => Promise<SqlRequestResult<SqlCompletionList>>;

  readonly diagnostics: (
    request?: SqlDiagnosticsRequest,
  ) => Promise<SqlRequestResult<SqlDiagnosticSet>>;

  readonly hover: (
    request: SqlPositionRequest,
  ) => Promise<SqlRequestResult<SqlHover | null>>;

  readonly definition: (
    request: SqlPositionRequest,
  ) => Promise<SqlRequestResult<readonly SqlLocation[]>>;

  readonly references: (
    request: SqlPositionRequest,
  ) => Promise<SqlRequestResult<readonly SqlLocation[]>>;

  readonly format: (
    request?: SqlFormatRequest,
  ) => Promise<SqlRequestResult<readonly SqlTextEdit[]>>;

  readonly onDidChange: (
    listener: (event: {
      readonly revision: SqlRevision;
      readonly reason: "catalog" | "provider-configuration";
    }) => void,
  ) => { readonly dispose: () => void };

  readonly isCurrent: (revision: SqlRevision) => boolean;
  readonly dispose: () => void;
}
```

`onDidChange` reports service-originated revision advances that do not come
from the host's own document transaction. State changes before notification;
listener failures are isolated; and both subscription and session disposal are
idempotent. ADR 0005 specifies the first catalog use.

The walking skeleton exposes only implemented features. Adding a method is
backward-compatible; returning placeholder success from an unimplemented method
is not.

## Provider rules

Providers are narrow and async-only. Pure range, change, identifier, and
statement-index primitives remain synchronous.

Provider requests contain:

- Immutable source snapshot with distinctly named `originalText`,
  `analysisText`, and source mapping
- Explicit document context
- Provider configuration identity
- `AbortSignal`

Each validator declares both `granularity: "document" | "statement"` and
`input: "original" | "analysis"`. Regardless of input form, returned public
ranges use original-document coordinates.

They do not contain:

- `EditorState` or `EditorView`
- DOM or CodeMirror completion values
- Mutable session objects
- Caller-controlled revision stamps

The service catches both synchronous throws during provider invocation and
asynchronous rejection. Provider invocation must return control within a
strict bounded synchronous budget. CPU-heavy or untrusted work runs in a worker
or process because an `AbortSignal` cannot interrupt a blocked event loop. Once
a promise exists, the service races public settlement against cancellation. It
validates ranges and result limits before arbitration.

Authority and arbitration are feature-specific:

- Completion merges, deduplicates, and deterministically ranks.
- Diagnostics use coverage and authority; they are not blindly unioned.
- Hover can select or attribute sections.
- Definitions use precedence, confidence, and provenance.
- Formatting normally selects one provider.

Provider completion order cannot affect final ordering.

## Parser-neutral artifacts

The walking skeleton normalizes only evidence needed by its first vertical
slice:

- Statement ranges and state
- Tokens
- Diagnostics
- Normalized relation references
- Cursor-context facts
- Exact completion replacement range

It does not expose `ast?: unknown` or attempt a universal SQL AST.

The later semantic IR will model query blocks, set operations, relation
bindings, column shapes, CTE order, correlation and `LATERAL`, clause-specific
visibility, definitions/references, provenance, and explicit unknown shapes.
That IR is prototyped against at least two parser implementations or materially
different conformance corpora before stabilization.

## Catalog contract

Catalog access is lazy and bounded. Providers search and resolve within an
explicit scope, prefix, object-kind set, and service-clamped result limit.
Responses carry stable entity IDs, provider epoch, pagination, and coverage.

Empty-complete and empty-loading are distinct. A miss supports a definite
unknown-object diagnostic only when the response proves complete coverage for
the searched scope.

Catalog subscriptions are scoped and disposable. An invalidation identifies
provider ID, affected scope, and:

```ts
interface SqlCatalogEpoch {
  readonly generation: number;
  readonly token: string;
}
```

Generation is monotonic within one provider and scope; token identifies the
provider snapshot. Lower out-of-order generations are discarded and equal
generations are duplicates. Only sessions subscribed to the affected scope
advance their public revision, and session disposal removes the subscription.
Internal unchanged parse artifacts remain reusable.

## Template contract

The no-template default is an identity mapping. A source transformer produces a
validated virtual document with copied, masked/opaque, or generated segments.

Marimo braces initially use masking that preserves the exact UTF-16 length and
every CR/LF code unit. Every other masked code unit becomes lexically inert
whitespace, including each half of an astral character, so masking cannot join
adjacent SQL tokens. More complex transformers use a versioned map whose
segments are ordered, non-overlapping, and validated for original/generated
coverage.

The initial internal source primitive implements identity snapshots and this
length-preserving masking only. It does not expose a transformer or source-map
SPI. Sessions create a new source snapshot from the complete post-update region
set for document updates and reuse the existing snapshot for context-only
updates. Non-identity generated/reordered source remains deferred until a
concrete consumer validates the segment model.

Current session edits use identity sources, so validated original-document
changes are also trusted analysis-coordinate changes. A future transformed
source must provide its own validated analysis-coordinate changes for
incremental statement indexing. Without them, changed analysis text
invalidates the index and is rebuilt lazily.

Edits crossing an ambiguous or unmapped boundary are rejected. Mapping failure
is unavailable analysis, not invalid SQL.

## CodeMirror adapter

The adapter creates one session per view and disposes it in
`ViewPlugin.destroy()`. It translates `ChangeSet` values into one atomic session
update and checks the result revision immediately before dispatch.

It owns:

- Focus and visibility scheduling
- Debounce timers
- Current request handles
- CodeMirror facets and effects
- Safe DOM rendering
- Composition with external completion sources

Context updates are explicit:

```ts
const support = sqlEditor({
  service,
  initialContext,
  features: {
    completion: true,
    diagnostics: true,
    hover: true,
    navigation: true,
    gutter: true,
  },
  completion: {
    externalSources: [pythonExpressionCompletion],
  },
});

const view = new EditorView({
  doc,
  extensions: [support.extension],
});

// Context-only convenience:
support.setContext(view, nextContext);

// Or update text and context atomically:
view.dispatch({
  changes,
  effects: support.contextEffect.of(nextContext),
});
```

The adapter installs one coherent `autocompletion` configuration. Package and
external sources have deterministic ordering, deduplication, and tie-breaking.
The support object contains no cross-view mutable session; `setContext` is a
context-only convenience that dispatches `contextEffect` to the target view.
Consumers use that public typed effect when text and context must change
together. The adapter converts a document change and context effect in one
CodeMirror transaction into one atomic session update, and highlighting and
service interpretation change to the same registered dialect ID.

A callback form may be added only with an explicit stable equality/key
contract. Cursor motion must not accidentally invalidate context.

Stable documentation data is plain text or Markdown. Default renderers never
use provider or catalog values as `innerHTML`. A custom trusted renderer returns
a DOM `Node` at the CodeMirror boundary.

## Cache and cancellation model

Revision identity and content reuse are separate.

Recommended cache layers:

```text
document
  → source transform
  → statement index
  → statement parse
  → semantic artifact
  → catalog resolution
  → feature request
```

Parser artifacts use statement-relative coordinates so an unchanged moved
statement can be reused and remapped. Keys include content fingerprint,
dialect, parser/configuration, and template identities. Catalog changes do not
invalidate parsing. Renderer, theme, focus, and cursor changes do not invalidate
semantic artifacts.

The current statement-index cache is private, lazy, and per session. It stores
only the current index, document sequence, and lexical-profile identity.
Context-only updates reuse it for the same profile; equal analysis text reuses
it across a new document revision; trusted identity-source changes update it
incrementally. A changed replacement, profile change, or transformed source
without trusted analysis changes clears it for a later full build. Invalid
updates do not mutate it, disposal clears it, and it retains no source text or
revision history.

In-flight deduplication uses the same complete key. Cancelling one consumer
detaches it; shared underlying work is aborted only when no consumers remain.
Caches are bounded by both item count and estimated retained bytes.

`AbortSignal` cannot interrupt any synchronous provider blocking the event
loop. CPU-heavy or untrusted providers must run in a worker or process.

## Lifecycle invariants

- `dispose()` is idempotent.
- Session disposal prevents publication immediately.
- Pending requests settle exactly once as cancelled/disposed.
- Late provider results are drained and discarded.
- Catalog subscriptions, timers, and workers are released.
- Service disposal disposes all child sessions before owned providers/workers.
- One session's edit, context, focus, cancellation, or disposal cannot affect
  another session sharing the service.

## Walking skeleton

The first implementation slice contains:

1. Opaque revisions and runtime-validated ranges/changes.
2. Session open, atomic update, current-revision, and disposal.
3. Dialect-aware statement indexing with explicit cursor affinity.
4. One internal parser adapter producing narrow normalized syntax evidence.
5. One bounded relation-search catalog contract.
6. `FROM`/`JOIN` relation completion with an exact edit range and provenance.
7. A thin CodeMirror transaction/completion adapter.

Deferred from this slice:

- Full semantic scope graph
- Multi-provider arbitration
- Remote validation
- Workers
- Non-identity template transforms
- Formatting
- Streaming
- Broad catalog materialization

## Required contract tests

- Revisions are monotonic through `A → B → A`.
- Revisions from other sessions are never current.
- Update ranges reject negative, fractional, reversed, overlapping, stale-base,
  and out-of-bounds changes without partial mutation.
- UTF-16 behavior is correct around astral characters, combining characters,
  unpaired surrogates, CRLF, EOF, and empty ranges.
- Text and context can update atomically.
- Non-cloneable context rejects without changing text, context, or revision.
- Caller mutation after open/update cannot change the owned context snapshot.
- Context-only dialect/connection changes supersede dependent results.
- Catalog invalidation does not reparse unchanged SQL.
- Caller abort, supersession, and disposal settle promptly when a provider
  ignores its signal.
- Late resolve/reject causes no dispatch or unhandled rejection.
- Provider throw and rejection normalize identically.
- Invalid SQL, unsupported syntax, unavailable analysis, failure, and
  cancellation remain distinct.
- Invalid provider ranges are rejected without corrupting valid contributions.
- Partial catalog misses never produce definite unknown-object diagnostics.
- Duplicate/lower catalog generations are ignored per provider and scope.
- Duplicate dialect IDs are rejected at service construction.
- Identical SQL in different sessions/contexts cannot contaminate caches.
- Shared work deduplicates without cross-consumer cancellation.
- Moving the cursor does not reparse.
- Fifty editors dispose without retained session state.
- Packed consumer declarations compile with `skipLibCheck: false`.
- The marimo fixture leaves no unresolved debounce promise.

## Alternatives rejected

### Stateless `analyze(text, context)`

Simple, but it loses session lifecycle, bounded incremental caches, shared-work
coordination, subscriptions, and a natural stale-result boundary.

### One generic request method

Small in line count but weakly discoverable, poorly narrowed, and easy to
misuse. Explicit feature methods provide clearer types.

### One mega-provider

Optional methods obscure capability and authority, encourage shared mutable
state, and couple unrelated features. Providers remain narrow.

### Public universal AST

It would either leak the first parser's shapes or become an unstable lowest
common denominator. Only narrow normalized evidence is exposed initially.

### Provider-owned revisions

A stale provider could stamp a result as current. Only the service owns result
revisions.

### Parser receives `EditorState`

This makes dependencies implicit and couples the core to CodeMirror. The
adapter extracts explicit context instead.

## Consequences

The architecture requires more deliberate lifecycle and result types than
v0.x. In exchange, it makes stale publication, incomplete catalog evidence,
provider failure, and cross-editor state leakage testable invariants.

Marimo can delete `CustomSqlParser`: remote validation becomes a
document-diagnostics provider, focus becomes scheduling policy, engine/dialect
changes become context updates, braces become a source transformer, and Python
completion remains an external CodeMirror completion source.

Legacy `SqlParser`, `NodeSqlParser`, `SqlStructureAnalyzer`, and
`QueryContextAnalyzer` are not part of the next-major stable API.
