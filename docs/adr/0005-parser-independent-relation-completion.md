# ADR 0005: Parser-Independent Relation Completion

Status: proposed

Date: 2026-07-25

## Context

ADR 0004 originally required the isolated parser worker to return normalized
relation facts before the first relation-completion slice. Implementation and
adversarial inspection of the pinned `node-sql-parser` 5.4.0 builds showed that
this is the wrong dependency.

Relation completion is most valuable for incomplete input such as:

```sql
SELECT * FROM |
SELECT * FROM schema.us|
SELECT * FROM users u JOIN |
```

The compatibility parser rejects many of these states. Waiting for it would
make completion least reliable at the exact moment it is requested. It would
also construct a roughly 500 KiB parser-worker graph for a feature that can
classify its initial cursor sites lexically.

The backend AST cannot provide a safe shortcut:

- Flat `tableList` data mixes physical relations with CTE references.
- Nested wrapper lists can include relations inherited from an ancestor.
- PostgreSQL and BigQuery use different shapes for CTE bodies.
- BigQuery qualified paths have different shapes when backtick quoted.
- PostgreSQL commonly omits relation locations and loses quote provenance.
- DML target and source fields have different read/write roles.
- CTE declaration order, nesting, shadowing, recursion, correlation, and
  `LATERAL` require scopes rather than a flat list.

A flat value named `dependencies`, `sources`, or `relations` would therefore
encode stronger semantics than the adapter can prove. Parser acceptance is
already compatibility-only evidence under ADR 0003.

The current vNext core has the required parser-independent foundations:

- immutable original and masked analysis source;
- absolute UTF-16 half-open coordinate mapping;
- dialect-owned lexical profiles;
- exact and explicitly opaque statement slots;
- cursor affinity;
- atomic session revisions and context changes; and
- service ownership shared across many document sessions.

Marimo adds concrete requirements. A notebook can mount many SQL editors,
change connection and dialect dynamically, combine notebook-local and remote
relations, and embed Python expressions in `{...}` regions. Its Python
completion source must remain independently composable.

## Decision

The first relation-completion vertical slice will not depend on the parser,
parser worker, or parser coordinator.

It will combine:

1. a private bounded lexical active-site classifier;
2. a private bounded lexical CTE visibility classifier;
3. an asynchronous relation-catalog provider with explicit coverage and epoch
   state;
4. revision-aware session arbitration and deterministic result composition;
   and
5. a separate CodeMirror adapter.

Parser execution remains the selected boundary for syntax evidence and future
scope-dependent semantics. A later semantic protocol will use a scoped IR and
will not expose raw ASTs or flat relation-name lists.

### Narrow initial cursor sites

The private classifier recognizes only relation-name positions that it can
prove:

- immediately after `FROM` or `JOIN`;
- a partial qualified or unqualified relation path following those keywords;
  and
- a comma-separated relation entry in the same `FROM` clause.

The initial classifier does not claim support for `UPDATE`, `INSERT INTO`,
table functions, derived output relations, `LATERAL`, or column positions.
Strings and comments never create sites. `FROM (` and a cursor inside a string,
comment, quoted token that cannot be decoded, or embedded region are
unavailable or inactive according to the closed classifier result.

The result distinguishes:

- inactive: the cursor is not at a supported relation site;
- unavailable: an opaque statement, resource limit, or ambiguous construct
  prevents a safe answer; and
- ready: the replacement range, decoded qualifier and prefix, visible CTEs,
  and exact or recovered quality are known.

All replacement ranges are authenticated statement-relative UTF-16 ranges
created from package-owned source. The session maps them to absolute original
document ranges before returning a completion item.

The replacement normally covers the final identifier segment. If a catalog
provider proves that only a qualified completion path is addressable, the
service may replace that segment with the complete dialect-quoted path.
Incomplete quoted identifiers replace the complete token rather than creating
an unmatched quote suffix.

### Dialect-owned identifier policy

Dialect runtime data, not providers, owns:

- bare-identifier syntax;
- quote delimiters and escaping;
- quoted and unquoted equality and normalization;
- reserved-word quoting;
- maximum identifier path depth; and
- supported CTE grammar.

Providers receive decoded identifier queries and the public dialect ID. They
do not produce SQL insertion text or choose quoting.

DuckDB uses DuckDB lexical and identifier rules for completion. Its use of the
PostgreSQL compatibility parser remains separate positive-only syntax
evidence.

### Lexical CTE visibility

The classifier recognizes a bounded subset of query-block-leading CTE syntax:

```text
WITH [RECURSIVE]
  name [(declared columns)] AS [NOT] MATERIALIZED (body),
  ...
main query
```

It records only proven declaration names, body boundaries, declaration order,
and visibility. It is not a miniature general SQL AST.

For non-recursive CTEs:

- a declaration is not visible in its own body;
- earlier siblings are visible in later sibling bodies;
- all completed declarations are visible in the main query;
- later declarations are never visible earlier;
- visible outer CTEs flow into nested query blocks;
- a nested declaration shadows an outer name only inside its query block; and
- nested declarations never leak outward.

Identifier equality follows the dialect. Duplicate names and structurally
ambiguous headers make the affected frame partial. `WITH RECURSIVE` may expose
proven names in the main query, but self and mutual-recursive body visibility
remain explicitly incomplete until implemented.

An empty positive-only local-relation list never proves that no CTE is visible.

### Embedded regions

The first public template input is a complete set of length-preserving embedded
regions attached atomically to a document revision. Arbitrary transformer
callbacks and generated/reordered source maps remain deferred.

The classifier:

- returns inactive while the cursor is inside an embedded region;
- treats a region as one opaque expression token so
  `FROM {df} JOIN |` can recognize the second site;
- never creates an edit or identifier path crossing a region; and
- marks a CTE header containing an opaque region partial rather than inventing
  a declaration.

Marimo keeps Python-expression completion as an external CodeMirror source for
positions inside `{...}`.

### Catalog provider boundary

The stable catalog provider is feature-specific and asynchronous. A relation
search request contains only copied, recursively frozen plain data:

- catalog scope and search paths;
- public dialect ID;
- decoded qualifier and prefix components with quoted state;
- result limit;
- expected epoch when known; and
- an optional bounded continuation token.

The `AbortSignal` is passed separately. Providers never receive a session,
revision, `EditorState`, DOM object, credential object, or arbitrary live host
context. Connection identity belongs in the catalog scope; live resources stay
inside the provider closure.

A returned relation contains:

- a stable provider-local entity ID;
- relation kind;
- canonical absolute catalog path;
- a completion path positively proven addressable for the request scope and
  search path; and
- optional bounded plain-text detail.

The service never invents an unqualified candidate from an absolute path. The
provider proves addressability through `completionPath`; the service validates
the query match and produces dialect-correct insertion text.

Search responses distinguish:

- ready with complete, partial, or paginated coverage;
- loading; and
- failed with a closed code and retry policy.

Partial positive entities may be offered. A partial or absent result never
proves that a relation does not exist. A complete empty search means only that
the exact search produced no matches at that provider epoch; it is not reused
as an unknown-object diagnostic.

Provider responses are decoded from `unknown` using bounded own enumerable
data properties and copied into fresh frozen current-realm objects. Accessors,
throwing proxies, unexpected keys, oversized strings or arrays, and malformed
closed values fail without exposing raw errors.

### Epochs, subscriptions, and invalidation

Epochs are monotonic per provider ID and catalog scope and contain:

- a non-negative safe generation; and
- an opaque bounded non-secret token.

The first accepted response establishes the observed epoch without invalidating
the revision that requested it. After that, lower generations are discarded.
Equal generation and token is a duplicate. Equal generation with a different
token is malformed provider behavior. A higher accepted invalidation or search
response clears affected cache entries and advances every subscribed session
revision.

A search that discovers a higher epoch supersedes itself instead of publishing
against its older captured revision. Pages and cache entries from different
epochs are never merged.

The service reference-counts one provider subscription per provider and scope,
then fans invalidation out to subscribed sessions. Fifty sessions sharing a
scope do not create fifty provider subscriptions.

### Completion result contract

The framework-independent session returns immutable completion items containing
plain strings, one exact absolute original-document text edit, relation kind,
and positive provenance.

Provenance is per item because duplicate candidates can merge evidence from:

- one or more catalog providers; and
- a visible document CTE.

The list separately records whether it is incomplete and closed reasons such
as catalog loading, partial or paginated coverage, provider failure or timeout,
lexical recovery, recursive CTE uncertainty, and result limiting.

A recognized site with no candidates is a ready empty list. It remains marked
incomplete when catalog or lexical evidence is incomplete. An inactive or
unavailable site lets the CodeMirror adapter return `null` so other completion
sources can run.

Malformed synchronous request input throws a stable session contract error.
Normal provider, cancellation, supersession, disposal, and unsupported-analysis
outcomes settle through a discriminated request result.

### Cancellation and deterministic composition

Completion is latest-wins per session:

- a new completion request supersedes the previous request;
- text, context, embedded-region, relevant catalog, or provider-configuration
  changes supersede captured work;
- caller cancellation and session/service disposal settle promptly;
- late provider resolution or rejection is drained without publication or an
  unhandled rejection; and
- the adapter checks revision currency immediately before returning or
  applying a result.

Shared in-flight catalog work detaches each consumer independently. The service
aborts the provider only after the last consumer leaves.

Ranking is independent of provider completion order:

1. visible CTEs;
2. exact-case prefix matches;
3. folded prefix matches;
4. shorter proven completion paths;
5. relation-kind priority;
6. dialect-normalized label and path; and
7. provider ID and entity ID.

A visible CTE shadows a normalized-equivalent unqualified catalog candidate.
Other equal insertions merge positive provenance. The first slice does not
accept arbitrary floating provider scores.

### Initial resource budgets

The initial checked limits are:

| Resource | Limit |
| --- | ---: |
| Active statement scanned | 65,536 UTF-16 units |
| Lexical tokens | 16,384 |
| Parenthesis/query depth | 128 |
| CTE declarations | 256 |
| Identifier path segments | 4 |
| Identifier segment | 256 UTF-16 units |
| Catalog results per search | 100 |
| Completion results after merge | 100 |
| Provider and entity ID | 256 UTF-16 units |
| Plain-text detail | 1,024 UTF-16 units |
| Continuation token | 2,048 UTF-16 units |
| Service catalog cache | 256 entries and 2 MiB estimated strings |
| Active catalog searches | 8 |
| Queued catalog searches | 64 |
| Active completion consumers | 1 per session |

Limit exhaustion produces an explicit unavailable or incomplete result. An
oversized provider response is rejected; it is never silently truncated while
retaining a false `complete` claim.

The 65,536-unit scan limit is a safety ceiling, not a latency target. The
classifier must still meet the active-statement product envelope on the
representative 10 KiB workload and must return explicit resource unavailability
instead of creating a routine main-thread task over 50 ms.

### CodeMirror boundary

CodeMirror integration ships from a separate entry point. It owns:

- one document session per `EditorView`;
- conversion of transactions into atomic text, context, and region updates;
- focus, visibility, debounce, and request cancellation;
- conversion to CodeMirror completion results;
- safe rendering and external completion-source composition; and
- session disposal from the view plugin.

The core does not expose CodeMirror `Completion`, `EditorState`, `EditorView`,
facets, DOM nodes, or renderer callbacks. The first adapter omits reusable
`validFor` caching so CodeMirror cannot reuse a result across a session revision
without revalidation.

## Parser semantics remain separate

Worker protocol v1 remains unchanged.

When scope-dependent completion, hover, navigation, or diagnostics require
parser semantics, the worker protocol will move atomically to v2. A parsed
response will keep normalized syntax and semantic availability independent.
The semantic payload will be a bounded scoped IR covering query blocks,
bindings, visibility, and limitations. It will not contain raw ASTs, raw source,
absolute document ranges, flat `tableList` data, or generic fact bags.

The host and worker will not negotiate or simultaneously support v1 and v2.
Mixed cached assets fail the exact version check and retire the generation.

## Implementation sequence

1. Accept this ADR and freeze the public completion, catalog, epoch,
   invalidation, request-result, and minimal embedded-region types.
2. Attach embedded regions to session open/update transactions atomically.
3. Add the bounded lexical active-site classifier.
4. Add the bounded lexical CTE frame and visibility classifier.
5. Add the service-owned catalog coordinator, subscriptions, cache,
   in-flight sharing, cancellation, and provider contract suite.
6. Add the session completion method and deterministic composition.
7. Add the separate CodeMirror adapter and packed/browser fixtures.
8. Add the marimo fixture and 1/10/50-editor performance and leak evidence.
9. Design scoped parser semantics and protocol v2 against PostgreSQL and
   BigQuery corpora before any scope-dependent feature consumes it.

Every production step is a medium change and requires two independent
commit-bound adversarial reviews.

## Consequences

- Incomplete relation completion does not wait for parser startup or success.
- Relation-only completion does not construct the parser worker.
- Cursor movement and catalog invalidation do not cause reparsing.
- DuckDB completion is not defined by PostgreSQL parser compatibility.
- Catalog changes do not invalidate statement parsing.
- Parser crashes and safety timeouts do not suppress local/catalog relation
  completion.
- The lexical classifier is intentionally narrow and reports uncertainty
  instead of growing into an implicit general SQL parser.
- CTE visibility has an explicit bounded model rather than a flat query-wide
  list.
- The public core remains independent of CodeMirror and DOM types.
- Scoped semantic work is deferred, not represented by an incorrect flat
  contract.

## Rejected alternatives

### Gate relation completion on worker parsing

The parser rejects important incomplete editor states, adds cold-start and
message latency, and is unnecessary for the narrow first cursor sites.

### Return flat relation names from protocol v1

Flat names cannot distinguish CTE references, physical relations, nested
scope, or DML roles and have unreliable path and quote provenance.

### Expose parser tokens or AST ranges to completion

Backend-specific data would leak through the stable boundary and is not
consistent across the target dialects.

### Reuse `SQLNamespace` as the catalog API

A fully materialized nested object has no asynchronous coverage, pagination,
epoch, stable entity identity, or positive addressability contract.

### Put CodeMirror completion types in the core

That would couple providers and sessions to editor state, DOM rendering, and
CodeMirror lifecycle instead of keeping the language service reusable.
