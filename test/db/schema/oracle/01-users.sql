-- Run by the image as SYS, after it has made the TABLE_CRAFT user (APP_USER).
ALTER SESSION SET CONTAINER = FREEPDB1;

-- GV$SESSION, DBMS_XPLAN.DISPLAY_CURSOR and ALTER SYSTEM CANCEL SQL / KILL SESSION, for the
-- sessions view, EXPLAIN ANALYZE and their contract cases.
GRANT SELECT_CATALOG_ROLE TO table_craft;
GRANT ALTER SYSTEM TO table_craft;
GRANT CREATE PROCEDURE, CREATE SEQUENCE, CREATE VIEW, CREATE MATERIALIZED VIEW TO table_craft;
ALTER USER table_craft QUOTA UNLIMITED ON users;

-- A second schema, so completion and the Database pane meet a namespace that is not current.
CREATE USER archive NO AUTHENTICATION DEFAULT TABLESPACE users QUOTA UNLIMITED ON users;

-- Sees only its own sessions and holds no catalog role.
CREATE USER table_craft_limited IDENTIFIED BY table_craft;
GRANT CREATE SESSION TO table_craft_limited;
