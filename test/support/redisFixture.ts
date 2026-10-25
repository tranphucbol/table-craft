import type { CommandsFixture } from "@table-craft/plugin-api/testing";

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
