import { acceptCompletion } from "@codemirror/autocomplete";
import { PostgreSQL, type SQLDialect, sql } from "@codemirror/lang-sql";
import { Compartment, type EditorState, StateEffect, StateField } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { basicSetup, EditorView } from "codemirror";
import {
  DefaultSqlTooltipRenders,
  defaultSqlHoverTheme,
  NodeSqlParser,
  createSqlAnalysis,
  type SupportedDialects,
  type SqlKeywordInfo,
  type SqlAnalysis,
  sqlCompletion,
  sqlExtension,
} from "../src/index.js";
import { tableTooltipRenderer } from "./custom-renderers.js";
import { defaultSqlDoc, schema } from "./data.js";
import { guessSqlDialect, parseDemoDialect } from "./utils.js";

let editor: EditorView;

const completionKindStyles = {
  borderRadius: "4px",
  padding: "2px 4px",
  marginRight: "4px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "12px",
  height: "12px",
};

const defaultDialect = PostgreSQL;

const defaultKeymap = [
  {
    key: "Tab",
    run: (view: EditorView) => {
      if (acceptCompletion(view)) {
        return true;
      }
      // In production, you can use @codemirror/commands.indentWithTab instead of custom logic
      const { state } = view;
      const { selection } = state;
      if (selection.main.empty) {
        view.dispatch({
          changes: {
            from: selection.main.from,
            insert: "\t",
          },
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
];

const getKeywordDocs = async (): Promise<Record<string, SqlKeywordInfo>> => {
  const keywords = await import("@marimo-team/codemirror-sql/data/common-keywords.json");
  const duckdbKeywords = await import("@marimo-team/codemirror-sql/data/duckdb-keywords.json");
  return {
    ...keywords.default.keywords,
    ...duckdbKeywords.default.keywords,
  };
};

const setDatabase = StateEffect.define<SupportedDialects>();
const databaseField = StateField.define<SupportedDialects>({
  create: () => "PostgreSQL",
  update: (prevValue, transaction) => {
    for (const effect of transaction.effects) {
      if (effect.is(setDatabase)) {
        return effect.value;
      }
    }
    return prevValue;
  },
});

const baseSqlCompartment = new Compartment();

const baseSqlExtension = (dialect: SQLDialect, analysis: SqlAnalysis) => {
  const languageSupport = sql({
    dialect: dialect,
    schema: schema,
    upperCaseKeywords: true,
    keywordCompletion: (label, _type) => {
      return {
        label,
        keyword: label,
        info: async () => {
          const dom = document.createElement("div");
          const keywordDocs = await getKeywordDocs();
          const description = keywordDocs[label.toLocaleLowerCase()];
          if (!description) {
            return null;
          }
          dom.innerHTML = DefaultSqlTooltipRenders.keyword({
            keyword: label,
            info: description,
          });
          return dom;
        },
      };
    },
  });
  return [languageSupport, sqlCompletion({ dialect, schema, ...analysis })];
};

export function initializeEditor() {
  const parser = new NodeSqlParser({
    getParserOptions: (state: EditorState) => {
      return {
        database: getDatabase(state),
      };
    },
  });
  const analysis = createSqlAnalysis({ parser });

  const extensions = [
    basicSetup,
    EditorView.lineWrapping,
    keymap.of(defaultKeymap),
    databaseField,
    baseSqlCompartment.of(baseSqlExtension(defaultDialect, analysis)),
    sqlExtension({
      ...analysis,
      needsRefresh: (update) => getDatabase(update.startState) !== getDatabase(update.state),
      schema: schema,
      linterConfig: {
        delay: 250,
      },
      semanticLinterConfig: {
        delay: 250,
      },

      gutterConfig: {
        backgroundColor: "#3b82f6",
        errorBackgroundColor: "#ef4444",
        hideWhenNotFocused: true,
      },
      enableHover: true,
      hoverConfig: {
        schema: schema,
        hoverTime: 300,
        enableKeywords: true,
        enableTables: true,
        enableColumns: true,
        keywords: async () => {
          const keywords = await getKeywordDocs();
          return keywords;
        },
        tooltipRenderers: {
          table: tableTooltipRenderer,
        },
        theme: defaultSqlHoverTheme("light"),
      },
      enableNavigation: true,
      navigationConfig: {
        keymap: true, // F12/Mod-b go-to-definition, F2 rename
      },
    }),
    EditorView.theme({
      "&": {
        fontSize: "14px",
        fontFamily: '"JetBrains Mono", monospace',
      },
      ".cm-content": {
        minHeight: "400px",
      },
      ".cm-focused": {
        outline: "none",
      },
      ".cm-editor": {
        borderRadius: "8px",
      },
      ".cm-scroller": {
        fontFamily: "inherit",
      },
      ".cm-diagnostic-error": {
        borderBottom: "2px wavy #dc2626",
      },
      ".cm-diagnostic": {
        padding: "4px 8px",
        borderRadius: "4px",
        backgroundColor: "#fef2f2",
        border: "1px solid #fecaca",
        color: "#dc2626",
        fontSize: "13px",
      },
      ".cm-completionIcon-keyword": {
        backgroundColor: "#e0e7ff", // indigo-100
        ...completionKindStyles,
      },
      ".cm-completionIcon-variable": {
        backgroundColor: "#fef9c3", // yellow-100
        ...completionKindStyles,
      },
      ".cm-completionIcon-property": {
        backgroundColor: "#bbf7d0", // green-100
        ...completionKindStyles,
      },
      ".cm-completionIcon-function": {
        backgroundColor: "#bae6fd", // sky-100
        ...completionKindStyles,
      },
      ".cm-completionIcon-class": {
        backgroundColor: "#fbcfe8", // pink-100
        ...completionKindStyles,
      },
      ".cm-completionIcon-constant": {
        backgroundColor: "#fde68a", // amber-200
        ...completionKindStyles,
      },
      ".cm-completionIcon-type": {
        backgroundColor: "#ddd6fe", // violet-200
        ...completionKindStyles,
      },
      ".cm-completionIcon-text": {
        backgroundColor: "#f3f4f6", // gray-100
        ...completionKindStyles,
      },
    }),
  ];

  editor = new EditorView({
    doc: defaultSqlDoc,
    extensions,
    parent: document.querySelector("#sql-editor") ?? undefined,
  });

  setupDatabaseSelect(analysis);
  return editor;
}

function setupExampleButtons() {
  const buttons = document.querySelectorAll(".example-btn");

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      const code = button.querySelector("code");
      if (code && editor) {
        const sql = code.textContent || "";
        editor.dispatch({
          changes: {
            from: 0,
            to: editor.state.doc.length,
            insert: sql,
          },
        });
        editor.focus();
      }
    });
  });
}

export function getDatabase(state: EditorState): SupportedDialects {
  return state.field(databaseField);
}

function setupDatabaseSelect(analysis: SqlAnalysis) {
  const select = document.querySelector("#database-select");
  if (select instanceof HTMLSelectElement) {
    select.addEventListener("change", () => {
      const database = parseDemoDialect(select.value);
      if (database === undefined) return;
      updateSqlDialect(editor, database, analysis);
    });
  }
}

function updateSqlDialect(view: EditorView, database: SupportedDialects, analysis: SqlAnalysis) {
  const dialect = guessSqlDialect(database);
  view.dispatch({
    effects: [
      setDatabase.of(database),
      baseSqlCompartment.reconfigure(baseSqlExtension(dialect, analysis)),
    ],
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initializeEditor();
  setupExampleButtons();

  console.log("SQL Editor Demo initialized!");
  console.log("Features:");
  console.log("- Real-time SQL syntax validation");
  console.log("- Error highlighting with detailed messages");
  console.log("- Support for multiple SQL dialects");
  console.log("- TypeScript support");
});
