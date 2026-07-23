import type { SQLNamespace } from "@codemirror/lang-sql";
import { Facet } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/**
 * A schema source: either a namespace object or a function that resolves one
 * from the current view.
 *
 * When a function is provided it is called on every lint/hover pass, so it
 * should be cheap (return a cached/memoized namespace rather than rebuilding it).
 */
export type SqlSchemaSource = SQLNamespace | ((view: EditorView) => SQLNamespace);

/**
 * Facet holding the SQL schema shared by schema-aware features (hover tooltips,
 * semantic linting). Register it once instead of passing the same schema to
 * each sub-extension:
 *
 * ```ts
 * import { sqlSchemaFacet } from "@marimo-team/codemirror-sql";
 *
 * const extensions = [sqlSchemaFacet.of({ users: ["id", "name"] })];
 * ```
 *
 * Per-extension `schema` config options take precedence over this facet.
 */
export const sqlSchemaFacet = Facet.define<SqlSchemaSource, SqlSchemaSource | null>({
  combine: (values) => values[0] ?? null,
});

/**
 * Resolves a schema for the given view, preferring an explicitly configured
 * source over the {@link sqlSchemaFacet} value.
 */
export function resolveSqlSchema(
  explicit: SqlSchemaSource | undefined,
  view: EditorView,
): SQLNamespace | null {
  const source = explicit ?? view.state.facet(sqlSchemaFacet);
  if (source == null) {
    return null;
  }
  return typeof source === "function" ? source(view) : source;
}
