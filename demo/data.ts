export const defaultSqlDoc = `-- codemirror-sql session demo
-- Edits in the editor are forwarded to SqlDocumentSession.update()

WITH recent_orders AS (
  SELECT customer_id, total_amount FROM orders WHERE order_date >= '2024-01-01'
),
top_customers AS (
  SELECT customer_id, SUM(total_amount) AS total_spent
  FROM recent_orders
  GROUP BY customer_id
)
SELECT c.first_name, t.total_spent AS amount
FROM customers c
JOIN top_customers t ON t.customer_id = c.id
ORDER BY amount DESC;

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
`;
