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

Rich completion details are opt-in through
`autocomplete.infoResolver`. The resolver receives the immutable core item and
an `AbortSignal`, and returns a DOM resource with an explicit `destroy`
callback. The adapter aborts pending work and destroys resolved resources when
the selected option, document input, context, regions, or view lifetime
changes. Resolver failures are contained and simply omit the detail panel.

```ts
const support = sqlEditor({
  autocomplete: {
    infoResolver: async (item, { signal }) => {
      const metadata = await loadMetadata(item, { signal });
      const dom = document.createElement("div");
      const root = createRoot(dom);
      root.render(renderMetadata(metadata));
      return { dom, destroy: () => root.unmount() };
    },
  },
  initialContext,
  service,
});
```

## Statement boundaries and gutter

The support object exposes synchronous structural queries without exposing the
adapter-owned session:

```ts
const current = support.statementBoundaryAt(view, {
  affinity: "left",
  position: view.state.selection.main.head,
});
const visible = support.statementBoundariesIntersecting(view, {
  from: view.viewport.from,
  to: view.viewport.to,
});
```

Both methods return `null` for foreign, destroyed, or unsynchronized views.
An opt-in structural gutter marks only lines intersecting scanner-owned SQL
`code` spans. It never parses or copies statement text:

```ts
const support = sqlEditor({
  initialContext,
  service,
  statementGutter: {
    hideWhenNotFocused: true,
    showInactive: true,
  },
});
```

The gutter uses `--cm-sql-statement-color` and
`--cm-sql-statement-inactive-opacity` CSS variables. It is disabled by default.

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
