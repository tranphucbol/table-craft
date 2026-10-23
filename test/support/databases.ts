/** Connection configs for the `test/db/compose.yml` databases, shared by `test:db` and the live test. */

const CREDENTIAL = "table_craft";
const WRONG_PASSWORD = "not-the-password";
const LOOPBACK = "127.0.0.1";
const DEFAULT_POSTGRES_PORT = 55432;
const DEFAULT_MYSQL_PORT = 53306;
const DEFAULT_TIDB_PORT = 54000;
/** TiDB starts with a passwordless `root` and a `test` database. */
const TIDB_USER = "root";
const TIDB_DATABASE = "test";

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

/** A TiDB 4 server: no Global Kill, and `KILL QUERY` only warns (decision 058). */
export const TIDB_CONFIG = {
  host: hostFromEnv("TABLE_CRAFT_TIDB_HOST"),
  port: portFromEnv("TABLE_CRAFT_TIDB_PORT", DEFAULT_TIDB_PORT),
  database: TIDB_DATABASE,
  user: TIDB_USER,
  password: "",
} as const;

export function withWrongPassword<Config extends { readonly password: string }>(config: Config): Config {
  return { ...config, password: WRONG_PASSWORD };
}
