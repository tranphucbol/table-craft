CREATE USER 'tc_cert'@'%' REQUIRE X509;
CREATE TABLE tls_probe (id integer PRIMARY KEY, note text NOT NULL);
INSERT INTO tls_probe VALUES (1, 'reached over TLS');
GRANT SELECT ON table_craft.* TO 'tc_cert'@'%';
