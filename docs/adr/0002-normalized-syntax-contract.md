# ADR 0002: Internal Normalized Syntax Contract

Status: accepted
Date: 2026-07-24

## Context

The legacy parser API accepts a complete CodeMirror `EditorState`, mutates
offset bookkeeping, exposes backend-specific AST shapes, and can report success
without a usable tree. Dialect support and location quality are also easy to
overstate: a compatibility grammar rejecting input is not evidence that the
target dialect is invalid.

The vNext statement index already separates exact, incomplete, and opaque
lexical boundaries. The next layer needs a narrow parser boundary that can
support multiple backends without making the first backend's AST public or
mixing lexical eligibility, parser evidence, and request cancellation into one
ambiguous result.

This contract is internal. It must be exercised by a real adapter and semantic
consumer before any part is considered for the stable `/vnext` API.

## Decision

Syntax processing has three separate state machines:

1. Lexical eligibility decides whether a statement is empty, incomplete,
   opaque, unavailable, or eligible for an analyzed result.
2. Parser analysis reports parsed, invalid, unsupported, or failed evidence.
3. The session request lifecycle owns caller cancellation, supersession,
   disposal, revision applicability, and timeouts.

Parser outcomes never contain `empty`, `incomplete`, `opaque`, `cancelled`, or
`superseded`. Keeping those layers separate prevents a parser failure from
being mistaken for invalid SQL and prevents an incomplete lexical construct
from being sent to a backend.

The parser runner transports cancellation without classifying it: a
pre-aborted request does not invoke the backend, and an in-flight abort rejects
with the signal's exact reason if it wins the race with backend completion.
Late backend rejection remains handled. The session decides whether that
rejection represents cancellation, supersession, disposal, or another request
lifecycle event.

### Eligibility

| State | Meaning | Parser invoked |
| --- | --- | --- |
| `empty` | Exact slot has no code | No |
| `incomplete` | Exact slot ends inside a known lexical construct | No |
| `opaque` | Statement boundaries are not trustworthy | No |
| `unavailable` | No parser is configured for the resolved dialect | No |
| `analyzed` | The parser returned authenticated normalized evidence | Yes |

Incomplete and opaque states preserve the scanner's closed construct/reason
unions and a statement-relative location. They do not accept arbitrary strings.

### Parser analysis

`parsed` has two mutually exclusive modes:

- `direct` carries a conformance identity. The backend is configured for the
  target grammar and may make authoritative syntax claims within that grammar.
- `compatibility` carries one or more explicit limitations. It may provide a
  useful artifact, but it does not claim target-dialect conformance.

`invalid` requires a direct conformance identity and at least one normalized
syntax diagnostic. Compatibility rejection is therefore `unsupported` with
reason `compatibility-rejected`, never `invalid`.

`unsupported` is an expected capability boundary: backend capability,
compatibility rejection, uncovered construct, or resource limit. `failed`
means the backend failed or violated its output contract; it carries a bounded
safe message and explicit retryability.

Parser-reported locations are either an exact statement-relative range or
explicitly `unavailable/not-reported`. An adapter that claims a malformed
location returns `failed/malformed-output`; it must not erase the defect by
turning the location into `unavailable`.

### Coordinates and input

The parser receives only:

- The exact code-bearing normal slot's `source` slice
- An `AbortSignal`

The slice excludes the statement terminator and is not trimmed. It contains no
editor state, document offsets, cursor, catalog, focus, or host context.
Parser requests are package-created and frozen. Input is bounded to 1 MiB; a
larger statement is an explicit coordinator resource limit and is not passed to
the backend. Abort signals are checked by their cross-realm-compatible
`AbortSignal` surface instead of `instanceof`; adapters may safely use every
member declared by that interface.

All artifact and diagnostic ranges are branded half-open UTF-16 offsets
relative to that exact slice:

```text
0 <= from <= to <= statementText.length
```

Absolute document ranges and statement-relative ranges are not assignable.
This lets an unchanged statement artifact move with an edited prefix without
rewriting its coordinates.

### Artifacts and identity

The normalized artifact initially exposes only a closed statement kind and its
full statement-relative range. It exposes no generic AST, facts bag, backend
node, source text, or mutable payload.

Package-private metadata binds every artifact, diagnostic, and analysis to its
exact immutable statement text. This text is not exposed or copied into the
artifact, but exact equality provides collision-free reuse for identical
statements and prevents same-length text from sharing evidence.

Artifacts, diagnostics, analyses, states, ranges, and identities are created by
package constructors, frozen, and authenticated through package-owned weak
identity sets. Structural copies and fabricated objects are rejected at
runtime. Future official adapters may key private `WeakMap` payloads by the
artifact so relation extraction can reuse a parse without exposing backend
data.

Cache authority requires three distinct package-owned identities:

- Backend/module identity
- Parser-configuration identity
- Dialect-syntax identity

One frozen package-owned parser-authority handle captures that exact tuple.
Parsers, artifacts, diagnostics, analyses, and future private backend payloads
all retain the handle in private metadata. The runner rejects every outcome
whose handle differs from its parser, including compatibility, unsupported, and
failed outcomes. A conformance identity is scoped to the same handle, so direct
or invalid evidence cannot pair one backend's artifact with another backend's
authority.

Direct validity also carries a conformance identity. String dialect IDs never
substitute for these authorities. A conformance identity is created for and
retains the exact backend, parser-configuration, and dialect-syntax identity
tuple; a parser cannot use another tuple's conformance to make an authoritative
claim.

Parsers are also package-created frozen descriptors. Their callback stays in
private metadata and can be invoked only through the contract runner. The
runner:

- Accepts only authentic parser and request objects
- Normalizes synchronous throws and rejected promises without retaining raw
  errors
- Rejects fabricated results
- Verifies that every authentic artifact or diagnostic was constructed for the
  exact request text
- Verifies direct/invalid conformance against the parser's exact authority
  tuple

The runner returns the authenticated `analyzed` lexical state directly; there
is no separately callable analyzed-state constructor. This prevents authentic
evidence created for one statement from being replayed against another.

Compatibility limitations are a unique, non-empty subset of the three closed
values and are capped accordingly. Diagnostic collections, messages, parser
input, and retained strings are likewise bounded before backend-controlled work
can cause unbounded copying.

## Consequences

- Impossible result combinations are rejected by TypeScript and constructor
  validation.
- Backends can be changed without exposing their AST as API.
- Unsupported dialect coverage remains honest.
- Parser artifacts can be cached independently of catalog generations.
- The contract has more explicit result variants, but consumers narrow on
  stable discriminants instead of interpreting nullable fields or exceptions.

The initial `node-sql-parser` adapter will lazy-load dialect-specific builds,
request locations, retain backend data privately, and normalize every boundary
before constructing these results. Cache/session wiring follows only after the
adapter passes the contract suite.

[ADR 0003](./0003-node-sql-parser-adapter.md) applies this contract
conservatively: PostgreSQL, BigQuery, and DuckDB acceptance is compatibility
evidence with explicit limitations; rejection is unsupported rather than
invalid; and session wiring waits for an explicit
synchronous-execution/worker decision.

## Non-goals

This decision does not define:

- A public parser plugin SPI
- A universal SQL AST
- Semantic relations, scopes, types, or catalog lookup
- Recovery-node semantics
- Document-level validation
- Session cancellation or stale-result publication
- Parser cache sizing and eviction

Those layers depend on this contract but remain independently reviewable
decisions.
