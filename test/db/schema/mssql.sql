-- Run by the one-shot `mssql-seed` service as `sa`, on every `up` that starts it, so each step
-- checks first. Plan 055 writes the contract fixtures; until then only the sentinel exists.
IF DB_ID('table_craft') IS NULL CREATE DATABASE table_craft;
GO
IF SUSER_ID('table_craft') IS NULL
  CREATE LOGIN table_craft WITH PASSWORD = 'table_craft', CHECK_POLICY = OFF, DEFAULT_DATABASE = table_craft;
GO
USE table_craft;
GO
IF USER_ID('table_craft') IS NULL CREATE USER table_craft FOR LOGIN table_craft;
ALTER ROLE db_owner ADD MEMBER table_craft;
GO
IF OBJECT_ID('dbo.seed_probe') IS NULL
BEGIN
  CREATE TABLE dbo.seed_probe (id INT PRIMARY KEY);
  INSERT INTO dbo.seed_probe (id) VALUES (1);
END;
GO
