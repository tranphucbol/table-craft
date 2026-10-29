# Test database servers

`test/db/compose.yml` defines every server, each behind a compose profile that
`TABLE_CRAFT_DATABASES` selects; `test/db/up.ts` starts the selected profiles and seeds them from
`test/db/schema/`. Every port below is the default for the main checkout; a second checkout moves
them ([parallel-checkouts.md](parallel-checkouts.md)). `test/support/databases.ts` holds the
configs the suites connect with.

Unless a row says otherwise, the database, user and password are all `table_craft`.

| Server              | Profile    | Host port | Notes                                                                                                        |
| :------------------ | :--------- | :-------- | :----------------------------------------------------------------------------------------------------------- |
| SQLite              | none       | none      | Always runs, in memory or from `test/db/schema/sqlite.sql`                                                   |
| MySQL 8.4 (`mysql`) | `mysql`    | 53306     | Seeded from `test/db/schema/mysql.sql`; `root` has the same password                                         |
| MariaDB 10.11       | `mariadb`  | 53310     | The MySQL plugin's contract (`test/db/mariadb.test.ts`), same seed as MySQL                                  |
| TiDB 4              | `tidb`     | 54000     | `test/db/tidb.test.ts`; `root`, no password. An amd64 image, emulated on Apple silicon, and heavy            |
| PostgreSQL 17       | `postgres` | 55432     | Seeded from `test/db/schema/postgres.sql`                                                                    |
| Oracle 23ai Free    | `oracle`   | 51521     | Service `FREEPDB1`, about 2 GB; seeded from `test/db/schema/oracle/`, which also makes `table_craft_limited` |
| SQL Server 2022     | `mssql`    | 51433     | amd64-emulated; the `table_craft` login comes from `test/db/schema/mssql.sql`, `sa` is only the seed's       |
| `postgres-tls`      | `postgres` | 55433     | TLS only, for `test/db/tls.test.ts`                                                                          |
| `mysql-tls`         | `mysql`    | 53307     | TLS only, for `test/db/tls.test.ts`                                                                          |
| `ssh` bastion       | several    | 2222      | User `tunnel`, test-only keys in `test/db/ssh/`, for `test/db/tunnel.test.ts`                                |

The certificate suite uses the test-only CA, server and client certificates in `test/db/tls/`;
`test/db/tls/generate.sh` remakes them.

## Redis

The `redis` profile selects seven services (decision 116), all seeded by `test/db/redis/seed.sh`
from `test/db/schema/redis.redis`. Each cluster is one container running every node
(`test/db/redis/cluster.sh`).

| Service           | Version | Host ports  | Notes                                 |
| :---------------- | :------ | :---------- | :------------------------------------ |
| `redis`           | 7.4     | 56379       | ACL users `table_craft` and `limited` |
| `redis-tls`       | 7.4     | 56380       | TLS                                   |
| `redis-6`         | 6.2     | 56362       |                                       |
| `redis-5`         | 5.0     | 56350       | Password `table_craft`, no ACL users  |
| `redis-cluster`   | 7.4     | 47001-47006 | Three primaries and three replicas    |
| `redis-6-cluster` | 6.2     | 47011-47013 | Three primaries                       |
| `redis-5-cluster` | 5.0     | 47021-47026 | Three primaries and three replicas    |

## The remote TiDB

When the git-ignored `.env` names a remote TiDB (`TABLE_CRAFT_TIDB_REMOTE_HOST`, `_PORT`, `_USER`,
`_PASSWORD`, see `.env.example`) and it answers, the TiDB container is left out and every suite, on
the host and in the headless box, uses that server instead (`test/db/tidbTarget.ts`).

Either way a run works only in its own `tc_run_*` database (`test/support/tidbScratch.ts`, read
through `TIDB_DATABASE` and `tidbScratchDatabase` in `test/support/databases.ts`) and drops it
after. The remote server is shared: never write to, create users in, or kill sessions outside what
the run made.

Prefer the remote whenever `.env` names it: never pass `--profile tidb` to `docker compose`, and
never start the `tidb` service or any TiDB container by hand. A log line `TiDB: local container`
with `.env` present means the remote did not answer: say so, and stop that container when the run
ends.
