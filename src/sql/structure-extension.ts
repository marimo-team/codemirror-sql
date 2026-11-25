import { debug } from "../debug.js";
import { createSqlAnalysis } from "./analysis.js";
import { type Extension, type Range, RangeSet, StateEffect, StateField } from "@codemirror/state";
import { EditorView, GutterMarker, gutter, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { type SqlStatement, SqlStructureAnalyzer } from "./structure-analyzer.js";
import type { SqlParser } from "./types.js";

export interface SqlGutterConfig {
  /** Re-run analysis when parser configuration changes without a document edit. */
  needsRefresh?: (update: import("@codemirror/view").ViewUpdate) => boolean;
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
  structureAnalyzer?: SqlStructureAnalyzer;
}

interface SqlGutterState {
  currentStatement: SqlStatement | null;
  allStatements: SqlStatement[];
  isFocused: boolean;
}

const updateSqlStatementsEffect = StateEffect.define<SqlGutterState>();

const sqlGutterStateField = StateField.define<SqlGutterState>({
  create(): SqlGutterState {
    return {
      currentStatement: null,
      allStatements: [],
      isFocused: true,
    };
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(updateSqlStatementsEffect)) {
        return effect.value;
      }
    }
    if (!tr.docChanged) return value;
    const allStatements = value.allStatements.flatMap((statement) => {
      const from = tr.changes.mapPos(statement.from, 1);
      const to = tr.changes.mapPos(statement.to, -1);
      if (to <= from) return [];
      return [{
        ...statement,
        from,
        to,
        lineFrom: tr.newDoc.lineAt(from).number,
        lineTo: tr.newDoc.lineAt(to).number,
      }];
    });
    const position = tr.newSelection.main.head;
    return {
      ...value,
      allStatements,
      currentStatement: allStatements.find((statement) =>
        position >= statement.from && position <= statement.to,
      ) ?? null,
    };
  },
});

export function computeMarkerStyle(
  config: SqlGutterConfig,
  state: { isCurrent: boolean; isValid: boolean; isFocused: boolean },
): { backgroundColor: string; opacity: string } {
  const { isCurrent, isValid, isFocused } = state;

  let backgroundColor = config.backgroundColor || "#3b82f6";
  if (!isValid && config.showInvalid !== false) {
    backgroundColor = config.errorBackgroundColor || "#ef4444";
  }

  const normalOpacity = isCurrent ? "1" : (config.inactiveOpacity ?? 0.3).toString();

  let opacity: string;
  if (!isFocused) {
    if (config.unfocusedOpacity !== undefined) {
      opacity = config.unfocusedOpacity.toString();
    } else if (config.hideWhenNotFocused) {
      opacity = "0";
    } else {
      opacity = normalOpacity;
    }
  } else {
    opacity = normalOpacity;
  }

  return { backgroundColor, opacity };
}

class SqlGutterMarker extends GutterMarker {
  constructor(
    private config: SqlGutterConfig,
    private isCurrent: boolean,
    private isValid: boolean = true,
    private isFocused: boolean = true,
  ) {
    super();
  }

  override toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-sql-gutter-marker";

    const { backgroundColor, opacity } = computeMarkerStyle(this.config, {
      isCurrent: this.isCurrent,
      isValid: this.isValid,
      isFocused: this.isFocused,
    });

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

  override eq(other: SqlGutterMarker): boolean {
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
  if (config.whenHide?.(view)) return RangeSet.empty;
  const state = view.state.field(sqlGutterStateField, false);
  if (!state) return RangeSet.empty;

  const { currentStatement, allStatements, isFocused } = state;
  const startLine = view.state.doc.lineAt(view.viewport.from).number;
  const endLine = view.state.doc.lineAt(view.viewport.to).number;
  const markers: Range<SqlGutterMarker>[] = [];
  for (const statement of allStatements) {
    if (!statement.isValid && config.showInvalid === false) continue;
    const isCurrent = currentStatement?.from === statement.from && currentStatement.to === statement.to;
    const marker = new SqlGutterMarker(config, isCurrent, statement.isValid, isFocused);
    const first = Math.max(1, statement.lineFrom, startLine);
    const last = Math.min(view.state.doc.lines, statement.lineTo, endLine);
    for (let line = first; line <= last; line++) {
      markers.push(marker.range(view.state.doc.line(line).from));
    }
  }
  return RangeSet.of(markers, true);
}

function createStructurePlugin(analyzer: SqlStructureAnalyzer, config: SqlGutterConfig): Extension {
  return ViewPlugin.define((view: EditorView) => {
    let generation = 0;
    let pending: Promise<SqlStatement[]> | undefined;
    const analyze = async (refresh = false) => {
      const currentGeneration = ++generation;
      const { state } = view;
      try {
        if (refresh || !pending) pending = analyzer.analyzeDocument(state);
        const allStatements = await pending;
        if (currentGeneration !== generation) return;
        const position = state.selection.main.head;
        const currentStatement = allStatements.find(
          (statement) => position >= statement.from && position <= statement.to,
        ) ?? null;
        view.dispatch({
          effects: updateSqlStatementsEffect.of({
            currentStatement,
            allStatements,
            isFocused: view.hasFocus,
          }),
        });
      } catch (error) {
        if (currentGeneration === generation) pending = undefined;
        debug("SQL gutter analysis failed", error);
      }
    };
    void analyze();
    return {
      update(update: ViewUpdate) {
        const refresh = update.docChanged || config.needsRefresh?.(update) === true;
        if (refresh || update.selectionSet || update.focusChanged) void analyze(refresh);
      },
      destroy() { generation++; },
    };
  });
}

const gutterTheme = EditorView.baseTheme({
  ".cm-sql-gutter": {
    width: "var(--cm-sql-gutter-width, 3px)",
    minWidth: "var(--cm-sql-gutter-width, 3px)",
  },
  ".cm-sql-gutter .cm-gutterElement": {
    width: "var(--cm-sql-gutter-width, 3px)",
    padding: "0",
    margin: "0",
  },
  ".cm-sql-gutter-marker": {
    width: "100%",
    height: "100%",
    display: "block",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    paddingLeft: "8px",
    paddingRight: "8px",
  },
});

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
  const { structureAnalyzer: analyzer } = createSqlAnalysis(config);

  return [
    sqlGutterStateField,
    createStructurePlugin(analyzer, config),
    [
      gutterTheme,
      EditorView.editorAttributes.of({
        style: `--cm-sql-gutter-width: ${config.width || 3}px`,
      }),
    ],
    createSqlGutter(config),
  ];
}
