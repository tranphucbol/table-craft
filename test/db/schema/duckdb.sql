-- DuckDB keeps a CHECK's expression but not its name, so the contract looks for `total >= 0`.
CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name VARCHAR NOT NULL,
  email VARCHAR NOT NULL UNIQUE
);

COMMENT ON TABLE customers IS 'People who place orders';

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers (id),
  total DECIMAL(12, 2) NOT NULL,
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
  exact_decimal DECIMAL(20, 4),
  unicode_text VARCHAR,
  flag BOOLEAN,
  doc JSON,
  payload BLOB,
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
   '{"a": 1, "b": [true, null]}', from_hex('DEADBEEF'), '2024-02-29', '2024-02-29 13:45:30'),
  (2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);

-- The data editor's round trip (plan 008): an auto-increment key and a default for every column,
-- so an insert of nothing but defaults succeeds. DuckDB has no SERIAL; a sequence stands in.
CREATE SEQUENCE edit_probe_id_seq;

CREATE TABLE edit_probe (
  id INTEGER PRIMARY KEY DEFAULT nextval('edit_probe_id_seq'),
  label VARCHAR NOT NULL DEFAULT 'new',
  qty INTEGER DEFAULT 1,
  note VARCHAR NULL,
  doc JSON NULL
);

CREATE TABLE no_key_probe (
  label VARCHAR
);

INSERT INTO edit_probe (label, qty, note, doc) VALUES
  ('first', 1, NULL, '{"tags": ["a"]}'),
  ('second', 2, 'kept', NULL);

INSERT INTO no_key_probe (label) VALUES ('loose');

CREATE TABLE "Line Items" (
  id INTEGER PRIMARY KEY,
  sku VARCHAR NOT NULL
);

INSERT INTO "Line Items" (id, sku) VALUES (1, 'SKU-1');

CREATE SCHEMA archive;

CREATE TABLE archive.old_orders (
  id INTEGER PRIMARY KEY,
  total DECIMAL(12, 2)
);
