# vNext node-sql-parser Adapter

Status: internal and not wired to sessions

The first concrete syntax adapter exercises the normalized contract from
[ADR 0002](../adr/0002-normalized-syntax-contract.md) under the evidence and
execution policy in
[ADR 0003](../adr/0003-node-sql-parser-adapter.md). It is not exported from
`/vnext` and does not currently power completion, diagnostics, hover,
navigation, or any other editor feature.

## Capability matrix

| Dialect | Backend | Acceptance | Rejection |
| --- | --- | --- | --- |
| PostgreSQL | PostgreSQL-specific build | `parsed/compatibility` with `partial-artifact` | `unsupported/uncovered-construct` |
| BigQuery | BigQuery-specific build | `parsed/compatibility` with `partial-artifact` | `unsupported/uncovered-construct` |
| DuckDB | PostgreSQL-specific build | `parsed/compatibility` with `dialect-compatibility`, `partial-artifact` | `unsupported/compatibility-rejected` |
| Dremio | None | Unavailable when coordinator wiring exists | `unavailable/dialect-not-supported` |

This adapter never returns `direct` or `invalid`. The PostgreSQL and BigQuery
grammars both reject valid target-dialect constructs and accept constructs the
target engines reject. Acceptance therefore records only a partial
compatibility artifact; rejection is not an authoritative syntax diagnostic.

## Loading and packaging

The implementation is tied to an exact `node-sql-parser` 5.4.0 pin and loads
only:

```text
node-sql-parser/build/postgresql.js
node-sql-parser/build/bigquery.js
```

The complete all-dialect entry point is not used. In pure Node, the adapter
dynamically acquires `createRequire`, revalidates the realm, then synchronously
requires the selected build so evaluation and cleanup cannot be interleaved
with another task. Runtime module decoding handles the package's CommonJS shape
rather than trusting its inaccurate named-export declarations.

The adapter invokes `astify` with location collection enabled and query
trimming disabled. Disabling trimming preserves offsets relative to the exact
statement slice. Locations remain partial: PostgreSQL commonly omits root and
identifier locations, while BigQuery provides broader but still incomplete
coverage.

Module-shape decoding, parser invocation, result validation, and error
normalization live in a realm-neutral internal backend engine. That engine has
no Node, browser-window, or worker dependency. The Node adapter remains
responsible for realm validation, module loading, cleanup, parser authority,
and private AST ownership. A browser worker can therefore reuse the same
backend semantics without importing Node globals or weakening main-realm
artifact authenticity.

Loading the distributed bundles may write `NodeSQLParser` or `global` on a
global object. The adapter rejects parser loads whenever `window` or `self`
exists, or `global` does not resolve exactly to `globalThis`, before loading a
bundle. This blocks browser windows and Node DOM shims from exposing an
unguarded secondary target. Pure Node loads restore the exact prior descriptors
synchronously after module evaluation, including removing names that were
previously absent. Cleanup failure permanently poisons loading. The dedicated
worker applies the same exact restoration rule around the complete backend
operation, including module evaluation, module decoding, parser construction,
parsing, and output normalization.

### Private browser worker endpoint

The package contains a production-shaped but private module-worker endpoint.
It is not exported from the package and is not reachable through `/vnext`.
There is no public worker constructor, executor, queue, language-service
module, or session integration.

The endpoint:

- uses only the extension-qualified PostgreSQL and BigQuery builds above;
- loads each grammar lazily after a valid request;
- reuses the realm-neutral backend engine for module, AST, and parser-error
  normalization;
- accepts and emits only a closed, versioned plain-data protocol;
- returns normalized statement kind, bounded unsupported or failure evidence,
  and never returns source text, raw errors, or backend ASTs;
- derives retryability from the closed failure code instead of trusting a
  separate wire flag;
- restores the exact prior `NodeSQLParser` and `global` descriptors around
  each complete backend operation; and
- permanently poisons and closes its worker realm if cleanup cannot be proven
  exact.

The endpoint accepts only one request at a time. Overlap and malformed messages
fail closed instead of creating an implicit worker-side queue. A private
main-realm executor now provides bounded FIFO admission, serialization,
correlation, startup/queue/execution deadlines, prompt consumer cancellation,
generation replacement, and disposal. It creates the production module worker
lazily and keeps cancelled posted work in a draining lane until the worker
responds or its safety deadline retires that generation. Posted work is never
replayed. Every worker-reported failure retires the generation because a
`backend` failure may be indistinguishable from endpoint cleanup poisoning;
never-posted queued work retains its original deadline on the replacement.

The executor remains implementation infrastructure only. It is not exported
from the root package or `/vnext`, is not owned by `SqlLanguageService`, and
does not yet create authenticated syntax analyses or relation facts for a
session.

Direct Chromium tests construct this source module worker and exercise both
real grammar builds, including the private executor's production worker path.
The separate worker-placement fixture remains diagnostic packaging evidence:
it records resource timing, emitted chunk reachability, and bundle sizes with
a fixture-owned protocol. It is not the public integration boundary and must
not be read as evidence that a session API already exists.

Approximate local Node 24 arm64 measurements for the installed package were:

| Build | Raw size | gzip size | Cold import |
| --- | ---: | ---: | ---: |
| PostgreSQL-specific | 308,145 B | 58,648 B | 19 ms |
| BigQuery-specific | 208,264 B | 41,828 B | 14 ms |
| All dialects | 2,505,457 B | 428,097 B | Not selected |

These figures are investigation evidence, not cross-machine performance
guarantees. Reproducible browser and bundle baselines are required before
session integration.

## Input and output rules

The adapter accepts at most 16 KiB of statement text. Larger statements return
`unsupported/resource-limit` before a backend import or parse.

The input is the exact code-bearing normal statement source:

- Leading and trailing trivia are retained.
- A statement terminator is excluded.
- The source is not trimmed or rewritten.
- The backend receives no editor state, document offset, cursor, catalog, or
  host context.

A usable backend result has exactly one object root with a string `type`. The
adapter accepts either that object directly or a one-element array containing
it. Empty or multi-root output is uncovered; structurally malformed output is a
backend contract failure.

Normalized statement kinds are intentionally small:

| Backend type | Normalized kind |
| --- | --- |
| `select`, `union` | `query` |
| `insert`, `replace` | `insert` |
| `update`, `delete`, `create`, `alter`, `drop`, `merge`, `transaction` | Same closed kind |
| Any other string | `other` |

Only the normalized kind and full statement-relative range appear in the
syntax artifact. The raw AST stays in private weakly keyed storage for a future
adapter-owned semantic decoder. Flat `tableList` and `columnList` output is not
used as the semantic model.

## Failure and cancellation behavior

Expected PostgreSQL and BigQuery PEG rejections are uncovered capability, not
failures. DuckDB rejection is compatibility rejection. Unexpected native
exceptions, module-load failures, and malformed module or AST values remain
explicit backend failures; raw exceptions are not retained in results.

Cancellation is checked before and after asynchronous loading and after the
parse. The parse itself is synchronous and cannot be interrupted by an
`AbortSignal` while it blocks JavaScript. A late result can be discarded, but
the CPU work has already occurred. Unsupported execution realms fail closed
without importing a backend.

For that reason, this adapter remains unwired. A worker-versus-main-thread ADR,
with browser latency, memory, hostile-input, timeout, and recovery evidence, is
required before interactive sessions may call it.

[ADR 0004](../adr/0004-isolated-parser-execution.md) chooses isolated
browser-worker execution and records the packaging, performance, memory, and
semantic-reuse gates that still block session wiring.
