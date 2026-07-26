# codemirror-sql

SQL language service for document sessions, dialects, and schema-aware analysis.
Published to npm as `@marimo-team/codemirror-sql` and used by marimo.

## Development

```bash
pnpm install --ignore-scripts --frozen-lockfile  # CI install
pnpm test              # vitest
pnpm run test:browser  # vitest browser tests (Playwright)
pnpm run lint          # oxlint --fix (autofix.ci runs this on PRs)
pnpm exec oxlint       # non-mutating lint CI enforces
pnpm run typecheck     # tsc --noEmit
pnpm run demo          # vite build of demo/
pnpm run test:package  # pack + consumer smoke
pnpm run test:worker-placement  # browser worker placement budgets
```

- Browser tests need Playwright browsers installed first: `pnpm exec playwright install`.
- Release: `pnpm run release` (pnpm version) bumps + tags; pushing a `v*` tag triggers release.yml, which publishes to npm via OIDC.
