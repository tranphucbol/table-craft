CREATE ROLE tc_cert LOGIN;
CREATE TABLE tls_probe (id integer PRIMARY KEY, note text NOT NULL);
INSERT INTO tls_probe VALUES (1, 'reached over TLS');
GRANT SELECT ON tls_probe TO tc_cert;
