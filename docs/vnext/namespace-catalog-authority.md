# vNext Namespace Catalog Authority

Status: public provider and session integration

Namespace completion searches catalog, schema, project, and dataset containers.
One query site produces one bounded provider request containing its qualifier,
prefix, search paths, result limit, dialect, scope, and expected catalog epoch.
The API does not recursively walk a provider tree or issue one request per
container.

Each result has a stable container entity ID, a canonical role-tagged identifier
path, provider-rendered insertion text, match quality, and immutable provenance.
The hostile boundary rejects accessors, sparse arrays, extra properties,
oversized data, invalid epochs, and conflicting duplicate identities. Identical
duplicate identities are collapsed and results receive deterministic code-unit
ordering.

The composer applies the dialect's prefix matcher, deduplicates by authority
identity, and produces deterministic completion edits. Unknown or throwing
prefix comparison is reported as incomplete instead of guessing.

## Epoch, cache, and lifecycle

A cold request uses `expectedEpoch: null`; the returned epoch becomes the
owner's observed epoch. Complete ready searches are held in a bounded LRU keyed
by provider instance, scope, dialect, epoch, query site, search paths, and limit.
Partial, loading, and failed responses remain visible but are never cached.

A newer request supersedes and aborts prior work for the same owner. Explicit
cancellation and owner/coordinator disposal abort pending work. Provider throws,
rejections, malformed data, and late settlements are contained.

Session integration prepares one owner for each live scope/dialect and
disposes it when catalog authority changes. Query-site integration calls
`prepareSqlNamespaceCatalogSearch`, submits the result through the owner, and
passes the outcome plus the site's replacement range and dialect prefix matcher
to `composeSqlNamespaceCompletion`. Namespace items are merged with local and
relation-catalog items under the same bounded completion response budget.
