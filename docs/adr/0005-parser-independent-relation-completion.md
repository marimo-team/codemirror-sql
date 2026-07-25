# ADR 0005: Parser-Independent Relation Completion

Status: accepted

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
general scope-dependent semantics. A later semantic protocol will use a scoped
IR and will not expose raw ASTs or flat relation-name lists.

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

The recognizer may cross a `USING` join constraint only after authenticating
the complete bounded grammar `USING(identifier [, identifier ...])` with
dialect-owned identifier validation. It does not interpret `ON` expressions:
encountering `ON` makes the query site unavailable until a future
parser-backed or separately specified expression recognizer can prove the
boundary.

The conformance corpus includes positive base `FROM`, qualified prefix,
aliased `JOIN`, authenticated `USING`, same-depth comma, and nested
supported-query cases. It includes
negative `IS DISTINCT FROM`, `substring(... FROM ...)`, `extract(... FROM
...)`, `DELETE FROM`, `COPY ... FROM`, set-operation, `QUALIFY`, `WINDOW`,
`ON`, malformed `USING`, DML, and expression cases. A keyword match alone
never creates a site.

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
rendered canonical suffix selected by provider-proven `completionPathStart`.
It never inserts a full path into a final-segment edit, so `schema.us` cannot
become `schema.schema.users`.
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

The accepted grammar is dialect-owned and closed:

| Dialect | Declarations per frame | `RECURSIVE` | Declared columns | Materialization modifier |
| --- | ---: | --- | --- | --- |
| PostgreSQL | up to the global bound | accepted | accepted | `MATERIALIZED` and `NOT MATERIALIZED` |
| DuckDB | up to the global bound | accepted | accepted | `MATERIALIZED` and `NOT MATERIALIZED` |
| BigQuery | up to the global bound | accepted | rejected | rejected |
| Dremio | one | rejected | accepted | rejected |

This matrix describes only syntax the bounded recognizer can prove. Rejection
does not claim that a database engine rejects every extension or future
version; it makes the current completion result explicitly incomplete or
unavailable instead of borrowing another dialect's grammar.

The recognizer records only:

- flat query-block frames and their parent frame;
- proven declaration names, exact source spelling and name ranges;
- body ranges and declaration order;
- authenticated main-query `SELECT` entrypoints; and
- bounded candidate-name and uncertainty evidence for incomplete headers.

It stores no AST, SQL substring, token tape, inferred output columns, or
recursive dependency graph. A declaration is committed only after its `AS`
body has a proven matching close parenthesis. Seeing `WITH name`, `name AS`, or
an opening body alone never invents a visible relation. Once a body opening is
proven, a separate bounded draft record retains its name, ordinal, body range,
and comparison evidence. Drafts can establish the current body phase and
fail-closed shadow uncertainty, but never become completion candidates.

Candidate-name evidence, visible-candidate evidence, and shadow evidence are
distinct. Before a body opens, an active incomplete header has no supported
relation site; direct private projection still reports recovered unknown
coverage rather than exact absence. Once a body opens, its draft name is not
returned as a completion candidate, but it prevents the service from claiming
exact scope or exact non-shadowing where recursive or uncertain equality could
make it visible. Such a result is marked incomplete with
`cte-scope-uncertainty`. A proven declaration shadows an equivalent outer CTE
or unqualified catalog insertion only over its proven visibility range. A
duplicate equivalence class produces no arbitrary first- or last-wins
candidate and blocks an equivalent outer or catalog name wherever that class
would be visible. Uncertainty in one nested frame does not erase independently
proven candidates outside that frame.

For non-recursive CTEs:

- a declaration is not visible in its own body;
- earlier siblings are visible in later sibling bodies;
- all completed declarations are visible in the main query;
- later declarations are never visible earlier;
- visible outer CTEs flow into nested query blocks;
- a nested declaration shadows an outer name only inside its query block; and
- nested declarations never leak outward.

Identifier comparison follows the dialect and is tri-state: `equal`,
`distinct`, or `unknown`. PostgreSQL non-ASCII folding can depend on server
encoding and locale, while BigQuery and Dremio document case-insensitivity
without giving this package an authoritative general Unicode folding
algorithm. `unknown` therefore degrades namespace coverage and never means
`distinct`. The private layout builder consumes the same pairwise
`compareCteIdentifiers` operation exposed by the relation-completion dialect
runtime; it does not define a second nullable comparison key. Within the
256-name bound it snapshots symmetric pairwise results into frozen
equivalence classes and scoped uncertainty evidence. Throws, invalid values,
asymmetry, non-reflexivity, or inconsistent equivalence results fail closed.
Duplicate detection uses those classes rather than generic case folding.

A declaration retains both its decoded value and exact source token. The
decoded value is the completion label; the exact token is the insertion text,
so required quoting, case, and escapes are never reconstructed by the catalog
renderer. CTEs are considered only for unqualified relation sites. Prefix
eligibility is also a dialect-owned tri-state operation distinct from equality;
generic locale-sensitive or Unicode case folding is never used.

`WITH RECURSIVE` may expose proven names in the main query. The initial
recognizer also retains independently proven earlier-sibling and outer
visibility inside a recursive body, but self and forward or mutual-recursive
body candidates remain incomplete and add `recursive-cte-uncertainty`. Every
known frame-local recursive name still contributes shadow evidence inside a
recursive body, so withholding a self candidate cannot incorrectly reveal an
equivalent outer or catalog relation. The recognizer does not infer a recursive
dependency graph or output columns. DuckDB `USING KEY`, PostgreSQL
`SEARCH`/`CYCLE`, and any Dremio recursive extension remain unsupported.

The index is cursor-independent and cached with the immutable source,
statement, embedded-region, and dialect-runtime identities. Visibility is a
pure projection over its flat frozen ranges. Building the index and recognizing
the relation query site may initially make two independent linear streaming
passes over the shared lexer; traversal fusion is allowed only after benchmark
evidence. Neither cursor movement nor catalog invalidation rebuilds the index.

Stored source ranges remain half-open. Visibility projection accepts cursor
positions, so a cursor exactly before a proven closing delimiter remains in
the body or nested frame, and a top-level cursor at statement EOF remains in
the main query. A cursor after the delimiter is outside. At the first
untrusted boundary the enclosing draft phase may still contribute proven
positive evidence, but quality and shadow coverage are recovered rather than
exact.

An opaque region in a CTE header or body, an unterminated quoted token, an
unsupported dialect modifier, a duplicate declaration, or a structurally
plausible but unfinished declaration makes the affected frame partial. The
first opaque region terminates exact structural coverage: visible punctuation
after an untyped barrier never closes a body or frame that started before it.
A resource limit records the same first-untrusted boundary. Partial artifacts
may still contribute declarations, entrypoints, and visibility ranges proven
entirely before that boundary, but they never produce exact absence or shadow
claims across it.

An empty positive-only local-relation list never proves that no CTE is visible.

The first bounded grammar intentionally authenticates only `SELECT` query
leaders. PostgreSQL `VALUES` and data-modifying CTE bodies, DuckDB `FROM`-first
queries, and additionally parenthesized BigQuery recursive terms currently
fail closed. Their query-leader sets will become dialect-owned in a follow-up
before relation completion is declared feature-complete.

### Embedded regions

The first public template input is a complete set of length-preserving embedded
regions attached atomically to a document revision. `openDocument` accepts an
optional complete set; omission or an empty set means identity source.
Arbitrary transformer callbacks and generated/reordered source maps remain
deferred.

Every accepted full-text or incremental document update includes the complete
ordered, non-overlapping region set for the resulting text. A base-revision
transaction may instead change regions alone or together with context while
leaving text and document identity unchanged. Without a document mutation,
omission preserves the current set and an explicit empty set clears it. Text,
context, and regions pass one validation gate and either create one new
revision together or leave the session unchanged. The CodeMirror adapter
supplies the post-transaction set through a typed effect or a configured pure
extractor; it never opens or changes text and follows with a second region
update.

An untyped embedded region is an unknown grammar barrier, not an exact
expression token. The recognizer:

- returns inactive while the cursor is inside an embedded region;
- never creates an edit or identifier path crossing a region; and
- marks a CTE header containing an opaque region partial rather than inventing
  a declaration; and
- returns unavailable when proof cannot cross the barrier, or ready with
  recovered quality, `isIncomplete: true`, and the closed reason
  `opaque-template-context` when source tokens after the barrier heuristically
  resemble a supported site and the edit coordinates are independently safe.

Therefore generic marimo interpolation such as `FROM {df} JOIN |` is never
exact: its SQL site semantics remain uncertain even when a recovered completion
is useful. Exact continuation across a region requires a future trusted,
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
inside the provider closure. The provider object is caller-owned. The service
captures its own-data callbacks once and owns searches, subscriptions, and
their cleanup, but does not imply provider-wide disposal. Provider callbacks
are closure functions with a declared `this: void` contract and are invoked
with `this === undefined`; mutable receiver state is not part of the provider
API. Unrelated own configuration fields are ignored, while inherited callbacks
and accessors are rejected. An own optional subscription value of `undefined`
is normalized as omitted.

A returned relation contains:

- a stable provider-local entity ID;
- relation kind;
- a canonical absolute catalog path whose components contain decoded values
  and closed semantic roles;
- a `completionPathStart` index selecting an exact suffix of that canonical
  path, positively proven addressable for the request scope and search path;
- a closed provider-proven match quality, initially `exact` or `equivalent`;
  and
- optional bounded plain-text detail.

The initial closed component roles are `catalog`, `schema`, `project`,
`dataset`, and `relation`. Each dialect accepts only its documented role
sequences, and the final component is always `relation`. The provider's
`quoted` bit is positive catalog evidence that the canonical decoded spelling
is quoted; it is never insertion SQL. The dialect still owns delimiters,
escaping, reserved-word quoting, and rendering.

The service never invents an unqualified candidate from an absolute path. The
provider proves matching and addressability through `matchQuality` and
`completionPathStart`; the service validates that the selected suffix and role
sequence are legal for the registered dialect, then produces dialect-correct,
segment-role-aware insertion text. Alias paths that are not canonical suffixes
remain deferred. Each catalog item has one positive catalog provenance
containing provider and entity IDs.

Search responses distinguish:

- ready with complete, partial, or paginated coverage;
- loading; and
- failed with a closed code and retry policy.

A terminal `loading` response is not cached. A provider that later becomes
ready must publish a strictly higher epoch through its subscription; same-epoch
duplicate invalidation is not a readiness signal. A still-pending search
promise can instead resolve ready under the service-owned response/refresh
rules below. Every completion result carrying `catalog-loading`, whether caused
by terminal loading or soft expiry, also carries a checked remaining
completion-intent lease. For terminal loading that lease is independent of
in-flight work ownership and is keyed to the exact session, query, and captured
observed or unobserved epoch.

Partial positive entities may be offered. A partial or absent result never
proves that a relation does not exist. A complete empty search means only that
the exact search produced no matches at that provider epoch; it is not reused
as an unknown-object diagnostic.

Provider responses are decoded from `unknown` using bounded own enumerable
data properties and copied into fresh frozen current-realm objects. Accessors,
throwing proxies, unexpected keys, oversized strings or arrays, and malformed
closed values fail without exposing raw errors. One malformed relation rejects
the whole page: silently retaining other entities while preserving the
provider's coverage claim would create false authority. Entity IDs must be
unique within a page. Their stability across searches and epochs is a provider
promise used for provenance, not authority the service can infer by generic
deduplication. Shared input identities are allowed, but each occurrence is
decoded, budgeted, and copied independently, so aliasing cannot retain mutable
provider state or bypass aggregate limits.

Both the complete canonical role sequence and the suffix selected by
`completionPathStart` must be legal for the registered dialect. The boundary
pre-renders the selected suffix from fresh decoded data so later scheduling and
composition never touch raw provider objects or provider-supplied SQL.

The initial vertical slice validates one bounded page and reports paginated
coverage as incomplete; it does not automatically follow or merge continuation
tokens. Continuation tokens are opaque provider state. They are bounded,
retained only with their page/work state, and never included in completion
items, logs, errors, or revision events.

The core also provides a provisional `createInMemoryRelationCatalog` helper for
bounded readonly relation data. It indexes stable IDs, kinds, role-bearing
canonical component paths, optional details, scopes, and caller-proven
addressable suffix starts. Each scope explicitly selects a closed matching
policy such as exact code-unit or ASCII case-insensitive matching; the helper
never infers catalog policy from dialect ID. Package dialect utilities decode
and render SQL but do not establish catalog eligibility. The helper returns
complete, frozen generation-zero results and requires no no-op subscription for
a static catalog. It imports no CodeMirror, DOM, React, or host state.

### Epochs, subscriptions, and invalidation

Epochs are monotonic per provider ID and catalog scope and contain:

- a non-negative safe generation; and
- an opaque bounded non-secret token.

They identify observable catalog search state, including loading versus ready
availability, not only the underlying database schema snapshot.

Every response and invalidation passes through one serialized gate for the
configured provider identity and scope. A subscription callback is always a
change event, never an initial snapshot. The first accepted invalidation
establishes its epoch and advances all sessions already subscribed to that
scope. A first successful search response may establish a baseline without a
revision advance only when no invalidation has been accepted since the request
captured its revision and no soft-settled refresh observer requires the
availability notification defined below.

After a baseline exists, lower generations are discarded with closed stale
evidence. Equal generation and token is a duplicate. Equal generation with a
different token is malformed provider behavior and causes no state mutation.
A higher accepted invalidation or response atomically installs the new epoch,
clears older scope cache entries, supersedes affected work, and then advances
each subscribed session revision exactly once.

The epoch coordinator accepts one optional package-owned, receiver-free
transition-preparation closure. For an accepted invalidation baseline or
advance, and for a higher response, it snapshots the active revision audience,
installs the epoch and notification sequence, and then calls that closure with
a copied scope and the already-frozen epoch. The closure synchronously detaches
incompatible work, cache entries, and epoch-specific gates and may return one
receiver-free dispatch closure. The no-hook and no-dispatch paths allocate no
transition wrapper state. Only after transition and session preparation
has finished does the coordinator settle the producing response, invoke the
transition dispatch, and dispatch session listeners. Provider aborts and work
settlement therefore observe every prepared session revision, while listener
code observes already-retired catalog work. Reentrant transition dispatch
commands remain behind the current revision dispatch in the epoch FIFO.
A missing or `null` dispatch is valid. A thrown transition preparation or
non-function result is an internal contract failure and disposes the
coordinator fail-closed. Dispatch is synchronously exact-return: it must return
`undefined`. A throw or any other return value disposes the coordinator after
state preparation and suppresses later revision listeners; an accidental
Promise result receives best-effort detached rejection draining. Coordinator
disposal revokes the preparation closure before external cleanup. The hook
remains package-private and is not a provider or session extension point.
The combined search coordinator also installs one package-owned disposal
target. Epoch self-quarantine makes the outer coordinator inert before
subscription cleanup continues, so search work cannot outlive its epoch
authority. The target is receiver-free, invoked at most once, and its failure
cannot reopen disposal. It is synchronously exact-return and must return
`undefined`; any other runtime result is detached and rejection-drained.

A search that discovers a higher epoch supersedes itself instead of publishing
against its older captured revision. Pages and cache entries from different
epochs are never merged.

Any successfully decoded response status (`ready`, `loading`, or `failed`) may
establish the first epoch baseline. Equal-epoch responses for different exact
searches remain usable; only the epoch observation is a duplicate. A terminal
`loading` response requires a higher epoch before that exact search can become
ready. Providers without subscriptions may return `loading`, but they cannot
cause automatic refresh; a later explicit request must observe the higher
epoch. Failed responses are attempt evidence: `next-request` may recover at
the same epoch, while `after-invalidation` and `never` create bounded retry
gates rather than cached search results.

The service reference-counts one provider subscription per provider
configuration and scope, then fans invalidation out to subscribed sessions.
The installed callback closure supplies authenticated provider and scope
identity; the untrusted invalidation payload therefore contains only an epoch.
Membership uses a two-phase prepare/commit protocol: the session stores its
prepared lease before commit can invoke provider code. Commit installs the
membership atomically before a provider can call back synchronously. Because a
subscription callback is always a change event, a valid callback fired during
`subscribe` advances that committed member after subscription installation
succeeds; it is not reclassified as an initial snapshot. A later joining
session captures an already-observed epoch without a synthetic revision bump.
Disposal removes membership before unsubscribing or running external cleanup.
Retirement also clears the membership's target and coordinator link before
that cleanup, so a consumer retaining a disposed lease retains only inert,
bounded membership metadata. The coordinator stores only the copied provider
ID and captured subscription function; it does not retain the unused search
function. Coordinator disposal revokes that subscription reference before
external cleanup, so a consumer retaining the disposed coordinator handle does
not retain the provider graph.
Fifty sessions sharing a scope do not create fifty provider subscriptions.
The coordinator reserves membership state and capacity before reading the
revision target callback. A throwing or invalid callback getter rolls that
reservation back with `invalid-target` unavailable evidence. Reentrant
coordinator disposal instead reports `disposed` and leaves no reserved
membership or captured callback behind.

Each installed subscription has a service-owned incarnation identity captured
by its callback. The identity is revoked before external unsubscribe or
cleanup, and every callback checks it before entering the serialized epoch
gate. Cleanup from a retired incarnation is keyed to that identity and cannot
remove, mutate, or notify a reentrantly installed replacement.

The callback closes over a revocable cell rather than the service, scope state,
or sessions. Retirement clears the cell before external cleanup, so a provider
that retains an old callback retains only an inert bounded object. Synchronous
callbacks are decoded into frozen epochs while `subscribe` is running; raw
payloads and premature audience snapshots are not buffered. After the returned
cleanup closure is validated, the buffered epochs are staged together in FIFO
order. Each accepted baseline or advance snapshots active membership and
installs the epoch as one serialized step with no external call between those
operations. A member joined during one event's dispatch therefore
participates in a later pending event, but not the event already committed.
A thrown subscription or malformed returned cleanup value discards that buffer
and disables automatic invalidation for the live scope; explicit search
remains available.
The returned cleanup closure is itself untrusted: the service captures only a
function and calls it with `this === undefined` at most once. Its exact
synchronous contract returns `undefined`; TypeScript therefore rejects async
cleanup functions rather than silently accepting them through `void`
assignability. A throw or any other return value quarantines the coordinator
after the subscription is inert. Accidental ordinary Promise or thenable
returns receive best-effort detached rejection draining, but a same-realm
callback can always create a poisoned or independent unhandled rejection that
no JavaScript library can retroactively contain. Legitimate asynchronous
teardown must consume or report its own failure before the cleanup closure
returns `undefined`. The valid `undefined` path returns without Promise
allocation or a microtask. A closure avoids a structural TypeScript
contract that would accept class instances or inherited methods which the
hostile runtime boundary could not safely validate. Dropping the last owner
removes the complete scope incarnation before cleanup. A later join creates a
new unobserved incarnation and may attempt a fresh subscription.

Malformed, duplicate, stale, or token-conflicting invalidations do not mutate
state and do not tear down an otherwise valid subscription. Every raw callback
still consumes the callback reset-window allowance. Exceeding that allowance
revokes the incarnation and disables automatic invalidation before decoding
further payloads. The conservative window resets from a zero-delay timer
scheduled by the first callback. It intentionally makes no claim about formal
JavaScript task or turn boundaries, while still preventing a provider from
evading the allowance with a microtask chain. If hostile payload inspection
synchronously reenters the same callback, the nested callback consumes that
allowance but is ignored fail-closed; the coordinator does not retain the raw
payload or invert callback order.

An epoch capture authenticates the exact provider configuration, scope
incarnation, membership, observed epoch, and notification sequence. An
equal-current response is publishable only if no accepted invalidation or
higher response changed that sequence after capture. Otherwise it is
superseded even when its epoch equals the newly current epoch. A capture is a
single-use work token: submission claims it before queue admission, and replay
is discarded even when the first submission was overloaded.

Epoch commands use one bounded, non-recursive FIFO drain. Its hard admission
limit counts all work accepted during that drain, including commands already
processed, so a one-at-a-time reentrant chain cannot evade the bound. For every
accepted change, active membership is snapshotted and the epoch is immediately
installed before revision preparation or any external listener runs. All
affected session revisions then change before dispatch. Reentrant commands run
only after the current change has reached every still-active member, preserving
event order. The core does not coalesce revision events. The CodeMirror adapter
may coalesce the resulting UI refresh, as described below. Admission fails
before epoch mutation:
an overflowing provider callback revokes automatic invalidation for that
incarnation, while an overflowing response observation settles with closed
overload evidence.
Invalid, retired, replayed, disposed, and overflowing response submissions
return closed settlement evidence without invoking a callback. Only an admitted
FIFO command invokes its completion callback, so rejection cannot recursively
reenter the coordinator's drain.

A revision target prepares its state change and returns a listener-dispatch
closure. Returning `null`, returning a non-function, or throwing retires that
membership. Retirement detaches state immediately, but hostile provider cleanup
is deferred until every remaining target has prepared. A higher response epoch
installed before preparation remains observed; if its submitting membership is
retired during preparation, its response settles as retired while other
successfully prepared members still dispatch. Coordinator disposal takes
precedence over that retired evidence. The outermost cleanup barrier admits and
invokes at most 1,024 captured cleanups. If reentrant work attempts to admit a
1,025th cleanup, the coordinator quarantines itself immediately: all cells and
memberships become inert and all not-yet-invoked cleanup references are
cleared without calling more provider code. Cleanup is never continued from a
timer.

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
- same-key supersession atomically attaches the new request consumer, or
  retags the existing observer as that consumer, before removing old request
  ownership; different-key supersession revokes the old observer first;
- text, context, embedded-region, relevant catalog, or provider-configuration
  changes supersede captured work;
- caller cancellation and session/service disposal settle promptly;
- late provider resolution or rejection is drained without publication or an
  unhandled rejection; and
- the adapter checks revision currency immediately before returning or
  applying a result.

Shared in-flight catalog work has one atomic owner set containing request
consumers and refresh observers. Request cancellation detaches that consumer
independently. The service aborts the provider only after one combined mutation
observes no owners of either kind. A same-key latest-wins request attaches or
transfers its owner before the old owner detaches, then evaluates abort once,
so a soft-expiry observer cannot lose and restart identical work. Ownership is
removed before any abort or external callback. All cancellation, supersession,
disposal, deadline, and completion races pass one settle-once transition and
leave no timer or listener behind.

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

Each shared work item owns one immutable absolute queue deadline from its first
enqueue and, once invoked, one immutable absolute execution deadline. Defaults
are 100 ms and 250 ms. Configuration is checked at construction and restricted
to 10–2,000 ms for queue wait and 10–5,000 ms for execution. Joiners inherit
the remaining work budget and never extend either deadline. Hard queue expiry
atomically removes the work without invoking the provider and settles every
attached request consumer. Hard execution expiry atomically removes the work,
settles every attached consumer, removes its refresh observers, aborts once,
and drains a late resolve or reject. Earlier caller cancellation detaches only
that consumer.

At a recognized site, queue overload or hard expiry still settles each attached
completion request with its composed local/CTE result, `isIncomplete: true`,
and a closed `catalog-overloaded`, `catalog-queue-timeout`, or
`catalog-timeout` reason. Catalog lifecycle failure never converts proven
query-site evidence into unavailable analysis.

Hard safety deadlines do not define interactive latency. Each completion
request has a checked catalog response budget, default 40 ms and configurable
from 0 through 50 ms, measured from the start of the complete request. Local
and CTE evidence is composed first and never waits past the remaining response
budget. On soft expiry the request settles ready, possibly empty, with
`isIncomplete: true`, `catalog-loading`, and bounded remaining
completion-intent lease metadata; its session may atomically retag the request
consumer as a service-owned refresh observer. The intent lease is no longer
than the remaining work lease.
That bounded refresh lease can retain the shared operation only until its
existing hard deadline and active/queued service limits. With no consumers or
live observers, the service removes and aborts the work. An observer is bound
to the captured session revision and exact work key; any session change,
supersession, or disposal removes it.

If leased work resolves ready compatibly with the captured state—either
`UNOBSERVED` to its first baseline epoch or at the already-observed equal
epoch—the service decodes and caches it, re-keys first-baseline work, removes
the observers, and advances each still-current observing session once with the
closed reason `catalog-availability`. A higher epoch follows the epoch-change
path and clears the same observers without a second availability notification.
The adapter coalesces the resulting notification into a new completion request.
This is service-owned evidence readiness, not a duplicate provider
invalidation. Hard queue or execution expiry removes observers without a
refresh notification and leaves the already-returned incomplete result valid.
No optional catalog promise can keep `complete()` pending indefinitely or
block the local baseline past its product response budget.

The first implementation increment of this section is intentionally
package-private. It combines an authenticated provider with the epoch
coordinator and owns the fixed 8-active/64-queued scheduler, exact-key
in-flight sharing, one latest-wins consumer per owner, independent
cancellation, absolute queue and execution deadlines, response decoding, and
epoch publication. An owner captures its scope and dialect when prepared, so
individual requests cannot substitute provider, scope, dialect, or epoch
authority. The authenticated dialect runtime owns its canonical provider ID;
callers cannot pair an unrelated ID and runtime. Establishing the first
baseline re-keys other joinable unobserved work in that scope, allowing
newly-observed consumers to join it without duplicating a provider call.

Cache entries, loading/retry policy, refresh observers and their leases, the
40 ms completion-response budget, pagination composition, ranking, session
composition, and CodeMirror integration do not belong to that increment. They
remain explicit follow-up increments; the coordinator must not expose a
premature public surface that makes those deferred semantics difficult to add
or test.

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

Decoded entity IDs are unique for `(provider configuration, scope, epoch)`
across every page composed into one result. A repeated ID, even with otherwise
identical data, makes the page chain malformed before ranking or caching; array
and page order therefore cannot resolve conflicting identity records.

### Initial resource budgets

The initial checked limits are:

| Resource | Limit |
| --- | ---: |
| Active statement scanned | 65,536 UTF-16 units |
| Lexical tokens | 16,384 |
| Parenthesis/query depth | 128 |
| CTE frames | 256 |
| CTE declarations | 256 |
| Identifier path segments | 32 global ceiling; dialect runtime sets the checked limit |
| Identifier segment | 256 UTF-16 units |
| Catalog scope | 512 UTF-16 units |
| Search paths | 32 |
| Components per search path | 4 |
| Total catalog context | 16,384 UTF-16 units |
| Configured relation catalog providers | 1 |
| Live catalog scopes per service | 128 |
| Catalog memberships per service | 1,024 |
| Catalog memberships per scope | 256 |
| Raw subscription callbacks per reset window | 256 |
| Catalog epoch admissions per drain | 1,024 |
| Provider cleanups per outer barrier | 1,024 |
| Catalog results per search | 100 |
| Completion results after composition | 100 |
| Provider ID | 256 UTF-16 units |
| Entity ID | 256 UTF-16 units |
| Epoch token | 256 UTF-16 units |
| Plain-text detail | 1,024 UTF-16 units |
| Continuation token | 2,048 UTF-16 units |
| Decoded response aggregate | 65,536 UTF-16 units |
| Decoded response own keys | 16,384 aggregate traversal occurrences |
| Decoded response nesting depth | 8 |
| Service catalog cache | 256 entries and 2 MiB estimated retained bytes |
| Service-wide active catalog searches | 8 |
| Service-wide queued catalog searches | 64 |
| Active completion consumers | 1 per session |
| Catalog response budget | 40 ms default, 50 ms maximum |
| Catalog refresh observers | 1 per session |
| Completion-intent lease | 1,000 ms default, 5,000 ms maximum |

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

For every recognized incomplete `catalog-loading` result, including an empty
list that opens no menu, the adapter retains at most one bounded completion
intent. The one-shot intent records the exact view, document, selection,
context, query, captured epoch, and work identity when work exists. It expires
no later than the service-supplied completion-intent lease. On
`catalog-availability` or a service higher-epoch catalog revision notification
caused by either an accepted response or invalidation, the adapter aborts stale
captured work and coalesces exactly one scheduled refresh when the matching
view state has any of:

- an active completion invocation that has not yet installed a result;
- an active menu representing the captured loading request; or
- a valid no-menu loading intent.

If notification arrives while the invocation is active, the adapter records a
one-shot pending-refresh latch before aborting or allowing the stale invocation
to settle. It clears the latch before the scheduled replacement starts. A
later loading settlement or intent installation observes the latch and cannot
schedule a duplicate refresh.

A newer completion, selection/document/context change, explicit completion
cancel or Escape, configured blur policy, lease expiry, or view/session
disposal clears the active invocation, latch, and intent. Consuming either
one-shot refresh marker clears it before dispatch, preventing reopen loops. The
adapter never synchronously dispatches from a CodeMirror update or provider
callback.

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

Browser cases include empty soft result to first-baseline and same-epoch ready
with exactly one no-typing refresh; cursor movement, Escape, blur policy, hard
expiry, or destruction before readiness with no reopen; a nonempty CTE plus
loading catalog whose open menu refreshes once; and bounded 50-view fan-out.
The coordinator suite also covers soft-expiry observer to same-key consumer
handoff without abort/restart.

They also cover immediate empty terminal loading followed by a higher ready
epoch before intent expiry with exactly one no-typing refresh, and the same
event after intent expiry, Escape, movement, blur, or destruction with no
reopen. Coordinator/adapter ordering cases include a higher-epoch response
before soft expiry and a revision notification delivered before loading-intent
installation; each preserves the original invocation with exactly one
replacement request.

## Parser semantics remain separate

Worker protocol v1 remains unchanged.

When additional or general parser-derived scope semantics are required for
completion, hover, navigation, or diagnostics, the worker protocol will move
atomically to v2. A parsed
response will keep normalized syntax and semantic availability independent.
The semantic payload will be a bounded scoped IR covering query blocks,
bindings, visibility, and limitations. It will not contain raw ASTs, raw source,
absolute document ranges, flat `tableList` data, or generic fact bags.

The host and worker will not negotiate or simultaneously support v1 and v2.
Mixed cached assets fail the exact version check and retire the generation.

## Implementation sequence

1. Accept this ADR as the provisional contract and add a checked-in,
   runtime-free marimo-shaped type fixture. Its core portion compiles region,
   search-path, catalog, notification, and completion sketches without DOM
   imports; its adapter portion compiles the rich-info resolver signature. No
   production slice starts until both pass.
2. Attach embedded regions to session open/update transactions atomically.
3. Add the bounded partial-`SELECT` query-site recognizer.
4. Add the bounded CTE frame and visibility recognizer.
5. Add the service-owned scoped epoch/subscription coordinator and its hostile
   lifecycle contract suite. It does not invoke provider search or retain
   result pages.
6. Add catalog search scheduling, cache, in-flight sharing, cancellation,
   retry gates, and availability observers over the proven epoch coordinator.
7. Add the session completion method and deterministic composition.
8. Add the separate CodeMirror adapter and packed/browser fixtures.
9. Add the pinned packed/browser/runtime marimo fixture and 1/10/50-editor
   performance and leak evidence.
10. Validate both the in-memory/notebook and hierarchical remote provider
   shapes, then stabilize the declarations and public export surface.
11. Design scoped parser semantics and protocol v2 against PostgreSQL and
   BigQuery corpora before any additional parser-derived scope feature
   consumes it.

Breaking refinement remains allowed through step 9. The provider and
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
