# codemirror-sql

SQL language service for document sessions, dialects, and schema-aware analysis.
Built by and used in [marimo](https://github.com/marimo-team/marimo).

Published as [`@marimo-team/codemirror-sql`](https://www.npmjs.com/package/@marimo-team/codemirror-sql).

## Features

- **Document sessions** — open SQL documents, apply atomic text and context updates, and track opaque revisions
- **Built-in dialects** — PostgreSQL, DuckDB, BigQuery, and Dremio
- **Embedded regions** — mask non-SQL spans (for example notebook interpolations) in document coordinates
- **Schema-aware completion** — complete relations, namespaces, physical columns, aliases, correlated scopes, and visible CTEs
- **CodeMirror integration** — cancellation-safe completion, disposable detail panels, atomic context updates, and an optional virtualized statement gutter
- **Composable completion** — package results coexist with SQL keywords, functions, embedded-language sources, and host sources
- **Isolated parsing** — optional browser-worker parser execution kept off the public API surface

## Installation

```bash
npm install @marimo-team/codemirror-sql
# or
pnpm add @marimo-team/codemirror-sql
```

## CodeMirror usage

```ts
import { sql, StandardSQL } from "@codemirror/lang-sql";
import { EditorView } from "@codemirror/view";
import {
  createSqlLanguageService,
  duckdbDialect,
} from "@marimo-team/codemirror-sql";
import { sqlEditor } from "@marimo-team/codemirror-sql/codemirror";

const service = createSqlLanguageService({
  dialects: [duckdbDialect()],
});
const support = sqlEditor({
  initialContext: { dialect: "duckdb" },
  service,
  statementGutter: { showInactive: true },
});
const view = new EditorView({
  doc: "SELECT * FROM users",
  extensions: [
    sql({ dialect: StandardSQL }),
    support.extension,
  ],
});

view.destroy();
service.dispose();
```

Configure relation, column, and namespace providers on the shared service for
schema-aware completion. See the [CodeMirror adapter](./docs/codemirror-adapter.md)
and [session primitives](./docs/session-primitives.md) for the full contracts.

## Demo

```bash
pnpm install
pnpm dev
```

The playground exercises relation, namespace, physical-column, CTE, correlated
scope, and `LATERAL` completion against an in-memory catalog. It also exposes
provider latency and catalog invalidation controls.

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
