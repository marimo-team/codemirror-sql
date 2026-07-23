import { type Extension, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { debug } from "../debug.js";
import {
  identifierTokenAt,
  type SqlRange,
  SqlReferenceResolver,
  type SqlReferenceConfig,
  type SqlReferenceResult,
} from "./references.js";

/**
 * Configuration for the SQL navigation features (go-to-definition, document
 * highlights, rename)
 */
export interface SqlNavigationConfig extends SqlReferenceConfig {
  /**
   * Register keybindings — go-to-definition and rename (default: false).
   * Highlights and Mod-click/Mod-hover need no keybindings and are always on.
   */
  keymap?: boolean;
  /** Keys bound to go-to-definition when `keymap` is enabled (default: ["F12", "Mod-b"]) */
  gotoDefinitionKeys?: string[];
  /** Key bound to rename when `keymap` is enabled (default: "F2") */
  renameKey?: string;
  /**
   * Callback that supplies the new name for a rename, so hosts can plug in
   * their own input UI. Defaults to `window.prompt`. Return null to cancel.
   */
  prompt?: (currentName: string) => string | null | Promise<string | null>;
  /** Debounce for reference highlighting, in ms (default: 150) */
  highlightDelay?: number;
  /** Shared resolver instance (created from the config when omitted) */
  resolver?: SqlReferenceResolver;
}

function getResolver(config: SqlNavigationConfig): SqlReferenceResolver {
  return config.resolver ?? new SqlReferenceResolver(config);
}

const navigationTheme = EditorView.baseTheme({
  ".cm-sqlReference": { backgroundColor: "rgba(96, 165, 250, 0.18)" },
  ".cm-sqlReference.cm-sqlDefinition": { backgroundColor: "rgba(96, 165, 250, 0.35)" },
  ".cm-sqlGotoTarget": { textDecoration: "underline", cursor: "pointer" },
});

const referenceMark = Decoration.mark({ class: "cm-sqlReference" });
const definitionMark = Decoration.mark({ class: "cm-sqlReference cm-sqlDefinition" });
const gotoTargetMark = Decoration.mark({ class: "cm-sqlGotoTarget" });

function markReferences(result: SqlReferenceResult): DecorationSet {
  return Decoration.set(
    result.references.map((range) =>
      (range.from === result.definition.from ? definitionMark : referenceMark).range(
        range.from,
        range.to,
      ),
    ),
    true,
  );
}

const setReferenceHighlights = StateEffect.define<DecorationSet>();

const referenceHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setReferenceHighlights)) {
        return effect.value;
      }
    }
    return tr.docChanged ? decorations.map(tr.changes) : decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * Highlights all references (and the definition) of the statement-local
 * identifier under the cursor — CTE names, table aliases, select aliases.
 */
export function sqlHighlightReferences(config: SqlNavigationConfig = {}): Extension {
  const resolver = getResolver(config);
  const delay = config.highlightDelay ?? 150;

  const plugin = ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null;
      private generation = 0;

      constructor(private view: EditorView) {
        this.schedule();
      }

      update(update: ViewUpdate) {
        if (update.selectionSet || update.docChanged) {
          this.schedule();
        }
      }

      private schedule() {
        this.generation++;
        if (this.timer != null) {
          clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.run();
        }, delay);
      }

      private async run() {
        const generation = this.generation;
        const state = this.view.state;
        const selection = state.selection.main;

        let decorations: DecorationSet = Decoration.none;
        if (selection.empty) {
          try {
            const result = await resolver.resolve(state, selection.head);
            if (result) {
              decorations = markReferences(result);
            }
          } catch (error) {
            debug("sql reference highlight failed", error);
          }
        }

        if (generation !== this.generation) {
          return;
        }
        const current = this.view.state.field(referenceHighlightField, false);
        if (decorations.size === 0 && (current == null || current.size === 0)) {
          return;
        }
        this.view.dispatch({ effects: setReferenceHighlights.of(decorations) });
      }

      destroy() {
        this.generation++;
        if (this.timer != null) {
          clearTimeout(this.timer);
        }
      }
    },
  );

  return [referenceHighlightField, plugin, navigationTheme];
}

/**
 * Jumps the selection to the definition of the identifier at `pos` (the
 * cursor when omitted). Returns false when nothing resolvable is there.
 */
export async function gotoSqlDefinition(
  view: EditorView,
  pos?: number,
  config: SqlNavigationConfig = {},
): Promise<boolean> {
  const at = pos ?? view.state.selection.main.head;
  const result = await getResolver(config).resolve(view.state, at);
  if (!result) {
    return false;
  }
  view.dispatch({
    selection: { anchor: result.definition.from, head: result.definition.to },
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}

const setGotoTarget = StateEffect.define<DecorationSet>();

const gotoTargetField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setGotoTarget)) {
        return effect.value;
      }
    }
    return tr.docChanged ? decorations.map(tr.changes) : decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * Go-to-definition on Mod-click (Cmd on macOS, Ctrl elsewhere), with an
 * underline affordance while hovering a resolvable identifier with the
 * modifier held. Mod-clicks on anything unresolvable keep CodeMirror's
 * default behavior (e.g. adding cursors).
 */
export function sqlGotoDefinition(config: SqlNavigationConfig = {}): Extension {
  const resolver = getResolver(config);

  const plugin = ViewPlugin.fromClass(
    class {
      /** Token currently underlined, with its resolution (null while pending) */
      private hovered: { from: number; to: number; result: SqlReferenceResult | null } | null =
        null;

      constructor(private view: EditorView) {}

      resultAt(pos: number): SqlReferenceResult | null {
        if (this.hovered && pos >= this.hovered.from && pos <= this.hovered.to) {
          return this.hovered.result;
        }
        return null;
      }

      clear() {
        if (this.hovered) {
          this.hovered = null;
          const field = this.view.state.field(gotoTargetField, false);
          if (field && field.size > 0) {
            this.view.dispatch({ effects: setGotoTarget.of(Decoration.none) });
          }
        }
      }

      async hover(pos: number) {
        const token = identifierTokenAt(this.view.state, pos);
        if (!token) {
          this.clear();
          return;
        }
        if (this.hovered && this.hovered.from === token.from && this.hovered.to === token.to) {
          return;
        }
        const hovered: { from: number; to: number; result: SqlReferenceResult | null } = {
          from: token.from,
          to: token.to,
          result: null,
        };
        this.hovered = hovered;
        try {
          const result = await resolver.resolve(this.view.state, pos);
          if (this.hovered !== hovered) {
            return; // moved on while resolving
          }
          hovered.result = result;
          this.view.dispatch({
            effects: setGotoTarget.of(
              result
                ? Decoration.set([gotoTargetMark.range(token.from, token.to)])
                : Decoration.none,
            ),
          });
        } catch (error) {
          debug("sql goto-definition resolve failed", error);
        }
      }

      destroy() {
        this.hovered = null;
      }
    },
    {
      eventHandlers: {
        mousemove(event: MouseEvent, view: EditorView) {
          if (!(event.metaKey || event.ctrlKey)) {
            this.clear();
            return;
          }
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos == null) {
            this.clear();
            return;
          }
          void this.hover(pos);
        },
        mousedown(event: MouseEvent, view: EditorView) {
          if (!(event.metaKey || event.ctrlKey) || event.button !== 0) {
            return false;
          }
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos == null) {
            return false;
          }
          // Only intercept when Mod-hover already resolved this token — an
          // unresolvable Mod-click falls through to the default behavior
          const result = this.resultAt(pos);
          if (!result) {
            return false;
          }
          view.dispatch({
            selection: { anchor: result.definition.from, head: result.definition.to },
            scrollIntoView: true,
            userEvent: "select.pointer",
          });
          return true;
        },
      },
    },
  );

  return [gotoTargetField, plugin, navigationTheme];
}

const defaultPrompt = (currentName: string): string | null =>
  typeof window !== "undefined" && typeof window.prompt === "function"
    ? window.prompt(`Rename '${currentName}' to:`, currentName)
    : null;

/** New names must be plain identifiers so the rewritten SQL stays valid */
const VALID_IDENTIFIER = /^[A-Za-z_][\w$]*$/;

/**
 * Renames the statement-local identifier (CTE name, table alias, or select
 * alias) at the cursor: replaces the definition and every reference in a
 * single transaction (one undo step). Refuses (returns false) when the
 * identifier is not confidently resolvable — never falls back to a plain
 * text search-and-replace.
 */
export async function renameSqlIdentifier(
  view: EditorView,
  config: SqlNavigationConfig = {},
): Promise<boolean> {
  const state = view.state;
  const result = await getResolver(config).resolve(state, state.selection.main.head);
  if (!result) {
    return false;
  }
  const newName = await (config.prompt ?? defaultPrompt)(result.name);
  if (!newName || newName === result.name || !VALID_IDENTIFIER.test(newName)) {
    return false;
  }
  if (view.state !== state) {
    return false; // the document changed while the prompt was open
  }
  view.dispatch({
    changes: result.references.map((range: SqlRange) => ({
      from: range.from,
      to: range.to,
      insert: newName,
    })),
    userEvent: "rename",
  });
  return true;
}

/**
 * Keybindings for go-to-definition (F12 / Mod-b) and rename (F2). Not
 * included by default — enable via `sqlNavigation({ keymap: true })` or add
 * this extension directly.
 */
export function sqlNavigationKeymap(config: SqlNavigationConfig = {}): Extension {
  const resolved: SqlNavigationConfig = { ...config, resolver: getResolver(config) };
  const gotoKeys = config.gotoDefinitionKeys ?? ["F12", "Mod-b"];
  const renameKey = config.renameKey ?? "F2";
  return keymap.of([
    ...gotoKeys.map((key) => ({
      key,
      run: (view: EditorView) => {
        void gotoSqlDefinition(view, undefined, resolved);
        return true;
      },
    })),
    {
      key: renameKey,
      run: (view: EditorView) => {
        void renameSqlIdentifier(view, resolved);
        return true;
      },
    },
  ]);
}

/**
 * The full SQL navigation bundle: document highlights, Mod-click/Mod-hover
 * go-to-definition, and (opt-in via `keymap: true`) F12/Mod-b/F2 bindings.
 */
export function sqlNavigation(config: SqlNavigationConfig = {}): Extension[] {
  const resolved: SqlNavigationConfig = { ...config, resolver: getResolver(config) };
  const extensions: Extension[] = [
    sqlHighlightReferences(resolved),
    sqlGotoDefinition(resolved),
  ];
  if (config.keymap) {
    extensions.push(sqlNavigationKeymap(resolved));
  }
  return extensions;
}
