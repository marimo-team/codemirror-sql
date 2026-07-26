import { acceptCompletion } from "@codemirror/autocomplete";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import {
  bigQueryDialect,
  createSqlLanguageService,
  dremioDialect,
  duckdbDialect,
  postgresDialect,
  SqlSessionError,
  type SqlDialect,
  type SqlDocumentContext,
  type SqlDocumentSession,
  type SqlLanguageService,
  type SqlTextChange,
} from "../src/index.js";
import { defaultSqlDoc } from "./data.js";

interface DemoSqlContext extends SqlDocumentContext {
  readonly engine: "demo";
}

const dialectOptions = [
  postgresDialect(),
  duckdbDialect(),
  bigQueryDialect(),
  dremioDialect(),
] as const;

const dialectById = new Map(
  dialectOptions.map((dialect) => [dialect.id, dialect]),
);

let currentDialect: SqlDialect = postgresDialect();

const service: SqlLanguageService<DemoSqlContext> =
  createSqlLanguageService<DemoSqlContext>({
    dialects: [...dialectOptions],
  });

const session: SqlDocumentSession<DemoSqlContext> = service.openDocument({
  text: defaultSqlDoc,
  context: { dialect: currentDialect.id, engine: "demo" },
});

let editor: EditorView;
let updateCount = 1;

const statusElements = {
  dialect: document.querySelector<HTMLElement>("#status-dialect"),
  updates: document.querySelector<HTMLElement>("#status-updates"),
  revision: document.querySelector<HTMLElement>("#status-revision"),
  message: document.querySelector<HTMLElement>("#status-message"),
};

function setStatus(message: string, isError = false): void {
  if (!statusElements.message) {
    return;
  }
  statusElements.message.textContent = message;
  statusElements.message.classList.toggle("text-red-700", isError);
  statusElements.message.classList.toggle("bg-red-50", isError);
  statusElements.message.classList.toggle("border-red-200", isError);
  statusElements.message.classList.toggle("text-gray-700", !isError);
  statusElements.message.classList.toggle("bg-gray-50", !isError);
  statusElements.message.classList.toggle("border-gray-200", !isError);
}

function refreshStatusPanel(): void {
  if (statusElements.dialect) {
    statusElements.dialect.textContent = currentDialect.displayName;
  }
  if (statusElements.updates) {
    statusElements.updates.textContent = String(updateCount);
  }
  if (statusElements.revision) {
    statusElements.revision.textContent = session.isCurrent(session.revision)
      ? "current"
      : "stale";
  }
}

function collectTextChanges(changes: {
  iterChanges: (
    callback: (
      fromA: number,
      toA: number,
      fromB: number,
      toB: number,
      inserted: { toString: () => string },
    ) => void,
  ) => void;
}): SqlTextChange[] {
  const textChanges: SqlTextChange[] = [];
  changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    textChanges.push({ from, insert: inserted.toString(), to });
  });
  return textChanges;
}

function applySessionUpdate(
  update:
    | {
        document: { kind: "changes"; changes: readonly SqlTextChange[] };
        embeddedRegions: [];
      }
    | {
        document: { kind: "replace"; text: string };
        embeddedRegions: [];
      }
    | {
        context: DemoSqlContext;
      },
): void {
  try {
    const revision = session.update({
      baseRevision: session.revision,
      ...update,
    });
    updateCount += 1;
    refreshStatusPanel();
    setStatus(
      session.isCurrent(revision)
        ? "Session update accepted."
        : "Session update accepted but revision is no longer current.",
    );
  } catch (error) {
    refreshStatusPanel();
    if (error instanceof SqlSessionError) {
      setStatus(`${error.code}: ${error.message}`, true);
      return;
    }
    throw error;
  }
}

function replaceDocument(text: string): void {
  applySessionUpdate({
    document: { kind: "replace", text },
    embeddedRegions: [],
  });
  editor.dispatch({
    changes: { from: 0, insert: text, to: editor.state.doc.length },
  });
}

function initializeEditor(): EditorView {
  const extensions = [
    basicSetup,
    EditorView.lineWrapping,
    keymap.of([
      {
        key: "Tab",
        run: (view) => {
          if (acceptCompletion(view)) {
            return true;
          }
          const { selection } = view.state;
          if (selection.main.empty) {
            view.dispatch({
              changes: { from: selection.main.from, insert: "\t" },
              selection: {
                anchor: selection.main.from + 1,
                head: selection.main.from + 1,
              },
            });
            return true;
          }
          return false;
        },
      },
    ]),
    sql({ dialect: PostgreSQL, upperCaseKeywords: true }),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) {
        return;
      }
      const changes = collectTextChanges(update.changes);
      if (changes.length === 0) {
        return;
      }
      applySessionUpdate({
        document: { changes, kind: "changes" },
        embeddedRegions: [],
      });
    }),
    EditorView.theme({
      "&": {
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: "14px",
      },
      ".cm-content": {
        minHeight: "400px",
      },
      ".cm-editor": {
        borderRadius: "8px",
      },
      ".cm-focused": {
        outline: "none",
      },
      ".cm-scroller": {
        fontFamily: "inherit",
      },
    }),
  ];

  editor = new EditorView({
    doc: defaultSqlDoc,
    extensions,
    parent: document.querySelector("#sql-editor") ?? undefined,
  });

  return editor;
}

function setupExampleButtons(): void {
  document.querySelectorAll(".example-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const code = button.querySelector("code");
      if (!code) {
        return;
      }
      replaceDocument(code.textContent ?? "");
      editor.focus();
    });
  });
}

function setupDialectSelect(): void {
  const select = document.querySelector<HTMLSelectElement>("#dialect-select");
  if (!select) {
    return;
  }

  select.value = currentDialect.id;
  select.addEventListener("change", () => {
    const nextDialect = dialectById.get(select.value);
    if (!nextDialect) {
      return;
    }
    currentDialect = nextDialect;
    applySessionUpdate({
      context: { dialect: nextDialect.id, engine: "demo" },
    });
    refreshStatusPanel();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initializeEditor();
  setupExampleButtons();
  setupDialectSelect();
  refreshStatusPanel();
  setStatus("Session opened. Type to send incremental updates.");
});
