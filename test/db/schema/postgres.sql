CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE
);

COMMENT ON TABLE customers IS 'People who place orders';

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers (id),
  total NUMERIC(12, 2) NOT NULL,
  placed_at TIMESTAMP NOT NULL,
  CONSTRAINT orders_total_nonnegative CHECK (total >= 0)
);

CREATE INDEX orders_placed_at_idx ON orders (placed_at);

CREATE VIEW customer_totals AS
  SELECT c.id AS customer_id, c.name, COALESCE(SUM(o.total), 0) AS total
  FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
  GROUP BY c.id, c.name;

CREATE TABLE type_probe (
  id INTEGER PRIMARY KEY,
  small_int SMALLINT,
  big_int BIGINT,
  exact_decimal NUMERIC(20, 4),
  unicode_text TEXT,
  flag BOOLEAN,
  doc JSONB,
  payload BYTEA,
  day DATE,
  moment TIMESTAMP
);

INSERT INTO customers (id, name, email) VALUES
  (1, 'Ada Lovelace', 'ada@example.com'),
  (2, 'Grace Hopper', 'grace@example.com');

INSERT INTO orders (id, customer_id, total, placed_at) VALUES
  (1, 1, 19.99, '2024-02-29 09:00:00'),
  (2, 1, 5.00, '2024-03-01 10:30:00'),
  (3, 2, 120.50, '2024-03-02 16:45:00');

INSERT INTO type_probe VALUES
  (1, 42, 9007199254740993, 1234567890123456.7890, 'héllo, 世界 🌍', TRUE,
   '{"a": 1, "b": [true, null]}', '\xdeadbeef', '2024-02-29', '2024-02-29 13:45:30'),
  (2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);

-- The data editor's round trip (plan 008): an auto-increment key and a default for every column,
-- so an insert of nothing but defaults succeeds.
CREATE TABLE edit_probe (
  id SERIAL PRIMARY KEY,
  label TEXT NOT NULL DEFAULT 'new',
  qty INTEGER DEFAULT 1,
  note TEXT NULL,
  doc JSONB NULL
);

CREATE TABLE no_key_probe (
  label TEXT
);

INSERT INTO edit_probe (label, qty, note, doc) VALUES
  ('first', 1, NULL, '{"tags": ["a"]}'),
  ('second', 2, 'kept', NULL);

INSERT INTO no_key_probe (label) VALUES ('loose');

CREATE TABLE "Line Items" (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL
);

INSERT INTO "Line Items" (id, sku) VALUES (1, 'SKU-1');

-- A second schema, so completion and the Database pane meet a namespace that is not current.
CREATE SCHEMA archive;

CREATE TABLE archive.old_orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES public.customers (id)
);

-- Routines, so Execute Routine meets a default, an overload, a table result and an OUT parameter.
CREATE FUNCTION public.calc_fee(amount NUMERIC, rate NUMERIC DEFAULT 0.015) RETURNS NUMERIC
  LANGUAGE sql IMMUTABLE
  AS $$ SELECT round(amount * rate, 2) $$;

CREATE FUNCTION public.calc_fee(amount NUMERIC, currency TEXT, rate NUMERIC DEFAULT 0.015) RETURNS NUMERIC
  LANGUAGE sql IMMUTABLE
  AS $$ SELECT round(amount * rate, 2) + CASE WHEN currency = 'USD' THEN 0 ELSE 1 END $$;

CREATE FUNCTION public.customer_orders(customer INTEGER) RETURNS TABLE (id INTEGER, total NUMERIC)
  LANGUAGE sql STABLE
  AS $$ SELECT o.id, o.total FROM public.orders o WHERE o.customer_id = customer ORDER BY o.id $$;

CREATE PROCEDURE public.settle_order(IN order_id INTEGER, OUT total NUMERIC)
  LANGUAGE plpgsql
  AS $$ BEGIN SELECT o.total INTO total FROM public.orders o WHERE o.id = order_id; END $$;
