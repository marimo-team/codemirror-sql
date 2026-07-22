# codemirror-sql

CodeMirror 6 extension for SQL: real-time linting, gutter indicators, hover tooltips, and schema-aware autocomplete (DuckDB, BigQuery, Dremio dialects). Published to npm as `@marimo-team/codemirror-sql` and used by marimo's editor.

## Development

```bash
pnpm install --ignore-scripts --frozen-lockfile  # CI install
pnpm test              # vitest
pnpm run test:browser  # vitest browser tests (Playwright)
pnpm run lint          # oxlint --fix (autofix.ci runs this on PRs)
pnpm exec oxlint       # non-mutating lint CI enforces
pnpm run typecheck     # tsc --noEmit
pnpm run demo          # vite build of demo/
```

- Browser tests need Playwright browsers installed first: `pnpm exec playwright install`.
- Release: `pnpm run release` (pnpm version) bumps + tags; pushing a `v*` tag triggers release.yml, which publishes to npm via OIDC.
