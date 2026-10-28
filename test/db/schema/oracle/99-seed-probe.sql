-- Run by the image as SYS, last of the seed files, so the healthcheck's table means the seed is done.
ALTER SESSION SET CONTAINER = FREEPDB1;

CREATE TABLE table_craft.seed_probe (id NUMBER(10) PRIMARY KEY);
INSERT INTO table_craft.seed_probe (id) VALUES (1);
COMMIT;
