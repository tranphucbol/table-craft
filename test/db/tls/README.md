# Test-only TLS certificates

Every certificate and key in this directory is a throwaway for the `postgres-tls` and `mysql-tls`
services in `test/db/compose.yml`, which `bun run test:db` (`test/db/tls.test.ts`) and the plan 037
live test connect to. They guard nothing; never trust them anywhere else. `generate.sh` makes a
fresh set; the CA keys are not kept.

- `ca.crt`: the CA that signed the server and client certificates.
- `wrong-ca.crt`: an unrelated CA, for the verification failure cases.
- `server.crt`, `server.key`: the servers' certificate, valid for `localhost`, `postgres-tls`,
  `mysql-tls`, `redis-tls` and `mssql` but not for `127.0.0.1`.
- `client.crt`, `client.key`: the client certificate of user `tc_cert`, which both servers let in
  by certificate alone (PostgreSQL `hostssl … cert`, MySQL `REQUIRE X509`).
- `client-encrypted.key`: the same client key encrypted with the passphrase `tls-key`.

`pg_hba.conf`, `postgres.sql` and `mysql.sql` set up the servers: TLS only, the `tc_cert` user and
a one-row `tls_probe` table. `mssql.conf` hands the certificate to the `mssql` service, which keeps
encryption optional; its `tls_probe` comes from `../schema/mssql.sql`.
