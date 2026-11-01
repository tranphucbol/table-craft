import redis from "@table-craft/plugin-redis";
import { PluginError, type Session } from "@table-craft/plugin-api";
import { runPluginContract } from "@table-craft/plugin-api/testing";
import { describe, expect, it } from "vitest";
import {
  databaseEnabled,
  REDIS5_CONFIG,
  REDIS6_CONFIG,
  REDIS_CONFIG,
  REDIS_TLS_CONFIG,
  withWrongPassword,
} from "../support/databases.js";
import { REDIS_MANIFEST } from "../support/manifests.js";
import { REDIS_COMMANDS, REDIS_KEYSPACE, REDIS_STATEMENTS, redisSessions } from "../support/redisFixture.js";

const DATABASES = 16;
const EDIT_LIST = { text: "edit:list", hex: null };

function text(value: string) {
  return { text: value, hex: null };
}

function keyspaceOf(session: Session) {
  if (session.keyspace === undefined) throw new Error("no keyspace");
  return session.keyspace;
}

async function withRedis(config: unknown, use: (session: Session) => Promise<void>): Promise<void> {
  const session = await redis.connect(redis.connectionSchema.parse(config), { readOnly: false });
  try {
    await use(session);
  } finally {
    await session.close();
  }
}

const SERVERS = [
  { version: "7.4", config: REDIS_CONFIG },
  { version: "6.2", config: REDIS6_CONFIG },
  { version: "5.0", config: REDIS5_CONFIG },
] as const;

describe.runIf(databaseEnabled("redis")).each(SERVERS)("redis $version server", ({ config }) => {
  runPluginContract(redis, {
    manifest: REDIS_MANIFEST,
    config,
    wrongPasswordConfig: withWrongPassword(config),
    commands: REDIS_COMMANDS,
    keyspace: REDIS_KEYSPACE,
    statements: REDIS_STATEMENTS,
    sessions: redisSessions(config),
  });

  describe("standalone", () => {
    it("givenNodes_whenStandalone_thenOnePrimary", async () => {
      await withRedis(config, async (session) => {
        const nodes = (await session.nodes?.()) ?? [];
        expect(nodes).toEqual([
          expect.objectContaining({ role: "primary", slots: [], primaryId: null, state: "connected" }),
        ]);
      });
    });

    it("givenOtherDatabase_whenKeyspaceReads_thenConsoleKeepsItsOwn", async () => {
      await withRedis(config, async (session) => {
        const keyspace = session.keyspace;
        if (keyspace === undefined) throw new Error("no keyspace");
        const databases = await keyspace.databases();
        expect(databases.length).toBeGreaterThanOrEqual(DATABASES);
        expect(databases[1]).toMatchObject({ index: 1, keys: 2, current: false });
        const [info] = await keyspace.describe(1, [{ text: "db1:config", hex: null }]);
        expect(info?.type).toBe("hash");
        expect((await session.execute("EXISTS db1:config")).reply?.text).toBe("(integer) 0");
      });
    });

    it("givenListDeletes_whenApply_thenElementsRemovedInOneTransaction", async () => {
      await withRedis(config, async (session) => {
        const keyspace = keyspaceOf(session);
        await session.execute("DEL edit:list");
        await session.execute("RPUSH edit:list a b c d");
        try {
          await keyspace.apply(
            0,
            EDIT_LIST,
            [
              { kind: "deleteIndex", index: 1, original: text("b") },
              { kind: "setIndex", index: 3, value: text("D"), original: text("d") },
              { kind: "deleteIndex", index: 2, original: text("c") },
              { kind: "push", value: text("e") },
            ],
            { type: "list", guard: true },
          );
          const values: unknown[] = [];
          for await (const row of (await session.execute("LRANGE edit:list 0 -1")).rows) values.push(row[1]);
          expect(values).toEqual(["a", "D", "e"]);
        } finally {
          await session.execute("DEL edit:list");
        }
      });
    });

    it("givenFailingCommand_whenApply_thenStatementFailedNamingIt", async () => {
      await withRedis(config, async (session) => {
        await session.execute("DEL edit:list");
        await session.execute("RPUSH edit:list a");
        try {
          const applied = keyspaceOf(session).apply(
            0,
            EDIT_LIST,
            [{ kind: "setIndex", index: 5, value: text("x"), original: text("y") }],
            { type: "list", guard: false },
          );
          await expect(applied).rejects.toThrow(/LSET edit:list 5 x failed: ERR index out of range/);
        } finally {
          await session.execute("DEL edit:list");
        }
      });
    });

    it("givenReadOnly_whenKeyspaceChanges_thenRefusedAndNothingWritten", async () => {
      const session = await redis.connect(redis.connectionSchema.parse(config), { readOnly: true });
      try {
        const keyspace = keyspaceOf(session);
        const key = text("type_probe:string");
        const refused = /read-only datasource refuses \w+/;
        await expect(
          keyspace.apply(0, key, [{ kind: "setString", value: text("x"), original: null }], {
            type: "string",
            guard: false,
          }),
        ).rejects.toThrow(refused);
        await expect(keyspace.rename(0, key, text("type_probe:renamed"), false)).rejects.toThrow(refused);
        await expect(keyspace.expire(0, key, { inMs: 1000 })).rejects.toThrow(refused);
        await expect(keyspace.remove(0, [key])).rejects.toThrow(refused);
        expect((await session.execute("GET type_probe:string")).reply?.text).toBe('"hello"');
        expect((await session.execute("PTTL type_probe:string")).reply?.text).toBe("(integer) -1");
      } finally {
        await session.close();
      }
    });
  });
});

describe.runIf(databaseEnabled("redis"))("redis without authentication", () => {
  it("givenNoAuthWithLeftoverCredentials_whenConnected_thenSessionIsTheDefaultUser", async () => {
    await withRedis({ ...REDIS_CONFIG, authMode: "none" }, async (session) => {
      expect((await session.execute("ACL WHOAMI")).reply?.text).toBe('"default"');
    });
  });

  it("givenNoAuth_whenServerRequiresPassword_thenAuthenticationFailed", async () => {
    const config = redis.connectionSchema.parse({ ...REDIS5_CONFIG, authMode: "none" });
    const error: unknown = await redis.connect(config, { readOnly: true }).then(
      async (session) => {
        await session.execute("PING").finally(() => session.close());
        return null;
      },
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(PluginError);
  });
});

describe.runIf(databaseEnabled("redis"))("redis tls server", () => {
  it("givenVerifyFull_whenConnected_thenCommandsRun", async () => {
    const session = await redis.connect(redis.connectionSchema.parse(REDIS_TLS_CONFIG), { readOnly: true });
    try {
      expect((await session.execute("GET type_probe:string")).reply?.text).toBe('"hello"');
    } finally {
      await session.close();
    }
  });

  it("givenWrongHostName_whenVerifyFull_thenConnectionFailedNamingTheHost", async () => {
    const config = redis.connectionSchema.parse({ ...REDIS_TLS_CONFIG, host: "127.0.0.1" });
    const error: unknown = await redis.connect(config, { readOnly: true }).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(PluginError);
    expect(error).toMatchObject({ code: "connectionFailed" });
    expect(String((error as Error).message)).toContain("not valid for host 127.0.0.1");
  });
});
