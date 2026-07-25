import {
  RangeSet,
  type Extension,
  type Text,
} from "@codemirror/state";
import {
  EditorView,
  GutterMarker,
  gutter,
} from "@codemirror/view";
import type {
  SqlStatementBoundariesIntersectingResult,
  SqlStatementBoundaryAtResult,
  SqlTextRange,
} from "../index.js";

export interface SqlEditorStatementGutterOptions {
  readonly hideWhenNotFocused?: boolean;
  readonly showInactive?: boolean;
}

export interface SqlStatementGutterAccess {
  readonly boundaryAt: (
    view: EditorView,
    position: number,
    affinity: "left" | "right",
  ) => SqlStatementBoundaryAtResult | null;
  readonly boundariesIntersecting: (
    view: EditorView,
    range: SqlTextRange,
  ) => SqlStatementBoundariesIntersectingResult | null;
  readonly inputKeys: (
    view: EditorView,
  ) => readonly [unknown, unknown];
}

class SqlStatementGutterMarker extends GutterMarker {
  constructor(readonly active: boolean) {
    super();
  }

  override eq(other: SqlStatementGutterMarker): boolean {
    return this.active === other.active;
  }

  override toDOM(view: EditorView): Node {
    const marker = view.dom.ownerDocument.createElement("div");
    marker.className = this.active
      ? "cm-sql-statement-marker cm-sql-statement-marker-active"
      : "cm-sql-statement-marker cm-sql-statement-marker-inactive";
    return marker;
  }
}

const activeMarker = new SqlStatementGutterMarker(true);
const inactiveMarker = new SqlStatementGutterMarker(false);
const emptyMarkers: RangeSet<GutterMarker> = RangeSet.empty;

interface SqlStatementGutterSnapshot {
  readonly contextKey: unknown;
  readonly document: Text;
  readonly embeddedRegionsKey: unknown;
  readonly focused: boolean;
  readonly markers: RangeSet<GutterMarker>;
  readonly selectionHead: number;
  readonly viewportFrom: number;
  readonly viewportTo: number;
}

function sameRange(
  left: SqlTextRange,
  right: SqlTextRange,
): boolean {
  return left.from === right.from && left.to === right.to;
}

function exactCode(
  result: SqlStatementBoundaryAtResult | null,
): SqlTextRange | null {
  const boundary = result?.boundary;
  return boundary?.boundaryQuality === "exact" &&
      boundary.hasCode
    ? boundary.code
    : null;
}

function currentCodeRange(
  view: EditorView,
  access: SqlStatementGutterAccess,
): SqlTextRange | null {
  const position = view.state.selection.main.head;
  const right = access.boundaryAt(view, position, "right");
  if (
    right?.boundary.boundaryQuality === "opaque"
  ) {
    return null;
  }
  const rightCode = exactCode(right);
  if (rightCode !== null) return rightCode;
  if (
    right?.boundary.boundaryQuality !== "exact" ||
    right.boundary.hasCode
  ) {
    return null;
  }
  return exactCode(
    access.boundaryAt(view, position, "left"),
  );
}

function buildMarkers(
  view: EditorView,
  options: SqlEditorStatementGutterOptions,
  access: SqlStatementGutterAccess,
): RangeSet<GutterMarker> {
  if (
    options.hideWhenNotFocused === true && !view.hasFocus
  ) {
    return emptyMarkers;
  }
  const { from, to } = view.viewport;
  if (from === to) return emptyMarkers;
  const visible = access.boundariesIntersecting(view, { from, to });
  if (visible === null) return emptyMarkers;
  const current = currentCodeRange(view, access);
  const lineMarkers = new Map<number, boolean>();
  for (const boundary of visible.boundaries) {
    if (
      boundary.boundaryQuality !== "exact" ||
      !boundary.hasCode
    ) {
      continue;
    }
    const codeFrom = Math.max(from, boundary.code.from);
    const codeTo = Math.min(to, boundary.code.to);
    if (codeFrom >= codeTo) continue;
    const active = current !== null &&
      sameRange(boundary.code, current);
    let line = view.state.doc.lineAt(codeFrom);
    while (line.from < codeTo) {
      if (active || options.showInactive !== false) {
        lineMarkers.set(
          line.from,
          active || lineMarkers.get(line.from) === true,
        );
      }
      if (line.to >= codeTo || line.to === view.state.doc.length) {
        break;
      }
      line = view.state.doc.line(line.number + 1);
    }
  }
  return RangeSet.of(
    Array.from(lineMarkers, ([position, active]) =>
      (active ? activeMarker : inactiveMarker).range(position)
    ),
    true,
  );
}

function snapshotMatches(
  snapshot: SqlStatementGutterSnapshot,
  view: EditorView,
  contextKey: unknown,
  embeddedRegionsKey: unknown,
): boolean {
  return snapshot.document === view.state.doc &&
    snapshot.selectionHead === view.state.selection.main.head &&
    snapshot.viewportFrom === view.viewport.from &&
    snapshot.viewportTo === view.viewport.to &&
    snapshot.focused === view.hasFocus &&
    snapshot.contextKey === contextKey &&
    snapshot.embeddedRegionsKey === embeddedRegionsKey;
}

export function createSqlStatementGutter(
  options: SqlEditorStatementGutterOptions,
  access: SqlStatementGutterAccess,
): Extension {
  const snapshots = new WeakMap<
    EditorView,
    SqlStatementGutterSnapshot
  >();
  return [
    gutter({
      class: "cm-sql-statement-gutter",
      markers: (view) => {
        const [contextKey, embeddedRegionsKey] =
          access.inputKeys(view);
        const previous = snapshots.get(view);
        if (
          previous !== undefined &&
          snapshotMatches(
            previous,
            view,
            contextKey,
            embeddedRegionsKey,
          )
        ) {
          return previous.markers;
        }
        const markers = buildMarkers(view, options, access);
        snapshots.set(view, {
          contextKey,
          document: view.state.doc,
          embeddedRegionsKey,
          focused: view.hasFocus,
          markers,
          selectionHead: view.state.selection.main.head,
          viewportFrom: view.viewport.from,
          viewportTo: view.viewport.to,
        });
        return markers;
      },
    }),
    EditorView.baseTheme({
      ".cm-sql-statement-gutter": {
        minWidth: "3px",
        width: "3px",
      },
      ".cm-sql-statement-gutter .cm-gutterElement": {
        margin: "0",
        padding: "0",
        width: "3px",
      },
      ".cm-sql-statement-marker": {
        backgroundColor: "var(--cm-sql-statement-color, #3b82f6)",
        borderRadius: "1px",
        display: "block",
        height: "100%",
        width: "3px",
      },
      ".cm-sql-statement-marker-inactive": {
        opacity: "var(--cm-sql-statement-inactive-opacity, 0.3)",
      },
    }),
  ];
}
