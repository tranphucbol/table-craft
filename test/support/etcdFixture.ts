import type { CommandsFixture, KeyspaceFixture } from "@table-craft/plugin-api/testing";

const KV_COLUMNS = ["key", "value", "create_revision", "mod_revision", "version", "lease"];

/**
 * What the commands contract runs against the seeded etcd servers (plan 110), whose keys come from
 * `test/db/schema/etcd.etcd`. The revisions are those of a fresh server: `etcd-seed` puts the keys
 * in file order from revision 2, and `test/db/stack.ts` recreates both servers with it.
 */
export const ETCD_COMMANDS: CommandsFixture = {
  scripts: [
    {
      text: '# a comment\nput /contract/greeting "hello world"\n\n  get /contract/greeting  \n',
      statements: ['put /contract/greeting "hello world"', "get /contract/greeting"],
    },
    { text: "get /app/ --prefix --keys-only\n# trailing", statements: ["get /app/ --prefix --keys-only"] },
  ],
  scalar: { command: "put /contract/scalar 1", text: "OK" },
  array: {
    command: "get /app/feature/flags",
    columns: KV_COLUMNS,
    rows: [["/app/feature/flags", "dark-mode,beta-search", 4, 4, 1, null]],
  },
  map: {
    command: "get /app/config/ --prefix",
    columns: KV_COLUMNS,
    rows: [
      ["/app/config/app.properties", "log.level=info\nhttp.port=8080", 3, 3, 1, null],
      [
        "/app/config/db.json",
        '{"host":"db.internal","port":5432,"pool":{"min":2,"max":10},"tags":["primary","eu"]}',
        2,
        2,
        1,
        null,
      ],
    ],
  },
  binary: { command: "get /probe/binary --print-value-only", hex: "fffe0001" },
  write: { command: "put /contract/write 1", name: "put" },
  costly: { command: "get / --prefix", fixed: "get / --prefix --limit=1000" },
  confirmByName: 'del "" --from-key',
};

/** The seeded keys the keyspace contract scans: `/bulk/key-01` … `/bulk/key-30` and the probes. */
export const ETCD_KEYSPACE: KeyspaceFixture = {
  database: 0,
  scan: { match: "/bulk/*", count: 30, batch: 7 },
  typed: { match: "/app/config/*", type: "string", keys: ["/app/config/app.properties", "/app/config/db.json"] },
  expiring: "/app/session/token",
  binary: { hex: "2f62696e2ffffe", match: "/bin/*", type: "string", value: "binary key" },
  edit: {
    key: "/contract/edit",
    type: "string",
    change: (value, original) => ({
      kind: "setString",
      value: { text: value, hex: null },
      original: original === null ? null : { text: original, hex: null },
    }),
    valueOf: (contents) => Promise.resolve(typeof contents.value === "string" ? contents.value : null),
  },
};
