# codemirror-sql

A CodeMirror extension for SQL linting and visual gutter indicators. Built by and used in [marimo](https://github.com/marimo-team/marimo).

## Features

- ⚡ **Real-time validation** - SQL syntax checking as you type with detailed error messages
- 🎨 **Visual gutter** - Color-coded statement indicators and error highlighting
- 💡 **Hover tooltips** - Schema info, keywords, and column details on hover
- 🔮 **CTE autocomplete** - Auto-complete support for CTEs
- 🎯 **Query-aware resolution** - Context-sensitive schema and column suggestions
- 🔍 **Additional dialects** - DuckDB, BigQuery
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
import { sql, StandardSQL } from '@codemirror/lang-sql';
import { basicSetup, EditorView } from 'codemirror';
import { sqlExtension, cteCompletionSource } from '@marimo-team/codemirror-sql';

const schema = {
  users: ["id", "name", "email", "active"],
  posts: ["id", "title", "content", "user_id"]
};

const editor = new EditorView({
  doc: "SELECT * FROM users WHERE active = true",
  extensions: [
    basicSetup,
    sql({
      dialect: StandardSQL,
      schema: schema,
      upperCaseKeywords: true
    }),
    StandardSQL.language.data.of({
      autocomplete: cteCompletionSource,
    }),
    sqlExtension({
      linterConfig: {
        delay: 250 // Validation delay in ms
      },
      gutterConfig: {
        backgroundColor: "#3b82f6", // Current statement color
        errorBackgroundColor: "#ef4444", // Error highlight color
        hideWhenNotFocused: true
      },
      enableHover: true,
      hoverConfig: {
        schema: schema,
        hoverTime: 300,
        enableKeywords: true,
        enableTables: true,
        enableColumns: true
      }
    })
  ],
  parent: document.querySelector('#editor')
});
```

## Additional Dialects

This extension adds support for additional dialects:

- **DuckDB**
- **BigQuery**

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
