import {
  PluginError,
  type KeyApplied,
  type KeyApplyOptions,
  type KeyChange,
  type KeyContents,
  type KeyDatabase,
  type KeyExpiry,
  type KeyInfo,
  type KeyName,
  type KeyReadRequest,
  type KeyScan,
  type KeyScanRequest,
  type Keyspace,
  type KeyType,
} from "@table-craft/plugin-api";
import { TYPE_MAPPING } from "./connect.js";
import { bytesOf, keyBytesOf } from "./keyBytes.js";
import { readKey, type ReadHost } from "./read.js";
import type { Router } from "./routing.js";

/** The databases a server has when `CONFIG GET databases` is refused, Redis' default. */
const DEFAULT_DATABASES = 16;
const KEYSPACE_LINE = /^db(\d+):keys=(\d+),expires=(\d+)/gm;
const END_OF_PASS = "0";
const NO_EXPIRY = -1;
const MISSING = -2;
const COMMAND_OPTIONS = { typeMapping: TYPE_MAPPING };

/** The `TYPE` reply of each key type; `other` has none, so a scan cannot filter by it. */
const SERVER_TYPES: Readonly<Record<KeyType, string | null>> = {
  string: "string",
  hash: "hash",
  list: "list",
  set: "set",
  zset: "zset",
  stream: "stream",
  json: "ReJSON-RL",
  other: null,
};

/** What the keyspace needs from its session. */
export interface KeyspaceHost {
  readonly mode: "standalone" | "cluster";
  readonly delimiter: string;
  readonly scanBatch: number;
  readonly configuredDatabase: number;
  readonly router: Router;
  /** Runs `work` with the connection on `database`, one call at a time. */
  onDatabase<T>(database: number, work: () => Promise<T>): Promise<T>;
  /** Whether the server has per-field hash TTLs (Redis 7.4). */
  hashFieldTtl(): Promise<boolean>;
}

/** A `TYPE` reply as a key type; null for `none`, a key that does not exist. */
export function keyTypeOf(name: string): KeyType | null {
  if (name === "none") return null;
  const known = Object.entries(SERVER_TYPES).find(([, server]) => server === name);
  return known === undefined ? "other" : (known[0] as KeyType);
}

/** `INFO keyspace` as database index → key and expiry counts. */
export function keyspaceCounts(info: string): Map<number, { keys: number; expires: number }> {
  const counts = new Map<number, { keys: number; expires: number }>();
  for (const [, index, keys, expires] of info.matchAll(KEYSPACE_LINE)) {
    counts.set(Number(index), { keys: Number(keys), expires: Number(expires) });
  }
  return counts;
}

/** A cluster scan's cursor: the primary it is on and that primary's own cursor (decision 113). */
export function clusterCursor(node: string, cursor: string): string {
  return `${node} ${cursor}`;
}

export function parseClusterCursor(cursor: string): { node: string; cursor: string } {
  const space = cursor.lastIndexOf(" ");
  if (space < 0) throw new PluginError("statementFailed", `Not a cluster scan cursor: ${cursor}. Rescan the keys.`);
  return { node: cursor.slice(0, space), cursor: cursor.slice(space + 1) };
}

function text(reply: unknown): string {
  return reply instanceof Uint8Array ? Buffer.from(reply).toString("utf8") : String(reply);
}

function scanReply(reply: unknown): { cursor: string; keys: Buffer[] } {
  const [cursor, keys] = Array.isArray(reply) ? (reply as [unknown, unknown]) : [END_OF_PASS, []];
  return {
    cursor: text(cursor),
    keys: (Array.isArray(keys) ? keys : []).filter((key): key is Buffer => key instanceof Buffer),
  };
}

function notYet(what: string): PluginError {
  return new PluginError("statementFailed", `${what} is not available yet.`);
}

/** The Redis keyspace (decision 113): the tree's databases and scans, and changes to single keys. */
export class RedisKeyspace implements Keyspace {
  readonly delimiter: string;
  readonly #host: KeyspaceHost;

  constructor(host: KeyspaceHost) {
    this.#host = host;
    this.delimiter = host.delimiter;
  }

  databases(): Promise<readonly KeyDatabase[]> {
    const host = this.#host;
    return this.#onDatabase(host.mode === "cluster" ? 0 : host.configuredDatabase, () => this.#databases());
  }

  async #databases(): Promise<readonly KeyDatabase[]> {
    const host = this.#host;
    const primaries = await host.router.primaries();
    const infos = await Promise.all(
      primaries.map(({ client }) => client.sendCommand(["INFO", "keyspace"], COMMAND_OPTIONS)),
    );
    const counts = infos.map((info) => keyspaceCounts(text(info)));
    if (host.mode === "cluster") {
      const db0 = counts.map((count) => count.get(0) ?? { keys: 0, expires: 0 });
      const sum = (pick: (entry: { keys: number; expires: number }) => number) =>
        db0.reduce((total, entry) => total + pick(entry), 0);
      return [{ index: 0, keys: sum((entry) => entry.keys), expires: sum((entry) => entry.expires), current: true }];
    }
    const found = counts[0] ?? new Map<number, { keys: number; expires: number }>();
    const total = await this.#databaseCount(found);
    return Array.from({ length: total }, (_, index) => ({
      index,
      keys: found.get(index)?.keys ?? 0,
      expires: found.get(index)?.expires ?? 0,
      current: index === host.configuredDatabase,
    }));
  }

  scan(request: KeyScanRequest): Promise<KeyScan> {
    return this.#onDatabase(request.database, () => this.#scan(request));
  }

  async #scan(request: KeyScanRequest): Promise<KeyScan> {
    const host = this.#host;
    const count = request.count ?? host.scanBatch;
    const serverType = request.type === null ? null : SERVER_TYPES[request.type];
    const args = (cursor: string) => [
      "SCAN",
      cursor,
      "MATCH",
      request.match,
      "COUNT",
      String(count),
      ...(serverType === null ? [] : ["TYPE", serverType]),
    ];
    if (host.mode === "standalone") {
      const reply = scanReply(await host.router.anyPrimary(args(request.cursor ?? END_OF_PASS)));
      return {
        keys: reply.keys.map(keyBytesOf),
        cursor: reply.cursor === END_OF_PASS ? null : reply.cursor,
        scanned: count,
      };
    }
    const primaries = await host.router.primaries();
    const at =
      request.cursor === null
        ? { node: primaries[0]?.node ?? "", cursor: END_OF_PASS }
        : parseClusterCursor(request.cursor);
    const index = primaries.findIndex((primary) => primary.node === at.node);
    const primary = primaries[index];
    if (primary === undefined) {
      throw new PluginError("statementFailed", `The cluster no longer has a primary at ${at.node}. Rescan the keys.`);
    }
    const reply = scanReply(await primary.client.sendCommand(args(at.cursor), COMMAND_OPTIONS));
    const next = reply.cursor !== END_OF_PASS ? clusterCursor(primary.node, reply.cursor) : primaries[index + 1];
    return {
      keys: reply.keys.map(keyBytesOf),
      cursor: next === undefined ? null : typeof next === "string" ? next : clusterCursor(next.node, END_OF_PASS),
      scanned: count,
    };
  }

  async describe(database: number, keys: readonly KeyName[]): Promise<readonly KeyInfo[]> {
    return this.#onDatabase(database, () =>
      Promise.all(
        keys.map(async (key) => {
          const bytes = bytesOf(key);
          const [type, ttl] = await Promise.all([
            this.#host.router.onKey(bytes, ["TYPE", bytes]),
            this.#host.router.onKey(bytes, ["PTTL", bytes]),
          ]);
          const typeName = text(type);
          const kind = keyTypeOf(typeName);
          const ms = Number(ttl);
          return {
            key,
            type: kind,
            typeName: kind === null ? null : typeName,
            ttlMs: ms === NO_EXPIRY || ms === MISSING ? null : ms,
          };
        }),
      ),
    );
  }

  async read(database: number, key: KeyName, request: KeyReadRequest): Promise<KeyContents> {
    const [typed] = await this.describe(database, [key]);
    const host: ReadHost = {
      // One command a call, not the whole read: the rows are read lazily, after this returns.
      onKey: (on, bytes, args) => this.#onDatabase(on, () => this.#host.router.onKey(bytes, args)),
      hashFieldTtl: () => this.#host.hashFieldTtl(),
    };
    return readKey(host, database, key, typed ?? { type: null, typeName: null, ttlMs: null }, request);
  }

  preview(_key: KeyName, _changes: readonly KeyChange[], _options: KeyApplyOptions): readonly string[] {
    throw notYet("Previewing changes");
  }

  apply(
    _database: number,
    _key: KeyName,
    _changes: readonly KeyChange[],
    _options: KeyApplyOptions,
  ): Promise<KeyApplied> {
    return Promise.reject(notYet("Changing a key"));
  }

  async rename(database: number, key: KeyName, to: KeyName, overwrite: boolean): Promise<void> {
    const from = bytesOf(key);
    const target = bytesOf(to);
    const renamed = await this.#onDatabase(database, () =>
      this.#host.router.onKey(from, [overwrite ? "RENAME" : "RENAMENX", from, target]),
    );
    if (!overwrite && Number(renamed) === 0) {
      throw new PluginError("statementFailed", `${to.text} already exists. Tick Overwrite to replace it.`);
    }
  }

  async expire(database: number, key: KeyName, expiry: KeyExpiry): Promise<void> {
    const bytes = bytesOf(key);
    const args =
      expiry === null
        ? ["PERSIST", bytes]
        : "inMs" in expiry
          ? ["PEXPIRE", bytes, String(Math.round(expiry.inMs))]
          : ["PEXPIREAT", bytes, String(Date.parse(expiry.at))];
    // PERSIST also answers 0 for a key without an expiry, so only EXISTS tells a missing key apart.
    const missing = await this.#onDatabase(database, async () => {
      const changed = Number(await this.#host.router.onKey(bytes, args));
      return changed === 0 && Number(await this.#host.router.onKey(bytes, ["EXISTS", bytes])) === 0;
    });
    if (missing) throw new PluginError("statementFailed", `${key.text} no longer exists.`);
  }

  async remove(database: number, keys: readonly KeyName[]): Promise<number> {
    const removed = await this.#onDatabase(database, () =>
      Promise.all(
        keys.map((key) => {
          const bytes = bytesOf(key);
          return this.#host.router.onKey(bytes, ["UNLINK", bytes]);
        }),
      ),
    );
    return removed.reduce<number>((total, count) => total + Number(count), 0);
  }

  #onDatabase<T>(database: number, work: () => Promise<T>): Promise<T> {
    if (this.#host.mode === "cluster" && database !== 0) {
      return Promise.reject(new PluginError("statementFailed", "A cluster has database 0 only."));
    }
    return this.#host.onDatabase(database, work);
  }

  async #databaseCount(found: ReadonlyMap<number, unknown>): Promise<number> {
    const highest = Math.max(this.#host.configuredDatabase, ...found.keys()) + 1;
    try {
      const reply = await this.#host.router.anyPrimary(["CONFIG", "GET", "databases"]);
      const value: unknown =
        reply instanceof Map
          ? [...(reply as Map<unknown, unknown>).values()][0]
          : Array.isArray(reply)
            ? (reply as readonly unknown[])[1]
            : null;
      const configured = Number(text(value));
      return Number.isInteger(configured) && configured > 0 ? Math.max(configured, highest) : highest;
    } catch {
      return Math.max(DEFAULT_DATABASES, highest); // ACL may refuse CONFIG
    }
  }
}
