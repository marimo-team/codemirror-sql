import type { SQLDialect, SQLNamespace } from "@codemirror/lang-sql";
import type { Extension } from "@codemirror/state";
import { EditorView, hoverTooltip, type Tooltip } from "@codemirror/view";
import { debug } from "../debug.js";
import {
  isArrayNamespace,
  type ResolvedNamespaceItem,
  resolveNamespaceItem,
} from "./namespace-utils.js";

/**
 * SQL schema information for hover tooltips
 */
export interface SqlSchema {
  [tableName: string]: string[];
}

/**
 * SQL keyword information
 */
export interface SqlKeywordInfo {
  description?: string;
  syntax?: string;
  example?: string;
  metadata?: Record<string, string>;
}

/**
 * Data passed to keyword tooltip renderers
 */
export interface KeywordTooltipData {
  keyword: string;
  info: SqlKeywordInfo;
}

/**
 * Data passed to namespace tooltip renderers (namespace, table, column)
 */
export interface NamespaceTooltipData {
  item: ResolvedNamespaceItem;
  /** The word being hovered over */
  word: string;
  /** The resolved schema context */
  resolvedSchema: SQLNamespace;
}

/**
 * Configuration for SQL hover tooltips
 */
export interface SqlHoverConfig {
  /** Database schema for table and column information */
  schema?: SQLNamespace | ((view: EditorView) => SQLNamespace);
  /** SQL dialect for keyword information */
  dialect?: SQLDialect | ((view: EditorView) => SQLDialect);
  /** Custom keyword information */
  keywords?:
    | Record<string, SqlKeywordInfo>
    | ((view: EditorView) => Promise<Record<string, SqlKeywordInfo>>);
  /** Hover delay in milliseconds (default: 300) */
  hoverTime?: number;
  /** Enable hover for keywords (default: true) */
  enableKeywords?: boolean;
  /** Enable hover for tables (default: true) */
  enableTables?: boolean;
  /** Enable hover for columns (default: true) */
  enableColumns?: boolean;
  /** Enable fuzzy search for namespace items (default: false) */
  enableFuzzySearch?: boolean;
  /** Custom tooltip renderers for different item types */
  tooltipRenderers?: {
    /** Custom renderer for SQL keywords */
    keyword?: (data: KeywordTooltipData) => string;
    /** Custom renderer for namespace items (database, schema, generic namespace) */
    namespace?: (data: NamespaceTooltipData) => string;
    /** Custom renderer for table items */
    table?: (data: NamespaceTooltipData) => string;
    /** Custom renderer for column items */
    column?: (data: NamespaceTooltipData) => string;
  };
}

/**
 * Creates a hover tooltip extension for SQL
 */
export function sqlHover(config: SqlHoverConfig = {}): Extension {
  const {
    schema = {},
    keywords = {},
    hoverTime = 300,
    enableKeywords = true,
    enableTables = true,
    enableColumns = true,
    enableFuzzySearch = true,
    tooltipRenderers = {},
  } = config;

  let keywordsPromise: Promise<Record<string, SqlKeywordInfo>> | null = null;

  return hoverTooltip(
    async (view: EditorView, pos: number, side: number): Promise<Tooltip | null> => {
      const { from, to, text } = view.state.doc.lineAt(pos);
      let start = pos;
      let end = pos;

      if (keywordsPromise === null) {
        keywordsPromise =
          typeof keywords === "function" ? keywords(view) : Promise.resolve(keywords);
      }

      const resolvedKeywords = await keywordsPromise;

      // Find word boundaries (including dots for table.column syntax)
      while (start > from && /[\w.]/.test(text[start - from - 1] ?? "")) start--;
      while (end < to && /[\w.]/.test(text[end - from] ?? "")) end++;

      // Validate pointer position within word
      if ((start === pos && side < 0) || (end === pos && side > 0)) {
        return null;
      }

      const word = text.slice(start - from, end - from).toLowerCase();
      if (!word || word.length === 0) {
        return null;
      }

      const resolvedSchema = typeof schema === "function" ? schema(view) : schema;

      let tooltipContent: string | null = null;

      debug(`hover word: '${word}'`);

      // Implement preference order:
      // 1. Look in keywords if it exists
      // 2. Look for it in SQLNamespace as is
      // 3. If neither, look in SQLNamespace and try to guess (fuzzy match)

      // Step 1: If no namespace match, try keywords
      if (!tooltipContent && enableKeywords && resolvedKeywords[word]) {
        debug("keywordResult", word, resolvedKeywords[word]);
        const keywordData: KeywordTooltipData = { keyword: word, info: resolvedKeywords[word] };
        tooltipContent = tooltipRenderers.keyword
          ? tooltipRenderers.keyword(keywordData)
          : createKeywordTooltip(keywordData);
      }

      // Step 2: Try to resolve directly in SQLNamespace
      if (!tooltipContent && (enableTables || enableColumns) && resolvedSchema) {
        const namespaceResult = resolveNamespaceItem(resolvedSchema, word, {
          enableFuzzySearch,
        });
        if (namespaceResult) {
          debug("namespaceResult", word, namespaceResult);
          const namespaceData: NamespaceTooltipData = {
            item: namespaceResult,
            word,
            resolvedSchema,
          };

          // Use custom renderer based on semantic type, fallback to default
          const { semanticType } = namespaceResult;
          if (semanticType === "table" && tooltipRenderers.table) {
            tooltipContent = tooltipRenderers.table(namespaceData);
          } else if (semanticType === "column" && tooltipRenderers.column) {
            tooltipContent = tooltipRenderers.column(namespaceData);
          } else if (
            (semanticType === "database" ||
              semanticType === "schema" ||
              semanticType === "namespace") &&
            tooltipRenderers.namespace
          ) {
            tooltipContent = tooltipRenderers.namespace(namespaceData);
          } else {
            // Fallback to default renderer
            tooltipContent = createNamespaceTooltip(namespaceResult);
          }
        }
      }

      // Step 3: Fuzzy matching is handled by resolveNamespaceItem if enableFuzzySearch is true

      if (!tooltipContent) {
        return null;
      }

      return {
        pos: start,
        end,
        above: true,
        create(_view: EditorView) {
          const dom = document.createElement("div");
          dom.className = "cm-sql-hover-tooltip";
          dom.innerHTML = tooltipContent!;
          return { dom };
        },
      };
    },
    { hoverTime },
  );
}

/**
 * Creates HTML content for namespace-resolved items
 */
function createNamespaceTooltip(item: ResolvedNamespaceItem): string {
  const pathStr = item.path.join(".");
  const name = item.completion?.label || item.value || item.path[item.path.length - 1] || "unknown";

  let html = `<div class="sql-hover-${item.semanticType}">`;
  html += `<div class="sql-hover-header"><strong>${name}</strong> <span class="sql-hover-type">${item.semanticType}</span></div>`;

  // Add semantic-specific descriptions and information
  switch (item.semanticType) {
    case "database":
      html += `<div class="sql-hover-description">Database${item.completion?.detail ? `: ${item.completion.detail}` : ""}</div>`;
      if (item.namespace) {
        const childCount = countNamespaceChildren(item.namespace);
        if (childCount > 0) {
          html += `<div class="sql-hover-children">Contains ${childCount} schema${childCount !== 1 ? "s" : ""}</div>`;
        }
      }
      break;

    case "schema":
      html += `<div class="sql-hover-description">Schema${item.completion?.detail ? `: ${item.completion.detail}` : ""}</div>`;
      if (pathStr) {
        html += `<div class="sql-hover-path"><strong>Path:</strong> <code>${pathStr}</code></div>`;
      }
      if (item.namespace) {
        const childCount = countNamespaceChildren(item.namespace);
        if (childCount > 0) {
          html += `<div class="sql-hover-children">Contains ${childCount} table${childCount !== 1 ? "s" : ""}</div>`;
        }
      }
      break;

    case "table":
      html += `<div class="sql-hover-description">Table${item.completion?.detail ? `: ${item.completion.detail}` : ""}</div>`;
      if (pathStr) {
        const pathParts = item.path;
        if (pathParts.length > 1) {
          html += `<div class="sql-hover-path"><strong>Schema:</strong> <code>${pathParts.slice(0, -1).join(".")}</code></div>`;
        }
      }

      // Show column information for tables
      if (item.namespace && isArrayNamespace(item.namespace)) {
        const columns = item.namespace;
        if (columns.length > 0) {
          html += `<div class="sql-hover-columns"><strong>Columns (${columns.length}):</strong><br>`;
          const displayColumns = columns.slice(0, 8);
          const columnNames = displayColumns.map((col) =>
            typeof col === "string" ? col : col.label,
          );
          html += columnNames.map((col) => `<code>${col}</code>`).join(", ");

          if (columns.length > 8) {
            html += `, <em>and ${columns.length - 8} more...</em>`;
          }
          html += `</div>`;
        }
      }
      break;

    case "column":
      html += `<div class="sql-hover-description">Column${item.completion?.detail ? `: ${item.completion.detail}` : ""}</div>`;
      if (pathStr) {
        const pathParts = item.path;
        if (pathParts.length > 1) {
          html += `<div class="sql-hover-path"><strong>Table:</strong> <code>${pathParts.slice(0, -1).join(".")}</code></div>`;
        }
      }
      break;
    default:
      html += `<div class="sql-hover-description">Namespace${item.completion?.detail ? `: ${item.completion.detail}` : ""}</div>`;
      if (pathStr) {
        html += `<div class="sql-hover-path"><strong>Path:</strong> <code>${pathStr}</code></div>`;
      }
      if (item.namespace) {
        const childCount = countNamespaceChildren(item.namespace);
        if (childCount > 0) {
          html += `<div class="sql-hover-children">Contains ${childCount} item${childCount !== 1 ? "s" : ""}</div>`;
        }
      }
      break;
  }

  // Add completion-specific info if available
  if (item.completion?.info) {
    html += `<div class="sql-hover-info">${item.completion.info}</div>`;
  }

  html += `</div>`;
  return html;
}

/**
 * Helper function to count children in a namespace
 */
function countNamespaceChildren(namespace: SQLNamespace): number {
  if (Array.isArray(namespace)) {
    return namespace.length;
  } else if (typeof namespace === "object" && namespace !== null) {
    if ("self" in namespace && "children" in namespace) {
      return 1 + countNamespaceChildren(namespace.children);
    } else {
      return Object.keys(namespace).length;
    }
  }
  return 0;
}

/**
 * Creates HTML content for keyword tooltips
 * Renders metadata as tags if present
 */
function createKeywordTooltip(opts: { keyword: string; info: SqlKeywordInfo }): string {
  const { keyword, info } = opts;

  let html = `<div class="sql-hover-keyword">`;
  html += `<div class="sql-hover-header"><strong>${keyword.toUpperCase()}</strong> <span class="sql-hover-type">keyword</span></div>`;
  html += `<div class="sql-hover-description">${info.description}</div>`;

  if (info.syntax) {
    html += `<div class="sql-hover-syntax"><strong>Syntax:</strong> <code>${info.syntax}</code></div>`;
  }

  if (info.example) {
    html += `<div class="sql-hover-example"><strong>Example:</strong><br><code>${info.example}</code></div>`;
  }

  if (info.metadata && typeof info.metadata === "object" && Object.keys(info.metadata).length > 0) {
    html += `<div class="sql-hover-metadata">`;
    for (const [key, value] of Object.entries(info.metadata)) {
      html += `<span class="sql-hover-tag" title="${key}">${value}</span> `;
    }
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

/**
 * Creates HTML content for table tooltips
 */
function createTableTooltip(opts: {
  tableName: string;
  columns: string[];
  metadata?: Record<string, string>;
}): string {
  const { tableName, columns, metadata } = opts;

  let html = `<div class="sql-hover-table">`;
  html += `<div class="sql-hover-header"><strong>${tableName}</strong> <span class="sql-hover-type">table</span></div>`;
  html += `<div class="sql-hover-description">Table with ${columns.length} column${columns.length !== 1 ? "s" : ""}</div>`;

  if (columns.length > 0) {
    html += `<div class="sql-hover-columns"><strong>Columns:</strong><br>`;
    const displayColumns = columns.slice(0, 10); // Show max 10 columns
    html += displayColumns.map((col) => `<code>${col}</code>`).join(", ");

    if (columns.length > 10) {
      html += `, <em>and ${columns.length - 10} more...</em>`;
    }
    html += `</div>`;
  }

  if (metadata && typeof metadata === "object" && Object.keys(metadata).length > 0) {
    html += `<div class="sql-hover-metadata">`;
    for (const [key, value] of Object.entries(metadata)) {
      html += `<span class="sql-hover-tag" title="${key}">${value}</span> `;
    }
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

/**
 * Creates HTML content for column tooltips
 */
function createColumnTooltip(opts: {
  tableName: string;
  columnName: string;
  schema: SqlSchema;
  metadata?: Record<string, string>;
}): string {
  const { tableName, columnName, schema, metadata } = opts;

  let html = `<div class="sql-hover-column">`;
  html += `<div class="sql-hover-header"><strong>${columnName}</strong> <span class="sql-hover-type">column</span></div>`;
  html += `<div class="sql-hover-description">Column in table <code>${tableName}</code></div>`;

  const allColumns = schema[tableName];
  if (allColumns && allColumns.length > 1) {
    const otherColumns = allColumns.filter((col) => col !== columnName);
    if (otherColumns.length > 0) {
      html += `<div class="sql-hover-related"><strong>Other columns in ${tableName}:</strong><br>`;
      const displayColumns = otherColumns.slice(0, 8); // Show max 8 other columns
      html += displayColumns.map((col) => `<code>${col}</code>`).join(", ");

      if (otherColumns.length > 8) {
        html += `, <em>and ${otherColumns.length - 8} more...</em>`;
      }
      html += `</div>`;
    }
  }

  if (metadata && typeof metadata === "object" && Object.keys(metadata).length > 0) {
    html += `<div class="sql-hover-metadata">`;
    for (const [key, value] of Object.entries(metadata)) {
      html += `<span class="sql-hover-tag" title="${key}">${value}</span> `;
    }
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

export const DefaultSqlTooltipRenders = {
  keyword: createKeywordTooltip,
  table: createTableTooltip,
  column: createColumnTooltip,
  namespace: createNamespaceTooltip,
};

/**
 * Default CSS styles for hover tooltips
 */
export const sqlHoverTheme = (): Extension =>
  EditorView.theme({
    ".cm-sql-hover-tooltip": {
      padding: "8px 12px",
      backgroundColor: "#ffffff",
      border: "1px solid #e5e7eb",
      borderRadius: "6px",
      boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)",
      fontSize: "13px",
      lineHeight: "1.4",
      maxWidth: "320px",
      fontFamily: "system-ui, -apple-system, sans-serif",
    },
    ".cm-sql-hover-tooltip .sql-hover-header": {
      marginBottom: "6px",
      display: "flex",
      alignItems: "center",
      gap: "6px",
    },
    ".cm-sql-hover-tooltip .sql-hover-type": {
      fontSize: "11px",
      padding: "2px 6px",
      backgroundColor: "#f3f4f6",
      color: "#6b7280",
      borderRadius: "4px",
      fontWeight: "500",
    },
    ".cm-sql-hover-tooltip .sql-hover-description": {
      color: "#374151",
      marginBottom: "8px",
    },
    ".cm-sql-hover-tooltip .sql-hover-syntax": {
      marginBottom: "8px",
      color: "#374151",
    },
    ".cm-sql-hover-tooltip .sql-hover-example": {
      marginBottom: "4px",
      color: "#374151",
    },
    ".cm-sql-hover-tooltip .sql-hover-columns": {
      marginBottom: "4px",
      color: "#374151",
    },
    ".cm-sql-hover-tooltip .sql-hover-related": {
      marginBottom: "4px",
      color: "#374151",
    },
    ".cm-sql-hover-tooltip .sql-hover-path": {
      marginBottom: "4px",
      color: "#374151",
    },
    ".cm-sql-hover-tooltip .sql-hover-info": {
      marginBottom: "4px",
      color: "#374151",
    },
    ".cm-sql-hover-tooltip .sql-hover-children": {
      marginBottom: "4px",
      color: "#6b7280",
      fontSize: "12px",
    },
    ".cm-sql-hover-tooltip code": {
      backgroundColor: "#f9fafb",
      padding: "1px 4px",
      borderRadius: "3px",
      fontSize: "12px",
      fontFamily: "ui-monospace, 'SF Mono', 'Monaco', 'Cascadia Code', 'Roboto Mono', monospace",
      color: "#1f2937",
    },
    ".cm-sql-hover-tooltip strong": {
      fontWeight: "600",
      color: "#111827",
    },
    ".cm-sql-hover-tooltip em": {
      fontStyle: "italic",
      color: "#6b7280",
    },
    // Dark theme support
    ".cm-editor.cm-focused.cm-dark .cm-sql-hover-tooltip": {
      backgroundColor: "#1f2937",
      borderColor: "#374151",
      color: "#f9fafb",
    },
    ".cm-editor.cm-focused.cm-dark .cm-sql-hover-tooltip .sql-hover-type": {
      backgroundColor: "#374151",
      color: "#9ca3af",
    },
    ".cm-editor.cm-focused.cm-dark .cm-sql-hover-tooltip .sql-hover-description": {
      color: "#d1d5db",
    },
    ".cm-editor.cm-focused.cm-dark .cm-sql-hover-tooltip .sql-hover-syntax": {
      color: "#d1d5db",
    },
    ".cm-editor.cm-focused.cm-dark .cm-sql-hover-tooltip .sql-hover-example": {
      color: "#d1d5db",
    },
    ".cm-editor.cm-focused.cm-dark .cm-sql-hover-tooltip .sql-hover-columns": {
      color: "#d1d5db",
    },
    ".cm-editor.cm-focused.cm-dark .cm-sql-hover-tooltip .sql-hover-related": {
      color: "#d1d5db",
    },
    ".cm-editor.cm-focused.cm-dark .cm-sql-hover-tooltip .sql-hover-path": {
      color: "#d1d5db",
    },
    ".cm-editor.cm-focused.cm-dark .cm-sql-hover-tooltip .sql-hover-info": {
      color: "#d1d5db",
    },
    ".cm-editor.cm-focused.cm-dark .cm-sql-hover-tooltip .sql-hover-children": {
      color: "#9ca3af",
    },
    ".cm-editor.cm-focused.cm-dark .cm-sql-hover-tooltip code": {
      backgroundColor: "#374151",
      color: "#f3f4f6",
    },
    ".cm-editor.cm-focused.cm-dark .cm-sql-hover-tooltip strong": {
      color: "#ffffff",
    },
    ".cm-editor.cm-focused.cm-dark .cm-sql-hover-tooltip em": {
      color: "#9ca3af",
    },
  });
