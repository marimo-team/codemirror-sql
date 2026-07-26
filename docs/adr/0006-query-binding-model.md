# ADR 0006: Internal query binding model

## Status

Accepted for the standard implementation. The model remains package-internal until a
column-completion vertical slice has validated it across the supported dialect
corpora.

## Context

Column completion needs more than a parser's flat table list. It must distinguish
query blocks, relation declarations, aliases, correlation, and clause-specific
visibility. The parser adapter also has strict trust boundaries: raw parser ASTs
are private, parser results can be partial, and cached analysis must belong to
the exact statement and parser authority that produced it.

The model must remain cheap enough for interactive use and must not make the
existing parser-independent relation completion path wait for parsing.

## Decision

Add an internal, backend-neutral query binding model with:

- statement-relative UTF-16 ranges;
- query blocks and relation bindings identified by model-local array indexes;
- a persistent scope chain in which each node adds at most one binding;
- ordered, globally non-overlapping visibility regions that point to a scope;
- independent query-block, relation-binding, and visibility coverage;
- closed issue and unknown-source reason sets;
- private authentication and exact statement/parser-authority ownership.

Globally non-overlapping regions deliberately exclude nested query text from
their parent region. A decoder splits a parent region around nested queries.
This permits binary-search lookup without duplicating the visible binding set.
Persistent scopes then reconstruct bindings in declaration order using linear
space. In particular:

- a `SELECT` list can point to the completed `FROM` scope even though it appears
  earlier in the source;
- a join condition points to the scope containing prior relations and its
  current right-hand relation;
- a correlated child block can enter through a parent scope;
- an ordinary derived table enters through a scope that excludes same-level
  siblings; a future proven `LATERAL` decoder may opt into that scope.

Aliases are the visible qualifier when present and hide a named relation's base
name. Identifier equality is supplied by the dialect runtime; the model does
not lowercase or otherwise reinterpret identifiers.

Construction accepts untrusted plain data and validates it before issuing an
immutable authenticated model. It rejects accessors, sparse or oversized
arrays, malformed UTF-16 identifiers, invalid or unrelated ranges, forward
parent edges, repeated bindings in a scope chain, overlapping regions, and
unknown bindings paired with complete relation coverage.

Resolution returns:

- a visible binding list with complete or partial coverage;
- one resolved binding, known ambiguity, or authoritative no-match;
- unavailable instead of no-match when coverage is partial.

## Ownership and invalidation

The future parser service owns bounded parse/model caching and in-flight
deduplication. A document session owns the mapping from its current statement
slots to immutable models. The cache key includes exact statement text,
dialect, parser authority/conformance, and implementation version.
Statement-relative coordinates allow an unchanged statement to be reused after
an edit shifts its absolute document position. Source, dialect, or parser
authority changes invalidate the model; catalog epoch and completion context
changes do not.

The interactive statement limit is initially 16 KiB. The model also caps query
blocks at 256, relation bindings at 1,024, scopes and regions at 2,048 each,
nesting by the block limit, issues at 256, path depth at 8, and identifier
components at 256 UTF-16 code units.

## Degradation

A decoder may claim complete evidence only for directly conforming parser output
and constructs it understands. Compatibility parses can supply useful partial
evidence but cannot prove absence. Unknown AST subtrees become an unknown source
or a closed issue and downgrade the relevant coverage; they are never silently
dropped under complete coverage.

Invalid, failed, opaque, incomplete, or resource-limited analysis becomes
partial or unavailable. Parser-independent relation completion remains
available. Dremio remains partial or unavailable until it has an owned semantic
corpus.

## Consequences

The model can support lazy batched column loading without exposing a parser AST
or CodeMirror's eager `SQLNamespace`. Its indexes are not stable identities
across revisions. Projection inference, output columns, star expansion, types,
expression binding, semantic diagnostics, navigation, rename, formatting, and
vendor constructs such as `PIVOT`, `UNNEST`, table functions, and unproven
`LATERAL` semantics are explicitly outside this slice.

The node-sql-parser integration now supplies a strict AST-to-plain-data decoder,
normalizes inside the worker, and checks direct-versus-worker parity. Public
semantic APIs remain deferred until a column-completion vertical slice proves
the model against consumer and dialect corpora.
