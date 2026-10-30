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

/** The demo etcd's loopback port, beside the `test:db` etcd services' 52379 to 52381. */
export const SHOP_ETCD_PORT = 52390;
export const SHOP_ETCD_NAMESPACE = "/shop/";
const ETCD_SEED = new URL("./shop.etcd", import.meta.url);
/** The `test:db` `etcd` service's image, so `readme:media` pulls nothing new. */
const ETCD_IMAGE = "gcr.io/etcd-development/etcd:v3.6.5";
const ETCD_CONTAINER = "table-craft-readme-etcd";
const ETCD_READY_TIMEOUT_MS = 15_000;
const ETCD_POLL_MS = 200;
const STOCK_KEYS = 20;
const SESSION_KEY = "/shop/session/u17";
const SESSION_TTL_SECONDS = 3600;
const JSON_SUFFIX = ".json";
const JSON_INDENT = 2;

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function etcdctl(...args: string[]): string {
  return docker(["exec", ETCD_CONTAINER, "/usr/local/bin/etcdctl", ...args]);
}

/** Removes the demo etcd; nothing of it outlives the scene. */
export function stopShopEtcd(): void {
  try {
    docker(["rm", "--force", ETCD_CONTAINER]);
  } catch (error) {
    if (!String(error).includes("No such container")) throw error;
  }
}

async function etcdReady(): Promise<void> {
  const deadline = Date.now() + ETCD_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const healthy = await fetch(`http://127.0.0.1:${String(SHOP_ETCD_PORT)}/health`)
      .then((response) => response.ok)
      .catch(() => false);
    if (healthy) return;
    await new Promise((resolve) => setTimeout(resolve, ETCD_POLL_MS));
  }
  throw new Error(
    `The demo etcd did not answer on port ${String(SHOP_ETCD_PORT)}; see \`docker logs ${ETCD_CONTAINER}\`.`,
  );
}

/**
 * Starts a disposable etcd and fills it from `shop.etcd`, the stock keys and one leased session.
 * Disposable rather than the `test:db` `etcd` service, because etcd keeps every write in a key's
 * History and only compaction forgets it: on a shared server each recording would show the last
 * one's versions too.
 */
export async function loadShopEtcd(): Promise<void> {
  stopShopEtcd();
  docker([
    "run",
    "--detach",
    "--name",
    ETCD_CONTAINER,
    "--publish",
    `127.0.0.1:${String(SHOP_ETCD_PORT)}:2379`,
    "--tmpfs",
    "/var/lib/etcd",
    ETCD_IMAGE,
    "/usr/local/bin/etcd",
    "--name=shop",
    "--data-dir=/var/lib/etcd",
    "--listen-client-urls=http://0.0.0.0:2379",
    `--advertise-client-urls=http://127.0.0.1:${String(SHOP_ETCD_PORT)}`,
    "--listen-peer-urls=http://127.0.0.1:2380",
    "--initial-advertise-peer-urls=http://127.0.0.1:2380",
    "--initial-cluster=shop=http://127.0.0.1:2380",
  ]);
  await etcdReady();
  const seed = readFileSync(ETCD_SEED, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"));
  for (const line of seed) {
    const space = line.indexOf(" ");
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    etcdctl("put", key, key.endsWith(JSON_SUFFIX) ? JSON.stringify(JSON.parse(value), null, JSON_INDENT) : value);
  }
  for (let index = 1; index <= STOCK_KEYS; index++) {
    etcdctl("put", `/shop/stock/sku-${String(index).padStart(2, "0")}`, String((index * STOCK_FACTOR) % STOCK_MODULUS));
  }
  const lease = /^lease (\w+) granted/.exec(etcdctl("lease", "grant", String(SESSION_TTL_SECONDS)))?.[1];
  if (lease === undefined) throw new Error("The demo etcd granted no lease.");
  etcdctl("put", `--lease=${lease}`, SESSION_KEY, '{"user":17,"cart":1042}');
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
