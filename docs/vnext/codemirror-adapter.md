# vNext CodeMirror Adapter

Status: experimental

Import: `@marimo-team/codemirror-sql/vnext/codemirror`

`sqlEditor` connects one caller-owned vNext language service to one or more
CodeMirror 6 views. Each view owns a document session, cancellation state,
catalog-refresh intent, and revision subscription. Destroying a view disposes
that view's session but never disposes the shared service.

```ts
import { EditorView } from "@codemirror/view";
import {
  createSqlLanguageService,
  duckdbDialect,
} from "@marimo-team/codemirror-sql/vnext";
import {
  sqlEditor,
} from "@marimo-team/codemirror-sql/vnext/codemirror";

const service = createSqlLanguageService({
  dialects: [duckdbDialect()],
});
const support = sqlEditor({
  initialContext: {
    catalog: { scope: "connection-incarnation:1" },
    dialect: "duckdb",
  },
  service,
});
const view = new EditorView({
  doc: "SELECT * FROM ",
  extensions: [support.extension],
});

support.setContext(view, {
  catalog: { scope: "connection-incarnation:2" },
  dialect: "duckdb",
});

view.destroy();
service.dispose();
```

The adapter installs one coherent `autocompletion` configuration. Additional
sources belong in `autocomplete.externalSources`; consumers should not install
a second independently configured `autocompletion` extension.

## Atomic inputs

Context and document changes can share one CodeMirror transaction:

```ts
view.dispatch({
  changes,
  effects: support.contextEffect.of(nextContext),
});
```

CodeMirror's composite `ChangeSet` is converted to sorted, non-overlapping
pre-update UTF-16 changes and sent to the session exactly once.

Embedded-language ranges are explicit. Their effect payload is the complete
region set in the resulting document's coordinates:

```ts
view.dispatch({
  changes,
  effects: support.embeddedRegionsEffect.of(nextRegions),
});
```

When the current document contains embedded regions, every document-changing
transaction must include the complete resulting region set. The adapter fails
closed instead of guessing how host-language delimiters map through edits.
Region-only updates may use `setEmbeddedRegions`.

The adapter's own completion edit is the narrow exception: it maps unrelated
regions through the exact edit and includes the complete mapped set in the same
transaction. A completion edit that overlaps an embedded region is ignored.

## Completion currency

The adapter does not use `validFor` or result mapping in this first slice.
Every result and completion application rechecks the session revision,
document identity, selection, and context generation.

Loading completion results retain one bounded, token-correlated refresh intent,
including empty results that open no menu. Only a session event carrying the
exact task token can schedule a refresh. A newer request, document/context/
region/selection change, Escape, configured blur, visibility loss, lease
expiry, or view destruction cancels the intent. Refresh and close operations
are always queued; provider and session callbacks never synchronously dispatch
CodeMirror transactions.
