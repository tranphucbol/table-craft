import type { KeyType } from "@table-craft/plugin-api";
import type { CommandsFixture, KeyspaceFixture } from "@table-craft/plugin-api/testing";

/** What the commands contract runs against the seeded Redis servers, standalone and cluster (plan 058). */
export const REDIS_COMMANDS: CommandsFixture = {
  scripts: [
    {
      text: '# a comment\nSET greeting "hello world"\n\n  GET greeting  \n',
      statements: ['SET greeting "hello world"', "GET greeting"],
    },
    { text: "HSET h f 'a b'\n# trailing", statements: ["HSET h f 'a b'"] },
  ],
  scalar: { command: "HGET user:{42}:profile name", text: '"Ann"' },
  array: {
    command: "LRANGE type_probe:list 0 1",
    columns: ["#", "value"],
    rows: [
      [1, "a"],
      [2, "b"],
    ],
  },
  map: {
    command: "HGETALL user:{43}:profile",
    columns: ["field", "value"],
    rows: [
      ["name", "Bob"],
      ["email", "bob@example.com"],
    ],
  },
  binary: { command: "GET type_probe:binary", hex: "fffe0001" },
  write: { command: "SET type_probe:write 1", name: "SET" },
  costly: { command: "KEYS user:*", fixed: "SCAN 0 MATCH user:* COUNT 1000" },
  confirmByName: "FLUSHDB",
};

const EDITED_FIELD = { text: "status", hex: null };

function sourced(key: string, type: KeyType, whole: boolean) {
  return { database: 0, key: { text: key, hex: null }, type, whole };
}

/** The seeded keys the keyspace contract scans: `page:0001` … `page:5000` and the type probes. */
export const REDIS_KEYSPACE: KeyspaceFixture = {
  database: 0,
  scan: { match: "page:*", count: 5000, batch: 500 },
  typed: { match: "type_probe:*", type: "hash", keys: ["type_probe:hash"] },
  expiring: "user:{42}:session",
  binary: { hex: "62696e3afffe", match: "bin:*", type: "string", value: "binary key" },
  hash: {
    key: "type_probe:hash",
    rows: [
      ["name", "Ann"],
      ["email", "ann@example.com"],
      ["prefs", '{"theme":"dark","tags":[1,2]}'],
    ],
  },
  zset: {
    key: "leaderboard",
    rows: [
      ["bob", 80],
      ["ann", 120],
      ["cid", 200],
    ],
  },
  stream: {
    key: "type_probe:stream",
    columns: ["id", "event", "user", "reason"],
    rows: [
      ["1700000000000-0", "login", "42", null],
      ["1700000000001-0", "logout", "42", "idle"],
    ],
  },
  edit: {
    key: "contract:edit",
    type: "hash",
    change: (value, original) => ({
      kind: "setField",
      field: EDITED_FIELD,
      value: { text: value, hex: null },
      original: original === null ? null : { text: original, hex: null },
    }),
    valueOf: async (contents) => {
      if (contents.result === null) return null;
      for await (const row of contents.result.rows) {
        const value = row[1];
        if (row[0] === EDITED_FIELD.text) return typeof value === "string" ? value : JSON.stringify(value);
      }
      return null;
    },
  },
  sources: [
    { command: "HGETALL type_probe:hash", source: sourced("type_probe:hash", "hash", true) },
    { command: "GET type_probe:binary", source: sourced("type_probe:binary", "string", true), read: true },
    { command: "HGET type_probe:hash name", source: sourced("type_probe:hash", "hash", false), read: true },
    { command: "LRANGE type_probe:list 0 1", source: sourced("type_probe:list", "list", false) },
    { command: "ZRANGE leaderboard 0 -1 WITHSCORES", source: sourced("leaderboard", "zset", true) },
    { command: "GET contract:missing", source: null, read: true },
    { command: "MGET user:{42}:profile user:{42}:session", source: null },
    { command: "DBSIZE", source: null },
    { command: "STRLEN type_probe:binary", source: sourced("type_probe:binary", "string", false), read: false },
  ],
};

/**
 * A blocking pop that waits `seconds` for a list no one fills. `{bar}` hashes to slot 5061, so in
 * the fixture clusters it blocks on the first primary, the one a session's `serverSessionId` names.
 */
export const REDIS_STATEMENTS = {
  sleep: (seconds: number) => `BLPOP contract:{bar}:sleep ${String(seconds)}`,
};

/** The sessions fixture: a second connection lists, and `CLIENT LIST` names the command only. */
export function redisSessions(config: unknown) {
  return { monitorConfig: config, sleepQuery: "blpop" };
}
