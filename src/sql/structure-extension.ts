import { type Extension, RangeSet, StateEffect, StateField } from "@codemirror/state";
import { EditorView, GutterMarker, gutter, type ViewUpdate } from "@codemirror/view";
import { NodeSqlParser } from "./parser.js";
import { type SqlStatement, SqlStructureAnalyzer } from "./structure-analyzer.js";
import type { SqlParser } from "./types.js";

export interface SqlGutterConfig {
  /** Background color for the current statement indicator */
  backgroundColor?: string;
  /** Background color for invalid statements */
  errorBackgroundColor?: string;
  /** Width of the gutter marker in pixels */
  width?: number;
  /** Additional CSS class for the gutter */
  className?: string;
  /** Whether to show markers for invalid statements */
  showInvalid?: boolean;
  /** Function to determine when to hide the gutter */
  whenHide?: (view: EditorView) => boolean;
  /** Opacity for non-current statements */
  inactiveOpacity?: number;
  /** Hide gutter when editor is not focused */
  hideWhenNotFocused?: boolean;
  /** Opacity when editor is not focused (overrides hideWhenNotFocused if set) */
  unfocusedOpacity?: number;
  /** Custom SQL parser instance to use for analysis */
  parser?: SqlParser;
}

interface SqlGutterState {
  currentStatement: SqlStatement | null;
  allStatements: SqlStatement[];
  cursorPosition: number;
  isFocused: boolean;
}

// State effect for updating SQL statements
const updateSqlStatementsEffect = StateEffect.define<SqlGutterState>();

// State field to track current SQL statements
const sqlGutterStateField = StateField.define<SqlGutterState>({
  create(): SqlGutterState {
    return {
      currentStatement: null,
      allStatements: [],
      cursorPosition: 0,
      isFocused: true,
    };
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(updateSqlStatementsEffect)) {
        return effect.value;
      }
    }
    return value;
  },
});

class SqlGutterMarker extends GutterMarker {
  constructor(
    private config: SqlGutterConfig,
    private isCurrent: boolean,
    private isValid: boolean = true,
    private isFocused: boolean = true,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-sql-gutter-marker";

    // Set background color based on state
    let backgroundColor = this.config.backgroundColor || "#3b82f6";
    if (!this.isValid && this.config.showInvalid !== false) {
      backgroundColor = this.config.errorBackgroundColor || "#ef4444";
    }

    // Calculate opacity based on focus state
    let opacity: string;
    if (!this.isFocused) {
      if (this.config.unfocusedOpacity !== undefined) {
        opacity = this.config.unfocusedOpacity.toString();
      } else if (this.config.hideWhenNotFocused) {
        opacity = "0";
      } else {
        // Default behavior when not focused - use normal opacity
        opacity = this.isCurrent ? "1" : (this.config.inactiveOpacity || "0.3").toString();
      }
    } else {
      // Normal focused behavior
      opacity = this.isCurrent ? "1" : (this.config.inactiveOpacity || "0.3").toString();
    }

    el.style.cssText = `
      background: ${backgroundColor};
      height: 100%;
      width: 100%;
      opacity: ${opacity};
      transition: opacity 150ms ease-in-out;
      border-radius: 1px;
    `;

    return el;
  }

  eq(other: SqlGutterMarker): boolean {
    return (
      this.isCurrent === other.isCurrent &&
      this.isValid === other.isValid &&
      this.isFocused === other.isFocused &&
      this.config === other.config
    );
  }
}

function createSqlGutterMarkers(
  view: EditorView,
  config: SqlGutterConfig,
): RangeSet<SqlGutterMarker> {
  let markers = RangeSet.empty;

  // Check if gutter should be hidden
  if (config.whenHide?.(view)) {
    return markers;
  }

  const state = view.state.field(sqlGutterStateField, false);
  if (!state) {
    return markers;
  }

  const { currentStatement, allStatements, isFocused } = state;

  try {
    // Create markers for all statements
    for (const statement of allStatements) {
      const isCurrent =
        currentStatement?.from === statement.from && currentStatement?.to === statement.to;

      // Skip invalid statements if configured to hide them
      if (!statement.isValid && config.showInvalid === false) {
        continue;
      }

      const marker = new SqlGutterMarker(config, isCurrent, statement.isValid, isFocused);

      // Add marker to each line of the statement
      for (let lineNum = statement.lineFrom; lineNum <= statement.lineTo; lineNum++) {
        try {
          // Check if line number is within valid bounds
          if (lineNum < 1 || lineNum > view.state.doc.lines) {
            // Skip stale line numbers silently - this is expected when text is deleted
            continue;
          }

          const line = view.state.doc.line(lineNum);
          markers = markers.update({
            add: [marker.range(line.from)],
          });
        } catch (e) {
          // Handle edge cases where line numbers might be invalid
          console.warn("SqlGutter: Invalid line number", lineNum, e);
        }
      }
    }
  } catch (error) {
    console.warn("SqlGutter: Error creating markers", error);
  }

  return markers;
}

function createUpdateListener(analyzer: SqlStructureAnalyzer): Extension {
  return EditorView.updateListener.of(async (update: ViewUpdate) => {
    // Update on document changes, selection changes, or focus changes
    if (!update.docChanged && !update.selectionSet && !update.focusChanged) {
      return;
    }

    const { state } = update.view;
    const { main } = state.selection;
    const cursorPosition = main.head;

    // Analyze the document for SQL statements
    const allStatements = await analyzer.analyzeDocument(state);
    const currentStatement = await analyzer.getStatementAtPosition(state, cursorPosition);

    const newState: SqlGutterState = {
      currentStatement,
      allStatements,
      cursorPosition,
      isFocused: update.view.hasFocus,
    };

    // Dispatch the update
    update.view.dispatch({
      effects: updateSqlStatementsEffect.of(newState),
    });
  });
}

function createGutterTheme(config: SqlGutterConfig): Extension {
  const gutterWidth = config.width || 3;

  return EditorView.baseTheme({
    ".cm-sql-gutter": {
      width: `${gutterWidth}px`,
      minWidth: `${gutterWidth}px`,
    },
    ".cm-sql-gutter .cm-gutterElement": {
      width: `${gutterWidth}px`,
      padding: "0",
      margin: "0",
    },
    ".cm-sql-gutter-marker": {
      width: "100%",
      height: "100%",
      display: "block",
    },
    // Ensure line numbers have proper spacing when SQL gutter is present
    ".cm-lineNumbers .cm-gutterElement": {
      paddingLeft: "8px",
      paddingRight: "8px",
    },
  });
}

function createSqlGutter(config: SqlGutterConfig): Extension {
  return gutter({
    class: `cm-sql-gutter ${config.className || ""}`,
    markers: (view: EditorView) => createSqlGutterMarkers(view, config),
  });
}

/**
 * Creates a SQL gutter extension that shows visual indicators for SQL statements
 * based on cursor position. Highlights the current statement and shows dimmed
 * indicators for other statements.
 */
export function sqlStructureGutter(config: SqlGutterConfig = {}): Extension[] {
  const parser = config.parser || new NodeSqlParser();
  const analyzer = new SqlStructureAnalyzer(parser);

  return [
    sqlGutterStateField,
    createUpdateListener(analyzer),
    createGutterTheme(config),
    createSqlGutter(config),
  ];
}
