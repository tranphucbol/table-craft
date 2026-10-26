import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import redis from "@table-craft/plugin-redis";
import { POSTGRES_CONFIG, REDIS_CONFIG } from "../support/databases.js";

/** The demo shop's database inside the `test:db` PostgreSQL container, beside the fixture one. */
export const SHOP_DATABASE = "shop";
export const SHOP_SQLITE_FILE = "shop.db";
/** The demo cache's database in the `test:db` `redis` service; the fixture keys use 0 and 1. */
export const SHOP_REDIS_DATABASE = 3;

const COMPOSE_FILE = new URL("../db/compose.yml", import.meta.url).pathname;
const POSTGRES_SEED = new URL("./shop.postgres.sql", import.meta.url);
const SQLITE_SEED = new URL("./shop.sqlite.sql", import.meta.url);
const REDIS_SEED = new URL("./shop.redis", import.meta.url);
/** As many as `shop.postgres.sql` inserts, with the same stock formula. */
const PRODUCTS = 30;
const STOCK_MODULUS = 90;
const STOCK_FACTOR = 13;
const POSTGRES_SERVICE = "postgres";
/** The maintenance database psql connects to while `shop` is dropped and re-created. */
const MAINTENANCE_DATABASE = "postgres";

function psql(database: string, args: string[], input?: string): void {
  execFileSync(
    "docker",
    [
      "compose",
      "-f",
      COMPOSE_FILE,
      "exec",
      "-T",
      POSTGRES_SERVICE,
      "psql",
      "-U",
      POSTGRES_CONFIG.user,
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
      ...args,
    ],
    { input, stdio: ["pipe", "ignore", "pipe"] },
  );
}

/**
 * Drops and re-creates `shop` in the `test:db` container from `shop.postgres.sql`, so every
 * recording starts from the same rows whatever the previous one wrote. `WITH (FORCE)` closes the
 * sessions a crashed run may have left open.
 */
export function loadShopPostgres(): void {
  psql(MAINTENANCE_DATABASE, [
    "-c",
    `DROP DATABASE IF EXISTS ${SHOP_DATABASE} WITH (FORCE)`,
    "-c",
    `CREATE DATABASE ${SHOP_DATABASE}`,
  ]);
  psql(SHOP_DATABASE, [], readFileSync(POSTGRES_SEED, "utf8"));
}

/** Empties database 3 of the `redis` service and fills it from `shop.redis` and the products. */
export async function loadShopRedis(): Promise<void> {
  const seed = readFileSync(REDIS_SEED, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const stock = Array.from(
    { length: PRODUCTS },
    (_, index) => `SET product:${index + 1}:stock ${((index + 1) * STOCK_FACTOR) % STOCK_MODULUS}`,
  );
  const session = await redis.connect({ ...REDIS_CONFIG, database: SHOP_REDIS_DATABASE }, { readOnly: false });
  try {
    for (const command of ["FLUSHDB", ...seed, ...stock]) await session.execute(command);
  } finally {
    await session.close();
  }
}

/** Writes `shop.db` into `directory` from `shop.sqlite.sql` and returns its path. */
export function buildShopSqlite(directory: string): string {
  const path = join(directory, SHOP_SQLITE_FILE);
  const database = new DatabaseSync(path);
  try {
    database.exec(readFileSync(SQLITE_SEED, "utf8"));
  } finally {
    database.close();
  }
  return path;
}
