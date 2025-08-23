import type { Schema } from "./custom-renderers";

// Default SQL content for the demo
export const defaultSqlDoc = `-- Welcome to the SQL Editor Demo!
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

export const schema: Record<Schema, string[]> = {
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
  // Users_Posts table
  Users_Posts: ["user_id", "post_id"],
};
