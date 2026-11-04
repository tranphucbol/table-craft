-- Plan 152's ER diagram fixture: a shop whose foreign keys are only naming conventions, none
-- declared, so every edge the diagram draws is inferred, plus one (notes.person_id -> people.id)
-- the user adds by hand because `person` and `people` share no stem the rule knows.
CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE
);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id INTEGER
);

CREATE TABLE addresses (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  line1 TEXT NOT NULL,
  city TEXT NOT NULL
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  shipping_address_id INTEGER,
  placed_at TEXT NOT NULL,
  total NUMERIC NOT NULL
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  category_id INTEGER,
  name TEXT NOT NULL,
  price NUMERIC NOT NULL
);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL
);

CREATE TABLE people (
  id INTEGER PRIMARY KEY,
  full_name TEXT NOT NULL
);

CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL,
  body TEXT NOT NULL
);
