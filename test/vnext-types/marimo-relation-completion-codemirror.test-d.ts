import type { CompletionInfo } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";

import type {
  SqlCompletionInfoResolver,
  SqlCompletionInfoResolverContext,
} from "../../src/vnext/codemirror/relation-completion-types.js";
import type { SqlRelationCompletionItem } from "../../src/vnext/relation-completion-types.js";

const resolveInfo: SqlCompletionInfoResolver = async (item, { signal }) => {
  signal.throwIfAborted();
  if (item.provenance.kind !== "catalog") {
    return null;
  }

  const root = document.createElement("div");
  root.textContent = `${item.provenance.providerId}:${item.provenance.entityId}`;
  return {
    destroy: () => root.replaceChildren(),
    dom: root,
  };
};

declare const item: SqlRelationCompletionItem;
const resolved: CompletionInfo | Promise<CompletionInfo> = resolveInfo(item, {
  signal: new AbortController().signal,
});

// @ts-expect-error resolver items are immutable
item.label = "changed";
if (item.provenance.kind === "catalog") {
  // @ts-expect-error catalog provenance is immutable
  item.provenance.entityId = "changed";
}

// @ts-expect-error live editor state is not a resolver parameter
const resolverWithView: SqlCompletionInfoResolver = (
  _item: SqlRelationCompletionItem,
  _context: SqlCompletionInfoResolverContext,
  _view: EditorView,
) => null;
// @ts-expect-error arbitrary host values are not CodeMirror completion info
const resolverReturningNumber: SqlCompletionInfoResolver = () => 42;
// @ts-expect-error React-shaped data is not a disposable CodeMirror resource
const resolverReturningReactData: SqlCompletionInfoResolver = () => ({
  props: {},
  type: "table",
});

void resolved;
void resolverReturningNumber;
void resolverReturningReactData;
void resolverWithView;
