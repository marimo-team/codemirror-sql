# Marimo SQL Completion Migration

Status: implementation fixture; relation completion only

The compile-only fixture
[`marimo-sql-migration.test-d.ts`](../../test/vnext-types/marimo-sql-migration.test-d.ts)
models the intended marimo integration exclusively through public vNext
exports. It is not application code and has no runtime dependency on marimo.

## Ownership and provider seam

Marimo creates one caller-owned `SqlLanguageService` for an editor fleet.
Every `sqlEditor` support/view opens its own session against that service.
Destroying a view never disposes the service; the application disposes the
service after its views have been retired.

One provider projects `dataConnectionsMapAtom` and `datasetTablesAtom` into
canonical relation records. It must preserve today's collision rule:
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

## One atomic editor input

Marimo should have one transaction builder for SQL interpretation changes. A
document or engine change emits all of these in the same CodeMirror
transaction:

1. marimo language metadata;
2. `support.contextEffect` with engine, registered vNext dialect, connection
   scope, and search paths;
3. the CodeMirror SQL dialect compartment reconfiguration; and
4. `support.embeddedRegionsEffect` containing the complete region set in the
   resulting document.

No update listener should dispatch a follow-up context or dialect transaction.
That creates an observable grammar/catalog mismatch and makes rapid
connection switches race.

## Templates and external sources

`sqlEditor` owns the single `autocompletion()` configuration. Marimo passes its
Python variable and keyword sources through `autocomplete.externalSources`.
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

The rich-info resolver uses catalog provenance IDs to look up current marimo
metadata, mounts React into a new element, and returns
`{ dom, destroy: root.unmount }`. The adapter owns cancellation and disposal.

## Dialect cutover

The first cutover is limited to the registered vNext dialects:

- DuckDB
- PostgreSQL
- BigQuery
- Dremio

MySQL, MariaDB, SQLite, MSSQL, Oracle, and standard/fallback engines continue
to use the legacy schema completion source. The router must select exactly one
table/schema source; installing legacy schema completion as an external source
for a vNext-enabled dialect would create duplicate and conflicting relation
edits.

Full removal of the legacy source requires equivalent dialect handles or an
explicit, tested generic-dialect policy.

## Remaining library gaps

Marimo's current `tablesCompletionSource()` is broader than its name. The
CodeMirror SQL schema source provides relations, namespace navigation, and
columns. vNext currently provides relation items only.

No-regression replacement therefore still requires:

- lazy, bounded, cancellation-aware column lookup keyed by stable relation
  entity IDs;
- qualified and unqualified column completion with aliases, joins,
  ambiguity, quoting, and exact edits;
- column provenance for the disposable info resolver;
- namespace/container parity for database, schema, project, and dataset
  navigation; and
- the dialect coverage described above.

Column lookup should be batched for all visible relations at a completion site.
It must not attach every column to every relation-search response or issue one
provider request per relation.

## Migration sequence

1. Capture golden legacy results for labels, kinds, edit ranges, qualification,
   and details across representative connection shapes.
2. Land the shared provider, incarnation scope, atomic transaction builder,
   region scanner, insertion-point completion gate, and completion router
   behind a feature flag.
3. Run vNext relation completion in shadow mode while the legacy source remains
   visible.
4. Add column and namespace completion to the library and compare the golden
   corpus.
5. Cut over the four supported dialects as one source replacement, preserving
   variable and keyword external sources.
6. Add dialect coverage, expand the router, and remove completion-only legacy
   schema code. Keep legacy schema data while hover or diagnostics still use
   it.

## Acceptance tests

Library tests cover relation and column completion for `FROM`, `JOIN`,
`alias.`, unqualified projections and predicates, `USING`, nested queries,
CTEs, quoted identifiers, ambiguous columns, provider loading/invalidations,
bounded batching, and template barriers.

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
