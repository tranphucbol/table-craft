/** Connection configs for the `test/db/compose.yml` databases, shared by `test:db` and the live test. */
import { join } from "node:path";

const CREDENTIAL = "table_craft";
const WRONG_PASSWORD = "not-the-password";
const LOOPBACK = "127.0.0.1";
const DEFAULT_POSTGRES_PORT = 55432;
const DEFAULT_MYSQL_PORT = 53306;
const DEFAULT_TIDB_PORT = 54000;
/** The local TiDB starts with a passwordless `root`; a remote one brings its own (test/db/tidbTarget.ts). */
const DEFAULT_TIDB_USER = "root";
/** Where TiDB connects before the run's scratch database exists, and when no setup made one. */
const DEFAULT_TIDB_DATABASE = "test";
/** Every database the suites create on TiDB starts with this, so they never touch one they did not make. */
export const TIDB_SCRATCH_PREFIX = "tc_run_";
/** MySQL's limit on a database name, which TiDB shares. */
const DATABASE_NAME_LIMIT = 64;

/** The headless box (plan 031) reaches each database by its compose service name. */
function hostFromEnv(name: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? LOOPBACK : value;
}

/** `test/db/compose.yml` publishes on these unless a parallel worktree overrides them. */
function portFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : Number(value);
}

function textFromEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

/** Every server the suites can run against; SQLite is in-process and always runs. */
export const DATABASE_IDS = ["mysql", "tidb", "mariadb", "postgres", "oracle", "mssql", "redis", "etcd"] as const;
export type DatabaseId = (typeof DATABASE_IDS)[number];
export const DATABASES_ENV = "TABLE_CRAFT_DATABASES";
/**
 * Decision 099: the normal flow tests every server the built-in MySQL plugin reaches, MySQL 8.4,
 * the remote TiDB and MariaDB; every other server is opt-in.
 */
export const DEFAULT_DATABASES: readonly DatabaseId[] = ["mysql", "tidb", "mariadb"];
/** What every smoke run needs: the app's scenarios drive MySQL 8.4 and TiDB only. */
export const SMOKE_DATABASES: readonly DatabaseId[] = ["mysql", "tidb"];
const EVERY_DATABASE = "all";

function isDatabaseId(id: string): id is DatabaseId {
  return (DATABASE_IDS as readonly string[]).includes(id);
}

/** The servers `TABLE_CRAFT_DATABASES` selects, a comma list or `all`, in `DATABASE_IDS` order. */
export function selectedDatabases(env: NodeJS.ProcessEnv = process.env): readonly DatabaseId[] {
  const ids = (env[DATABASES_ENV] ?? "")
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter((id) => id !== "");
  if (ids.length === 0) return DEFAULT_DATABASES;
  if (ids.includes(EVERY_DATABASE)) return DATABASE_IDS;
  const unknown = ids.filter((id) => !isDatabaseId(id));
  if (unknown.length > 0) {
    throw new Error(
      `${DATABASES_ENV} names ${unknown.join(", ")}, which is not a test database; ` +
        `list any of ${[...DATABASE_IDS, EVERY_DATABASE].join(", ")}, separated by commas.`,
    );
  }
  return DATABASE_IDS.filter((id) => ids.includes(id));
}

export function databaseEnabled(id: DatabaseId, env: NodeJS.ProcessEnv = process.env): boolean {
  return selectedDatabases(env).includes(id);
}

export const POSTGRES_CONFIG = {
  host: hostFromEnv("TABLE_CRAFT_PG_HOST"),
  port: portFromEnv("TABLE_CRAFT_PG_PORT", DEFAULT_POSTGRES_PORT),
  database: CREDENTIAL,
  user: CREDENTIAL,
  password: CREDENTIAL,
} as const;

export const MYSQL_CONFIG = {
  host: hostFromEnv("TABLE_CRAFT_MYSQL_HOST"),
  port: portFromEnv("TABLE_CRAFT_MYSQL_PORT", DEFAULT_MYSQL_PORT),
  database: CREDENTIAL,
  user: CREDENTIAL,
  password: CREDENTIAL,
} as const;

const DEFAULT_MARIADB_PORT = 53310;

/** The `mariadb` service, seeded from the same `schema/mysql.sql` as `mysql`. */
export const MARIADB_CONFIG = {
  ...MYSQL_CONFIG,
  host: hostFromEnv("TABLE_CRAFT_MARIADB_HOST"),
  port: portFromEnv("TABLE_CRAFT_MARIADB_PORT", DEFAULT_MARIADB_PORT),
} as const;

const DEFAULT_ORACLE_PORT = 51521;
const DEFAULT_MSSQL_PORT = 51433;

/** The `oracle` service's application user, in the image's default pluggable database. */
export const ORACLE_CONFIG = {
  host: hostFromEnv("TABLE_CRAFT_ORACLE_HOST"),
  port: portFromEnv("TABLE_CRAFT_ORACLE_PORT", DEFAULT_ORACLE_PORT),
  service: "FREEPDB1",
  user: CREDENTIAL,
  password: CREDENTIAL,
} as const;

/** An account `test/db/schema/oracle/01-users.sql` makes with no catalog role: it sees only its own session. */
export const ORACLE_LIMITED_CONFIG = { ...ORACLE_CONFIG, user: "table_craft_limited" } as const;

/** The login `test/db/schema/mssql.sql` creates; `sa` is only the seed's. */
export const MSSQL_CONFIG = {
  host: hostFromEnv("TABLE_CRAFT_MSSQL_HOST"),
  port: portFromEnv("TABLE_CRAFT_MSSQL_PORT", DEFAULT_MSSQL_PORT),
  database: CREDENTIAL,
  user: CREDENTIAL,
  password: CREDENTIAL,
  // The container serves a certificate it made itself.
  trustServerCertificate: true,
} as const;

/**
 * The run's own database on TiDB, which `tidbScratch.ts` creates before the suites and drops
 * after; scratch databases a suite makes for itself come from `tidbScratchDatabase`.
 */
export const TIDB_DATABASE = textFromEnv("TABLE_CRAFT_TIDB_DATABASE", DEFAULT_TIDB_DATABASE);

/** Read when called: the global setup settles which TiDB the run uses before the workers start. */
export function tidbConfigFromEnv() {
  return {
    host: hostFromEnv("TABLE_CRAFT_TIDB_HOST"),
    port: portFromEnv("TABLE_CRAFT_TIDB_PORT", DEFAULT_TIDB_PORT),
    database: textFromEnv("TABLE_CRAFT_TIDB_DATABASE", DEFAULT_TIDB_DATABASE),
    user: textFromEnv("TABLE_CRAFT_TIDB_USER", DEFAULT_TIDB_USER),
    password: textFromEnv("TABLE_CRAFT_TIDB_PASSWORD", ""),
  } as const;
}

/** MySQL's `root`, which holds `PROCESS` and may kill any thread; `table_craft` holds neither. */
export const MYSQL_ROOT_CONFIG = { ...MYSQL_CONFIG, user: "root", password: CREDENTIAL } as const;
export const MARIADB_ROOT_CONFIG = { ...MARIADB_CONFIG, user: "root", password: CREDENTIAL } as const;

/** A TiDB 4 server: no Global Kill, and `KILL QUERY` only warns (decision 058). */
export const TIDB_CONFIG = tidbConfigFromEnv();

/**
 * Another database a suite may create and drop on TiDB, named after the run's so it cannot be
 * anyone else's. `length` pads the name to that many characters, for a test about long names.
 */
export function tidbScratchDatabase(suffix: string, length?: number): string {
  const name = `${TIDB_DATABASE}_${suffix}`;
  const padded = length === undefined ? name : name.padEnd(length, "_x").slice(0, length);
  if (padded.length > DATABASE_NAME_LIMIT) throw new Error(`TiDB scratch database name too long: ${padded}`);
  return padded;
}

const DEFAULT_SSH_PORT = 2222;
const SSH_USER = "tunnel";

/**
 * The `ssh` bastion in `test/db/compose.yml`; every key under `test/db/ssh/` is test-only. The
 * bastion reaches the databases by service name, so tunnel targets are the same everywhere.
 */
export const SSH_BASTION = {
  host: hostFromEnv("TABLE_CRAFT_SSH_HOST"),
  port: portFromEnv("TABLE_CRAFT_SSH_PORT", DEFAULT_SSH_PORT),
  user: SSH_USER,
  password: "tunnel",
  keyPath: join(import.meta.dirname, "..", "db", "ssh", "id_ed25519"),
  passphrase: "tunnel-key",
  fingerprint: "SHA256:cCEVNeTkTJOv+K7Nfi/QPhn6BJZ7yH06aEJzWF6EiAg",
} as const;

export const POSTGRES_BEHIND_BASTION = { host: "postgres", port: 5432 } as const;
export const MYSQL_BEHIND_BASTION = { host: "mysql", port: 3306 } as const;
export const ORACLE_BEHIND_BASTION = { host: "oracle", port: 1521 } as const;
export const MSSQL_BEHIND_BASTION = { host: "mssql", port: 1433 } as const;

const DEFAULT_POSTGRES_TLS_PORT = 55433;
const DEFAULT_MYSQL_TLS_PORT = 53307;
/** On the host the TLS servers are reached by a name their certificate carries, not 127.0.0.1. */
const TLS_HOST_NAME = "localhost";
const TLS_DIRECTORY = join(import.meta.dirname, "..", "db", "tls");

function tlsHostFromEnv(name: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? TLS_HOST_NAME : value;
}

/**
 * The test-only certificates in `test/db/tls/` for the `postgres-tls` and `mysql-tls` services.
 * The server certificate names `localhost` and both service names but no IP address.
 */
export const TLS_FILES = {
  ca: join(TLS_DIRECTORY, "ca.crt"),
  wrongCa: join(TLS_DIRECTORY, "wrong-ca.crt"),
  clientCert: join(TLS_DIRECTORY, "client.crt"),
  clientKey: join(TLS_DIRECTORY, "client.key"),
  encryptedClientKey: join(TLS_DIRECTORY, "client-encrypted.key"),
  keyPassphrase: "tls-key",
  certUser: "tc_cert",
} as const;

export const POSTGRES_TLS_CONFIG = {
  ...POSTGRES_CONFIG,
  host: tlsHostFromEnv("TABLE_CRAFT_PG_TLS_HOST"),
  port: portFromEnv("TABLE_CRAFT_PG_TLS_PORT", DEFAULT_POSTGRES_TLS_PORT),
} as const;

export const MYSQL_TLS_CONFIG = {
  ...MYSQL_CONFIG,
  host: tlsHostFromEnv("TABLE_CRAFT_MYSQL_TLS_HOST"),
  port: portFromEnv("TABLE_CRAFT_MYSQL_TLS_PORT", DEFAULT_MYSQL_TLS_PORT),
} as const;

/** The `mssql` service presents the test certificate but leaves encryption to the client. */
export const MSSQL_TLS_CONFIG = {
  ...MSSQL_CONFIG,
  host: tlsHostFromEnv("TABLE_CRAFT_MSSQL_HOST"),
  encrypt: "mandatory",
  trustServerCertificate: false,
} as const;

export const POSTGRES_TLS_BEHIND_BASTION = { host: "postgres-tls", port: 5432 } as const;
export const MYSQL_TLS_BEHIND_BASTION = { host: "mysql-tls", port: 3306 } as const;

const DEFAULT_REDIS_PORT = 56379;
const DEFAULT_REDIS_TLS_PORT = 56380;
const DEFAULT_REDIS6_PORT = 56362;
/** Below 55536: a Redis node's cluster bus listens on its port plus 10,000. */
const DEFAULT_REDIS_CLUSTER_PORTS = "47001-47006";
const DEFAULT_REDIS6_CLUSTER_PORTS = "47011-47013";
const DEFAULT_REDIS5_PORT = 56350;
const DEFAULT_REDIS5_CLUSTER_PORTS = "47021-47026";

/** The first port of a `first-last` range variable, which `compose.yml` publishes one to one. */
function firstPortFromEnv(name: string, fallback: string): number {
  const value = process.env[name];
  const range = value === undefined || value === "" ? fallback : value;
  return Number(range.split("-")[0]);
}

const REDIS_STANDALONE = {
  mode: "standalone",
  host: hostFromEnv("TABLE_CRAFT_REDIS_HOST"),
  database: 0,
  user: CREDENTIAL,
  password: CREDENTIAL,
} as const;

/** The `redis` service: Redis 7.4, the ACL user `table_craft`, keys seeded from `schema/redis.redis`. */
export const REDIS_CONFIG = {
  ...REDIS_STANDALONE,
  port: portFromEnv("TABLE_CRAFT_REDIS_PORT", DEFAULT_REDIS_PORT),
} as const;

/** The `redis-6` service: Redis 6.2, the oldest with RESP3 (plan 058 decision 23). */
export const REDIS6_CONFIG = {
  ...REDIS_STANDALONE,
  host: hostFromEnv("TABLE_CRAFT_REDIS6_HOST"),
  port: portFromEnv("TABLE_CRAFT_REDIS6_PORT", DEFAULT_REDIS6_PORT),
} as const;

/** The `redis-5` service: the oldest server the plugin supports, no ACL users (plan 060). */
export const REDIS5_CONFIG = {
  ...REDIS_STANDALONE,
  host: hostFromEnv("TABLE_CRAFT_REDIS5_HOST"),
  port: portFromEnv("TABLE_CRAFT_REDIS5_PORT", DEFAULT_REDIS5_PORT),
  user: "",
} as const;

export const REDIS_TLS_CONFIG = {
  ...REDIS_STANDALONE,
  host: tlsHostFromEnv("TABLE_CRAFT_REDIS_TLS_HOST"),
  port: portFromEnv("TABLE_CRAFT_REDIS_TLS_PORT", DEFAULT_REDIS_TLS_PORT),
  tlsMode: "verify-full",
  tlsCa: TLS_FILES.ca,
} as const;

/** The `limited` ACL user, which may not run MEMORY, OBJECT or CONFIG. */
export const REDIS_LIMITED_USER = { user: "limited", password: "limited" } as const;

/**
 * The Node address map that reaches a cluster whose nodes announce 127.0.0.1 from elsewhere: the
 * headless box names the cluster's compose service instead (plan 058 decision 23).
 */
function clusterAddressMap(host: string, ports: string): string {
  if (host === LOOPBACK) return "";
  const [first, last] = ports.split("-").map(Number) as [number, number];
  const entries: string[] = [];
  for (let port = first; port <= last; port += 1) entries.push(`${LOOPBACK}:${port}=${host}:${port}`);
  return entries.join(", ");
}

function clusterConfig(hostVariable: string, portsVariable: string, fallback: string) {
  const host = hostFromEnv(hostVariable);
  const value = process.env[portsVariable];
  const ports = value === undefined || value === "" ? fallback : value;
  return {
    mode: "cluster",
    host,
    port: firstPortFromEnv(portsVariable, fallback),
    user: CREDENTIAL,
    password: CREDENTIAL,
    nodeAddressMap: clusterAddressMap(host, ports),
  } as const;
}

/** Three primaries and three replicas, every node announcing 127.0.0.1 and its own port. */
export const REDIS_CLUSTER_CONFIG = clusterConfig(
  "TABLE_CRAFT_REDIS_CLUSTER_HOST",
  "TABLE_CRAFT_REDIS_CLUSTER_PORTS",
  DEFAULT_REDIS_CLUSTER_PORTS,
);

/** Three Redis 6.2 primaries without replicas. */
export const REDIS6_CLUSTER_CONFIG = clusterConfig(
  "TABLE_CRAFT_REDIS6_CLUSTER_HOST",
  "TABLE_CRAFT_REDIS6_CLUSTER_PORTS",
  DEFAULT_REDIS6_CLUSTER_PORTS,
);

/** Three Redis 5.0 primaries and three replicas, a password and no ACL users, like QC. */
export const REDIS5_CLUSTER_CONFIG = {
  ...clusterConfig("TABLE_CRAFT_REDIS5_CLUSTER_HOST", "TABLE_CRAFT_REDIS5_CLUSTER_PORTS", DEFAULT_REDIS5_CLUSTER_PORTS),
  user: "",
} as const;

const DEFAULT_ETCD_PORT = 52379;
const DEFAULT_ETCD35_PORT = 52380;
const DEFAULT_ETCD_TLS_PORT = 52381;

/** Test-only mTLS server; its server trust anchor is separate from the shared client CA. */
export const ETCD_TLS_CONFIG = {
  host: tlsHostFromEnv("TABLE_CRAFT_ETCD_TLS_HOST"),
  port: portFromEnv("TABLE_CRAFT_ETCD_TLS_PORT", DEFAULT_ETCD_TLS_PORT),
  tlsMode: "verify-full",
  tlsCa: join(import.meta.dirname, "..", "db", "etcd", "server.crt"),
  tlsCert: TLS_FILES.clientCert,
  tlsKey: TLS_FILES.clientKey,
} as const;

export const ETCD_TLS_BEHIND_BASTION = { host: "etcd-tls", port: 2379 } as const;

/** The `etcd` service: etcd 3.6 with auth on, keys seeded from `schema/etcd.etcd` (plan 110). */
export const ETCD_CONFIG = {
  host: hostFromEnv("TABLE_CRAFT_ETCD_HOST"),
  port: portFromEnv("TABLE_CRAFT_ETCD_PORT", DEFAULT_ETCD_PORT),
  user: CREDENTIAL,
  password: CREDENTIAL,
} as const;

/** The `etcd-3-5` service: etcd 3.5 without auth, the same keys. */
export const ETCD35_CONFIG = {
  host: hostFromEnv("TABLE_CRAFT_ETCD35_HOST"),
  port: portFromEnv("TABLE_CRAFT_ETCD35_PORT", DEFAULT_ETCD35_PORT),
  user: "",
  password: "",
} as const;

/** The `etcd` server's root, which may read and change everything, maintenance included. */
export const ETCD_ROOT_USER = { user: "root", password: CREDENTIAL } as const;

/** The `etcd` server's user that may only read keys under `/app/`. */
export const ETCD_LIMITED_USER = { user: "limited", password: "limited" } as const;

export function withWrongPassword<Config extends { readonly password: string }>(config: Config): Config {
  return { ...config, password: WRONG_PASSWORD };
}

/** The smoke files' PostgreSQL scenarios skip unless `TABLE_CRAFT_DATABASES` selects it (decision 099). */
export const WITHOUT_POSTGRES = !databaseEnabled("postgres");

/** The smoke files' Redis scenarios skip unless `TABLE_CRAFT_DATABASES` selects it. */
export const WITHOUT_REDIS = !databaseEnabled("redis");

/** The smoke files' Oracle scenarios skip unless `TABLE_CRAFT_DATABASES` selects it. */
export const WITHOUT_ORACLE = !databaseEnabled("oracle");
/** The smoke files' SQL Server scenarios skip unless `TABLE_CRAFT_DATABASES` selects it. */
export const WITHOUT_MSSQL = !databaseEnabled("mssql");
/** The etcd suites and scenarios skip unless `TABLE_CRAFT_DATABASES` selects it. */
export const WITHOUT_ETCD = !databaseEnabled("etcd");

/** Whether a scenario on a datasource of `pluginId` skips, because its server is not selected. */
export function serverSkipped(pluginId: string): boolean {
  return (
    (pluginId === "postgres" && WITHOUT_POSTGRES) ||
    (pluginId === "redis" && WITHOUT_REDIS) ||
    (pluginId === "oracle" && WITHOUT_ORACLE) ||
    (pluginId === "mssql" && WITHOUT_MSSQL) ||
    (pluginId === "etcd" && WITHOUT_ETCD)
  );
}
