# Language feature providers

The language service exposes diagnostics, hover, definition, references,
highlights, rename, document symbols, folding, formatting, and code actions
through the same document session used for completion.

```ts
const service = createSqlLanguageService({
  dialects: [duckdbDialect()],
  featureProviders: [{
    id: "duckdb",
    diagnostics: async ({ document, signal }) => {
      const response = await validateSql(document.text, { signal });
      return response.diagnostics;
    },
    hover: ({ document, request }) =>
      describeSqlAt(document.text, request.position),
    format: ({ document, request }) => ({
      changes: [{
        from: request.range?.from ?? 0,
        to: request.range?.to ?? document.text.length,
        insert: formatSql(document.text, request),
      }],
    }),
  }],
});

const session = service.openDocument({
  context: { dialect: "duckdb" },
  text: "select * form users",
});

const task = session.diagnostics();
const result = await task.result;
if (result.status === "ready" && session.isCurrent(result.revision)) {
  renderDiagnostics(result.value);
}
```

Every provider receives a frozen document snapshot, a normalized request, and
an `AbortSignal`. Public ranges are absolute, half-open UTF-16 ranges in the
original document. Results are copied, bounded, validated, and frozen before
publication. Provider exceptions, rejections, timeouts, malformed ranges, and
malformed edits do not escape the service boundary.

Providers run concurrently. `featureProviderBudgetMs` is one absolute
per-request deadline, not a budget multiplied by the provider count. Elapsed
synchronous invocation time counts against that deadline, but JavaScript
cannot preempt a provider that blocks the current thread. Expensive or
untrusted integrations must yield immediately and continue asynchronously in a
worker, process, or remote service. Cancellation, session updates, catalog
invalidation, and disposal stop publication promptly once control returns,
even when an underlying provider ignores its signal.

Collection features compose successful providers in configuration order.
Scalar features such as hover, rename, and format select the first successful
non-empty result. `isIncomplete` explicitly records bounded collection
truncation. Source reports remain available on ready and unavailable results,
preserving which providers were ready, failed, or timed out. Formatting is
explicit; typing never invokes a formatter.

The built-in local structure provider supplies statement-level document
symbols and multiline folding without loading an optional parser. Parser,
native-engine, language-server, host-policy, and formatter integrations remain
ordinary providers and do not expose their AST or transport types.

`sqlEditor` exposes the same tasks through its returned support object:

```ts
const support = sqlEditor({ initialContext, service });
const diagnostics = support.diagnostics(view);
const hover = support.hover(view, { position: view.state.selection.main.head });
```

The host owns presentation and scheduling. This keeps the core SSR-safe and
allows applications to use CodeMirror lint, tooltip, panel, or custom UI
extensions without the SQL package imposing DOM rendering or debounce policy.

Function, scalar parameter, and snippet completion use
`autocomplete.externalSources`, which accepts ordinary CodeMirror
`CompletionSource` values and therefore preserves snippet application and
parameter syntax without translating them through a lossy catalog shape.
Table-valued functions can also be returned by relation catalogs with
`relationKind: "table-function"`; the CodeMirror adapter presents them as
functions at relation sites.
