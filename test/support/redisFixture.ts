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
    command: "LRANGE type_probe:list 0 -1",
    columns: ["#", "value"],
    rows: [
      [1, "a"],
      [2, "b"],
      [3, "c"],
    ],
  },
  map: {
    command: "HGETALL user:{43}:profile",
    columns: ["key", "value"],
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
};
