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
export const DATABASE_IDS = ["mysql", "tidb", "postgres", "oracle", "mssql"] as const;
export type DatabaseId = (typeof DATABASE_IDS)[number];
export const DATABASES_ENV = "TABLE_CRAFT_DATABASES";
/** Decision 099: the normal flow tests MySQL and the remote TiDB; every other server is opt-in. */
export const DEFAULT_DATABASES: readonly DatabaseId[] = ["mysql", "tidb"];
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

const DEFAULT_ORACLE_PORT = 51521;
const DEFAULT_MSSQL_PORT = 51433;

/** The `oracle` service's application user, in the image's default pluggable database. */
export const ORACLE_CONFIG = {
  host: hostFromEnv("TABLE_CRAFT_ORACLE_HOST"),
  port: portFromEnv("TABLE_CRAFT_ORACLE_PORT", DEFAULT_ORACLE_PORT),
  serviceName: "FREEPDB1",
  user: CREDENTIAL,
  password: CREDENTIAL,
} as const;

/** The login `test/db/schema/mssql.sql` creates; `sa` is only the seed's. */
export const MSSQL_CONFIG = {
  host: hostFromEnv("TABLE_CRAFT_MSSQL_HOST"),
  port: portFromEnv("TABLE_CRAFT_MSSQL_PORT", DEFAULT_MSSQL_PORT),
  database: CREDENTIAL,
  user: CREDENTIAL,
  password: CREDENTIAL,
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

export const POSTGRES_TLS_BEHIND_BASTION = { host: "postgres-tls", port: 5432 } as const;
export const MYSQL_TLS_BEHIND_BASTION = { host: "mysql-tls", port: 3306 } as const;

export function withWrongPassword<Config extends { readonly password: string }>(config: Config): Config {
  return { ...config, password: WRONG_PASSWORD };
}

/** The smoke files' PostgreSQL scenarios skip unless `TABLE_CRAFT_DATABASES` selects it (decision 099). */
export const WITHOUT_POSTGRES = !databaseEnabled("postgres");

/** Whether a scenario on a datasource of `pluginId` skips, because its server is not selected. */
export function serverSkipped(pluginId: string): boolean {
  return pluginId === "postgres" && WITHOUT_POSTGRES;
}
