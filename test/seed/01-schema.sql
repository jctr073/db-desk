-- Schema for the integration-test database: a small storefront.
--
-- Three tables chained by foreign keys (customers -> orders -> order_items)
-- so the connection tree has PKs, FKs, indexes, an enum type and a function
-- to introspect. The `add_customer` function exists specifically to test the
-- one write path a client-side statement classifier cannot see: a plain
-- SELECT that calls a volatile function which writes.

CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped', 'cancelled');

CREATE TABLE customers (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  full_name  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Natural key so the data seed can reference orders without knowing ids.
  reference   text NOT NULL UNIQUE,
  customer_id bigint NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  status      order_status NOT NULL DEFAULT 'pending',
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  placed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX orders_customer_id_idx ON orders (customer_id);

CREATE TABLE order_items (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id         bigint NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  sku              text NOT NULL,
  quantity         integer NOT NULL CHECK (quantity > 0),
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0)
);

CREATE INDEX order_items_order_id_idx ON order_items (order_id);

-- A SELECT that writes. Volatile and SECURITY INVOKER (both the default),
-- so it runs with the caller's privileges and inside the caller's
-- transaction -- which is what makes it a useful probe for both the
-- read-only session belt and the read-only role.
CREATE FUNCTION add_customer(p_email text, p_name text) RETURNS bigint
  LANGUAGE sql
  AS $$
    INSERT INTO customers (email, full_name)
    VALUES (p_email, p_name)
    RETURNING id
  $$;

-- The strongest available wall, recommended in the README: a login role with
-- no write privileges at all. Integration tests assert that it stops writes
-- the session-level belt cannot (see add_customer above).
CREATE ROLE dbdesk_ro LOGIN PASSWORD 'dbdesk_ro';
GRANT CONNECT ON DATABASE dbdesk_test TO dbdesk_ro;
GRANT USAGE ON SCHEMA public TO dbdesk_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO dbdesk_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO dbdesk_ro;
