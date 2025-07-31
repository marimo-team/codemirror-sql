# codemirror-sql

A CodeMirror extension for SQL linting and visual gutter indicators.

## Features

### SQL Linting

- **Syntax Validation**: Real-time syntax validation with detailed error messages
- **Statement Recognition**: Supports SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, USE, and other SQL statements

## Installation

```bash
npm install @marimo-team/codemirror-sql
# or
pnpm add @marimo-team/codemirror-sql
```

## Usage

### Basic SQL Extension

```ts
import { sqlExtension } from '@marimo-team/codemirror-sql';
import { EditorView } from '@codemirror/view';

const view = new EditorView({
  extensions: [
    sqlExtension({
      delay: 250, // Delay before running validation
      enableStructureAnalysis: true, // Enable gutter markers for SQL expressions
      enableGutterMarkers: true, // Show vertical bars in gutter
      backgroundColor: "#3b82f6", // Blue for current statement
      errorBackgroundColor: "#ef4444", // Red for invalid statements
      hideWhenNotFocused: true, // Hide gutter when editor loses focus
    }),
  ],
  parent: document.querySelector('#editor')
});
```

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
