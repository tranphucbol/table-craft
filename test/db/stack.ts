/**
 * Starts a checkout's `compose.yml` databases with fresh fixtures. Postgres and MySQL seed from
 * their initdb directory only when the tmpfs data directory is empty, and `compose up` keeps a
 * running container whose configuration did not change, so a seed edit alone never reached a
 * running stack. Each seeded service carries the hash of what it reads at first start as a label
 * (`table-craft.seed`): a changed seed changes the label, compose recreates exactly that
 * container, and it seeds again.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composeProfiles, type TidbTarget } from "./tidbTarget.js";

const DB_DIRECTORY = import.meta.dirname;
export const COMPOSE_FILE = join(DB_DIRECTORY, "compose.yml");

export type SeededService = "postgres" | "mysql" | "postgres-tls" | "mysql-tls";

/**
 * What each service reads when its data directory is first made: the initdb scripts, and for the
 * TLS servers the certificates and `pg_hba.conf`, which they load once at start.
 */
const SEED_FILES: Readonly<Record<SeededService, readonly string[]>> = {
  postgres: ["schema/postgres.sql"],
  mysql: ["schema/mysql.sql"],
  "postgres-tls": ["tls/postgres.sql", "tls/pg_hba.conf", "tls/ca.crt", "tls/server.crt", "tls/server.key"],
  "mysql-tls": ["tls/mysql.sql", "tls/ca.crt", "tls/server.crt", "tls/server.key"],
};

/** The variable `compose.yml` interpolates into each service's `table-craft.seed` label. */
export const SEED_ENV: Readonly<Record<SeededService, string>> = {
  postgres: "TABLE_CRAFT_PG_SEED",
  mysql: "TABLE_CRAFT_MYSQL_SEED",
  "postgres-tls": "TABLE_CRAFT_PG_TLS_SEED",
  "mysql-tls": "TABLE_CRAFT_MYSQL_TLS_SEED",
};

const SERVICES = Object.keys(SEED_FILES) as SeededService[];

/** SHA-256 per seeded service over its seed files, in order, each prefixed by its path. */
export function seedHashes(directory: string = DB_DIRECTORY): Readonly<Record<SeededService, string>> {
  const entries = SERVICES.map((service) => {
    const hash = createHash("sha256");
    for (const file of SEED_FILES[service]) {
      hash.update(`${file}\0`);
      hash.update(readFileSync(join(directory, file)));
      hash.update("\0");
    }
    return [service, hash.digest("hex")] as const;
  });
  return Object.fromEntries(entries) as Record<SeededService, string>;
}

/** The label variables for `hashes`, to add to the environment of every `docker compose` call. */
export function seedEnv(hashes: Readonly<Record<SeededService, string>> = seedHashes()): Record<string, string> {
  return Object.fromEntries(SERVICES.map((service) => [SEED_ENV[service], hashes[service]]));
}

/**
 * `docker compose up -d --wait` with the seed labels set, leaving TiDB out when `target` is remote;
 * returns the environment the rest of the run should pass to compose and the suites. Exits the
 * process when compose fails, as the scripts that call it would.
 */
export function upDatabases(target: TidbTarget, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base, ...target.env, ...seedEnv() };
  const { status, error } = spawnSync(
    "docker",
    ["compose", "-f", COMPOSE_FILE, ...composeProfiles(target), "up", "-d", "--wait"],
    { stdio: "inherit", env },
  );
  if (error !== undefined) throw error;
  if (status !== 0) process.exit(status ?? 1);
  return env;
}
