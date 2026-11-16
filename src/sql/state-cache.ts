import type { EditorState, Text } from "@codemirror/state";
import type { SqlParserLike } from "./types.js";

export class SqlStateCache<T extends object> {
  private states = new WeakMap<EditorState, T>();
  private documents = new WeakMap<Text, Map<unknown, T>>();

  constructor(private parser: SqlParserLike) {}

  get(state: EditorState, create: () => T): T {
    const key = this.parser.getCacheKey?.(state);
    if (key === undefined) {
      let value = this.states.get(state);
      if (!value) {
        value = create();
        this.states.set(state, value);
      }
      return value;
    }

    let entries = this.documents.get(state.doc);
    if (!entries) {
      entries = new Map();
      this.documents.set(state.doc, entries);
    }
    let value = entries.get(key);
    if (!value) {
      value = create();
      entries.set(key, value);
      if (entries.size > 10) entries.delete(entries.keys().next().value);
    }
    return value;
  }

  clear(): void {
    this.states = new WeakMap();
    this.documents = new WeakMap();
  }
}
