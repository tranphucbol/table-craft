/**
 * Vitest global setup for the smoke suites with databases: checks that every seeded server holds
 * its seed's newest objects before any Electron launches. A container that predates its seed
 * (`test/db/stack.ts`) otherwise shows up as tests waiting out their locator timeouts for a tree
 * item that is not there. `upDatabases` runs the same check to recreate such a container.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { SeededService } from "../db/stack.js";
import { MYSQL_CONFIG, MYSQL_TLS_CONFIG, POSTGRES_CONFIG, POSTGRES_TLS_CONFIG, TLS_FILES } from "./databases.js";

const CONNECT_TIMEOUT_MS = 5_000;
const UP_COMMAND = "bun test/db/up.ts";

export interface Sentinel {
  readonly service: SeededService;
  /** What the seed creates, as the failure names it. */
  readonly object: string;
  /** Returns a row when the object exists. */
  readonly sql: string;
}

/**
 * One per seed file: its oldest object, which proves the seed ran, and its newest, which proves it
 * is the current seed. A seed edit that adds an object moves the newest sentinel to it.
 */
export const SENTINELS: readonly Sentinel[] = [
  { service: "postgres", object: "table type_probe", sql: "SELECT 1 FROM pg_tables WHERE tablename = 'type_probe'" },
  {
    service: "postgres",
    object: "procedure settle_order",
    sql: "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'settle_order'",
  },
  {
    service: "mysql",
    object: "table type_probe",
    sql: "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'table_craft' AND TABLE_NAME = 'type_probe'",
  },
  {
    service: "mysql",
    object: "procedure settle_order",
    sql: "SELECT 1 FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = 'table_craft' AND ROUTINE_NAME = 'settle_order'",
  },
  {
    service: "mysql",
    object: "table archive.old_orders",
    sql: "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'archive' AND TABLE_NAME = 'old_orders'",
  },
  { service: "postgres-tls", object: "table tls_probe", sql: "SELECT 1 FROM pg_tables WHERE tablename = 'tls_probe'" },
  {
    service: "mysql-tls",
    object: "table tls_probe",
    sql: "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'table_craft' AND TABLE_NAME = 'tls_probe'",
  },
];

/** Asks one server whether `sql` returns a row; throws when the server cannot be reached. */
export type SentinelQuery = (service: SeededService, sql: string) => Promise<boolean>;

interface SentinelReport {
  /** The objects each reachable service lacks. */
  readonly missing: ReadonlyMap<SeededService, readonly string[]>;
  /** Why each service that could not be asked failed. */
  readonly unreachable: ReadonlyMap<SeededService, string>;
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
      unreachable.set(sentinel.service, error instanceof Error ? error.message : String(error));
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

const serverQuery: SentinelQuery = (service, sql) => {
  const tls = { ca: readFileSync(TLS_FILES.ca, "utf8") };
  switch (service) {
    case "postgres":
      return postgresHasRow(POSTGRES_CONFIG, sql);
    case "mysql":
      return mysqlHasRow(MYSQL_CONFIG, sql);
    case "postgres-tls":
      return postgresHasRow({ ...POSTGRES_TLS_CONFIG, ssl: tls }, sql);
    case "mysql-tls":
      return mysqlHasRow({ ...MYSQL_TLS_CONFIG, ssl: tls }, sql);
  }
};

/** Set once the check passed: every Vitest project runs the global setup in the one main process. */
const CHECKED_ENV = "TABLE_CRAFT_SMOKE_FIXTURES_CHECKED";

export async function setup(): Promise<void> {
  if (process.env[CHECKED_ENV] === "1") return;
  const problems = await staleServices(serverQuery);
  if (problems.length > 0) throw new Error(`The test databases are not ready:\n- ${problems.join("\n- ")}`);
  process.env[CHECKED_ENV] = "1";
}
