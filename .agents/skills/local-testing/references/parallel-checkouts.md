# Parallel checkouts

A second checkout, such as a parallel worktree, whose database suites may run while the main
checkout's do, sets `COMPOSE_PROJECT_NAME` and every port variable below on every `test:db`,
`test:smoke:db` and `docker compose` command, so it gets its own containers instead of reseeding or
stopping the other checkout's. It also copies the main checkout's `.env` into its root right after
the worktree is made (`cp <main checkout>/.env .env`, when the main checkout has one).

| Variable                           | Default     | Server                     |
| :--------------------------------- | :---------- | :------------------------- |
| `TABLE_CRAFT_PG_PORT`              | 55432       | PostgreSQL                 |
| `TABLE_CRAFT_PG_TLS_PORT`          | 55433       | `postgres-tls`             |
| `TABLE_CRAFT_MYSQL_PORT`           | 53306       | MySQL                      |
| `TABLE_CRAFT_MYSQL_TLS_PORT`       | 53307       | `mysql-tls`                |
| `TABLE_CRAFT_MARIADB_PORT`         | 53310       | MariaDB                    |
| `TABLE_CRAFT_TIDB_PORT`            | 54000       | TiDB container             |
| `TABLE_CRAFT_SSH_PORT`             | 2222        | `ssh` bastion              |
| `TABLE_CRAFT_ORACLE_PORT`          | 51521       | Oracle                     |
| `TABLE_CRAFT_MSSQL_PORT`           | 51433       | SQL Server                 |
| `TABLE_CRAFT_REDIS_PORT`           | 56379       | `redis`                    |
| `TABLE_CRAFT_REDIS_TLS_PORT`       | 56380       | `redis-tls`                |
| `TABLE_CRAFT_REDIS6_PORT`          | 56362       | `redis-6`                  |
| `TABLE_CRAFT_REDIS5_PORT`          | 56350       | `redis-5`                  |
| `TABLE_CRAFT_REDIS_CLUSTER_PORTS`  | 47001-47006 | `redis-cluster`, a range   |
| `TABLE_CRAFT_REDIS6_CLUSTER_PORTS` | 47011-47013 | `redis-6-cluster`, a range |
| `TABLE_CRAFT_REDIS5_CLUSTER_PORTS` | 47021-47026 | `redis-5-cluster`, a range |

A cluster range keeps its length. A node's bus port is its port + 10000, so keep cluster ports
below 55536.

For example, shifting every port by 100:

```sh
export COMPOSE_PROJECT_NAME=table-craft-second \
  TABLE_CRAFT_PG_PORT=55532 TABLE_CRAFT_PG_TLS_PORT=55533 \
  TABLE_CRAFT_MYSQL_PORT=53406 TABLE_CRAFT_MYSQL_TLS_PORT=53407 TABLE_CRAFT_MARIADB_PORT=53410 \
  TABLE_CRAFT_TIDB_PORT=54100 TABLE_CRAFT_SSH_PORT=2322 \
  TABLE_CRAFT_ORACLE_PORT=51621 TABLE_CRAFT_MSSQL_PORT=51533 \
  TABLE_CRAFT_REDIS_PORT=56479 TABLE_CRAFT_REDIS_TLS_PORT=56480 \
  TABLE_CRAFT_REDIS6_PORT=56462 TABLE_CRAFT_REDIS5_PORT=56450 \
  TABLE_CRAFT_REDIS_CLUSTER_PORTS=47101-47106 TABLE_CRAFT_REDIS6_CLUSTER_PORTS=47111-47113 \
  TABLE_CRAFT_REDIS5_CLUSTER_PORTS=47121-47126
```

A variable set for one command and missing on the next starts or reseeds the default project's
containers. An agent's shell calls do not keep exports between calls, so repeat the block in every
command that runs a suite, `bun test/db/up.ts` or `docker compose`. The headless box reads the same
variables.
