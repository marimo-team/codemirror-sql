import type { SqlRelationCompletionItem } from "../relation-completion-types.js";

// Provisional CodeMirror-only boundary; the framework-independent core stays DOM-free.
export interface SqlCompletionInfoResolverContext {
  readonly signal: AbortSignal;
}

export interface SqlDisposableCompletionInfo {
  readonly dom: Node;
  readonly destroy: () => void;
}

export type SqlCompletionInfoResolver = (
  item: SqlRelationCompletionItem,
  context: SqlCompletionInfoResolverContext,
) =>
  | SqlDisposableCompletionInfo
  | null
  | Promise<SqlDisposableCompletionInfo | null>;
