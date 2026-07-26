export interface DemoTable {
  readonly columns: readonly {
    readonly name: string;
    readonly type: string;
  }[];
  readonly description: string;
  readonly name: string;
  readonly schema: string;
}

export const demoTables: readonly DemoTable[] = [
  {
    columns: [
      { name: "id", type: "BIGINT" },
      { name: "name", type: "VARCHAR" },
      { name: "email", type: "VARCHAR" },
      { name: "active", type: "BOOLEAN" },
      { name: "created_at", type: "TIMESTAMP" },
    ],
    description: "Application users",
    name: "users",
    schema: "main",
  },
  {
    columns: [
      { name: "id", type: "BIGINT" },
      { name: "user_id", type: "BIGINT" },
      { name: "title", type: "VARCHAR" },
      { name: "published", type: "BOOLEAN" },
      { name: "created_at", type: "TIMESTAMP" },
    ],
    description: "Published and draft posts",
    name: "posts",
    schema: "main",
  },
  {
    columns: [
      { name: "id", type: "BIGINT" },
      { name: "customer_id", type: "BIGINT" },
      { name: "order_date", type: "DATE" },
      { name: "total_amount", type: "DECIMAL(18, 2)" },
      { name: "status", type: "VARCHAR" },
    ],
    description: "Customer orders",
    name: "orders",
    schema: "sales",
  },
  {
    columns: [
      { name: "id", type: "BIGINT" },
      { name: "first_name", type: "VARCHAR" },
      { name: "last_name", type: "VARCHAR" },
      { name: "email", type: "VARCHAR" },
      { name: "country", type: "VARCHAR" },
    ],
    description: "Customer directory",
    name: "customers",
    schema: "sales",
  },
] as const;

export const defaultSqlDoc = `-- vNext SQL language-service playground
-- Press Ctrl-Space anywhere completion is expected.

SELECT u.
FROM main.users AS u
WHERE EXISTS (
  SELECT 1
  FROM sales.orders AS o
  WHERE o.customer_id = u.id
);

SELECT *
FROM sales.
`;
