# vNext Column Catalog Authority

Status: internal vertical-slice contract

Column discovery is lazy, provider-owned, and batched. A completion request
sends every unresolved relation reference in one provider invocation. Each
reference carries a caller-local `requestKey`, a decoded identifier path, and
no unauthenticated entity identity. The provider resolves paths against the
supplied catalog scope, search paths, and dialect.

The provider returns stable relation and column entity IDs. Every accepted
column contains:

- a canonical `SqlIdentifierComponent`;
- bounded provider-rendered `insertText`;
- a stable column entity ID and ordinal; and
- immutable provenance containing provider, scope, epoch, relation, and column
  identities.

Responses describe each requested relation independently as:

- `ready` with complete or partial column coverage;
- `loading`; or
- `failed` with a normalized code and retry policy.

Missing, extra, conflicting, oversized, accessor-backed, or malformed data is
rejected at the provider boundary. Relations and columns have deterministic
code-unit order. Duplicate request keys and conflicting stable IDs fail closed;
identical duplicate columns are deduplicated.

## Epoch and cache behavior

Cold requests use `expectedEpoch: null`. A response always supplies an epoch.
An owner remembers that observation, and later null-epoch requests reuse only
cache entries from the observed epoch. Explicit expected epochs never reuse
entries from another epoch. The cache is LRU-bounded by relation entries.
Only complete ready results are cached. Partial, loading, and failed results
remain visible to the caller but are eligible for another provider request.

Relation-catalog subscription events invalidate the session's relation, column,
and namespace observations together. Hosts without a subscribed relation
provider call `session.invalidateCatalog()` when schema authority changes. The
method advances the session revision, cancels retained completion work, rebuilds
all catalog owners, and emits one `catalog` change event.

## Lifecycle

One owner represents one document/session authority for a scope and dialect.
Starting a newer request supersedes and aborts that owner's prior request.
Explicit cancellation settles as cancelled. Owner or coordinator disposal
aborts outstanding work and settles it as unavailable/disposed. Provider
rejections, throws, and malformed responses are contained; late settlements
cannot publish or populate the cache.

The coordinator batches a request once, never once per relation. Cache hits and
misses are composed deterministically while only misses are sent to the
provider.

Provider-declared loading receives at most one automatic retry for the same
document, context, and completion position. A persistent loading response is
then returned without a refresh token; hosts resume it through catalog
invalidation instead of an unbounded polling loop.
