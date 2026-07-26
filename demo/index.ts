import {
  acceptCompletion,
  closeCompletion,
  startCompletion,
} from "@codemirror/autocomplete";
import {
  PostgreSQL,
  sql,
  StandardSQL,
  type SQLDialect,
} from "@codemirror/lang-sql";
import { Compartment } from "@codemirror/state";
import { basicSetup, EditorView } from "codemirror";
import {
  bigQueryDialect,
  createSqlLanguageService,
  dremioDialect,
  duckdbDialect,
  postgresDialect,
  type SqlCatalogEpoch,
  type SqlCatalogRelation,
  type SqlColumnCatalogProvider,
  type SqlDocumentContext,
  type SqlNamespaceCatalogProvider,
  type SqlRelationCatalogProvider,
} from "../src/index.js";
import { sqlEditor } from "../src/codemirror/index.js";
import { defaultSqlDoc, demoTables } from "./data.js";

type DemoDialect = "bigquery" | "dremio" | "duckdb" | "postgresql";

interface DemoContext extends SqlDocumentContext {
  readonly environment: "demo";
}

const epoch: SqlCatalogEpoch = {
  generation: 1,
  token: "demo-catalog-v1",
};
let latencyMs = 0;
let catalogRequests = 0;
let columnRequests = 0;
let namespaceRequests = 0;

function identifier(value: string) {
  return { quoted: false as const, value };
}

async function delay(signal: AbortSignal): Promise<void> {
  if (latencyMs === 0) return;
  await new Promise<void>((resolve, reject) => {
    const handle = setTimeout(resolve, latencyMs);
    signal.addEventListener("abort", () => {
      clearTimeout(handle);
      reject(signal.reason);
    }, { once: true });
  });
}

function updateStats(): void {
  const node = document.querySelector("#provider-stats");
  if (node) {
    node.textContent =
      `${catalogRequests} relation · ${columnRequests} column · ` +
      `${namespaceRequests} namespace requests`;
  }
}

const catalog: SqlRelationCatalogProvider = {
  id: "demo-relations",
  search: async (request, signal) => {
    catalogRequests += 1;
    updateStats();
    await delay(signal);
    signal.throwIfAborted();
    const prefix = request.prefix.value.toLocaleLowerCase();
    const qualifier = request.qualifier.map((part) =>
      part.value.toLocaleLowerCase()
    );
    return {
      coverage: { kind: "complete" },
      epoch,
      relations: demoTables
        .filter((table) =>
          table.name.toLocaleLowerCase().startsWith(prefix) &&
          (qualifier.length === 0 ||
            qualifier.at(-1) === table.schema.toLocaleLowerCase())
        )
        .slice(0, request.limit)
        .map((table): SqlCatalogRelation => ({
          canonicalPath: [
            { ...identifier(table.schema), role: "schema" },
            { ...identifier(table.name), role: "relation" },
          ],
          completionPathStart: qualifier.length === 0 ? 1 : 0,
          detail: table.description,
          entityId: `${table.schema}.${table.name}`,
          matchQuality: "exact",
          relationKind: "table",
        })),
      status: "ready",
    };
  },
};

const columns: SqlColumnCatalogProvider = {
  id: "demo-columns",
  loadColumns: async (request, signal) => {
    columnRequests += 1;
    updateStats();
    await delay(signal);
    signal.throwIfAborted();
    return {
      epoch,
      relations: request.relations.map((relation) => {
        const tableName = relation.path.at(-1)?.value.toLocaleLowerCase();
        const table = demoTables.find((candidate) =>
          candidate.name.toLocaleLowerCase() === tableName
        );
        if (!table) {
          return {
            code: "unknown" as const,
            requestKey: relation.requestKey,
            retry: "after-invalidation" as const,
            status: "failed" as const,
          };
        }
        return {
          columns: table.columns.map((column, ordinal) => ({
            columnEntityId: `${table.schema}.${table.name}.${column.name}`,
            dataType: column.type,
            detail: `${column.type} · ${table.schema}.${table.name}`,
            identifier: identifier(column.name),
            insertText: column.name,
            ordinal,
          })),
          coverage: "complete" as const,
          relationEntityId: `${table.schema}.${table.name}`,
          requestKey: relation.requestKey,
          status: "ready" as const,
        };
      }),
    };
  },
};

const namespaces: SqlNamespaceCatalogProvider = {
  id: "demo-namespaces",
  search: async (request, signal) => {
    namespaceRequests += 1;
    updateStats();
    await delay(signal);
    signal.throwIfAborted();
    const prefix = request.prefix.value.toLocaleLowerCase();
    return {
      containers: ["main", "sales"]
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({
          canonicalPath: [{ ...identifier(name), role: "schema" as const }],
          containerEntityId: `schema:${name}`,
          detail: `Demo ${name} schema`,
          insertText: name,
          matchQuality: "exact" as const,
        })),
      coverage: "complete",
      epoch,
      status: "ready",
    };
  },
};

const service = createSqlLanguageService<DemoContext>({
  catalog,
  columns,
  completion: { catalogResponseBudgetMs: 40 },
  dialects: [
    bigQueryDialect(),
    dremioDialect(),
    duckdbDialect(),
    postgresDialect(),
  ],
  namespaces,
});

let dialect: DemoDialect = "duckdb";
const context = (): DemoContext => ({
  catalog: {
    scope: `demo-connection:${dialect}`,
    searchPath: [[identifier("main")]],
  },
  dialect,
  environment: "demo",
});

const support = sqlEditor({
  autocomplete: {
    activateOnTyping: true,
    activateOnTypingDelay: 75,
    infoResolver: (item) => {
      const dom = document.createElement("div");
      dom.className = "sql-completion-info";
      const title = document.createElement("strong");
      title.textContent = item.label;
      const detail = document.createElement("div");
      detail.textContent = item.detail ?? `${item.kind} completion`;
      dom.append(title, detail);
      return { destroy: () => undefined, dom };
    },
    maxRenderedOptions: 100,
    selectOnOpen: true,
  },
  initialContext: context(),
  service,
  statementGutter: {
    hideWhenNotFocused: false,
    showInactive: true,
  },
});

const syntax = new Compartment();
function syntaxDialect(value: DemoDialect): SQLDialect {
  return value === "postgresql" ? PostgreSQL : StandardSQL;
}

const editor = new EditorView({
  doc: defaultSqlDoc,
  extensions: [
    basicSetup,
    EditorView.lineWrapping,
    syntax.of(sql({ dialect: syntaxDialect(dialect) })),
    support.extension,
    EditorView.theme({
      "&": {
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: "14px",
      },
      ".cm-content": { minHeight: "390px" },
      ".cm-focused": { outline: "none" },
    }),
    EditorView.domEventHandlers({
      keydown: (event, view) =>
        event.key === "Tab" && acceptCompletion(view),
    }),
  ],
  parent: document.querySelector("#sql-editor") ?? undefined,
});

function loadExample(markedSql: string): void {
  const cursor = markedSql.indexOf("|");
  const text =
    cursor < 0
      ? markedSql
      : markedSql.slice(0, cursor) + markedSql.slice(cursor + 1);
  const position = cursor < 0 ? text.length : cursor;
  closeCompletion(editor);
  editor.dispatch({
    changes: { from: 0, insert: text, to: editor.state.doc.length },
    selection: { anchor: position },
  });
  editor.focus();
  queueMicrotask(() => startCompletion(editor));
}

for (const button of document.querySelectorAll<HTMLButtonElement>(".example-btn")) {
  button.addEventListener("click", () => {
    loadExample(button.dataset.sql ?? "");
  });
}

document.querySelector<HTMLSelectElement>("#database-select")
  ?.addEventListener("change", (event) => {
    dialect = (event.target as HTMLSelectElement).value as DemoDialect;
    support.setContext(editor, context());
    editor.dispatch({
      effects: syntax.reconfigure(sql({ dialect: syntaxDialect(dialect) })),
    });
    editor.focus();
  });

document.querySelector<HTMLSelectElement>("#latency-select")
  ?.addEventListener("change", (event) => {
    latencyMs = Number((event.target as HTMLSelectElement).value);
    support.invalidateCatalog(editor);
  });

document.querySelector<HTMLButtonElement>("#invalidate-catalog")
  ?.addEventListener("click", () => {
    support.invalidateCatalog(editor);
    editor.focus();
    startCompletion(editor);
  });

window.addEventListener("beforeunload", () => {
  editor.destroy();
  service.dispose();
});

updateStats();
