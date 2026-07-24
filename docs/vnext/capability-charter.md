# vNext Capability Charter

Status: accepted  
Date: 2026-07-24

## Product boundary

vNext is a framework-independent SQL language service with a first-class
CodeMirror 6 adapter. It provides local editor intelligence and composes
optional catalog, database-native, formatter, and remote validation providers.
It does not execute queries.

The service must remain useful in a browser with no backend. Native and remote
providers augment that local baseline; they do not silently replace unrelated
local evidence.

## Initial dialect tiers

Dialect support is capability-scoped. A dialect is not described as
"supported" without naming the feature.

### Conformance targets

The first release candidate targets:

- DuckDB
- PostgreSQL
- BigQuery

Each target needs checked-in valid, invalid, incomplete, templated, and
multi-statement corpora. Syntax status, statement boundaries, identifier rules,
relation and column resolution, and feature availability are tested
independently.

DuckDB is the reference native-provider integration. BigQuery is the reference
for multi-part identifiers and non-PostgreSQL quoting. PostgreSQL is the
reference baseline for broadly implemented relational syntax.

### Compatibility dialects

Dremio, SQLite, MySQL, and other existing parser dialects may ship with a
smaller declared capability set. Highlighting or parser acceptance alone does
not imply semantic diagnostics, navigation, formatting, or complete
autocomplete.

A compatibility dialect graduates to a conformance target only after it has an
owned corpus and explicit feature matrix. Hosts can register experimental
dialects without making them part of the stable compatibility promise.

## Initial SQL constructs

The first release candidate targets:

- Multiple statements with dialect-aware boundaries
- `SELECT`, `FROM`, joins, filters, grouping, ordering, and limits
- CTEs, including declaration-order visibility
- Derived tables and nested query blocks
- Set operations
- Qualified and unqualified relation and column references
- Aliases with clause-specific visibility
- Common parameters and quoted identifiers
- Comments, strings, incomplete input, and error recovery
- Template regions that can be masked or mapped without corrupting offsets

DDL, procedural SQL, macros, table functions, vendor extensions, recursive
CTEs, `LATERAL`, `PIVOT`, and nested/structured types must report their actual
analysis quality. They are not assumed semantically complete merely because a
parser accepts them.

## Feature target

The stable session API is intended to support:

- Keyword, relation, column, function, and snippet completion
- Syntax, semantic, and host-provided diagnostics
- Hover documentation
- Definition, references, highlight, and rename
- Statement and structure indicators
- Explicit formatting through a selected formatter provider

The walking skeleton implements parser-independent relation completion first,
so incomplete `FROM` and `JOIN` input does not wait for parser acceptance.
Subsequent features reuse the same session, revision, range, cancellation,
provenance, and result contracts. No feature gets a separate parser or schema
configuration.

## Correctness contract

Every public source range is:

- Absolute in the original document
- Measured in UTF-16 code units
- Half-open: `[from, to)`
- Validated before it can reach a consumer

Every asynchronous result carries a service-generated opaque revision. Text,
dialect, connection, template, relevant catalog, or provider-configuration
changes advance the affected session revision. The service does not settle a
request as ready if it is already superseded at settlement. Consumers, and
always the CodeMirror adapter, check currency again immediately before applying
a ready result.

The service distinguishes:

- Invalid SQL
- Recovered or partial analysis
- Unsupported capability
- Loading or incomplete catalog evidence
- Provider failure
- Caller cancellation
- Supersession
- Disposal

An absent or partial catalog cannot justify a definite unknown-object
diagnostic.

## Provider boundary

Providers are separated by feature concern. They receive immutable plain-data
requests and an `AbortSignal`; they never receive `EditorState`, `EditorView`,
DOM values, mutable sessions, or caller-controlled revisions.

Providers declare whether they consume original or transformed analysis text.
All public ranges are mapped to the original document.

Provider invocation must return control within a bounded synchronous budget.
After a promise is obtained, the service races publication against cancellation
even when the underlying promise ignores its signal. CPU-heavy or untrusted
work runs in a worker or process.

The stable external extension points are expected to include:

- Catalog search and resolution
- Completion augmentation
- Document and statement diagnostics
- Formatter selection
- Hover and navigation augmentation

Parser, statement-boundary, worker, and semantic-IR interfaces remain
experimental until conformance tests cover at least two materially different
implementations. Parser-specific AST types are never part of the stable root
API.

Document-granularity and statement-granularity validators are distinct
contracts. A scheduler must not silently invoke a whole-document engine
validator once per statement.

## Catalog boundary

The canonical catalog API is asynchronous, bounded, versioned, and explicit
about coverage. It does not require a host to materialize one complete nested
`SQLNamespace`.

Catalog requests must support scoped search and resolution with result limits.
Responses distinguish loading, partial, complete, failed, and paginated
coverage. Stable entity identity and provider epochs prevent evidence from
different catalog states being combined as authoritative.

Catalog invalidation identifies provider, affected scope, and an epoch
containing a provider/scope-monotonic generation plus opaque snapshot token.
Lower generations are discarded and equal generations are duplicates. Only
subscribed sessions advance their public revision. Internal unchanged statement
parse artifacts remain reusable.

## Template boundary

The original document remains the canonical coordinate space. A template
transformer produces either:

- A length-preserving masked analysis document, or
- A validated, versioned source map

Completion edits crossing ambiguous mappings are rejected. Diagnostics wholly
inside generated text are dropped or explicitly anchored. Mapping failure is
an unavailable analysis capability, not evidence that the SQL is invalid.

Length-preserving masks retain every UTF-16 code unit count and every CR/LF code
unit. Each other masked code unit becomes lexically inert whitespace so adjacent
tokens cannot be joined accidentally.

Mapped segments are ordered, non-overlapping, and validated for original and
generated coverage. Marimo `{...}` expressions are the first template
conformance target.

## Runtime and packaging support

The release target is:

- ESM packages
- Node.js 20.19 and newer for package import and non-DOM core use
- CodeMirror 6 peer dependencies
- Current evergreen Chromium, Firefox, and WebKit families
- Browser bundlers that honor package `exports`
- SSR-safe import of core modules

Exact minimum peer versions, browser versions, and supported bundler releases
are recorded in the release capability matrix and exercised through packed
consumer fixtures. A declared runtime is not supported unless its fixture runs
in CI.

The exact subpath layout is deferred to a packaging ADR after the walking
skeleton produces bundle and packed-consumer evidence. Packaging must provide:

- An SSR-safe, framework-independent core entry
- An explicit CodeMirror entry
- Explicit dialect entry points
- Independently importable optional parser/provider integrations
- No accidental transitive import of optional parsers or providers into core

## Provisional performance envelopes

These are product envelopes, not claims about the current implementation.
Benchmark baselines and raw samples must replace provisional values before the
release candidate.

For a warm local service, a 10 KiB document, and a 10,000-relation indexed
catalog:

- Keystroke bookkeeping: p95 under 8 ms
- Active-statement local analysis: p95 under 16 ms
- Local completion response: p95 under 50 ms
- Local diagnostics response: p95 under 150 ms
- No routine main-thread task over 50 ms

For a 1 MiB document, the service may degrade to active-statement intelligence,
but editing must remain responsive and the degraded state must be explicit.

Fifty mounted editors must have bounded retained memory after disposal and must
share immutable dialect/catalog data. Cache budgets are enforced by both entry
count and estimated retained bytes.

Provisional compressed bundle budgets:

- Core plus CodeMirror adapter, excluding parser and dialect data: 75 KiB
- Each ordinary dialect module: 25 KiB
- Optional `node-sql-parser` chunk: no regression from its recorded baseline
  without an approved ADR

## Security and robustness

- Default renderers do not insert provider or catalog strings with
  `innerHTML`.
- Stable documentation values are plain text or Markdown data.
- Provider ranges, edits, continuation tokens, and result sizes are validated.
- Catalog and completion result counts are clamped.
- Provider throws and rejections are normalized; raw errors do not cross the
  stable boundary.
- After provider invocation returns a promise, cancellation settles publication
  promptly even when that promise ignores its signal.
- Late provider resolution is drained without dispatch or unhandled rejection.
- `dispose()` is idempotent and settles all pending requests.

## Explicit non-goals

vNext is not:

- A SQL execution engine
- A query optimizer
- A complete database type checker
- A guarantee that one browser parser accepts every vendor extension
- An LSP transport implementation
- A mandatory full-catalog loader
- A generic universal SQL AST
- A compatibility wrapper around mutable v0.x parser/analyzer classes

Legacy behavior can be retained in migration helpers, but it does not constrain
the next-major architecture.

## Release evidence

Before vNext is stable:

- Every conformance target has an explicit feature matrix and corpus.
- Repository coverage meets the thresholds in `implementation.md`.
- Critical revision, range, mapping, cancellation, and arbitration logic has
  mutation evidence.
- Browser, package, SSR, marimo, fuzz, leak, and benchmark gates pass.
- Bundle and latency budgets compare against both `main` and the previous
  `dev-refactor` checkpoint.
- The marimo fixture proves remote DuckDB validation, connection changes,
  partial catalogs, Python-expression completion, rapid edits, and disposal.
- Unsupported and partial states are documented and visible to consumers.
