-- Run by the one-shot `mssql-seed` service as `sa`, on every `up` that starts it, so each step
-- checks first. Mirrors postgres.sql in database table_craft, schema dbo (plan 055).
IF DB_ID('table_craft') IS NULL CREATE DATABASE table_craft;
GO
-- Readers see the last committed row instead of waiting on a writer's lock, as on Azure SQL and in
-- every other contract database; writers still block each other (plan 055).
IF (SELECT is_read_committed_snapshot_on FROM sys.databases WHERE name = 'table_craft') = 0
  ALTER DATABASE table_craft SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE;
GO
IF SUSER_ID('table_craft') IS NULL
  CREATE LOGIN table_craft WITH PASSWORD = 'table_craft', CHECK_POLICY = OFF, DEFAULT_DATABASE = table_craft;
GO
-- Show Sessions lists every session and terminates any (plan 055 phase 4).
GRANT VIEW SERVER STATE TO table_craft;
GRANT ALTER ANY CONNECTION TO table_craft;
GO
-- A login without VIEW SERVER STATE, which sees only its own sessions.
IF SUSER_ID('table_craft_limited') IS NULL
  CREATE LOGIN table_craft_limited WITH PASSWORD = 'table_craft_limited', CHECK_POLICY = OFF,
    DEFAULT_DATABASE = table_craft;
GO
USE table_craft;
GO
IF USER_ID('table_craft') IS NULL CREATE USER table_craft FOR LOGIN table_craft;
ALTER ROLE db_owner ADD MEMBER table_craft;
GO
IF USER_ID('table_craft_limited') IS NULL CREATE USER table_craft_limited FOR LOGIN table_craft_limited;
ALTER ROLE db_datareader ADD MEMBER table_craft_limited;
GO
IF OBJECT_ID('dbo.customers') IS NULL
BEGIN
  CREATE TABLE dbo.customers (
    id INT PRIMARY KEY,
    name NVARCHAR(100) NOT NULL,
    email NVARCHAR(200) NOT NULL UNIQUE
  );
  EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'People who place orders',
    @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N'customers';
  INSERT INTO dbo.customers (id, name, email) VALUES
    (1, N'Ada Lovelace', N'ada@example.com'),
    (2, N'Grace Hopper', N'grace@example.com');
END;
GO
IF OBJECT_ID('dbo.orders') IS NULL
BEGIN
  CREATE TABLE dbo.orders (
    id INT PRIMARY KEY,
    customer_id INT NOT NULL REFERENCES dbo.customers (id),
    total DECIMAL(12, 2) NOT NULL,
    placed_at DATETIME2(0) NOT NULL,
    CONSTRAINT orders_total_nonnegative CHECK (total >= 0)
  );
  CREATE INDEX orders_placed_at_idx ON dbo.orders (placed_at);
  INSERT INTO dbo.orders (id, customer_id, total, placed_at) VALUES
    (1, 1, 19.99, '2024-02-29 09:00:00'),
    (2, 1, 5.00, '2024-03-01 10:30:00'),
    (3, 2, 120.50, '2024-03-02 16:45:00');
END;
GO
CREATE OR ALTER VIEW dbo.customer_totals AS
  SELECT c.id AS customer_id, c.name, COALESCE(SUM(o.total), 0) AS total
  FROM dbo.customers c LEFT JOIN dbo.orders o ON o.customer_id = c.id
  GROUP BY c.id, c.name;
GO
IF OBJECT_ID('dbo.type_probe') IS NULL
BEGIN
  CREATE TABLE dbo.type_probe (
    id INT PRIMARY KEY,
    small_int SMALLINT,
    big_int BIGINT,
    exact_decimal DECIMAL(20, 4),
    unicode_text NVARCHAR(100),
    flag BIT,
    doc NVARCHAR(MAX) CONSTRAINT type_probe_doc_is_json CHECK (ISJSON(doc) = 1),
    payload VARBINARY(MAX),
    day DATE,
    moment DATETIME2(0)
  );
  INSERT INTO dbo.type_probe VALUES
    (1, 42, 9007199254740993, 1234567890123456.7890, N'héllo, 世界 🌍', 1,
     N'{"a": 1, "b": [true, null]}', 0xDEADBEEF, '2024-02-29', '2024-02-29 13:45:30'),
    (2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
END;
GO
-- The data editor's round trip (plan 008): an identity key and a default for every column, so an
-- insert of nothing but defaults succeeds.
IF OBJECT_ID('dbo.edit_probe') IS NULL
BEGIN
  CREATE TABLE dbo.edit_probe (
    id INT IDENTITY(1, 1) PRIMARY KEY,
    label NVARCHAR(100) NOT NULL CONSTRAINT DF_edit_probe_label DEFAULT N'new',
    qty INT NULL CONSTRAINT DF_edit_probe_qty DEFAULT 1,
    note NVARCHAR(100) NULL,
    doc NVARCHAR(MAX) NULL
  );
  INSERT INTO dbo.edit_probe (label, qty, note, doc) VALUES
    (N'first', 1, NULL, N'{"tags": ["a"]}'),
    (N'second', 2, N'kept', NULL);
END;
GO
IF OBJECT_ID('dbo.no_key_probe') IS NULL
BEGIN
  CREATE TABLE dbo.no_key_probe (label NVARCHAR(100));
  INSERT INTO dbo.no_key_probe (label) VALUES (N'loose');
END;
GO
IF OBJECT_ID('dbo.[Line Items]') IS NULL
BEGIN
  CREATE TABLE dbo.[Line Items] (
    id INT PRIMARY KEY,
    sku NVARCHAR(100) NOT NULL
  );
  INSERT INTO dbo.[Line Items] (id, sku) VALUES (1, N'SKU-1');
END;
GO
-- A second schema, so completion and the Database pane meet a namespace that is not current.
IF SCHEMA_ID('archive') IS NULL EXEC (N'CREATE SCHEMA archive');
GO
IF OBJECT_ID('archive.old_orders') IS NULL
  CREATE TABLE archive.old_orders (
    id INT PRIMARY KEY,
    customer_id INT NOT NULL REFERENCES dbo.customers (id)
  );
GO
-- Routines, so Execute Routine meets a default, a table result and an OUTPUT parameter.
CREATE OR ALTER FUNCTION dbo.calc_fee(@amount DECIMAL(12, 2), @rate DECIMAL(6, 4) = 0.015)
RETURNS DECIMAL(12, 2)
AS
BEGIN
  RETURN ROUND(@amount * @rate, 2);
END;
GO
CREATE OR ALTER FUNCTION dbo.customer_orders(@customer INT)
RETURNS TABLE
AS
RETURN SELECT o.id, o.total FROM dbo.orders o WHERE o.customer_id = @customer;
GO
CREATE OR ALTER PROCEDURE dbo.settle_order @order_id INT, @total DECIMAL(12, 2) OUTPUT
AS
BEGIN
  SET NOCOUNT ON;
  SELECT @total = o.total FROM dbo.orders o WHERE o.id = @order_id;
END;
GO
-- The TLS suite reads it over the encrypted links (test/db/tls.test.ts).
IF OBJECT_ID('dbo.tls_probe') IS NULL
BEGIN
  CREATE TABLE dbo.tls_probe (note NVARCHAR(40) NOT NULL);
  INSERT INTO dbo.tls_probe (note) VALUES (N'reached over TLS');
END;
GO
IF OBJECT_ID('dbo.seed_probe') IS NULL
BEGIN
  CREATE TABLE dbo.seed_probe (id INT PRIMARY KEY);
  INSERT INTO dbo.seed_probe (id) VALUES (1);
END;
GO
