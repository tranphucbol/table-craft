# 099: Normal runs test MySQL and the remote TiDB

Status: Accepted. Amends 063 and 096.

## Decision

The normal flow tests against MySQL and the remote TiDB only. Every other server starts only when
a run asks for it by name.

- **One selector.** `TABLE_CRAFT_DATABASES` is a comma list of `mysql`, `tidb`, `postgres`,
  `oracle`, `mssql`, or `all`; unset, it is `mysql,tidb`. `test/support/databases.ts`
  (`selectedDatabases`, `databaseEnabled`) reads it, in any case and order, and refuses an
  unknown name with the list of known ones. SQLite is in-process and always runs.
- **Compose profiles named after the database.** `mysql` holds `mysql` and `mysql-tls`;
  `postgres` holds `postgres` and `postgres-tls`; `ssh` belongs to both, since it tunnels to
  each; `oracle` holds `gvenzl/oracle-free:23-slim-faststart`, seeded from
  `test/db/schema/oracle/`; `mssql` holds `mcr.microsoft.com/mssql/server:2022-latest` (amd64)
  and the one-shot `mssql-seed`, which runs `test/db/schema/mssql.sql` through `sqlcmd`; `tidb`
  stays the local TiDB fallback, used only when `.env` names no reachable remote.
  `test/db/up.ts` (`stackFor` in `test/db/stack.ts`) passes one `--profile` per selected
  database and prints the selection first.
- **Suites skip what is not selected.** The contract runners, the shared suites that list
  dialects inline (TLS, tunnel, cursor close, session chaos, import and export) and the seed
  sentinels gate on `databaseEnabled`. Smoke scenarios that need PostgreSQL carry
  `it.skipIf(WITHOUT_POSTGRES)`; none is deleted. A smoke run always needs `mysql,tidb`, so
  `test:smoke:db:headless:<id>` adds `<id>` to the default set.
- **Seed labels and sentinels cover every service** (decision 096), but only the selected
  services are recreated on a stale seed or checked for their sentinel.
- **Scripts.** `test:db:postgres`, `test:db:oracle`, `test:db:mssql`, `test:db:all`, and
  `test:smoke:db:headless:postgres|oracle|mssql|all`. Default ports: Oracle 51521, SQL Server 51433.
- **When they run.** A session runs `test:db` and `test:smoke:db:headless`; it adds
  `test:db:<id>` and that dialect's headless smoke files when it changes `plugins/<id>` or that
  dialect's part of the shared kit. CI runs `verify` on the default set and one `test-db` job
  per opt-in dialect, filtered to `plugins/<id>/**`, `packages/plugin-api/src/testing/**` and
  `test/db/schema/<id>*`; the PostgreSQL job also runs on a tag. The coordinator runs
  `test:db:all` before a release.

## Rationale

Oracle and SQL Server images need about 2 GB of VM memory each, and SQL Server runs emulated on
Apple silicon. Two or three plan sessions share one 8 GiB Docker VM (decision 096), so starting
every server on every run would starve them. The user ruled that a heavy server runs only when a
change touches its plugin, then extended the rule to every plugin: PostgreSQL leaves the normal
flow too. MySQL stays because most smoke files use it as their baseline server; TiDB stays
because it is the remote server and costs the VM nothing.

A profile per database keeps one `compose.yml` and lets `up -d --wait` start exactly the set.
A single environment variable, read in one module, keeps the scripts, the suites and the
headless box agreeing on what ran.

## Consequences

- A shared-code change that breaks only PostgreSQL, Oracle or SQL Server is first caught by the
  CI job for that dialect or by `test:db:all`, not by the session's own run.
- Oracle 23ai Free starts and seeds in about 22 s and holds about 2.1 GiB; SQL Server 2022
  under emulation in about 21 s and about 1 GiB (measured on the 8 GiB VM, images cached).
- `oracledb` (thin mode) and `tedious` are root devDependencies, used only by the sentinel
  checks.

## Amendment (MariaDB)

The default set is `mysql,tidb,mariadb`. A user reached MariaDB 10.11 through the MySQL plugin and
the catalog failed on `information_schema.STATISTICS.EXPRESSION`, which only MySQL 8.0.13+ and
TiDB have; nothing in the normal flow ran against MariaDB. The `mariadb` profile holds
`mariadb:10.11`, seeded from the same `test/db/schema/mysql.sql`, on port 53310
(`TABLE_CRAFT_MARIADB_PORT`), and `test/db/mariadb.test.ts` runs the MySQL plugin's contract
(`test/db/mysqlFamily.ts`) against it; `test:db:mariadb` runs it alone. It is light (about the
size of the MySQL container, native on Apple silicon), so it stays in the normal flow rather than
behind a CI path filter. Smoke runs still need only `mysql,tidb` (`SMOKE_DATABASES`).

MySQL 5.7 was tried and left out: it ignores `CHECK` constraints and has no `EXPLAIN ANALYZE`,
which the contract requires of every server the plugin declares them for, and its image is
amd64-only. The plugin still reads 5.7 (JSON plans, no `EXPRESSION`); unit tests cover that.
