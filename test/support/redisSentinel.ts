/** Drives the `redis-sentinel` test service's failover for the db and live suites (plan 133). */
import redis from "@table-craft/plugin-redis";
import type { ExecuteResult, Session } from "@table-craft/plugin-api";
import { REDIS_SENTINEL_CONFIG } from "./databases.js";

export const MASTER_NAME = "mymaster";
export const FAILOVER_TIMEOUT_MS = 30_000;
const POLL_MS = 200;
/** A Sentinel answers plain commands; a Standalone datasource on its port is how a user reaches one. */
export const SENTINEL_CONSOLE = {
  mode: "standalone",
  host: REDIS_SENTINEL_CONFIG.host,
  port: REDIS_SENTINEL_CONFIG.port,
  password: REDIS_SENTINEL_CONFIG.sentinelPassword,
} as const;

export function connectRedis(config: unknown = REDIS_SENTINEL_CONFIG): Promise<Session> {
  return redis.connect(redis.connectionSchema.parse(config), { readOnly: false });
}

export async function rowsOf(result: ExecuteResult): Promise<unknown[][]> {
  const rows: unknown[][] = [];
  for await (const row of result.rows) rows.push([...row]);
  return rows;
}

export function textOf(value: unknown): string {
  if (typeof value === "object" && value !== null && "text" in value) return String(value.text);
  return String(value);
}

export async function nodesOf(session: Session) {
  if (session.nodes === undefined) throw new Error("the Redis plugin declares nodes");
  return session.nodes();
}

function pause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, POLL_MS));
}

/** The master Sentinel names now, as `ip:port`. */
export async function masterAddress(): Promise<string> {
  const sentinel = await connectRedis(SENTINEL_CONSOLE);
  try {
    const rows = await rowsOf(await sentinel.execute(`SENTINEL GET-MASTER-ADDR-BY-NAME ${MASTER_NAME}`));
    return rows.map((row) => textOf(row.at(-1))).join(":");
  } finally {
    await sentinel.close();
  }
}

/** The role the data server at `address` reports, or null while it does not answer. */
async function roleAt(address: string): Promise<string | null> {
  const port = Number(address.split(":").at(-1));
  const { host, user, password } = REDIS_SENTINEL_CONFIG;
  const server = await connectRedis({ mode: "standalone", host, port, user, password }).catch(() => null);
  if (server === null) return null;
  try {
    const rows = await rowsOf(await server.execute("ROLE"));
    return textOf(rows[0]?.at(-1));
  } catch {
    return null;
  } finally {
    await server.close();
  }
}

async function replicaOnline(): Promise<boolean> {
  const session = await connectRedis().catch(() => null);
  if (session === null) return false;
  try {
    return (await nodesOf(session))[1]?.state === "online";
  } catch {
    return false;
  } finally {
    await session.close();
  }
}

/** A run right after another one's failover finds the demoted master still syncing. */
export async function replicaInSync(): Promise<void> {
  const deadline = Date.now() + FAILOVER_TIMEOUT_MS;
  while (!(await replicaOnline())) {
    if (Date.now() > deadline) throw new Error(`no replica in sync after ${String(FAILOVER_TIMEOUT_MS)} ms`);
    await pause();
  }
}

/** Promotes the replica and waits until Sentinel names it and the old master has stepped down. */
export async function failover(): Promise<{ before: string; after: string }> {
  await replicaInSync();
  const before = await masterAddress();
  const sentinel = await connectRedis(SENTINEL_CONSOLE);
  try {
    await sentinel.execute(`SENTINEL FAILOVER ${MASTER_NAME}`);
  } finally {
    await sentinel.close();
  }
  const deadline = Date.now() + FAILOVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const after = await masterAddress();
    if (after !== before && (await roleAt(after)) === "master" && (await roleAt(before)) === "slave") {
      return { before, after };
    }
    await pause();
  }
  throw new Error(`Sentinel still names ${before} after ${String(FAILOVER_TIMEOUT_MS)} ms`);
}
