import { StandardSQL, sql } from "@codemirror/lang-sql";
import { basicSetup, EditorView } from "codemirror";
import { cteCompletionSource } from "../src/sql/cte-completion-source.js";
import { sqlExtension } from "../src/sql/extension.js";

// Default SQL content for the demo
const defaultSqlDoc = `-- Welcome to the SQL Editor Demo!
-- Try editing the queries below to see real-time validation

WITH cte_name AS (
  SELECT * FROM users
)

-- Valid queries (no errors):
SELECT id, name, email
FROM users
WHERE active = true
ORDER BY created_at DESC;

SELECT
    u.name,
    p.title,
    p.created_at
FROM users u
JOIN posts p ON u.id = p.user_id
WHERE u.status = 'active'
  AND p.published = true
LIMIT 10;

-- Try editing these to create syntax errors:
-- Uncomment the lines below to see error highlighting

-- SELECT * FROM;  -- Missing table name
-- SELECT * FORM users;  -- Typo in FROM keyword
-- INSERT INTO VALUES (1, 2);  -- Missing table name
-- UPDATE SET name = 'test';  -- Missing table name

-- Complex example with subquery:
SELECT
    customer_id,
    order_date,
    total_amount,
    (SELECT AVG(total_amount) FROM orders) as avg_order_value
FROM orders
WHERE order_date >= '2024-01-01'
  AND total_amount > (
    SELECT AVG(total_amount) * 0.8
    FROM orders
    WHERE YEAR(order_date) = 2024
  )
ORDER BY total_amount DESC;
`;

const schema = {
  // Users table
  users: ["id", "name", "email", "active", "status", "created_at", "updated_at", "profile_id"],
  // Posts table
  posts: [
    "id",
    "title",
    "content",
    "user_id",
    "published",
    "created_at",
    "updated_at",
    "category_id",
  ],
  // Orders table
  orders: [
    "id",
    "customer_id",
    "order_date",
    "total_amount",
    "status",
    "shipping_address",
    "created_at",
  ],
  // Customers table (additional example)
  customers: ["id", "first_name", "last_name", "email", "phone", "address", "city", "country"],
  // Categories table
  categories: ["id", "name", "description", "parent_id"],
};

let editor: EditorView;

const completionKindStyles = {
  borderRadius: "4px",
  padding: "2px 4px",
  marginRight: "4px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "12px",
  height: "12px",
};

const dialect = StandardSQL;

// Initialize the SQL editor
function initializeEditor() {
  const extensions = [
    basicSetup,
    EditorView.lineWrapping,
    sql({
      dialect: dialect,
      // Example schema for autocomplete
      schema: schema,
      // Enable uppercase keywords for more traditional SQL style
      upperCaseKeywords: true,
    }),
    sqlExtension({
      // Linter extension configuration
      linterConfig: {
        delay: 250, // Delay before running validation
      },

      // Gutter extension configuration
      gutterConfig: {
        backgroundColor: "#3b82f6", // Blue for current statement
        errorBackgroundColor: "#ef4444", // Red for invalid statements
        hideWhenNotFocused: true, // Hide gutter when editor loses focus
      },
      // Hover extension configuration
      enableHover: true, // Enable hover tooltips
      hoverConfig: {
        schema: schema, // Use the same schema as autocomplete
        hoverTime: 300, // 300ms hover delay
        enableKeywords: true, // Show keyword information
        enableTables: true, // Show table information
        enableColumns: true, // Show column information
        keywords: async () => {
          const keywords = await import("../src/data/common-keywords.json");
          return keywords.default.keywords;
        },
      },
    }),
    dialect.language.data.of({
      autocomplete: cteCompletionSource,
    }),
    // Custom theme for better SQL editing
    EditorView.theme({
      "&": {
        fontSize: "14px",
        fontFamily: '"JetBrains Mono", monospace',
      },
      ".cm-content": {
        minHeight: "400px",
      },
      ".cm-focused": {
        outline: "none",
      },
      ".cm-editor": {
        borderRadius: "8px",
      },
      ".cm-scroller": {
        fontFamily: "inherit",
      },
      // Style for diagnostic errors
      ".cm-diagnostic-error": {
        borderBottom: "2px wavy #dc2626",
      },
      ".cm-diagnostic": {
        padding: "4px 8px",
        borderRadius: "4px",
        backgroundColor: "#fef2f2",
        border: "1px solid #fecaca",
        color: "#dc2626",
        fontSize: "13px",
      },
      // Completion kind backgrounds
      ".cm-completionIcon-keyword": {
        backgroundColor: "#e0e7ff", // indigo-100
        ...completionKindStyles,
      },
      ".cm-completionIcon-variable": {
        backgroundColor: "#fef9c3", // yellow-100
        ...completionKindStyles,
      },
      ".cm-completionIcon-property": {
        backgroundColor: "#bbf7d0", // green-100
        ...completionKindStyles,
      },
      ".cm-completionIcon-function": {
        backgroundColor: "#bae6fd", // sky-100
        ...completionKindStyles,
      },
      ".cm-completionIcon-class": {
        backgroundColor: "#fbcfe8", // pink-100
        ...completionKindStyles,
      },
      ".cm-completionIcon-constant": {
        backgroundColor: "#fde68a", // amber-200
        ...completionKindStyles,
      },
      ".cm-completionIcon-type": {
        backgroundColor: "#ddd6fe", // violet-200
        ...completionKindStyles,
      },
      ".cm-completionIcon-text": {
        backgroundColor: "#f3f4f6", // gray-100
        ...completionKindStyles,
      },
    }),
  ];

  editor = new EditorView({
    doc: defaultSqlDoc,
    extensions,
    parent: document.querySelector("#sql-editor") ?? undefined,
  });

  return editor;
}

// Handle example button clicks
function setupExampleButtons() {
  const buttons = document.querySelectorAll(".example-btn");

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      const code = button.querySelector("code");
      if (code && editor) {
        const sql = code.textContent || "";
        // Replace editor content with the example
        editor.dispatch({
          changes: {
            from: 0,
            to: editor.state.doc.length,
            insert: sql,
          },
        });
        // Focus the editor
        editor.focus();
      }
    });
  });
}

// Initialize everything when the page loads
document.addEventListener("DOMContentLoaded", () => {
  initializeEditor();
  setupExampleButtons();

  console.log("SQL Editor Demo initialized!");
  console.log("Features:");
  console.log("- Real-time SQL syntax validation");
  console.log("- Error highlighting with detailed messages");
  console.log("- Support for multiple SQL dialects");
  console.log("- TypeScript support");
});
