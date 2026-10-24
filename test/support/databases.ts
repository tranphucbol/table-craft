/** Connection configs for the `test/db/compose.yml` databases, shared by `test:db` and the live test. */

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

export function withWrongPassword<Config extends { readonly password: string }>(config: Config): Config {
  return { ...config, password: WRONG_PASSWORD };
}
