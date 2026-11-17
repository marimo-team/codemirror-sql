import type { Completion } from "@codemirror/autocomplete";
import type { SQLNamespace } from "@codemirror/lang-sql";

export type SemanticType = "database" | "schema" | "table" | "column" | "namespace";

export interface ResolvedNamespaceItem {
  completion?: Completion;
  value?: string;
  path: string[];
  type: "completion" | "string" | "namespace";
  semanticType: SemanticType;
  namespace?: SQLNamespace;
}

type NamespaceNode = ResolvedNamespaceItem & (
  | { type: "completion"; completion: Completion; value?: never }
  | { type: "string"; value: string; completion?: never }
  | { type: "namespace"; completion?: never; value?: never }
);

export interface NamespaceSearchConfig {
  /** Maximum depth to search (default: 10) */
  maxDepth?: number;
  /** Whether to perform case-sensitive matching (default: false) */
  caseSensitive?: boolean;
  /** Whether to allow partial matching (default: true) */
  allowPartialMatch?: boolean;
  /** Whether to enable fuzzy search (default: false) */
  enableFuzzySearch?: boolean;
}

export function isObjectNamespace(
  namespace: SQLNamespace,
): namespace is { [name: string]: SQLNamespace } {
  return (
    typeof namespace === "object" && !Array.isArray(namespace) && !isSelfChildrenNamespace(namespace)
  );
}

export function isSelfChildrenNamespace(
  namespace: SQLNamespace,
): namespace is { self: Completion; children: SQLNamespace } {
  if (typeof namespace !== "object" || Array.isArray(namespace)) {
    return false;
  }
  if (!("self" in namespace) || !("children" in namespace)) {
    return false;
  }
  // A self tag is a Completion; a table named "self" holds a namespace instead
  const self: unknown = namespace.self;
  return (
    typeof self === "object" &&
    self !== null &&
    !Array.isArray(self) &&
    "label" in self && typeof self.label === "string"
  );
}

export function isArrayNamespace(
  namespace: SQLNamespace,
): namespace is readonly (Completion | string)[] {
  return Array.isArray(namespace);
}

function determineSemanticType(
  path: string[],
  type: "completion" | "string" | "namespace",
  namespace?: SQLNamespace,
  parentNamespace?: SQLNamespace,
): SemanticType {
  const depth = path.length;

  if (
    type === "string" ||
    (type === "completion" && parentNamespace && isArrayNamespace(parentNamespace))
  ) {
    return "column";
  }

  if (type === "namespace" && namespace) {
    if (isArrayNamespace(namespace)) {
      return "table";
    }

    if (isObjectNamespace(namespace)) {
      const hasTableChildren = Object.values(namespace).some(
        (child) =>
          isArrayNamespace(child) ||
          (isSelfChildrenNamespace(child) && isArrayNamespace(child.children)),
      );

      if (hasTableChildren) {
        return depth <= 1 ? "database" : "schema";
      } else {
        return depth === 0 ? "database" : "namespace";
      }
    }
  }

  if (type === "completion" && namespace) {
    if (isArrayNamespace(namespace)) {
      return "table";
    }
    return depth <= 1 ? "database" : "schema";
  }

  switch (depth) {
    case 0:
      return "database";
    case 1:
      return "schema";
    default:
      return "namespace";
  }
}

/** Resolve a path; pre-split segments preserve dots inside quoted identifiers. */
export function traverseNamespacePath(
  namespace: SQLNamespace,
  path: string | readonly string[],
  config: NamespaceSearchConfig = {},
): ResolvedNamespaceItem | null {
  const { maxDepth = 10 } = config;
  const isEmptyPath = typeof path === "string" ? path === "" : path.length === 0;

  if (isEmptyPath && isSelfChildrenNamespace(namespace)) {
    const semanticType = determineSemanticType([], "completion", namespace.children);
    return {
      completion: namespace.self,
      path: [],
      type: "completion",
      semanticType,
      namespace: namespace.children,
    };
  }

  const pathParts = (typeof path === "string" ? path.split(".") : path).filter(
    (part) => part.length > 0,
  );

  if (pathParts.length === 0) {
    return null;
  }

  if (pathParts.length > maxDepth) {
    return null;
  }

  return traverseNamespaceRecursive(namespace, pathParts, [], config);
}

function traverseNamespaceRecursive(
  namespace: SQLNamespace,
  remainingPath: string[],
  currentPath: string[],
  config: NamespaceSearchConfig,
  parentNamespace?: SQLNamespace,
): NamespaceNode | null {
  if (remainingPath.length === 0) {
    if (isSelfChildrenNamespace(namespace)) {
      const semanticType = determineSemanticType(
        currentPath,
        "completion",
        namespace.children,
        parentNamespace,
      );
      return {
        completion: namespace.self,
        path: currentPath,
        type: "completion",
        semanticType,
        namespace: namespace.children,
      };
    }
    const semanticType = determineSemanticType(
      currentPath,
      "namespace",
      namespace,
      parentNamespace,
    );
    return {
      path: currentPath,
      type: "namespace",
      semanticType,
      namespace,
    };
  }

  const [currentSegment, ...restPath] = remainingPath;
  const { caseSensitive = false } = config;

  if (!currentSegment) {
    return null;
  }

  if (isObjectNamespace(namespace)) {
    const targetKey = caseSensitive
      ? Object.keys(namespace).find((key) => key === currentSegment)
      : Object.keys(namespace).find((key) => key.toLowerCase() === currentSegment.toLowerCase());

    if (targetKey) {
      const childNamespace = namespace[targetKey];
      if (childNamespace) {
        return traverseNamespaceRecursive(
          childNamespace,
          restPath,
          [...currentPath, targetKey],
          config,
          namespace,
        );
      }
    }
  } else if (isSelfChildrenNamespace(namespace)) {
    return traverseNamespaceRecursive(
      namespace.children,
      remainingPath,
      currentPath,
      config,
      namespace,
    );
  } else if (isArrayNamespace(namespace)) {
    for (const item of namespace) {
      if (typeof item === "string") {
        const matches = caseSensitive
          ? item === currentSegment
          : item.toLowerCase() === currentSegment.toLowerCase();

        if (matches && restPath.length === 0) {
          const semanticType = determineSemanticType(
            [...currentPath, item],
            "string",
            undefined,
            namespace,
          );
          return {
            value: item,
            path: [...currentPath, item],
            type: "string",
            semanticType,
          };
        }
      } else {
        const matches = caseSensitive
          ? item.label === currentSegment
          : item.label.toLowerCase() === currentSegment.toLowerCase();

        if (matches && restPath.length === 0) {
          const semanticType = determineSemanticType(
            [...currentPath, item.label],
            "completion",
            undefined,
            namespace,
          );
          return {
            completion: item,
            path: [...currentPath, item.label],
            type: "completion",
            semanticType,
          };
        }
      }
    }
  }

  return null;
}

/** Complete a prefix within its parent namespace, e.g. `db.ta`. */
export function findNamespaceCompletions(
  namespace: SQLNamespace,
  prefix: string,
  config: NamespaceSearchConfig = {},
): ResolvedNamespaceItem[] {
  const results: NamespaceNode[] = [];

  if (prefix.includes(".")) {
    const lastDotIndex = prefix.lastIndexOf(".");
    const basePath = prefix.substring(0, lastDotIndex);
    const finalSegment = prefix.substring(lastDotIndex + 1);

    const baseNode = traverseNamespacePath(namespace, basePath, config);
    if (baseNode?.namespace) {
      return findCompletionsInNamespace(baseNode.namespace, finalSegment, baseNode.path, config);
    }
  } else {
    return findCompletionsInNamespace(namespace, prefix, [], config);
  }

  return results;
}

function findCompletionsInNamespace(
  namespace: SQLNamespace,
  prefix: string,
  basePath: string[],
  config: NamespaceSearchConfig,
): NamespaceNode[] {
  const results: NamespaceNode[] = [];
  const { caseSensitive = false, allowPartialMatch = true } = config;

  if (isObjectNamespace(namespace)) {
    for (const [key, value] of Object.entries(namespace)) {
      const matches = allowPartialMatch
        ? caseSensitive
          ? key.startsWith(prefix)
          : key.toLowerCase().startsWith(prefix.toLowerCase())
        : caseSensitive
          ? key === prefix
          : key.toLowerCase() === prefix.toLowerCase();

      if (matches) {
        if (isSelfChildrenNamespace(value)) {
          const semanticType = determineSemanticType(
            [...basePath, key],
            "completion",
            value.children,
            namespace,
          );
          results.push({
            completion: value.self,
            path: [...basePath, key],
            type: "completion",
            semanticType,
            namespace: value.children,
          });
        } else {
          const semanticType = determineSemanticType(
            [...basePath, key],
            "namespace",
            value,
            namespace,
          );
          results.push({
            path: [...basePath, key],
            type: "namespace",
            semanticType,
            namespace: value,
          });
        }
      }
    }
  } else if (isSelfChildrenNamespace(namespace)) {
    const selfMatches = allowPartialMatch
      ? caseSensitive
        ? namespace.self.label.startsWith(prefix)
        : namespace.self.label.toLowerCase().startsWith(prefix.toLowerCase())
      : caseSensitive
        ? namespace.self.label === prefix
        : namespace.self.label.toLowerCase() === prefix.toLowerCase();

    if (selfMatches) {
      const semanticType = determineSemanticType(
        [...basePath, namespace.self.label],
        "completion",
        namespace.children,
      );
      results.push({
        completion: namespace.self,
        path: [...basePath, namespace.self.label],
        type: "completion",
        semanticType,
        namespace: namespace.children,
      });
    }

    results.push(...findCompletionsInNamespace(namespace.children, prefix, basePath, config));
  } else if (isArrayNamespace(namespace)) {
    for (const item of namespace) {
      if (typeof item === "string") {
        const matches = allowPartialMatch
          ? caseSensitive
            ? item.startsWith(prefix)
            : item.toLowerCase().startsWith(prefix.toLowerCase())
          : caseSensitive
            ? item === prefix
            : item.toLowerCase() === prefix.toLowerCase();

        if (matches) {
          const semanticType = determineSemanticType(
            [...basePath, item],
            "string",
            undefined,
            namespace,
          );
          results.push({
            value: item,
            path: [...basePath, item],
            type: "string",
            semanticType,
          });
        }
      } else {
        const matches = allowPartialMatch
          ? caseSensitive
            ? item.label.startsWith(prefix)
            : item.label.toLowerCase().startsWith(prefix.toLowerCase())
          : caseSensitive
            ? item.label === prefix
            : item.label.toLowerCase() === prefix.toLowerCase();

        if (matches) {
          const semanticType = determineSemanticType(
            [...basePath, item.label],
            "completion",
            undefined,
            namespace,
          );
          results.push({
            completion: item,
            path: [...basePath, item.label],
            type: "completion",
            semanticType,
          });
        }
      }
    }
  }

  return results;
}

/** Match any path segment, ranking final-segment matches first, then shorter paths. */
export function findNamespaceItemByEndMatch(
  namespace: SQLNamespace,
  identifier: string,
  config: NamespaceSearchConfig = {},
): ResolvedNamespaceItem[] {
  const results: NamespaceNode[] = [];
  const { maxDepth = 10 } = config;

  collectAllItems(namespace, [], results, maxDepth);

  const { caseSensitive = false } = config;
  const matchingResults = results.filter((item) => {
    return item.path.some((segment) =>
      caseSensitive ? segment === identifier : segment.toLowerCase() === identifier.toLowerCase(),
    );
  });

  return matchingResults.sort((a, b) => {
    const aIsLastSegment = caseSensitive
      ? a.path[a.path.length - 1] === identifier
      : a.path[a.path.length - 1]?.toLowerCase() === identifier.toLowerCase();
    const bIsLastSegment = caseSensitive
      ? b.path[b.path.length - 1] === identifier
      : b.path[b.path.length - 1]?.toLowerCase() === identifier.toLowerCase();

    if (aIsLastSegment && !bIsLastSegment) return -1;
    if (!aIsLastSegment && bIsLastSegment) return 1;
    return a.path.length - b.path.length;
  });
}

function collectAllItems(
  namespace: SQLNamespace,
  currentPath: string[],
  results: NamespaceNode[],
  maxDepth: number,
): void {
  if (currentPath.length >= maxDepth) {
    return;
  }

  if (isObjectNamespace(namespace)) {
    for (const [key, value] of Object.entries(namespace)) {
      const newPath = [...currentPath, key];

      if (isSelfChildrenNamespace(value)) {
        const semanticType = determineSemanticType(
          newPath,
          "completion",
          value.children,
          namespace,
        );
        results.push({
          completion: value.self,
          path: newPath,
          type: "completion",
          semanticType,
          namespace: value.children,
        });
        collectAllItems(value.children, newPath, results, maxDepth);
      } else {
        const semanticType = determineSemanticType(newPath, "namespace", value, namespace);
        results.push({
          path: newPath,
          type: "namespace",
          semanticType,
          namespace: value,
        });
        collectAllItems(value, newPath, results, maxDepth);
      }
    }
  } else if (isSelfChildrenNamespace(namespace)) {
    const semanticType = determineSemanticType(currentPath, "completion", namespace.children);
    results.push({
      completion: namespace.self,
      path: currentPath,
      type: "completion",
      semanticType,
      namespace: namespace.children,
    });
    collectAllItems(namespace.children, currentPath, results, maxDepth);
  } else if (isArrayNamespace(namespace)) {
    for (const item of namespace) {
      if (typeof item === "string") {
        const semanticType = determineSemanticType(
          [...currentPath, item],
          "string",
          undefined,
          namespace,
        );
        results.push({
          value: item,
          path: [...currentPath, item],
          type: "string",
          semanticType,
        });
      } else {
        const semanticType = determineSemanticType(
          [...currentPath, item.label],
          "completion",
          undefined,
          namespace,
        );
        results.push({
          completion: item,
          path: [...currentPath, item.label],
          type: "completion",
          semanticType,
        });
      }
    }
  }
}

/** Resolve by exact path, then prefix, then optional segment matching. */
export function resolveNamespaceItem(
  namespace: SQLNamespace,
  identifier: string,
  config: NamespaceSearchConfig = {},
): ResolvedNamespaceItem | null {
  const { enableFuzzySearch = false } = config;

  const exactMatch = traverseNamespacePath(namespace, identifier, config);
  if (exactMatch) {
    return exactMatch;
  }

  const completions = findNamespaceCompletions(namespace, identifier, config);
  if (completions.length > 0) {
    return completions[0] || null;
  }

  if (enableFuzzySearch) {
    const endMatches = findNamespaceItemByEndMatch(namespace, identifier, config);
    if (endMatches.length > 0) {
      return endMatches[0] || null;
    }
  }

  return null;
}
