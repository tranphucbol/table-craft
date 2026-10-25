import redis from "@table-craft/plugin-redis";
import { PluginError } from "@table-craft/plugin-api";
import { runPluginContract } from "@table-craft/plugin-api/testing";
import { describe, expect, it } from "vitest";
import {
  databaseEnabled,
  REDIS6_CONFIG,
  REDIS_CONFIG,
  REDIS_TLS_CONFIG,
  withWrongPassword,
} from "../support/databases.js";
import { REDIS_MANIFEST } from "../support/manifests.js";
import { REDIS_COMMANDS } from "../support/redisFixture.js";

const SERVERS = [
  { version: "7.4", config: REDIS_CONFIG },
  { version: "6.2", config: REDIS6_CONFIG },
] as const;

describe.runIf(databaseEnabled("redis")).each(SERVERS)("redis $version server", ({ config }) => {
  runPluginContract(redis, {
    manifest: REDIS_MANIFEST,
    config,
    wrongPasswordConfig: withWrongPassword(config),
    commands: REDIS_COMMANDS,
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
