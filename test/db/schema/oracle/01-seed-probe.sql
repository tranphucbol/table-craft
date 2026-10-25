-- Run by the image as SYS on the instance (gvenzl/oracle-free); APP_USER has made TABLE_CRAFT.
-- Plan 054 writes the contract fixtures; until then only the sentinel exists.
ALTER SESSION SET CONTAINER = FREEPDB1;

CREATE TABLE table_craft.seed_probe (id NUMBER(10) PRIMARY KEY);
INSERT INTO table_craft.seed_probe (id) VALUES (1);
COMMIT;
