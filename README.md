# codemirror-sql

SQL language service for document sessions, dialects, and schema-aware analysis.
Built by and used in [marimo](https://github.com/marimo-team/marimo).

Published as [`@marimo-team/codemirror-sql`](https://www.npmjs.com/package/@marimo-team/codemirror-sql).

## Features

- **Document sessions** — open SQL documents, apply atomic text and context updates, and track opaque revisions
- **Built-in dialects** — PostgreSQL, DuckDB, BigQuery, and Dremio
- **Embedded regions** — mask non-SQL spans (for example notebook interpolations) in document coordinates
- **Isolated parsing** — optional browser-worker parser execution kept off the public API surface

Editor integrations (completion, diagnostics, hover, navigation) build on this
session API and will ship as focused vertical slices.

## Installation

```bash
npm install @marimo-team/codemirror-sql
# or
pnpm add @marimo-team/codemirror-sql
```

## Usage

```ts
import {
  createSqlLanguageService,
  duckdbDialect,
  type SqlDocumentContext,
} from "@marimo-team/codemirror-sql";

interface AppSqlContext extends SqlDocumentContext {
  readonly engine: string;
}

const dialect = duckdbDialect();
const service = createSqlLanguageService<AppSqlContext>({
  dialects: [dialect],
});

const session = service.openDocument({
  text: "SELECT * FROM users",
  context: { dialect: dialect.id, engine: "local" },
});

const revision = session.update({
  baseRevision: session.revision,
  document: {
    kind: "changes",
    changes: [{ from: 14, to: 19, insert: "customers" }],
  },
  embeddedRegions: [],
});

if (session.isCurrent(revision)) {
  // Results produced for this revision may still be applied.
}

session.dispose();
service.dispose();
```

Use `{ kind: "replace", text }` for full replacement and
`{ baseRevision, context }` for a context-only update. Document mutations also
supply the complete embedded-region set for the resulting text.

See [session primitives](./docs/session-primitives.md) for the full contract.

## Demo

```bash
pnpm install
pnpm dev
```

The demo wires a CodeMirror editor to `SqlDocumentSession.update()` so edits,
replacements, and dialect switches exercise the public session API.

## Development

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Typecheck
pnpm run typecheck

# Run demo
pnpm dev
```

## License

Apache 2.0
