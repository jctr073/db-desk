-- Seed rows. Re-run by the test harness (resetData()) between tests that
-- write, so this file must be idempotent: it truncates first, and it never
-- hardcodes generated ids.
--
-- Row counts are asserted by the integration tests -- keep CUSTOMER_COUNT,
-- ORDER_COUNT and ORDER_ITEM_COUNT in test/integration/support/fixtures.ts
-- in sync with what follows.

TRUNCATE customers, orders, order_items RESTART IDENTITY CASCADE;

INSERT INTO customers (email, full_name) VALUES
  ('ada@example.com',     'Ada Lovelace'),
  ('grace@example.com',   'Grace Hopper'),
  ('alan@example.com',    'Alan Turing'),
  ('katherine@example.com', 'Katherine Johnson');

INSERT INTO orders (reference, customer_id, status, total_cents) VALUES
  ('ORD-1001', (SELECT id FROM customers WHERE email = 'ada@example.com'),   'paid',      4250),
  ('ORD-1002', (SELECT id FROM customers WHERE email = 'ada@example.com'),   'shipped',   1899),
  ('ORD-1003', (SELECT id FROM customers WHERE email = 'grace@example.com'), 'pending',   9900),
  ('ORD-1004', (SELECT id FROM customers WHERE email = 'alan@example.com'),  'cancelled',  500);

INSERT INTO order_items (order_id, sku, quantity, unit_price_cents) VALUES
  ((SELECT id FROM orders WHERE reference = 'ORD-1001'), 'SKU-KEYBOARD', 1, 3200),
  ((SELECT id FROM orders WHERE reference = 'ORD-1001'), 'SKU-CABLE',    2,  525),
  ((SELECT id FROM orders WHERE reference = 'ORD-1002'), 'SKU-MOUSE',    1, 1899),
  ((SELECT id FROM orders WHERE reference = 'ORD-1003'), 'SKU-MONITOR',  1, 9900),
  ((SELECT id FROM orders WHERE reference = 'ORD-1004'), 'SKU-CABLE',    1,  500);
