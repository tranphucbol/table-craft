import redis from "@table-craft/plugin-redis";
import { PluginError, type CompletionResult, type ExecuteResult, type Session } from "@table-craft/plugin-api";
import { describe, expect, it } from "vitest";
import {
  databaseEnabled,
  REDIS5_CONFIG,
  REDIS6_CLUSTER_CONFIG,
  REDIS6_CONFIG,
  REDIS_CONFIG,
} from "../support/databases.js";

const SLOT_COUNT = 16_384;
const READ_WINDOW = 100;

async function withRedis(config: unknown, use: (session: Session) => Promise<void>, readOnly = false): Promise<void> {
  const session = await redis.connect(redis.connectionSchema.parse(config), { readOnly });
  try {
    await use(session);
  } finally {
    await session.close();
  }
}

function labels(result: CompletionResult | null): string[] {
  return (result?.items ?? []).map((item) => item.label);
}

async function completed(session: Session, text: string): Promise<string[]> {
  const language = redis.commandLanguage;
  if (language === undefined) throw new Error("no command language");
  return labels(await language.complete({ text, offset: text.length }, session));
}

async function hashColumns(session: Session): Promise<string[]> {
  const contents = await session.keyspace?.read(0, { text: "type_probe:hash", hex: null }, { window: READ_WINDOW });
  return (contents?.result?.columns ?? []).map((column) => column.name);
}

async function shown(result: ExecuteResult): Promise<unknown> {
  const rows: unknown[][] = [];
  for await (const row of result.rows) rows.push([...row]);
  return { columns: result.columns.map((column) => column.name), rows, reply: result.reply?.text ?? null };
}

/** What `commands` show in a console on `config`, run after `setup` on a scratch key. */
async function consoleOf(config: unknown, setup: readonly string[], commands: readonly string[]): Promise<unknown[]> {
  const results: unknown[] = [];
  await withRedis(config, async (session) => {
    for (const command of setup) await session.execute(command);
    try {
      for (const command of commands) results.push(await shown(await session.execute(command)));
    } finally {
      await session.execute("DEL versions:scratch");
    }
  });
  return results;
}

const SCRATCH_ZSET = ["DEL versions:scratch", "ZADD versions:scratch 1.5 a 2 b inf c"];

/** Decision 116: a 5.0 server speaks RESP2, reshaped so the console shows what 7.4 shows. */
const SAME_AS_74 = [
  { name: "HGETALL", setup: [], commands: ["HGETALL user:{43}:profile"] },
  { name: "ZRANGE WITHSCORES", setup: [], commands: ["ZRANGE leaderboard 0 -1 WITHSCORES"] },
  { name: "ZREVRANGEBYSCORE WITHSCORES", setup: [], commands: ["ZREVRANGEBYSCORE leaderboard +inf 100 WITHSCORES"] },
  { name: "ZSCORE", setup: [], commands: ["ZSCORE leaderboard ann", "ZSCORE leaderboard nobody"] },
  { name: "CONFIG GET", setup: [], commands: ["CONFIG GET maxmemory"] },
  { name: "ZPOPMIN", setup: SCRATCH_ZSET, commands: ["ZPOPMIN versions:scratch", "ZPOPMAX versions:scratch 2"] },
  { name: "ZINCRBY", setup: SCRATCH_ZSET, commands: ["ZINCRBY versions:scratch 0.25 a", "ZSCORE versions:scratch c"] },
] as const;

/** Plan 058 decision 24: one code path, the version's features probed at connect. */
describe.runIf(databaseEnabled("redis"))("redis versions", () => {
  it("givenRedis62_whenComplete_thenSnapshotDocsLimitedToServerCommands", async () => {
    await withRedis(REDIS6_CONFIG, async (session) => {
      expect(await completed(session, "LMP")).not.toContain("LMPOP");
      expect(await completed(session, "HGE")).toContain("HGET");
    });
  });

  it("givenRedis74_whenComplete_thenServerDocs", async () => {
    await withRedis(REDIS_CONFIG, async (session) => {
      expect(await completed(session, "LMP")).toContain("LMPOP");
      expect(await completed(session, "HTT")).toContain("HTTL");
    });
  });

  it("givenRedis62Cluster_whenNodes_thenFromClusterNodes", async () => {
    await withRedis(REDIS6_CLUSTER_CONFIG, async (session) => {
      const nodes = (await session.nodes?.()) ?? [];
      const primaries = nodes.filter((node) => node.role === "primary");
      expect(primaries).toHaveLength(3);
      const slots = primaries.flatMap((node) => node.slots).reduce((sum, [from, to]) => sum + to - from + 1, 0);
      expect(slots).toBe(SLOT_COUNT);
    });
  });

  it("givenRedis62_whenReadHash_thenNoTtlColumn", async () => {
    await withRedis(REDIS6_CONFIG, async (session) => {
      expect(await hashColumns(session)).toEqual(["field", "value"]);
    });
  });

  it("givenRedis74_whenReadHash_thenTtlColumn", async () => {
    await withRedis(REDIS_CONFIG, async (session) => {
      expect(await hashColumns(session)).toEqual(["field", "value", "ttl"]);
    });
  });

  it("givenRedis62ReadOnly_whenConfigSet_thenRefusedBySubcommandTable", async () => {
    await withRedis(
      REDIS6_CONFIG,
      async (session) => {
        const error: unknown = await session.execute("CONFIG SET maxmemory 0").then(
          () => null,
          (cause: unknown) => cause,
        );
        expect(error).toBeInstanceOf(PluginError);
        expect(error).toMatchObject({ code: "statementFailed" });
        expect(String((error as Error).message)).toContain("CONFIG SET");
        await expect(session.execute("CONFIG GET maxmemory")).resolves.toBeDefined();
      },
      true,
    );
  });

  it.each([
    { version: "6.2", config: REDIS6_CONFIG },
    { version: "7.4", config: REDIS_CONFIG },
  ])("givenRedis$version_whenServerInfo_thenEverySection", async ({ config }) => {
    await withRedis(config, async (session) => {
      const info = await session.serverInfo?.(null);
      expect(info?.sections.map((section) => section.title)).toEqual(
        expect.arrayContaining([
          "Server",
          "Clients",
          "Memory",
          "Persistence",
          "Stats",
          "Replication",
          "CPU",
          "Keyspace",
        ]),
      );
      expect(info?.sections.find((section) => section.title === "Server")?.entries).toContainEqual(
        expect.objectContaining({ name: "redis_version" }),
      );
    });
  });

  it("givenRedis62_whenSetTtl_thenPlainPexpire", async () => {
    await withRedis(REDIS6_CONFIG, async (session) => {
      const keyspace = session.keyspace;
      if (keyspace === undefined) throw new Error("no keyspace");
      const key = { text: "versions:ttl", hex: null };
      await session.execute("SET versions:ttl 1");
      try {
        await keyspace.expire(0, key, { inMs: 60_000 });
        expect((await keyspace.describe(0, [key]))[0]?.ttlMs).toBeGreaterThan(0);
        await keyspace.expire(0, key, null);
        expect((await keyspace.describe(0, [key]))[0]?.ttlMs).toBeNull();
      } finally {
        await session.execute("DEL versions:ttl");
      }
    });
  });

  it("givenRedis5_whenConnect_thenResp2AndCommandsRun", async () => {
    await withRedis(REDIS5_CONFIG, async (session) => {
      expect(session.serverVersion).toMatch(/^5\.0\./);
      expect((await session.execute("GET type_probe:string")).reply?.text).toBe('"hello"');
    });
  });

  it.each(SAME_AS_74)("givenRedis5_when$name_thenSameAsRedis74", async ({ setup, commands }) => {
    const expected = await consoleOf(REDIS_CONFIG, setup, commands);
    expect(await consoleOf(REDIS5_CONFIG, setup, commands)).toEqual(expected);
  });

  it("givenRedis5_whenZrangeWithScores_thenMemberScoreRows", async () => {
    const [result] = await consoleOf(REDIS5_CONFIG, [], ["ZRANGE leaderboard 0 -1 WITHSCORES"]);
    expect(result).toEqual({
      columns: ["member", "score"],
      rows: [
        ["bob", 80],
        ["ann", 120],
        ["cid", 200],
      ],
      reply: null,
    });
  });

  it("givenRedis5WithUsername_whenConnect_thenConnectionFailedNamingAcl", async () => {
    const error: unknown = await redis
      .connect(redis.connectionSchema.parse({ ...REDIS5_CONFIG, user: "table_craft" }), { readOnly: false })
      .then(
        (session) => session.close(),
        (cause: unknown) => cause,
      );
    expect(error).toMatchObject({ code: "connectionFailed" });
    expect(String((error as Error).message)).toContain("no ACL users");
  });

  it("givenRedis5_whenScanByType_thenOnlyThatTypeWithoutScanType", async () => {
    await withRedis(REDIS5_CONFIG, async (session) => {
      const keyspace = session.keyspace;
      if (keyspace === undefined) throw new Error("no keyspace");
      const found: string[] = [];
      let cursor: string | null = null;
      do {
        const scan = await keyspace.scan({ database: 0, cursor, match: "type_probe:*", type: "zset", count: 2 });
        found.push(...scan.keys.map((key) => key.text));
        cursor = scan.cursor;
      } while (cursor !== null);
      expect(found).toEqual(["type_probe:zset"]);
    });
  });

  it("givenRedis5_whenEditStringWithTtl_thenTtlKept", async () => {
    await withRedis(REDIS5_CONFIG, async (session) => {
      const keyspace = session.keyspace;
      if (keyspace === undefined) throw new Error("no keyspace");
      const key = { text: "versions:string", hex: null };
      const change = {
        kind: "setString",
        value: { text: "after", hex: null },
        original: { text: "before", hex: null },
      } as const;
      await session.execute("SET versions:string before PX 600000");
      try {
        expect(keyspace.preview(key, [change], { guard: true, type: "string" })).toEqual(["SET versions:string after"]);
        const applied = await keyspace.apply(0, key, [change], { guard: true, type: "string" });
        expect(applied.commands).toEqual([
          "SET versions:string after",
          expect.stringMatching(/^PEXPIRE versions:string \d+$/),
        ]);
        expect((await session.execute("GET versions:string")).reply?.text).toBe('"after"');
        expect((await keyspace.describe(0, [key]))[0]?.ttlMs).toBeGreaterThan(0);
      } finally {
        await session.execute("DEL versions:string");
      }
    });
  });

  it("givenRedis5_whenReadStreamPastFirstWindow_thenNextEntriesOnce", async () => {
    const ids = ["1-0", "1-1", "1-2", "2-0", "2-1"];
    await withRedis(REDIS5_CONFIG, async (session) => {
      for (const id of ids) await session.execute(`XADD versions:stream ${id} n ${id}`);
      try {
        const contents = await session.keyspace?.read(0, { text: "versions:stream", hex: null }, { window: 2 });
        const read: unknown[] = [];
        for await (const row of contents?.result?.rows ?? []) read.push(row[0]);
        expect(read).toEqual(ids);
      } finally {
        await session.execute("DEL versions:stream");
      }
    });
  });

  it("givenRedis5_whenCompleteSet_thenNoKeepTtlToken", async () => {
    await withRedis(REDIS5_CONFIG, async (session) => {
      const tokens = await completed(session, "SET k v ");
      expect(tokens).toContain("EX");
      expect(tokens).not.toContain("KEEPTTL");
      expect(tokens).not.toContain("GET");
    });
    await withRedis(REDIS_CONFIG, async (session) => {
      expect(await completed(session, "SET k v ")).toContain("KEEPTTL");
    });
  });
});
