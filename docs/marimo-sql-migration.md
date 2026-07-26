# Marimo SQL Completion Migration

Status: implementation fixture; relation, column, and namespace completion

The compile-only fixture
[`marimo-sql-migration.test-d.ts`](../test/types/marimo-sql-migration.test-d.ts)
models the intended marimo integration exclusively through public standard
exports. It is not application code and has no runtime dependency on marimo.

## Ownership and provider seam

Marimo creates one caller-owned `SqlLanguageService` for an editor fleet.
Every `sqlEditor` support/view opens its own session against that service.
Destroying a view never disposes the service; the application disposes the
service after its views have been retired.

One relation provider projects `dataConnectionsMapAtom` and
`datasetTablesAtom` into canonical relation records. It must preserve today's
collision rule:
connection relations win over same-named local relations. Provider records
contain plain immutable data and stable entity IDs, never Jotai atoms, React
roots, or backend objects.

Catalog `scope` identifies a live connection incarnation:

```text
<engine-name>:<connection-incarnation>
```

Replacing or reconnecting a same-named connection creates a new incarnation
and scope. Schema/table mutations within an incarnation advance its provider
epoch and notify the one scoped subscription. The context `searchPath` values
reproduce
`default_database`, `default_schema`, nested-schema, and schemaless behavior.

## Batched DataTable columns

The same shared service configures one `SqlColumnCatalogProvider`. Each
`loadColumns` call forwards the complete relation request array to one
DataTable metadata batch operation. It does not fetch once per relation.
The column authority resolves each canonical relation path within the same
scope and search paths as relation completion. Column IDs and returned relation
IDs are stable within that connection incarnation.

The library sends at most 64 matching physical relations in one request.
Larger visible sets are deterministically truncated and reported as partial;
the provider must not interpret one batch as exhaustive when completion carries
`query-binding-partial`.

Each column supplies a canonical identifier and provider-rendered
`insertText`; these are intentionally separate so quoted or dialect-sensitive
names insert correctly. The provider also supplies ordinal, data type, and
detail when known. A cold request carries `expectedEpoch: null`. The returned
epoch becomes the authority for later work, while connection replacement gets
a new scope.

Every requested relation independently reports complete or partial ready
columns, loading, or normalized failure. Partial, loading, and failed results
remain retryable according to the library contract and are not disguised as
complete empty schemas. The public boundary validates the provider's unknown
payload before it reaches completion composition.

## One atomic editor input

Marimo should have one transaction builder for SQL interpretation changes. A
document or engine change emits all of these in the same CodeMirror
transaction:

1. marimo language metadata;
2. `support.contextEffect` with engine, registered standard dialect, connection
   scope, and search paths;
3. the CodeMirror SQL dialect compartment reconfiguration; and
4. `support.embeddedRegionsEffect` containing the complete region set in the
   resulting document.

No update listener should dispatch a follow-up context or dialect transaction.
That creates an observable grammar/catalog mismatch and makes rapid
connection switches race.

## Templates and external sources

`sqlEditor` owns the single `autocompletion()` configuration. Marimo passes its
Python variable sources through `autocomplete.externalSources`. SQL keyword
and function sources registered by the active CodeMirror SQL language compose
automatically with the library source.
The region scanner recognizes single `{python}` expressions, ignores escaped
`{{`, includes both delimiters in each region, and supplies a complete sorted
set after every document change. SQL completion is unavailable inside those
regions while the external variable source remains active.

Embedded regions are non-empty half-open ranges, so an unmatched `{` ending at
the document boundary cannot contain the insertion point at `doc.length`.
Marimo closes that boundary with
`autocomplete.isCompletionPositionAllowed`. Its synchronous scanner returns
false while the insertion point is in an unmatched Python expression. The
adapter then skips the SQL session source, while still running the installed
variable and keyword sources. A false result or thrown gate is fail-closed,
and a gate transition to false cancels owned SQL completion work and disposes
owned rich-info resources.

The gate receives only the immutable CodeMirror `EditorState` and numeric
position. It must remain synchronous and side-effect free. Do not encode a
range beyond the document or an empty embedded region.

The rich-info resolver uses relation `catalog` provenance or
`column-catalog` scope, relation ID, and column ID to look up current marimo
metadata. It mounts React into a new element and returns
`{ dom, destroy: root.unmount }`. The adapter owns cancellation and disposal.

## Dialect cutover

The first cutover is limited to the registered standard dialects:

- DuckDB
- PostgreSQL
- BigQuery
- Dremio

MySQL, MariaDB, SQLite, MSSQL, Oracle, and standard/fallback engines continue
to use the legacy schema completion source. The router must select exactly one
table/schema source; installing legacy schema completion as an external source
for a standard-enabled dialect would create duplicate and conflicting relation
edits.

Full removal of the legacy source requires equivalent dialect handles or an
explicit, tested generic-dialect policy.

## Remaining library gaps

Marimo's current `tablesCompletionSource()` is broader than its name. The
CodeMirror SQL schema source provides relations, namespace navigation, and
columns. standard now provides all three through separate bounded providers,
including qualified and unqualified query-site completion, ambiguity handling,
stable provenance, cancellation, and batched column work.

The remaining feature gaps are:

- the dialect coverage described above; and
- output-column inference for CTEs and derived relations. standard completes CTE
  relation names but deliberately does not send a visible CTE name to the
  physical column provider. Keep the legacy column source for those sites, or
  defer full source replacement, until projection/output-column inference
  lands.

The fixture feeds marimo's immutable namespace projection—stable entity ID,
scope, canonical identifier path, and namespace kind—through one public,
scoped namespace provider on the shared service.

## Migration sequence

1. Capture golden legacy results for labels, kinds, edit ranges, qualification,
   and details across representative connection shapes.
2. Land the shared relation and batched column providers, incarnation scope,
   atomic transaction builder, region scanner, insertion-point completion
   gate, and completion router behind a feature flag.
3. Run standard relation completion in shadow mode while the legacy source remains
   visible.
4. Compare relation and column results with the golden corpus, including
   quoted insert text, aliases, ambiguity, partial/loading/failure states, and
   cold epoch behavior.
5. Cut over supported physical-relation sites while preserving variable,
   keyword, and legacy CTE/derived-output column sources.
6. Add dialect coverage, expand the router, and remove completion-only legacy
   schema code. Keep legacy schema data while hover or diagnostics still use
   it.

## Acceptance tests

The compile-only marimo fixture proves:

- one shared service configured with one relation provider, one batched
  column provider, and one namespace provider;
- a two-relation cold column request with `expectedEpoch: null`;
- stable relation and column IDs, canonical identifiers, and distinct
  provider-rendered insert text;
- partial, loading, and failure provider states;
- relation and column provenance lookup by current scope with a React
  disposer;
- atomic editor interpretation updates, complete template regions, and the
  unmatched-expression insertion-point gate;
- preservation of variable and keyword sources; and
- supported-dialect standard routing with exclusive legacy fallback.

Library tests cover relation and physical-column completion for `FROM`, `JOIN`,
`alias.`, unqualified projections and predicates, `USING`, correlated nested
queries, quoted identifiers, ambiguous columns, provider
loading/invalidations, bounded batching, and template barriers. CTE tests prove
declaration-order relation visibility and that CTE names are not incorrectly
resolved through the physical column provider; they do not prove CTE
output-column inference.

Marimo integration tests cover:

- default, nested, and schemaless database/schema layouts;
- local-table collisions where the connection relation wins;
- atomic engine/dialect/scope changes and rapid A-B-A switching;
- reconnecting under the same display name without stale cache reuse;
- open-menu schema invalidation;
- closed, escaped, and unmatched Python expressions;
- completion edits mapping regions in the same transaction;
- variable and keyword source preservation;
- React table/column info unmount on navigation, edit, and view destruction;
- one shared service across 1, 10, and 50 views; and
- exclusive legacy routing for unsupported dialects.
