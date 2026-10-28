/**
 * Vitest global setup for the smoke suites with databases: checks that every seeded server holds
 * its seed's newest objects before any Electron launches. A container that predates its seed
 * (`test/db/stack.ts`) otherwise shows up as tests waiting out their locator timeouts for a tree
 * item that is not there. `upDatabases` runs the same check to recreate such a container.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { SeededService } from "../db/stack.js";
import {
  type DatabaseId,
  DATABASES_ENV,
  MARIADB_CONFIG,
  MSSQL_CONFIG,
  MYSQL_CONFIG,
  MYSQL_TLS_CONFIG,
  ORACLE_CONFIG,
  POSTGRES_CONFIG,
  POSTGRES_TLS_CONFIG,
  REDIS5_CLUSTER_CONFIG,
  REDIS5_CONFIG,
  REDIS6_CLUSTER_CONFIG,
  REDIS6_CONFIG,
  REDIS_CLUSTER_CONFIG,
  REDIS_CONFIG,
  REDIS_TLS_CONFIG,
  selectedDatabases,
  SMOKE_DATABASES,
  TLS_FILES,
} from "./databases.js";

const CONNECT_TIMEOUT_MS = 5_000;
const MS_PER_SECOND = 1_000;
const UP_COMMAND = "bun test/db/up.ts";

export interface Sentinel {
  readonly service: SeededService;
  /** What the seed creates, as the failure names it. */
  readonly object: string;
  /** Returns a row when the object exists; for a Redis server, a command that answers 1. */
  readonly sql: string;
}

const REDIS_SERVICES = [
  "redis",
  "redis-tls",
  "redis-6",
  "redis-cluster",
  "redis-6-cluster",
  "redis-5",
  "redis-5-cluster",
] as const satisfies readonly SeededService[];

/**
 * One per seed file: its oldest object, which proves the seed ran, and its newest, which proves it
 * is the current seed. A seed edit that adds an object moves the newest sentinel to it.
 */
/** `schema/mysql.sql` seeds MySQL 8.4 and MariaDB alike. */
const MYSQL_SEEDED = ["mysql", "mariadb"] as const satisfies readonly SeededService[];

export const SENTINELS: readonly Sentinel[] = [
  { service: "postgres", object: "table type_probe", sql: "SELECT 1 FROM pg_tables WHERE tablename = 'type_probe'" },
  {
    service: "postgres",
    object: "procedure settle_order",
    sql: "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'settle_order'",
  },
  ...MYSQL_SEEDED.flatMap((service) => [
    {
      service,
      object: "table type_probe",
      sql: "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'table_craft' AND TABLE_NAME = 'type_probe'",
    },
    {
      service,
      object: "procedure settle_order",
      sql: "SELECT 1 FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = 'table_craft' AND ROUTINE_NAME = 'settle_order'",
    },
    {
      service,
      object: "table archive.old_orders",
      sql: "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'archive' AND TABLE_NAME = 'old_orders'",
    },
  ]),
  { service: "postgres-tls", object: "table tls_probe", sql: "SELECT 1 FROM pg_tables WHERE tablename = 'tls_probe'" },
  {
    service: "mysql-tls",
    object: "table tls_probe",
    sql: "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'table_craft' AND TABLE_NAME = 'tls_probe'",
  },
  { service: "oracle", object: "table seed_probe", sql: "SELECT 1 FROM user_tables WHERE table_name = 'SEED_PROBE'" },
  { service: "mssql", object: "table seed_probe", sql: "SELECT 1 FROM sys.tables WHERE name = 'seed_probe'" },
  { service: "mssql", object: "table tls_probe", sql: "SELECT 1 FROM sys.tables WHERE name = 'tls_probe'" },
  ...REDIS_SERVICES.map((service) => ({
    service,
    object: "key seed:probe",
    sql: "EXISTS seed:probe",
  })),
];

/**
 * The seeded services each database brings up, under the compose profile of the same name
 * (`test/db/compose.yml`), which also starts the unseeded `ssh` bastion for MySQL and PostgreSQL
 * and `mssql-seed`. TiDB has no seed: the suites make their own scratch databases on it.
 */
const SERVICES_OF: Readonly<Record<DatabaseId, readonly SeededService[]>> = {
  mysql: ["mysql", "mysql-tls"],
  tidb: [],
  mariadb: ["mariadb"],
  postgres: ["postgres", "postgres-tls"],
  oracle: ["oracle"],
  mssql: ["mssql"],
  redis: REDIS_SERVICES,
};

export function servicesOf(databases: readonly DatabaseId[]): SeededService[] {
  return databases.flatMap((id) => SERVICES_OF[id]);
}

/** The sentinels of `services` only: a server the run did not select is neither asked nor reported. */
export function sentinelsFor(services: readonly SeededService[]): readonly Sentinel[] {
  return SENTINELS.filter((sentinel) => services.includes(sentinel.service));
}

/** Asks one server whether `sql` returns a row; throws when the server cannot be reached. */
export type SentinelQuery = (service: SeededService, sql: string) => Promise<boolean>;

interface SentinelReport {
  /** The objects each reachable service lacks. */
  readonly missing: ReadonlyMap<SeededService, readonly string[]>;
  /** Why each service that could not be asked failed. */
  readonly unreachable: ReadonlyMap<SeededService, string>;
}

/** A refused connection to both `localhost` addresses is an `AggregateError` with no message, only a code. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as { code?: unknown }).code;
  return error.message || (typeof code === "string" ? code : error.name);
}

async function inspect(query: SentinelQuery, sentinels: readonly Sentinel[]): Promise<SentinelReport> {
  const missing = new Map<SeededService, string[]>();
  const unreachable = new Map<SeededService, string>();
  for (const sentinel of sentinels) {
    if (unreachable.has(sentinel.service)) continue;
    try {
      if (!(await query(sentinel.service, sentinel.sql))) {
        missing.set(sentinel.service, [...(missing.get(sentinel.service) ?? []), sentinel.object]);
      }
    } catch (error) {
      unreachable.set(sentinel.service, describeError(error));
    }
  }
  return { missing, unreachable };
}

/** The reachable services that lack a sentinel: their data no longer matches their seed. */
export async function servicesMissingSentinels(
  query: SentinelQuery = serverQuery,
  sentinels: readonly Sentinel[] = SENTINELS,
): Promise<SeededService[]> {
  return [...(await inspect(query, sentinels)).missing.keys()];
}

/** What is wrong with the stack, one line per service, empty when every sentinel is present. */
export async function staleServices(
  query: SentinelQuery,
  sentinels: readonly Sentinel[] = SENTINELS,
): Promise<string[]> {
  const { missing, unreachable } = await inspect(query, sentinels);
  return [
    ...[...unreachable].map(
      ([service, reason]) => `the \`${service}\` server did not answer (${reason}); run \`${UP_COMMAND}\``,
    ),
    ...[...missing].map(
      ([service, objects]) =>
        `the \`${service}\` container predates its seed (no ${objects.join(", ")}); run \`${UP_COMMAND}\``,
    ),
  ];
}

interface PgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

interface MysqlConnection {
  query(sql: string): Promise<[unknown, unknown]>;
  end(): Promise<void>;
}

/** The plugins' own drivers, which the root workspace does not depend on. */
const pg = createRequire(new URL("../../plugins/postgres/package.json", import.meta.url))("pg") as {
  Client: new (options: Record<string, unknown>) => PgClient;
};
const mysql = createRequire(new URL("../../plugins/mysql/package.json", import.meta.url))("mysql2/promise") as {
  createConnection(options: Record<string, unknown>): Promise<MysqlConnection>;
};

async function postgresHasRow(config: Record<string, unknown>, sql: string): Promise<boolean> {
  const client = new pg.Client({ ...config, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  await client.connect();
  try {
    return (await client.query(sql)).rows.length > 0;
  } finally {
    await client.end();
  }
}

async function mysqlHasRow(config: Record<string, unknown>, sql: string): Promise<boolean> {
  const connection = await mysql.createConnection({ ...config, connectTimeout: CONNECT_TIMEOUT_MS });
  try {
    const [rows] = await connection.query(sql);
    return (rows as unknown[]).length > 0;
  } finally {
    await connection.end();
  }
}

interface RedisConnection {
  connect(): Promise<unknown>;
  sendCommand(...args: unknown[]): Promise<unknown>;
  destroy(): void;
}

const redis = createRequire(new URL("../../plugins/redis/package.json", import.meta.url))("redis") as {
  createClient(
    options: Record<string, unknown>,
  ): RedisConnection & { on(event: string, listener: () => void): unknown };
  createCluster(
    options: Record<string, unknown>,
  ): RedisConnection & { on(event: string, listener: () => void): unknown };
};

interface RedisTarget {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly nodeAddressMap?: string;
}

/** `announced=host:port` pairs, as the plugin's Node address map field takes them. */
function addressMapOf(text: string): Record<string, { host: string; port: number }> {
  const map: Record<string, { host: string; port: number }> = {};
  for (const entry of text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")) {
    const [announced = "", reachable = ""] = entry.split("=");
    const [host = "", port = ""] = reachable.split(":");
    map[announced] = { host, port: Number(port) };
  }
  return map;
}

/** Redis 5.0 has no `HELLO`, so the sentinel speaks RESP2 to every version. */
const SENTINEL_RESP = 2;

/** Runs `command` (one key at most, the last word) and answers whether the reply is 1. */
async function redisAnswersOne(
  target: RedisTarget,
  command: string,
  options: { cluster?: boolean; tls?: boolean } = {},
): Promise<boolean> {
  const socket = {
    host: target.host,
    port: target.port,
    connectTimeout: CONNECT_TIMEOUT_MS,
    reconnectStrategy: false,
    ...(options.tls === true ? { tls: true, ca: readFileSync(TLS_FILES.ca, "utf8") } : {}),
  };
  const credentials =
    target.user === "" ? { password: target.password } : { username: target.user, password: target.password };
  const connection =
    options.cluster === true
      ? redis.createCluster({
          RESP: SENTINEL_RESP,
          rootNodes: [{ socket }],
          defaults: { ...credentials, socket: { reconnectStrategy: false } },
          nodeAddressMap: addressMapOf(target.nodeAddressMap ?? ""),
        })
      : redis.createClient({ RESP: SENTINEL_RESP, socket, ...credentials });
  connection.on("error", () => undefined);
  await connection.connect();
  try {
    const args = command.split(" ");
    const reply =
      options.cluster === true
        ? await connection.sendCommand(args.at(-1), true, args)
        : await connection.sendCommand(args);
    return reply === 1;
  } finally {
    connection.destroy();
  }
}

/** node-oracledb in thin mode, the Oracle plugin's driver. */
async function oracleHasRow(sql: string): Promise<boolean> {
  const { default: oracledb } = await import("oracledb");
  const { host, port, service, user, password } = ORACLE_CONFIG;
  const connection = await oracledb.getConnection({
    user,
    password,
    connectString: `${host}:${String(port)}/${service}`,
    connectTimeout: CONNECT_TIMEOUT_MS / MS_PER_SECOND,
  });
  try {
    return ((await connection.execute(sql)).rows ?? []).length > 0;
  } finally {
    await connection.close();
  }
}

/** tedious, the driver plan 055's plugin will use; the test server's certificate is self-signed. */
async function mssqlHasRow(sql: string): Promise<boolean> {
  const { Connection, Request } = await import("tedious");
  const { host, port, database, user, password } = MSSQL_CONFIG;
  const connection = new Connection({
    server: host,
    authentication: { type: "default", options: { userName: user, password } },
    options: { port, database, trustServerCertificate: true, connectTimeout: CONNECT_TIMEOUT_MS },
  });
  await new Promise<void>((resolve, reject) => {
    connection.on("connect", (error) => (error === undefined ? resolve() : reject(error)));
    connection.connect();
  });
  try {
    let rows = 0;
    await new Promise<void>((resolve, reject) => {
      const request = new Request(sql, (error) => (error === undefined || error === null ? resolve() : reject(error)));
      request.on("row", () => (rows += 1));
      connection.execSql(request);
    });
    return rows > 0;
  } finally {
    connection.close();
  }
}

export const serverQuery: SentinelQuery = (service, sql) => {
  const tls = { ca: readFileSync(TLS_FILES.ca, "utf8") };
  switch (service) {
    case "postgres":
      return postgresHasRow(POSTGRES_CONFIG, sql);
    case "mysql":
      return mysqlHasRow(MYSQL_CONFIG, sql);
    case "mariadb":
      return mysqlHasRow(MARIADB_CONFIG, sql);
    case "postgres-tls":
      return postgresHasRow({ ...POSTGRES_TLS_CONFIG, ssl: tls }, sql);
    case "mysql-tls":
      return mysqlHasRow({ ...MYSQL_TLS_CONFIG, ssl: tls }, sql);
    case "oracle":
      return oracleHasRow(sql);
    case "mssql":
      return mssqlHasRow(sql);
    case "redis":
      return redisAnswersOne(REDIS_CONFIG, sql);
    case "redis-tls":
      return redisAnswersOne(REDIS_TLS_CONFIG, sql, { tls: true });
    case "redis-6":
      return redisAnswersOne(REDIS6_CONFIG, sql);
    case "redis-cluster":
      return redisAnswersOne(REDIS_CLUSTER_CONFIG, sql, { cluster: true });
    case "redis-6-cluster":
      return redisAnswersOne(REDIS6_CLUSTER_CONFIG, sql, { cluster: true });
    case "redis-5":
      return redisAnswersOne(REDIS5_CONFIG, sql);
    case "redis-5-cluster":
      return redisAnswersOne(REDIS5_CLUSTER_CONFIG, sql, { cluster: true });
  }
};

/** Set once the check passed: every Vitest project runs the global setup in the one main process. */
const CHECKED_ENV = "TABLE_CRAFT_SMOKE_FIXTURES_CHECKED";

/** The smoke files take MySQL and TiDB as given and skip only the opt-in servers' scenarios. */
export function smokeSelectionProblem(databases: readonly DatabaseId[]): string | null {
  const missing = SMOKE_DATABASES.filter((id) => !databases.includes(id));
  if (missing.length === 0) return null;
  return `${DATABASES_ENV} leaves out ${missing.join(", ")}, which every smoke run needs; add to ${SMOKE_DATABASES.join(",")} instead`;
}

export async function setup(): Promise<void> {
  if (process.env[CHECKED_ENV] === "1") return;
  const databases = selectedDatabases();
  const selection = smokeSelectionProblem(databases);
  if (selection !== null) throw new Error(selection);
  const problems = await staleServices(serverQuery, sentinelsFor(servicesOf(databases)));
  if (problems.length > 0) throw new Error(`The test databases are not ready:\n- ${problems.join("\n- ")}`);
  process.env[CHECKED_ENV] = "1";
}
