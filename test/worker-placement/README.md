# Worker placement evidence fixture

This fixture is copied into an isolated temporary directory and consumes the
exact tarball created by `pnpm pack`. It is intentionally not a workspace
package.

The initial minified Vite 8 baseline was 66,211 gzip bytes for PostgreSQL,
49,492 gzip bytes for BigQuery, and 123,798 gzip/567,271 raw bytes for the
complete worker application. The fail-closed ceilings include small explicit
headroom over that measured packed-consumer baseline:

- PostgreSQL named assets: 68 KiB gzip
- BigQuery named assets: 50 KiB gzip
- Complete worker application: 124 KiB gzip and 590 KiB raw

These are provisional placement limits, not product bundle promises. The
orchestration script fails closed when they are exceeded, when the dialects no
longer have separate named assets, or when the core-only graph imports parser
modules.
