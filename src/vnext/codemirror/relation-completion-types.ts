import type { CompletionInfo } from "@codemirror/autocomplete";

import type { SqlRelationCompletionItem } from "../relation-completion-types.js";

// Provisional CodeMirror-only boundary; the framework-independent core stays DOM-free.
export interface SqlCompletionInfoResolverContext {
  readonly signal: AbortSignal;
}

export type SqlCompletionInfoResolver = (
  item: SqlRelationCompletionItem,
  context: SqlCompletionInfoResolverContext,
) => CompletionInfo | Promise<CompletionInfo>;
