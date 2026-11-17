import type { Completion, CompletionContext } from "@codemirror/autocomplete";
import type { SQLNamespace } from "@codemirror/lang-sql";
import { type SqlSchemaSource, sqlSchemaFacet } from "./schema-facet.js";

export function resolveSchema(
  explicit: SqlSchemaSource | undefined,
  context: CompletionContext,
): SQLNamespace | null {
  const source = explicit ?? context.state.facet(sqlSchemaFacet);
  if (source == null) {
    return null;
  }
  if (typeof source === "function") {
    // Function schema sources require a live editor view.
    return context.view ? source(context.view) : null;
  }
  return source;
}

export { columnsOf, findTableColumns } from "./schema-utils.js";

export function toCompletion(
  column: Completion | string,
  detail: string,
  boost?: number,
): Completion {
  if (typeof column === "string") {
    return boost === undefined
      ? { label: column, type: "property", detail }
      : { label: column, type: "property", detail, boost };
  }
  const completion: Completion = { ...column, type: "property", detail: column.detail ?? detail };
  if (boost !== undefined && completion.boost === undefined) {
    completion.boost = boost;
  }
  return completion;
}
