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
recognize a narrow set of partial `SELECT` query sites without a complete AST.

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
- dialect-owned lexical profiles and identifier rendering;
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

1. a private bounded partial-`SELECT` query-site recognizer;
2. a private bounded CTE frame and visibility recognizer;
3. one asynchronous relation-catalog provider with explicit coverage and epoch
   state;
4. revision-aware session arbitration and deterministic result composition;
   and
5. a separate CodeMirror adapter.

Parser execution remains the selected boundary for syntax evidence and future
scope-dependent semantics. A later semantic protocol will use a scoped IR and
will not expose raw ASTs or flat relation-name lists.

The single configured provider may itself be a host-owned composite. The first
slice does not define provider fan-out, cross-provider deduplication, or
arbitration. Those remain deferred as required by ADR 0001.

### Narrow initial query sites

The private recognizer is a bounded partial SQL recognizer, not a keyword
scanner. It enters a relation-name state only from a proven supported `SELECT`
query block and a proven clause state at the current query depth:

- immediately after `FROM` or `JOIN`;
- a partial qualified or unqualified relation path following those keywords;
  and
- a comma-separated relation entry in the same `FROM` clause.

The initial recognizer does not claim support for `UPDATE`, `INSERT INTO`,
table functions, derived output relations, `LATERAL`, or column positions.
It fails closed when unsupported syntax could change the clause, expression,
or query-block state. Strings and comments never create sites. `FROM (` and a
cursor inside a string, comment, quoted token that cannot be decoded, or
embedded region are unavailable or inactive according to the closed result.
CTE visibility is the one narrow scope-semantics exception; general
parser-derived scope semantics remain deferred.

The conformance corpus includes positive base `FROM`, qualified prefix,
aliased `JOIN`, same-depth comma, and nested supported-query cases. It includes
negative `IS DISTINCT FROM`, `substring(... FROM ...)`, `extract(... FROM
...)`, `DELETE FROM`, `COPY ... FROM`, set-operation, `QUALIFY`, `WINDOW`, join
constraint, DML, and expression cases. A keyword match alone never creates a
site.

The result distinguishes:

- inactive: the cursor is not at a supported relation site;
- unavailable: an opaque statement, resource limit, or ambiguous construct
  prevents a safe answer; and
- ready: the replacement range, decoded qualifier and prefix, visible CTEs,
  and exact or recovered quality are known.

The recognizer authenticates both the final identifier-segment range and the
whole typed relation-path range as statement-relative UTF-16 ranges created
from package-owned source. The session maps them to absolute original-document
ranges before returning a completion item. In the first slice every catalog
completion replaces the authenticated whole typed relation path with the fully
rendered, provider-proven `completionPath`. It never inserts a full path into a
final-segment edit, so `schema.us` cannot become `schema.schema.users`.
Incomplete quoted identifiers replace the complete authenticated token or path
rather than creating an unmatched quote suffix. No edit crosses a statement or
embedded-region boundary.

### Dialect-owned identifier policy

Dialect runtime data, not providers, owns:

- bare-identifier syntax;
- quote delimiters and escaping;
- query-local quoted and unquoted CTE equality;
- reserved-word quoting;
- rendering by path-segment role;
- maximum identifier path depth; and
- supported CTE grammar.

The provider and catalog scope own catalog-path matching, case policy, and
addressability. This matters for systems such as BigQuery, where dataset
configuration can change case sensitivity, and where rendering rules differ
by path segment. Providers receive decoded identifier queries and the public
dialect ID, and return decoded path components plus positive matching evidence.
They never produce SQL insertion text or choose quoting.

The service does not generic-fold, deduplicate, reject, or infer absence for
catalog entities. A dialect-derived normalized string may be used only as a
locale-independent deterministic sort key; it never establishes catalog
eligibility, equality, addressability, or authority.

DuckDB uses DuckDB lexical and identifier rules for completion. Its use of the
PostgreSQL compatibility parser remains separate positive-only syntax
evidence.

### Bounded CTE visibility

The CTE recognizer handles a bounded subset of query-block-leading CTE syntax:

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

Every accepted full-text or incremental document update includes the complete
ordered, non-overlapping region set for the resulting text. An empty set clears
regions; a context-only update preserves them. Text, context, and regions pass
one validation gate and either create one new revision together or leave the
session unchanged. The CodeMirror adapter supplies the post-transaction set
through a typed effect or a configured pure extractor; it never follows a text
update with a second region update.

An untyped embedded region is an unknown grammar barrier, not an exact
expression token. The recognizer:

- returns inactive while the cursor is inside an embedded region;
- never creates an edit or identifier path crossing a region; and
- marks a CTE header containing an opaque region partial rather than inventing
  a declaration; and
- returns unavailable when proof cannot cross the barrier, or ready with
  recovered quality, `isIncomplete: true`, and the closed reason
  `opaque-template-context` when a later site is independently proven.

Therefore generic marimo interpolation such as `FROM {df} JOIN |` is never
exact. Exact continuation across a region requires a future trusted,
feature-specific syntactic-role contract; a language label alone is
insufficient.

Marimo keeps Python-expression completion as an external CodeMirror source for
positions inside `{...}`. Its region conformance fixtures cover `{df}`, nested
Python expressions and strings, `{{...}}`, unmatched braces, braces in SQL
strings/comments, cursor-inside-region behavior, and edits that create or
remove regions.

### Catalog provider boundary

The provisional catalog provider is feature-specific and asynchronous. A relation
search request contains only copied, recursively frozen plain data:

- catalog scope and an ordered list of search paths, where each path is an
  ordered list of decoded components with quoted state;
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
- a closed provider-proven match quality, initially `exact` or `equivalent`;
  and
- optional bounded plain-text detail.

The service never invents an unqualified candidate from an absolute path. The
provider proves matching and addressability through `matchQuality` and
`completionPath`; the service validates the bounded shape and produces
dialect-correct, segment-role-aware insertion text. Each catalog item has one
positive catalog provenance containing provider and entity IDs.

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

The core also provides a provisional `createInMemoryRelationCatalog` helper for
bounded readonly relation data. It indexes stable IDs, kinds, canonical
component paths, optional details, scopes, and search paths; uses package
dialect utilities for matching and addressable completion paths; returns
complete, frozen generation-zero results; and requires no no-op subscription
for a static catalog. It imports no CodeMirror, DOM, React, or host state.

### Epochs, subscriptions, and invalidation

Epochs are monotonic per provider ID and catalog scope and contain:

- a non-negative safe generation; and
- an opaque bounded non-secret token.

Every response and invalidation passes through one serialized gate for the
configured provider identity and scope. A subscription callback is always a
change event, never an initial snapshot. The first accepted invalidation
establishes its epoch and advances all sessions already subscribed to that
scope. A first successful search response may establish a baseline without a
revision advance only when no invalidation has been accepted since the request
captured its revision.

After a baseline exists, lower generations are discarded with closed stale
evidence. Equal generation and token is a duplicate. Equal generation with a
different token is malformed provider behavior and causes no state mutation.
A higher accepted invalidation or response atomically installs the new epoch,
clears older scope cache entries, supersedes affected work, and then advances
each subscribed session revision exactly once.

A search that discovers a higher epoch supersedes itself instead of publishing
against its older captured revision. Pages and cache entries from different
epochs are never merged.

The service reference-counts one provider subscription per provider
configuration and scope, then fans invalidation out to subscribed sessions.
Subscription membership is installed atomically before a provider can call
back synchronously. A newly joining session captures an already-observed epoch
without a synthetic revision bump. Disposal removes membership before
unsubscribing or running external cleanup. Fifty sessions sharing a scope do
not create fifty provider subscriptions.

The session exposes a disposable revision-change subscription for
service-originated changes:

```ts
const subscription = session.onDidChange(({ revision, reason }) => {
  // reason is a closed value such as "catalog"
});
subscription.dispose();
```

State and the opaque revision change before listeners run. Listener failures
are isolated; disposal is idempotent; and callbacks never run after session or
service disposal. The event contains no provider payload. Text and context
updates remain observed through the caller's own transaction and do not need a
duplicate event.

### Completion result contract

The framework-independent session returns immutable completion items containing
plain strings, one exact absolute original-document text edit, relation kind,
and one positive provenance: either a visible CTE with declaration position or
a catalog entity with provider and entity IDs.

The list separately records whether it is incomplete and closed reasons such
as catalog loading, partial or paginated coverage, provider failure or timeout,
query-site recovery, recursive CTE uncertainty, and result limiting.

A recognized site with no candidates is a ready empty list. It remains marked
incomplete when catalog or recognition evidence is incomplete. An inactive or
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
aborts the provider only after an atomic consumer-set mutation observes that
the last consumer left. A new same-key latest-wins request attaches to shared
work before the old request detaches, so supersession cannot abort and restart
identical provider work. Ownership is removed before any abort or external
callback. All cancellation, supersession, disposal, deadline, and completion
races pass one settle-once transition and leave no timer or listener behind.

Ranking is independent of asynchronous completion order:

1. visible CTEs;
2. provider-proven `exact` matches, then `equivalent` matches;
3. shorter proven completion paths;
4. catalog kind in the closed order temporary table, table, view, materialized
   view, then external relation;
5. rendered label and path under code-unit comparison using `<` and `>`, never
   locale-sensitive comparison; and
6. CTE declaration offset for local ties or provider entity ID for catalog
   ties.

A visible CTE shadows an unqualified catalog insertion only when the
dialect-owned query-local CTE equality policy proves equivalence. Distinct
catalog entities are never merged or deduplicated by a generic fold. The first
slice has one provider and does not accept arbitrary floating scores.

### Deadlines, cache identity, and retention

Provider invocation is measured against an 8 ms synchronous observation
budget. JavaScript cannot preempt synchronous code; an over-budget return is
therefore discarded as `catalog-timeout`, and CPU-heavy or untrusted providers
must use a worker or process.

Service-owned queue-wait and execution safety deadlines default to 100 ms and
250 ms. Configuration is checked at construction and restricted to 10–2,000 ms
for queue wait and 10–5,000 ms for execution. Joining shared work never extends
either request's absolute deadline. Queue expiry removes work without invoking
the provider. Execution expiry detaches the consumer, aborts only after the
consumer count reaches zero, and drains a late resolve or reject. No provider
promise can keep `complete()` pending indefinitely.

At a recognized site, queue or execution expiry still settles a ready local
result, possibly empty, with `isIncomplete: true` and a closed
`catalog-queue-timeout` or `catalog-timeout` reason. It does not turn proven
query-site evidence into unavailable analysis.

The exact structural cache and shared-work key contains:

- service-owned provider configuration identity and unique provider ID;
- exact catalog scope;
- ordered search paths, component values, and quote states;
- dialect runtime configuration identity;
- decoded qualifier and prefix values and quote states;
- clamped result limit;
- continuation token; and
- the captured epoch generation and token, or an explicit `UNOBSERVED`
  sentinel.

Hashes may accelerate comparison but never replace structural equality.
Provider IDs are unique within a service and callers cannot choose
configuration identity. The first decoded response can re-key unobserved work
to its epoch. Only decoded ready responses are cached under their response
epoch. Loading, failure, malformed, timeout, cancellation, supersession, queue
overload, and disposal outcomes are not cached. Complete-empty results are
reused only for the exact key and never prove an unknown-object diagnostic.
Partial and paginated entries retain incomplete coverage; pages combine only
for the identical base key and epoch, and each continuation remains a distinct
request key. Higher-epoch results may be cached only after older scope entries
are cleared and never publish to the revision that observed the older epoch.

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
| Catalog scope | 512 UTF-16 units |
| Search paths | 32 |
| Components per search path | 4 |
| Total catalog context | 16,384 UTF-16 units |
| Configured relation catalog providers | 1 |
| Catalog results per search | 100 |
| Completion results after composition | 100 |
| Provider ID | 256 UTF-16 units |
| Entity ID | 256 UTF-16 units |
| Epoch token | 256 UTF-16 units |
| Plain-text detail | 1,024 UTF-16 units |
| Continuation token | 2,048 UTF-16 units |
| Decoded response aggregate | 65,536 UTF-16 units |
| Decoded response own keys | 1,024 |
| Decoded response nesting depth | 8 |
| Service catalog cache | 256 entries and 2 MiB estimated retained bytes |
| Service-wide active catalog searches | 8 |
| Service-wide queued catalog searches | 64 |
| Active completion consumers | 1 per session |

Limit exhaustion produces an explicit unavailable or incomplete result. An
oversized provider response is rejected; it is never silently truncated while
retaining a false `complete` claim.

The 65,536-unit scan limit is a safety ceiling, not a latency target. The
recognizer must still meet the active-statement product envelope on the
representative 10 KiB workload and must return explicit resource unavailability
instead of creating a routine main-thread task over 50 ms.

### CodeMirror boundary

CodeMirror integration ships from a separate entry point. It owns:

- one document session per `EditorView`;
- conversion of transactions into atomic text, context, and region updates;
- focus, visibility, debounce, and request cancellation;
- conversion to CodeMirror completion results;
- one coalesced subscription to service-originated session revision changes;
- safe rendering and external completion-source composition; and
- session disposal from the view plugin.

The core does not expose CodeMirror `Completion`, `EditorState`, `EditorView`,
facets, DOM nodes, or renderer callbacks. The first adapter omits reusable
`validFor` caching so CodeMirror cannot reuse a result across a session revision
without revalidation. It checks `session.isCurrent()` both before returning and
immediately before applying a result.

When a catalog epoch advances without an editor transaction, the adapter
aborts captured work, invalidates stale completion state, and coalesces a
scheduled refresh if a completion UI is open. It never synchronously dispatches
from a CodeMirror update or a provider callback.

A supplied language service is caller-owned. Each view plugin owns exactly one
session, revision subscription, debounce set, active request, and any UI
resource. `destroy()` unsubscribes, aborts, disposes its session and UI, and is
idempotent; it never disposes the shared service or provider. Service disposal
settles all sessions even if views still exist, and later view destruction
remains harmless.

The adapter accepts a custom completion-info resolver/decorator. It receives
only the immutable core item and its provider/entity provenance, and may use a
host closure to resolve live metadata and produce rich CodeMirror information.
Async detail is cancellation-aware, late results are drained, and any returned
UI resource has explicit disposal so marimo can unmount React roots. The
default path creates safe plain text/DOM and never assigns provider strings to
`innerHTML`. React, Jotai, `DataTable`, DOM nodes, and live metadata never enter
the core contract.

The marimo acceptance fixture runs 1, 10, and 50 views against one shared
service. It proves one session/listener/request owner per view but one provider
subscription, cache, and catalog index per provider configuration and scope.
Destroying 49 views retains the subscription; destroying the last releases it
exactly once. A second scope adds one subscription, not one per view.

The fixture also proves that relation completion constructs no parser worker;
epoch invalidation creates one service fan-out and bounded coalesced view
refreshes; engine, dialect, and scope switches are atomic; and rapid edits,
loading/partial/failing providers, ignored abort signals, late settlement,
open-menu invalidation, repeated destruction, and service-before-view disposal
leave no stale apply, late dispatch, unresolved promise, unhandled rejection,
listener, subscription, React root, or unbounded cache retention. GC-capable
runs record retained resources, while 10 KiB documents enforce the capability
charter's main-thread and completion-latency envelopes.

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

1. Accept this ADR as the provisional contract and compile its completion,
   catalog, epoch, invalidation, notification, request-result, and
   embedded-region type sketches against core and marimo consumer fixtures.
2. Attach embedded regions to session open/update transactions atomically.
3. Add the bounded partial-`SELECT` query-site recognizer.
4. Add the bounded CTE frame and visibility recognizer.
5. Add the service-owned catalog coordinator, subscriptions, cache,
   in-flight sharing, cancellation, and provider contract suite.
6. Add the session completion method and deterministic composition.
7. Add the separate CodeMirror adapter and packed/browser fixtures.
8. Add the marimo fixture and 1/10/50-editor performance and leak evidence.
9. Validate both the in-memory/notebook and hierarchical remote provider
   shapes, then stabilize the declarations and public export surface.
10. Design scoped parser semantics and protocol v2 against PostgreSQL and
   BigQuery corpora before any scope-dependent feature consumes it.

Breaking refinement remains allowed through step 8. The provider and
completion types become stable only after the working vertical slice, reusable
provider contract suite, two materially different provider shapes, marimo
packed/browser integration, hostile decoding, cancellation, epoch and
pagination tests, declaration/API snapshots, and the rich-detail/external
completion-source migration decision all pass.

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
- The query-site recognizer is intentionally narrow and reports uncertainty
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
