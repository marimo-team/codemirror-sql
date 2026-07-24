# Worker placement evidence fixture

This fixture is copied into an isolated temporary directory and consumes the
exact tarball created by `pnpm pack`. It is intentionally not a workspace
package. Its direct `node-sql-parser` dependency is intentional: the frozen
fixture dependencies are installed before the exact tarball is extracted, and
the harness verifies that its exact `5.4.0` version matches the packed
package's dependency.

The minified Vite 8 single-worker baseline is 67,214 gzip bytes for the
PostgreSQL transitive graph, 50,205 gzip bytes for the BigQuery transitive
graph, and 117,941 gzip/549,003 raw bytes for the complete worker build output.
The PostgreSQL and BigQuery figures each include their transitive shared
chunks; the report also identifies those shared chunks explicitly. The
fail-closed ceilings include small explicit headroom over that measured
packed-consumer baseline:

- PostgreSQL transitive graph: 68 KiB gzip
- BigQuery transitive graph: 50 KiB gzip
- Complete worker build output: 120 KiB gzip and 570 KiB raw

These are provisional placement limits, not product bundle promises. The
orchestration script fails closed when they are exceeded, when the dialects no
longer have separate lazy chunks, when their transitive reachability changes,
or when the page/core graphs import parser modules.
