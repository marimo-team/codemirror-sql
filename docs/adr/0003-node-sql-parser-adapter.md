# ADR 0003: Internal node-sql-parser Adapter

Status: accepted
Date: 2026-07-25

## Context

ADR 0002 defines an internal normalized syntax contract, but it deliberately
does not decide how a concrete parser earns authority. The first adapter uses
`node-sql-parser` because the dependency is already present and can provide a
useful local AST in Node or an isolated worker. It must not turn the
dependency's incomplete grammar,
partial locations, synchronous execution, or packaging behavior into broader
vNext guarantees.

The installed `node-sql-parser` 5.4.0 package provides separate CommonJS
bundles for PostgreSQL and BigQuery. The complete bundle is approximately
2.5 MB uncompressed and 428 KiB compressed, while the PostgreSQL and BigQuery
builds are approximately 59 KiB and 42 KiB compressed respectively. Loading
the complete bundle would make consumers pay for unrelated grammars.

The target-named grammars are not authoritative validators for their database
engines. In local probes, the PostgreSQL build rejected valid `MERGE`,
`FETCH FIRST`, `INSERT ... DEFAULT VALUES`, identity-column, and
`FOR UPDATE SKIP LOCKED` statements. The BigQuery build rejected valid
`QUALIFY`, `MERGE`, and `DECLARE` statements. A parse rejection therefore
cannot establish that target-dialect SQL is invalid.

The parser also runs synchronously. An `AbortSignal` can prevent work before
the parse begins and suppress publication after it finishes, but it cannot
interrupt `astify` while JavaScript is blocked.

## Decision

The adapter remains internal and is not exported from `/vnext`. This change
does not connect it to document sessions, caches, diagnostics, completion, or
any other feature. Session wiring requires a separate decision about worker
isolation and cancellation.

### Dependency and loading

Pin `node-sql-parser` exactly to version `5.4.0`. The adapter depends on deep
paths, CommonJS interop, AST shapes, and grammar behavior that are not stable
enough for an unconstrained dependency range.

Load only these extension-qualified paths:

```text
node-sql-parser/build/postgresql.js
node-sql-parser/build/bigquery.js
```

After dynamically acquiring `createRequire` from `node:module`, the adapter
revalidates the realm and synchronously requires the selected build. Module
evaluation and global restoration therefore run in one JavaScript stack with
no alias-mutation gap. The adapter does not load the all-dialect entry point
and does not pass a `database` option to a dialect-specific build.

Node ESM exposes these CommonJS builds through `default`/`module.exports` even
though the declarations suggest a named `Parser` export. The module boundary
is decoded from `unknown` and accepts only a runtime-validated constructor and
`astify` method. No unchecked assertion compensates for the declaration/runtime
mismatch.

The parser receives fixed options:

```ts
{
  trimQuery: false,
  parseOptions: {
    includeLocations: true,
  },
}
```

Disabling trimming is required to keep every backend offset relative to the
exact untrimmed statement slice. Location inclusion is requested for future
private semantic decoding, but location availability remains per node and is
not promoted to a dialect-wide capability.

The distributed UMD-style builds can assign `NodeSQLParser` and, in some
environments, `global` on the global object while loading. The adapter refuses
to load them whenever `window` or `self` exists, or `global` does not resolve
exactly to `globalThis`. Only pure Node is currently eligible. This prevents
global collisions, including DOM shims in Node, and accidental synchronous
main-thread parsing. The Node loader captures the existing own-property
descriptors for the affected names and restores them synchronously after module
evaluation. A module that cannot be loaded and cleaned up safely permanently
poisons loading and returns a non-retryable backend failure.

### Evidence policy

PostgreSQL and BigQuery acceptance is positive-only compatibility evidence. A
successful target-specific parse produces `parsed/compatibility` with the
`partial-artifact` limitation. It means only that the target-named backend
produced a bounded normalized artifact. The adapter does not create a
conformance identity because the grammar also accepts constructs that the
target engines reject.

Every PostgreSQL or BigQuery parse rejection produces:

```text
unsupported / uncovered-construct
```

It never produces `invalid`, even for input that appears obviously malformed.
The same parser error is indistinguishable from rejection of valid syntax that
the dependency does not implement. This adapter therefore creates no
authoritative syntax diagnostics.

DuckDB uses the PostgreSQL build only as a compatibility parser:

- Acceptance produces `parsed/compatibility` with the
  `dialect-compatibility` and `partial-artifact` limitations.
- Rejection produces `unsupported/compatibility-rejected`.
- The adapter performs no rewrites, success-without-AST shortcuts, bracket
  quoting, comment stripping, or offset repair.

Dremio has no node-sql-parser adapter. When a coordinator is added later, it
will classify Dremio as `unavailable/dialect-not-supported` rather than silently
selecting another grammar.

Unexpected backend exceptions are failures, not syntax evidence. Invalid
module shapes or malformed AST roots are `failed/malformed-output`; other
unexpected parser exceptions are `failed/backend-failure`. Raw exceptions and
backend messages do not cross the normalized boundary.

### Input and artifacts

The adapter imposes a 16 KiB statement limit, below the syntax contract's
general 1 MiB ceiling. A larger statement returns
`unsupported/resource-limit` before importing or invoking the backend.
This conservative limit bounds work and temporary parser memory, but it does
not satisfy the provisional active-statement latency envelope: warm local
16 KiB parses already exceed that target. Placement measurements must set a
lower interactive limit or move parsing off the main thread.

The backend receives only the exact, untrimmed, code-bearing statement source.
It receives no terminator, document coordinates, editor state, catalog, cursor,
or host context.

A successful result must contain exactly one object root with a string `type`.
A direct object or one-element array is accepted. Zero or multiple roots are
`unsupported/uncovered-construct`; malformed roots are
`failed/malformed-output`.

The public normalized artifact exposes only its closed statement kind and full
statement-relative range. The backend AST is retained in a module-private
`WeakMap` keyed by the authenticated artifact. It is neither enumerable nor
returned through the syntax contract. Future relation extraction must decode
and validate backend nodes inside the adapter boundary rather than exposing
the raw AST to core features.

### Cancellation and execution placement

The callback checks cancellation before loading, after loading, and after
parsing. These checks preserve the syntax runner's request-lifecycle behavior,
but they cannot preempt synchronous parser execution.

The adapter must not be wired into interactive session requests until a
follow-up decision records one of:

- Worker/process isolation with enforceable wall-clock and memory limits, or
- Measured main-thread execution with an accepted adversarial-input risk and
  explicit scheduling policy.

That decision must include browser measurements, cancellation behavior,
worker/module failure recovery, and the effect of many mounted editors.

The current production loader supports pure Node only. A future browser
integration must invoke parsing from a dedicated worker whose global object is
not shared with application code, the legacy parser, or another installed copy.
The unsupported-realm rejection remains until that isolated execution path
exists.

## Consequences

- Local parsing can be evaluated without exposing a backend AST or
  committing the language service to one parser.
- PostgreSQL and BigQuery false negatives degrade to unsupported instead of
  false invalid diagnostics.
- PostgreSQL and BigQuery acceptance remains useful without claiming target
  conformance.
- DuckDB compatibility remains useful without pretending to be native
  conformance.
- Consumers do not load every node-sql-parser grammar.
- The 16 KiB limit and lack of session wiring intentionally restrict initial
  capability.
- Authoritative invalidity requires a separately justified validator and an
  owned dialect conformance corpus.

## Non-goals

This decision does not define:

- Stable parser or provider APIs
- Session cache keys or eviction
- Document-level syntax diagnostics
- Semantic relation, scope, column, or type models
- A worker protocol
- Native DuckDB or remote validation providers
- Dremio parsing
