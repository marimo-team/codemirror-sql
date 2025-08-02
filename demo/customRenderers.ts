import type { NamespaceTooltipData } from "../src/sql/hover.js";

interface ColumnMetadata {
  type: string;
  primaryKey?: boolean;
  foreignKey?: boolean;
  unique?: boolean;
  default?: string;
  notNull?: boolean;
  comment?: string;
}

interface ForeignKeyMetadata {
  column: string;
  referencedTable: string;
  referencedColumn: string;
}

interface IndexMetadata {
  name: string;
  columns: string[];
  unique: boolean;
}

interface TableMetadata {
  description: string;
  rowCount: string;
  columns: Record<string, ColumnMetadata>;
  foreignKeys: ForeignKeyMetadata[];
  indexes: IndexMetadata[];
}

export const tableTooltipRenderer = (data: NamespaceTooltipData) => {
  // Show table name, columns, description, primary key, foreign key, index, unique, check, default, comment
  const table = data.item.path.join(".");
  const columns = data.item.namespace?.[table] ?? [];

  // Enhanced table metadata (simulated for demo purposes)
  const tableMetadata = getTableMetadata(table);

  let tooltip = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; line-height: 1.4;">`;

  // Table header
  tooltip += `<div style="font-weight: 600; font-size: 14px; color: #1f2937; margin-bottom: 8px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px;">📋 Table: ${table}</div>`;

  // Description
  if (tableMetadata.description) {
    tooltip += `<div style="color: #6b7280; font-style: italic; margin-bottom: 12px;">${tableMetadata.description}</div>`;
  }

  // Column details in a table
  if (columns.length > 0) {
    tooltip += `<div style="margin-bottom: 12px;">`;
    tooltip += `<div style="font-weight: 600; color: #374151; margin-bottom: 6px;">📊 Columns</div>`;
    tooltip += `<table style="width: 100%; border-collapse: collapse; font-size: 12px;">`;
    tooltip += `<thead><tr style="background-color: #f9fafb;">`;
    tooltip += `<th style="text-align: left; padding: 4px 8px; border: 1px solid #e5e7eb; font-weight: 600;">Column</th>`;
    tooltip += `<th style="text-align: left; padding: 4px 8px; border: 1px solid #e5e7eb; font-weight: 600;">Type</th>`;
    tooltip += `<th style="text-align: left; padding: 4px 8px; border: 1px solid #e5e7eb; font-weight: 600;">Constraints</th>`;
    tooltip += `<th style="text-align: left; padding: 4px 8px; border: 1px solid #e5e7eb; font-weight: 600;">Description</th>`;
    tooltip += `</tr></thead><tbody>`;

    columns.forEach((column) => {
      const columnInfo = tableMetadata.columns[column];
      const constraints: string[] = [];

      if (columnInfo) {
        if (columnInfo.primaryKey) constraints.push("🔑 PK");
        if (columnInfo.foreignKey) constraints.push("🔗 FK");
        if (columnInfo.unique) constraints.push("✨ UNIQUE");
        if (columnInfo.notNull) constraints.push("❌ NOT NULL");
        if (columnInfo.default) constraints.push(`💡 DEFAULT ${columnInfo.default}`);

        tooltip += `<tr style="border-bottom: 1px solid #f3f4f6;">`;
        tooltip += `<td style="padding: 4px 8px; font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace; color: #059669;">${column}</td>`;
        tooltip += `<td style="padding: 4px 8px; color: #7c3aed;">${columnInfo.type}</td>`;
        tooltip += `<td style="padding: 4px 8px; color: #dc2626;">${constraints.join(" ")}</td>`;
        tooltip += `<td style="padding: 4px 8px; color: #6b7280; font-size: 11px;">${columnInfo.comment || ""}</td>`;
        tooltip += `</tr>`;
      } else {
        tooltip += `<tr style="border-bottom: 1px solid #f3f4f6;">`;
        tooltip += `<td style="padding: 4px 8px; font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace; color: #059669;">${column}</td>`;
        tooltip += `<td style="padding: 4px 8px; color: #7c3aed;">-</td>`;
        tooltip += `<td style="padding: 4px 8px; color: #dc2626;">-</td>`;
        tooltip += `<td style="padding: 4px 8px; color: #6b7280; font-size: 11px;">-</td>`;
        tooltip += `</tr>`;
      }
    });

    tooltip += `</tbody></table></div>`;
  }

  // Foreign key relationships
  if (tableMetadata.foreignKeys.length > 0) {
    tooltip += `<div style="margin-bottom: 12px;">`;
    tooltip += `<div style="font-weight: 600; color: #374151; margin-bottom: 6px;">🔗 Foreign Keys</div>`;
    tooltip += `<table style="width: 100%; border-collapse: collapse; font-size: 12px;">`;
    tooltip += `<thead><tr style="background-color: #f9fafb;">`;
    tooltip += `<th style="text-align: left; padding: 4px 8px; border: 1px solid #e5e7eb; font-weight: 600;">Column</th>`;
    tooltip += `<th style="text-align: left; padding: 4px 8px; border: 1px solid #e5e7eb; font-weight: 600;">References</th>`;
    tooltip += `</tr></thead><tbody>`;

    tableMetadata.foreignKeys.forEach((fk) => {
      tooltip += `<tr style="border-bottom: 1px solid #f3f4f6;">`;
      tooltip += `<td style="padding: 4px 8px; font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace; color: #059669;">${fk.column}</td>`;
      tooltip += `<td style="padding: 4px 8px; color: #7c3aed;">${fk.referencedTable}.${fk.referencedColumn}</td>`;
      tooltip += `</tr>`;
    });

    tooltip += `</tbody></table></div>`;
  }

  // Indexes
  if (tableMetadata.indexes.length > 0) {
    tooltip += `<div style="margin-bottom: 12px;">`;
    tooltip += `<div style="font-weight: 600; color: #374151; margin-bottom: 6px;">📈 Indexes</div>`;
    tooltip += `<table style="width: 100%; border-collapse: collapse; font-size: 12px;">`;
    tooltip += `<thead><tr style="background-color: #f9fafb;">`;
    tooltip += `<th style="text-align: left; padding: 4px 8px; border: 1px solid #e5e7eb; font-weight: 600;">Name</th>`;
    tooltip += `<th style="text-align: left; padding: 4px 8px; border: 1px solid #e5e7eb; font-weight: 600;">Columns</th>`;
    tooltip += `<th style="text-align: left; padding: 4px 8px; border: 1px solid #e5e7eb; font-weight: 600;">Type</th>`;
    tooltip += `</tr></thead><tbody>`;

    tableMetadata.indexes.forEach((index) => {
      tooltip += `<tr style="border-bottom: 1px solid #f3f4f6;">`;
      tooltip += `<td style="padding: 4px 8px; font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace; color: #059669;">${index.name}</td>`;
      tooltip += `<td style="padding: 4px 8px; color: #7c3aed;">${index.columns.join(", ")}</td>`;
      tooltip += `<td style="padding: 4px 8px; color: #dc2626;">${index.unique ? "UNIQUE" : "NORMAL"}</td>`;
      tooltip += `</tr>`;
    });

    tooltip += `</tbody></table></div>`;
  }

  // Table statistics
  tooltip += `<div style="margin-top: 12px; padding-top: 8px; border-top: 1px solid #e5e7eb; color: #6b7280; font-size: 11px;">`;
  tooltip += `📊 ${tableMetadata.rowCount} rows`;
  tooltip += `</div>`;

  tooltip += `</div>`;

  return tooltip;
};

// Helper function to get enhanced table metadata
function getTableMetadata(tableName: string): TableMetadata {
  const metadata: Record<string, TableMetadata> = {
    users: {
      description: "User accounts and profile information",
      rowCount: "1,234",
      columns: {
        id: { type: "INT", primaryKey: true, notNull: true, comment: "Unique user identifier" },
        name: { type: "VARCHAR(255)", notNull: true, comment: "User's full name" },
        email: {
          type: "VARCHAR(255)",
          unique: true,
          notNull: true,
          comment: "User's email address",
        },
        active: { type: "BOOLEAN", default: "true", comment: "Whether the user account is active" },
        status: {
          type: "ENUM('active','inactive','suspended')",
          default: "'active'",
          comment: "User account status",
        },
        created_at: {
          type: "TIMESTAMP",
          default: "CURRENT_TIMESTAMP",
          comment: "Account creation date",
        },
        updated_at: {
          type: "TIMESTAMP",
          default: "CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP",
          comment: "Last update timestamp",
        },
        profile_id: { type: "INT", foreignKey: true, comment: "Reference to user profile" },
      },
      foreignKeys: [{ column: "profile_id", referencedTable: "profiles", referencedColumn: "id" }],
      indexes: [
        { name: "idx_users_email", columns: ["email"], unique: true },
        { name: "idx_users_status", columns: ["status"], unique: false },
        { name: "idx_users_created", columns: ["created_at"], unique: false },
      ],
    },
    posts: {
      description: "Blog posts and articles",
      rowCount: "5,678",
      columns: {
        id: { type: "INT", primaryKey: true, notNull: true, comment: "Unique post identifier" },
        title: { type: "VARCHAR(255)", notNull: true, comment: "Post title" },
        content: { type: "TEXT", comment: "Post content" },
        user_id: { type: "INT", notNull: true, foreignKey: true, comment: "Author of the post" },
        published: { type: "BOOLEAN", default: "false", comment: "Publication status" },
        created_at: {
          type: "TIMESTAMP",
          default: "CURRENT_TIMESTAMP",
          comment: "Post creation date",
        },
        updated_at: {
          type: "TIMESTAMP",
          default: "CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP",
          comment: "Last update timestamp",
        },
        category_id: { type: "INT", foreignKey: true, comment: "Post category" },
      },
      foreignKeys: [
        { column: "user_id", referencedTable: "users", referencedColumn: "id" },
        { column: "category_id", referencedTable: "categories", referencedColumn: "id" },
      ],
      indexes: [
        { name: "idx_posts_user", columns: ["user_id"], unique: false },
        { name: "idx_posts_published", columns: ["published"], unique: false },
        { name: "idx_posts_created", columns: ["created_at"], unique: false },
      ],
    },
    orders: {
      description: "Customer orders and transactions",
      rowCount: "12,345",
      columns: {
        id: { type: "INT", primaryKey: true, notNull: true, comment: "Unique order identifier" },
        customer_id: {
          type: "INT",
          notNull: true,
          foreignKey: true,
          comment: "Customer who placed the order",
        },
        order_date: { type: "DATE", notNull: true, comment: "Date when order was placed" },
        total_amount: { type: "DECIMAL(10,2)", notNull: true, comment: "Total order amount" },
        status: {
          type: "ENUM('pending','processing','shipped','delivered','cancelled')",
          default: "'pending'",
          comment: "Order status",
        },
        shipping_address: { type: "TEXT", comment: "Shipping address" },
        created_at: {
          type: "TIMESTAMP",
          default: "CURRENT_TIMESTAMP",
          comment: "Order creation timestamp",
        },
      },
      foreignKeys: [
        { column: "customer_id", referencedTable: "customers", referencedColumn: "id" },
      ],
      indexes: [
        { name: "idx_orders_customer", columns: ["customer_id"], unique: false },
        { name: "idx_orders_date", columns: ["order_date"], unique: false },
        { name: "idx_orders_status", columns: ["status"], unique: false },
      ],
    },
    customers: {
      description: "Customer information and profiles",
      rowCount: "2,345",
      columns: {
        id: { type: "INT", primaryKey: true, notNull: true, comment: "Unique customer identifier" },
        first_name: { type: "VARCHAR(100)", notNull: true, comment: "Customer's first name" },
        last_name: { type: "VARCHAR(100)", notNull: true, comment: "Customer's last name" },
        email: {
          type: "VARCHAR(255)",
          unique: true,
          notNull: true,
          comment: "Customer's email address",
        },
        phone: { type: "VARCHAR(20)", comment: "Customer's phone number" },
        address: { type: "TEXT", comment: "Customer's address" },
        city: { type: "VARCHAR(100)", comment: "Customer's city" },
        country: { type: "VARCHAR(100)", comment: "Customer's country" },
      },
      foreignKeys: [],
      indexes: [
        { name: "idx_customers_email", columns: ["email"], unique: true },
        { name: "idx_customers_name", columns: ["last_name", "first_name"], unique: false },
      ],
    },
    categories: {
      description: "Product and post categories",
      rowCount: "89",
      columns: {
        id: { type: "INT", primaryKey: true, notNull: true, comment: "Unique category identifier" },
        name: { type: "VARCHAR(100)", notNull: true, comment: "Category name" },
        description: { type: "TEXT", comment: "Category description" },
        parent_id: {
          type: "INT",
          foreignKey: true,
          comment: "Parent category for hierarchical structure",
        },
      },
      foreignKeys: [{ column: "parent_id", referencedTable: "categories", referencedColumn: "id" }],
      indexes: [
        { name: "idx_categories_name", columns: ["name"], unique: false },
        { name: "idx_categories_parent", columns: ["parent_id"], unique: false },
      ],
    },
  };

  return (
    metadata[tableName] || {
      description: "Table information",
      rowCount: "Unknown",
      columns: {},
      foreignKeys: [],
      indexes: [],
    }
  );
}
