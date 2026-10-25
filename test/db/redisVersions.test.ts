import redis from "@table-craft/plugin-redis";
import { PluginError, type CompletionResult, type Session } from "@table-craft/plugin-api";
import { describe, expect, it } from "vitest";
import { databaseEnabled, REDIS6_CLUSTER_CONFIG, REDIS6_CONFIG, REDIS_CONFIG } from "../support/databases.js";

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
});
