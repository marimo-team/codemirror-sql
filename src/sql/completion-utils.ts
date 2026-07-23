import type { Completion, CompletionContext } from "@codemirror/autocomplete";
import type { SQLNamespace } from "@codemirror/lang-sql";
import {
  findNamespaceItemByEndMatch,
  isArrayNamespace,
  isSelfChildrenNamespace,
  type ResolvedNamespaceItem,
  traverseNamespacePath,
} from "./namespace-utils.js";
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
    // Function sources need a view; contexts created without one (e.g. tests)
    // simply get no schema
    return context.view ? source(context.view) : null;
  }
  return source;
}

/** Column list of a namespace node, when it is (or wraps) a column array */
export function columnsOf(
  namespace: SQLNamespace | undefined,
): readonly (Completion | string)[] | null {
  if (namespace == null) {
    return null;
  }
  const resolved = isSelfChildrenNamespace(namespace) ? namespace.children : namespace;
  return isArrayNamespace(resolved) ? resolved : null;
}

/**
 * Resolves a (possibly qualified) table path to its column list,
 * case-insensitively. An under-qualified name also matches a table nested
 * deeper in the namespace (e.g. `users` matches `mydb.users`). Pre-split
 * segments preserve identifier boundaries when a segment contains a dot
 * (e.g. a `"my.db"` quoted identifier).
 */
export function findTableColumns(
  schema: SQLNamespace,
  tablePath: string | readonly string[],
): readonly (Completion | string)[] | null {
  const exact = traverseNamespacePath(schema, tablePath, { caseSensitive: false });
  const exactColumns = columnsOf(exact?.namespace);
  if (exactColumns) {
    return exactColumns;
  }

  const segments = (typeof tablePath === "string" ? tablePath.split(".") : tablePath).map(
    (segment) => segment.toLowerCase(),
  );
  const lastSegment = segments[segments.length - 1];
  if (!lastSegment) {
    return null;
  }

  const matches = findNamespaceItemByEndMatch(schema, lastSegment).filter(
    (item: ResolvedNamespaceItem) => {
      if (columnsOf(item.namespace) === null) {
        return false;
      }
      if (item.path.length < segments.length) {
        return false;
      }
      const suffix = item.path.slice(-segments.length).map((segment) => segment.toLowerCase());
      return segments.every((segment, i) => suffix[i] === segment);
    },
  );

  // Only trust the column list when the match is unambiguous
  return matches.length === 1 ? columnsOf(matches[0]?.namespace) : null;
}

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
