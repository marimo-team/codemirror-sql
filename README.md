# codemirror-sql

SQL linting, completion, and navigation for CodeMirror 6. Built by and used in
[marimo](https://github.com/marimo-team/marimo). [Try the demo](https://marimo-team.github.io/codemirror-sql/).

- Per-statement syntax errors, schema warnings, and gutter indicators
- Schema and keyword hover tooltips with custom renderers
- Completion for CTEs, table aliases, and columns from referenced tables
- Reference highlighting, go-to-definition, and rename
- Additional dialects for DuckDB, BigQuery, and Dremio

## Installation

```bash
npm install @marimo-team/codemirror-sql @codemirror/lang-sql codemirror
```

## Quickstart

```ts
import { MySQL, sql } from "@codemirror/lang-sql";
import { basicSetup, EditorView } from "codemirror";
import { createSqlAnalysis, sqlCompletion, sqlExtension } from "@marimo-team/codemirror-sql";

const dialect = MySQL;
const schema = { users: ["id", "name", "email"] };
const analysis = createSqlAnalysis();

new EditorView({
  doc: "SELECT u.name FROM users u",
  extensions: [
    basicSetup,
    sql({ dialect, schema }),
    sqlCompletion({ ...analysis, dialect, schema }),
    sqlExtension({ ...analysis, schema }),
  ],
  parent: document.body,
});
```

`sqlExtension` provides linting, hover, gutter indicators, and navigation.
`sqlCompletion` registers the completion sources. Sharing `analysis` avoids
duplicate parsing across both bundles.

## Configuration

Providing a `schema` enables warnings for unknown tables, unknown columns, and
ambiguous columns. Set each check's severity to `"error"`, `"warning"`, or `"off"`:

```ts
sqlExtension({
  schema,
  semanticLinterConfig: { severity: { unknownTable: "error" } },
  navigationConfig: { keymap: true },
});
```

Reference highlighting and Cmd/Ctrl-click go-to-definition are enabled by default.
`navigationConfig.keymap` adds `F12`/`Mod-b` for go-to-definition and `F2` for rename.
Set `navigationConfig.prompt` to supply your own rename UI. Navigation skips
ambiguous or shadowed bindings.

For all options, see [`SqlExtensionConfig`](src/sql/extension.ts) and
[`SqlCompletionConfig`](src/sql/completion-extension.ts).

### Custom parser

To use DuckDB, replace the quickstart's `dialect` and `analysis` declarations with:

```ts
import { NodeSqlParser } from "@marimo-team/codemirror-sql";
import { DuckDBDialect } from "@marimo-team/codemirror-sql/dialects";

const dialect = DuckDBDialect;
const analysis = createSqlAnalysis({
  parser: new NodeSqlParser({
    getParserOptions: () => ({ database: "DuckDB" }),
  }),
});
```

Keep the completion dialect and parser database aligned. If parser options change
without an edit, set `needsRefresh` on `sqlExtension` to detect that change.
See [`SqlParser`](src/sql/types.ts) to implement a custom parser.

## Development

```bash
pnpm install
pnpm test
pnpm run typecheck
pnpm dev
```

## License

Apache 2.0
