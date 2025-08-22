import { acceptCompletion } from "@codemirror/autocomplete";
import { PostgreSQL, type SQLDialect, sql } from "@codemirror/lang-sql";
import { Compartment, type EditorState, StateEffect, StateField } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { basicSetup, EditorView } from "codemirror";
import {
  cteCompletionSource,
  DefaultSqlTooltipRenders,
  defaultSqlHoverTheme,
  NodeSqlParser,
  type SupportedDialects,
  sqlExtension,
} from "../src/index.js";
import { tableTooltipRenderer } from "./custom-renderers.js";
import { defaultSqlDoc, schema } from "./data.js";
import { guessSqlDialect } from "./utils.js";

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
      // Try to accept completion first
      if (acceptCompletion(view)) {
        return true;
      }
      // In production, you can use @codemirror/commands.indentWithTab instead of custom logic
      // If no completion to accept, insert a tab character
      const { state } = view;
      const { selection } = state;
      if (selection.main.empty) {
        // Insert tab at cursor position
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

// e.g. lazily load keyword docs
const getKeywordDocs = async () => {
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

// Allows us to reconfigure the base sql extension without reloading the editor
const baseSqlCompartment = new Compartment();

const baseSqlExtension = (dialect: SQLDialect) => {
  return sql({
    dialect: dialect,
    // Example schema for autocomplete
    schema: schema,
    // Enable uppercase keywords for more traditional SQL style
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
};

// Initialize the SQL editor
function initializeEditor() {
  // Use the same parser
  const parser = new NodeSqlParser({
    getParserOptions: (state: EditorState) => {
      return {
        database: getDatabase(state),
      };
    },
  });

  const extensions = [
    basicSetup,
    EditorView.lineWrapping,
    keymap.of(defaultKeymap),
    databaseField,
    baseSqlCompartment.of(baseSqlExtension(defaultDialect)),
    sqlExtension({
      // Linter extension configuration
      linterConfig: {
        delay: 250, // Delay before running validation
        parser,
      },

      // Gutter extension configuration
      gutterConfig: {
        backgroundColor: "#3b82f6", // Blue for current statement
        errorBackgroundColor: "#ef4444", // Red for invalid statements
        hideWhenNotFocused: true, // Hide gutter when editor loses focus
        parser,
      },
      // Hover extension configuration
      enableHover: true, // Enable hover tooltips
      hoverConfig: {
        schema: schema, // Use the same schema as autocomplete
        hoverTime: 300, // 300ms hover delay
        enableKeywords: true, // Show keyword information
        enableTables: true, // Show table information
        enableColumns: true, // Show column information
        keywords: async () => {
          const keywords = await getKeywordDocs();
          return keywords;
        },
        tooltipRenderers: {
          // Custom renderer for tables
          table: tableTooltipRenderer,
        },
        theme: defaultSqlHoverTheme("light"),
        parser,
      },
    }),
    defaultDialect.language.data.of({
      autocomplete: cteCompletionSource,
    }),
    // Custom theme for better SQL editing
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
      // Style for diagnostic errors
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
      // Completion kind backgrounds
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

  return editor;
}

// Handle example button clicks
function setupExampleButtons() {
  const buttons = document.querySelectorAll(".example-btn");

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      const code = button.querySelector("code");
      if (code && editor) {
        const sql = code.textContent || "";
        // Replace editor content with the example
        editor.dispatch({
          changes: {
            from: 0,
            to: editor.state.doc.length,
            insert: sql,
          },
        });
        // Focus the editor
        editor.focus();
      }
    });
  });
}

function getDatabase(state: EditorState): SupportedDialects {
  return state.field(databaseField);
}

function setupDatabaseSelect() {
  const select = document.querySelector("#database-select");
  if (select) {
    select.addEventListener("change", (e) => {
      const value = (e.target as HTMLSelectElement).value as SupportedDialects;
      updateSqlDialect(editor, guessSqlDialect(value));
      editor.dispatch({
        effects: [setDatabase.of(value)],
      });
    });
  }
}

function updateSqlDialect(view: EditorView, dialect: SQLDialect) {
  view.dispatch({
    effects: [baseSqlCompartment.reconfigure(baseSqlExtension(dialect))],
  });
}

// Initialize everything when the page loads
document.addEventListener("DOMContentLoaded", () => {
  initializeEditor();
  setupExampleButtons();
  setupDatabaseSelect();

  console.log("SQL Editor Demo initialized!");
  console.log("Features:");
  console.log("- Real-time SQL syntax validation");
  console.log("- Error highlighting with detailed messages");
  console.log("- Support for multiple SQL dialects");
  console.log("- TypeScript support");
});
