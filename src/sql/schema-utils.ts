import type { Completion } from "@codemirror/autocomplete";
import type { SQLNamespace } from "@codemirror/lang-sql";
import {
  findNamespaceItemByEndMatch,
  isArrayNamespace,
  isSelfChildrenNamespace,
  type ResolvedNamespaceItem,
  traverseNamespacePath,
} from "./namespace-utils.js";
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
export function resolveTable(
  schema: SQLNamespace,
  tablePath: string | readonly string[],
): { exists: boolean; columns: readonly (Completion | string)[] | null } {
  const exact = traverseNamespacePath(schema, tablePath, { caseSensitive: false });
  const exactColumns = columnsOf(exact?.namespace);
  if (exact) {
    return { exists: true, columns: exactColumns };
  }

  return resolveTableSuffix(schema, tablePath);
}

function resolveTableSuffix(
  schema: SQLNamespace,
  tablePath: string | readonly string[],
): { exists: boolean; columns: readonly (Completion | string)[] | null } {
  const segments = (typeof tablePath === "string" ? tablePath.split(".") : tablePath).map(
    (segment) => segment.toLowerCase(),
  );
  const lastSegment = segments[segments.length - 1];
  if (!lastSegment) {
    return { exists: false, columns: null };
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
  return {
    exists: matches.length > 0,
    columns: matches.length === 1 ? columnsOf(matches[0]?.namespace) : null,
  };
}

export function findTableColumns(
  schema: SQLNamespace,
  tablePath: string | readonly string[],
): readonly (Completion | string)[] | null {
  const exact = traverseNamespacePath(schema, tablePath, { caseSensitive: false });
  return columnsOf(exact?.namespace) ?? resolveTableSuffix(schema, tablePath).columns;
}
