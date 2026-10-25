/**
 * Vitest global setup: gives the run its own database on TiDB and drops it afterwards, so the
 * suites never work in a database they did not create, even on a shared server
 * (test/db/tidbTarget.ts). Workers read the name from `TABLE_CRAFT_TIDB_DATABASE`.
 */
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { resolveTidbTarget } from "../db/tidbTarget.js";
import { databaseEnabled, TIDB_SCRATCH_PREFIX, tidbConfigFromEnv } from "./databases.js";

const DATABASE_ENV = "TABLE_CRAFT_TIDB_DATABASE";
const RADIX = 36;
const RANDOM_BYTES = 3;
/** Scratch databases a crashed run left behind; older than any run, younger than none in flight. */
const STALE_AFTER_MS = 6 * 60 * 60 * 1_000;
const SCRATCH_NAME = new RegExp(`^${TIDB_SCRATCH_PREFIX}([0-9a-z]+)_[0-9a-z]+`);

interface Connection {
  query(sql: string): Promise<[unknown, unknown]>;
  end(): Promise<void>;
}

interface Driver {
  createConnection(options: Record<string, unknown>): Promise<Connection>;
}

/** The plugin's own copy of mysql2, which the root workspace does not depend on. */
const driver = createRequire(new URL("../../plugins/mysql/package.json", import.meta.url))("mysql2/promise") as Driver;

async function withServer<T>(work: (connection: Connection) => Promise<T>): Promise<T> {
  const { database: _database, ...server } = tidbConfigFromEnv();
  const connection = await driver.createConnection(server);
  try {
    return await work(connection);
  } finally {
    await connection.end();
  }
}

async function dropStale(connection: Connection, now: number): Promise<void> {
  const [rows] = await connection.query(`SHOW DATABASES LIKE '${TIDB_SCRATCH_PREFIX.replaceAll("_", "\\_")}%'`);
  for (const row of rows as Record<string, string>[]) {
    const name = Object.values(row)[0] ?? "";
    const stamp = SCRATCH_NAME.exec(name)?.[1];
    if (stamp !== undefined && now - parseInt(stamp, RADIX) > STALE_AFTER_MS) {
      await connection.query(`DROP DATABASE IF EXISTS \`${name}\``);
    }
  }
}

export async function setup(): Promise<() => Promise<void>> {
  // Every Vitest project runs the global setup in the one main process; the first database serves all.
  if (process.env[DATABASE_ENV]?.startsWith(TIDB_SCRATCH_PREFIX) === true) return () => Promise.resolve();
  if (!databaseEnabled("tidb")) return () => Promise.resolve();
  // In the headless box the remote settings are not passed in; compose already points it.
  const target = await resolveTidbTarget();
  Object.assign(process.env, target.env);
  const given = process.env.TABLE_CRAFT_TIDB_HOST;
  console.log(
    !target.remote && given !== undefined
      ? `TiDB: ${given}:${process.env.TABLE_CRAFT_TIDB_PORT ?? ""}, as the caller set it`
      : target.description,
  );
  const now = Date.now();
  const name = `${TIDB_SCRATCH_PREFIX}${now.toString(RADIX)}_${randomBytes(RANDOM_BYTES).toString("hex")}`;
  await withServer(async (connection) => {
    await dropStale(connection, now);
    await connection.query(`CREATE DATABASE \`${name}\``);
  });
  process.env[DATABASE_ENV] = name;
  return async () => {
    // Suites name their own scratch databases after the run's (`tidbScratchDatabase`).
    await withServer(async (connection) => {
      const [rows] = await connection.query(`SHOW DATABASES LIKE '${name.replaceAll("_", "\\_")}%'`);
      for (const row of rows as Record<string, string>[]) {
        await connection.query(`DROP DATABASE IF EXISTS \`${Object.values(row)[0] ?? ""}\``);
      }
    });
  };
}
