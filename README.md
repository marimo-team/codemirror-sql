# codemirror-sql

A CodeMirror extension for SQL linting and visual gutter indicators. Built by and used in [marimo](https://github.com/marimo-team/marimo).

## Features

- ⚡ **Real-time validation** - Per-statement SQL syntax checking as you type, with detailed error messages for every broken statement
- 🧠 **Schema-aware linting** - Warns about unknown tables, unknown columns, and ambiguous column references based on your schema
- 🎨 **Visual gutter** - Color-coded statement indicators and error highlighting
- 💡 **Hover tooltips** - Schema info, keywords, and column details on hover
- 🔮 **CTE autocomplete** - Auto-complete support for CTEs
- 🎯 **Query-aware resolution** - Context-sensitive schema and column suggestions
- 🔍 **Additional dialects** - DuckDB, BigQuery, Dremio
- 🛠️ **Custom renderers** - Customizable tooltip rendering for tables, columns, and keywords

## Installation

```bash
npm install @marimo-team/codemirror-sql
# or
pnpm add @marimo-team/codemirror-sql
```

## Usage

### Basic Setup

```ts
import { sql, StandardSQL } from "@codemirror/lang-sql";
import { basicSetup, EditorView } from "codemirror";
import { sqlExtension, cteCompletionSource } from "@marimo-team/codemirror-sql";

const schema = {
  users: ["id", "name", "email", "active"],
  posts: ["id", "title", "content", "user_id"],
};

const editor = new EditorView({
  doc: "SELECT * FROM users WHERE active = true",
  extensions: [
    basicSetup,
    sql({
      dialect: StandardSQL,
      schema: schema,
      upperCaseKeywords: true,
    }),
    StandardSQL.language.data.of({
      autocomplete: cteCompletionSource,
    }),
    sqlExtension({
      // Shared by hover tooltips and semantic linting
      schema: schema,
      linterConfig: {
        delay: 250, // Validation delay in ms
      },
      gutterConfig: {
        backgroundColor: "#3b82f6", // Current statement color
        errorBackgroundColor: "#ef4444", // Error highlight color
        hideWhenNotFocused: true,
      },
      enableHover: true,
      hoverConfig: {
        hoverTime: 300,
        enableKeywords: true,
        enableTables: true,
        enableColumns: true,
      },
    }),
  ],
  parent: document.querySelector("#editor"),
});
```

### Schema-aware semantic linting

When a schema is provided (via the top-level `schema` option, the
`sqlSchemaFacet`, or `semanticLinterConfig.schema`), queries are validated
against it: unknown tables, unknown columns, and ambiguous column references
are reported as warnings (configurable per check). Without a schema the
semantic linter is inert.

```ts
import { sqlSemanticLinter } from "@marimo-team/codemirror-sql";

sqlSemanticLinter({
  schema: { users: ["id", "name"], posts: ["id", "user_id"] },
  severity: {
    unknownTable: "error", // "error" | "warning" | "off" (default: "warning")
    unknownColumn: "warning",
    ambiguousColumn: "warning",
  },
});
```

Checks only run on statements that parse cleanly, and skip anything that
can't be confidently resolved (CTE outputs, subquery results, aliases from
outer scopes), preferring under-reporting over false positives. Semantic
diagnostics carry `source: "sql-schema"`; syntax diagnostics use
`source: "sql-parser"`. If the schema is provided as a function, it is called
on every lint pass and should be cheap/memoized.

## Additional Dialects

This extension adds support for additional dialects:

- **DuckDB**
- **BigQuery**
- **Dremio**

## Keyword Completion

The extension includes keyword documentation for common **SQL keywords** including used in hover and completion,
which can be found in the `src/data` directory.

## Demo

See the [demo](https://marimo-team.github.io/codemirror-sql/) for a full example.

## Development

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Run demo
pnpm dev
```

## License

Apache 2.0
