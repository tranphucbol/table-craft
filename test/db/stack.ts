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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DATABASE_IDS, type DatabaseId, DATABASES_ENV, selectedDatabases } from "../support/databases.js";
import { sentinelsFor, servicesMissingSentinels, servicesOf } from "../support/smokeFixtures.js";
import { TIDB_PROFILE, type TidbTarget } from "./tidbTarget.js";

const DB_DIRECTORY = import.meta.dirname;
export const COMPOSE_FILE = join(DB_DIRECTORY, "compose.yml");

export type SeededService =
  | "postgres"
  | "mysql"
  | "mariadb"
  | "postgres-tls"
  | "mysql-tls"
  | "oracle"
  | "mssql"
  | "redis"
  | "redis-tls"
  | "redis-6"
  | "redis-cluster"
  | "redis-6-cluster"
  | "redis-5"
  | "redis-5-cluster"
  | "etcd"
  | "etcd-3-5"
  | "etcd-tls";

/** What a Redis server reads at start (`redis/*.sh`): its users, its start script and the seeds. */
const REDIS_STANDALONE_SEED = [
  "redis/users.sh",
  "redis/seed.sh",
  "redis/standalone.sh",
  "schema/redis.redis",
  "schema/redis-db1.redis",
];
const REDIS_CLUSTER_SEED = ["redis/users.sh", "redis/seed.sh", "redis/cluster.sh", "schema/redis.redis"];
/** What `etcd-seed` reads, which seeds both etcd servers: its image, its script and the keys. */
const ETCD_SEED = ["etcd/Dockerfile", "etcd/seed.sh", "schema/etcd.etcd"];

/**
 * What each service reads when its data directory is first made: the initdb scripts, and for the
 * TLS servers the certificates and `pg_hba.conf`, which they load once at start. A directory
 * stands for every file under it.
 */
const SEED_FILES: Readonly<Record<SeededService, readonly string[]>> = {
  postgres: ["schema/postgres.sql"],
  mysql: ["schema/mysql.sql"],
  mariadb: ["schema/mysql.sql"],
  "postgres-tls": ["tls/postgres.sql", "tls/pg_hba.conf", "tls/ca.crt", "tls/server.crt", "tls/server.key"],
  "mysql-tls": ["tls/mysql.sql", "tls/ca.crt", "tls/server.crt", "tls/server.key"],
  oracle: ["schema/oracle"],
  mssql: ["schema/mssql.sql", "tls/mssql.conf", "tls/server.crt", "tls/server.key"],
  redis: REDIS_STANDALONE_SEED,
  "redis-tls": [...REDIS_STANDALONE_SEED, "tls/ca.crt", "tls/server.crt", "tls/server.key"],
  "redis-6": REDIS_STANDALONE_SEED,
  "redis-cluster": REDIS_CLUSTER_SEED,
  "redis-6-cluster": REDIS_CLUSTER_SEED,
  "redis-5": REDIS_STANDALONE_SEED,
  "redis-5-cluster": REDIS_CLUSTER_SEED,
  etcd: ETCD_SEED,
  "etcd-3-5": ETCD_SEED,
  "etcd-tls": [
    "etcd/Dockerfile",
    "etcd/transport-seed.sh",
    "etcd/server.crt",
    "etcd/server.key",
    "tls/ca.crt",
    "tls/client.crt",
    "tls/client.key",
  ],
};

/** The variable `compose.yml` interpolates into each service's `table-craft.seed` label. */
export const SEED_ENV: Readonly<Record<SeededService, string>> = {
  postgres: "TABLE_CRAFT_PG_SEED",
  mysql: "TABLE_CRAFT_MYSQL_SEED",
  mariadb: "TABLE_CRAFT_MARIADB_SEED",
  "postgres-tls": "TABLE_CRAFT_PG_TLS_SEED",
  "mysql-tls": "TABLE_CRAFT_MYSQL_TLS_SEED",
  oracle: "TABLE_CRAFT_ORACLE_SEED",
  mssql: "TABLE_CRAFT_MSSQL_SEED",
  redis: "TABLE_CRAFT_REDIS_SEED",
  "redis-tls": "TABLE_CRAFT_REDIS_TLS_SEED",
  "redis-6": "TABLE_CRAFT_REDIS6_SEED",
  "redis-cluster": "TABLE_CRAFT_REDIS_CLUSTER_SEED",
  "redis-6-cluster": "TABLE_CRAFT_REDIS6_CLUSTER_SEED",
  "redis-5": "TABLE_CRAFT_REDIS5_SEED",
  "redis-5-cluster": "TABLE_CRAFT_REDIS5_CLUSTER_SEED",
  etcd: "TABLE_CRAFT_ETCD_SEED",
  "etcd-3-5": "TABLE_CRAFT_ETCD35_SEED",
  "etcd-tls": "TABLE_CRAFT_ETCD_TLS_SEED",
};

const SERVICES = Object.keys(SEED_FILES) as SeededService[];

/**
 * What else to recreate with a stale service: the one-shot service that seeds a server with no
 * initdb directory, and for etcd the other server too, since `etcd-seed` reseeds both and the
 * fixture's revisions hold only on a fresh one.
 */
const RECREATED_WITH: Partial<Readonly<Record<SeededService, readonly string[]>>> = {
  mssql: ["mssql-seed"],
  etcd: ["etcd-3-5", "etcd-seed"],
  "etcd-3-5": ["etcd", "etcd-seed"],
  "etcd-tls": ["etcd-tls-seed"],
};

function seedFiles(directory: string, path: string): string[] {
  if (!statSync(join(directory, path)).isDirectory()) return [path];
  return readdirSync(join(directory, path))
    .sort()
    .flatMap((entry) => seedFiles(directory, `${path}/${entry}`));
}

/** SHA-256 per seeded service over its seed files, in order, each prefixed by its path. */
export function seedHashes(directory: string = DB_DIRECTORY): Readonly<Record<SeededService, string>> {
  const entries = SERVICES.map((service) => {
    const hash = createHash("sha256");
    for (const file of SEED_FILES[service].flatMap((path) => seedFiles(directory, path))) {
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

function compose(args: readonly string[], env: NodeJS.ProcessEnv): void {
  const { status, error } = spawnSync("docker", ["compose", "-f", COMPOSE_FILE, ...args], { stdio: "inherit", env });
  if (error !== undefined) throw error;
  if (status !== 0) process.exit(status ?? 1);
}

export interface Stack {
  /** `--profile` arguments for every `docker compose` call of the run. */
  readonly profiles: readonly string[];
  /** The seeded services those profiles start, the only ones checked for a stale seed. */
  readonly services: readonly SeededService[];
}

/**
 * What a run over `databases` starts: one profile per selected database, and the local TiDB
 * container only when TiDB is selected and the remote one did not answer.
 */
export function stackFor(databases: readonly DatabaseId[], target: TidbTarget): Stack {
  const profiles = databases.flatMap((id) => {
    if (id !== "tidb") return [id];
    return target.remote ? [] : [TIDB_PROFILE];
  });
  return {
    profiles: profiles.flatMap((profile) => ["--profile", profile]),
    services: servicesOf(databases),
  };
}

/** The run's first line: which servers it uses and why. */
export function describeSelection(databases: readonly DatabaseId[], env: NodeJS.ProcessEnv = process.env): string {
  const from = (env[DATABASES_ENV] ?? "").trim() === "" ? `${DATABASES_ENV} unset, the normal flow` : DATABASES_ENV;
  const left = DATABASE_IDS.filter((id) => !databases.includes(id));
  return `Databases: ${databases.join(", ")} (from ${from}); not started: ${left.length > 0 ? left.join(", ") : "none"}`;
}

/**
 * `docker compose up -d --wait` over the selected databases' profiles with the seed labels set,
 * leaving TiDB out when `target` is remote, then recreates any selected seeded service whose
 * sentinel objects are gone (`smokeFixtures.ts`): one whose label is current but whose data is
 * not, such as a container a suite damaged. Returns the environment the rest of the run should
 * pass to compose and the suites. Exits the process when compose fails, as the scripts that call
 * it would.
 */
export async function upDatabases(
  target: TidbTarget,
  base: NodeJS.ProcessEnv = process.env,
  databases: readonly DatabaseId[] = selectedDatabases(base),
): Promise<NodeJS.ProcessEnv> {
  const env = { ...base, ...target.env, ...seedEnv() };
  const { profiles, services } = stackFor(databases, target);
  if (profiles.length === 0) return env;
  compose([...profiles, "up", "-d", "--wait"], env);
  const stale = await servicesMissingSentinels(undefined, sentinelsFor(services));
  if (stale.length > 0) {
    console.log(`Reseeding ${stale.join(", ")}: their seed objects are missing.`);
    const recreated = [...new Set(stale.flatMap((service) => [service, ...(RECREATED_WITH[service] ?? [])]))];
    compose([...profiles, "up", "-d", "--wait", "--force-recreate", ...recreated], env);
  }
  return env;
}
