import redis from "@table-craft/plugin-redis";
import { PluginError, type Session } from "@table-craft/plugin-api";
import { runPluginContract } from "@table-craft/plugin-api/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseEnabled, REDIS_SENTINEL_CONFIG, withWrongPassword } from "../support/databases.js";
import { REDIS_MANIFEST } from "../support/manifests.js";
import { REDIS_COMMANDS, REDIS_KEYSPACE, REDIS_STATEMENTS, redisSessions } from "../support/redisFixture.js";
import {
  connectRedis as connect,
  failover,
  MASTER_NAME,
  masterAddress,
  nodesOf,
  replicaInSync,
  rowsOf,
  textOf,
} from "../support/redisSentinel.js";

const OPTIONS = { readOnly: false } as const;
const SEEDED_DATABASE = 1;

async function rejection(promise: Promise<unknown>): Promise<PluginError> {
  const error: unknown = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  if (!(error instanceof PluginError)) throw new Error(`expected a PluginError, got ${String(error)}`);
  return error;
}

describe.runIf(databaseEnabled("redis"))("redis 7.4 sentinel", () => {
  runPluginContract(redis, {
    manifest: REDIS_MANIFEST,
    config: REDIS_SENTINEL_CONFIG,
    wrongPasswordConfig: withWrongPassword(REDIS_SENTINEL_CONFIG),
    commands: REDIS_COMMANDS,
    keyspace: REDIS_KEYSPACE,
    statements: REDIS_STATEMENTS,
    sessions: redisSessions(REDIS_SENTINEL_CONFIG),
  });

  describe("sentinel", () => {
    let session: Session;

    beforeAll(async () => {
      await replicaInSync();
      session = await connect({ ...REDIS_SENTINEL_CONFIG, database: SEEDED_DATABASE });
    });

    afterAll(async () => {
      await session.close();
    });

    it("givenSentinel_whenConnect_thenSessionOnPrimaryWithConfiguredDatabase", async () => {
      const role = await rowsOf(await session.execute("ROLE"));
      expect(textOf(role[0]?.at(-1))).toBe("master");
      expect((await session.execute("CLIENT INFO")).reply?.text).toMatch(
        new RegExp(`\\bdb=${String(SEEDED_DATABASE)}\\b`),
      );
    });

    it("givenSentinel_whenNodes_thenPrimaryAndReplicaWithoutSlots", async () => {
      const nodes = await nodesOf(session);
      expect(nodes.map((node) => node.role)).toEqual(["primary", "replica"]);
      expect(nodes.every((node) => node.slots.length === 0)).toBe(true);
      expect(nodes[1]?.primaryId).toBe(nodes[0]?.id);
      expect(nodes[1]?.state).toBe("online");
    });

    it("givenPickedReplica_whenGet_thenAnsweredByReplica", async () => {
      const replica = (await nodesOf(session))[1];
      if (replica === undefined) throw new Error("no replica listed");
      const role = await rowsOf(await session.execute("ROLE", undefined, { node: replica.id }));
      expect(textOf(role[0]?.at(-1))).toBe("slave");
      const probe = await rowsOf(await session.execute("EXISTS db1:greeting", undefined, { node: replica.id }));
      const onMaster = await rowsOf(await session.execute("EXISTS db1:greeting"));
      expect(probe).toEqual(onMaster);
    });

    it("givenPickedReplica_whenSet_thenReadonlyPassesThroughAndSessionStays", async () => {
      const replica = (await nodesOf(session))[1];
      if (replica === undefined) throw new Error("no replica listed");
      const error = await rejection(session.execute("SET sentinel:probe 1", undefined, { node: replica.id }));
      expect(error.code).toBe("statementFailed");
      expect(error.message).toMatch(/^READONLY/);
      const role = await rowsOf(await session.execute("ROLE"));
      expect(textOf(role[0]?.at(-1))).toBe("master");
    });

    it("givenPickedReplica_whenServerInfo_thenReplicationRoleSlave", async () => {
      const replica = (await nodesOf(session))[1];
      if (replica === undefined || session.serverInfo === undefined) throw new Error("no replica listed");
      const info = await session.serverInfo(replica.id);
      const replication = info.sections.find((section) => section.title === "Replication");
      expect(replication?.entries.find((entry) => entry.name === "role")?.value).toBe("slave");
    });
  });

  it("givenSentinelAndSsh_whenConnect_thenConnectionFailedNamingTheTunnel", async () => {
    const error = await rejection(
      redis.connect(redis.connectionSchema.parse(REDIS_SENTINEL_CONFIG), {
        ...OPTIONS,
        serverName: REDIS_SENTINEL_CONFIG.host,
      }),
    );
    expect(error.code).toBe("connectionFailed");
    expect(error.message).toMatch(/An SSH tunnel reaches the Sentinel, not the master it names/);
  });

  it("givenWrongMasterName_whenConnect_thenConnectionFailedListingMonitoredMasters", async () => {
    const error = await rejection(connect({ ...REDIS_SENTINEL_CONFIG, masterName: "nope" }));
    expect(error.code).toBe("connectionFailed");
    expect(error.message).toContain("No Sentinel monitors a master named nope.");
    expect(error.message).toContain(`monitors ${MASTER_NAME}`);
  });

  it("givenNoSentinelPassword_whenConnect_thenConnectionFailedNamingSentinelLogin", async () => {
    const error = await rejection(connect({ ...REDIS_SENTINEL_CONFIG, sentinelPassword: "" }));
    expect(error.code).toBe("connectionFailed");
    expect(error.message).toMatch(/refused the login\. Fill Sentinel username and password\.$/);
  });

  it("givenDataServerAsSentinel_whenConnect_thenNotASentinel", async () => {
    const [host, port] = (await masterAddress()).split(":");
    const config = { ...REDIS_SENTINEL_CONFIG, sentinels: "", sentinelPassword: "", nodeAddressMap: "" };
    const target = { ...config, host: REDIS_SENTINEL_CONFIG.host, port: Number(port) };
    expect(host).toBeDefined();
    const error = await rejection(connect({ ...target, user: "", password: "" }));
    expect(error.code).toBe("connectionFailed");
    expect(error.message).toMatch(/is not a Sentinel\. Sentinels usually listen on 26379/);
  });

  // Runs last: it moves the master, and every test above asks Sentinel instead of assuming a port.
  describe("failover", () => {
    it("givenFailover_whenOldSessionRuns_thenConnectionLostBeforeSending", async () => {
      const session = await connect();
      try {
        await failover();
        const error = await rejection(session.execute("SET sentinel:failover 1"));
        expect(["connectionLost", "statementFailed"]).toContain(error.code);
        if (error.code === "statementFailed") expect(error.message).toMatch(/is no longer the master of mymaster/);
        const again = await rejection(session.execute("GET sentinel:failover"));
        expect(again.code).toBe("connectionLost");
      } finally {
        await session.close();
      }
    });

    it("givenFailover_whenReconnected_thenWritesLandOnNewPrimary", async () => {
      const { after } = await failover();
      const session = await connect();
      try {
        await session.execute("SET sentinel:failover 2");
        const nodes = await nodesOf(session);
        expect(nodes[0]?.role).toBe("primary");
        expect(after.endsWith(`:${nodes[0]?.address.split(":").at(-1) ?? ""}`)).toBe(true);
        expect((await session.execute("GET sentinel:failover")).reply?.text).toBe('"2"');
      } finally {
        await session.execute("DEL sentinel:failover").catch(() => undefined);
        await session.close();
      }
    });
  });
});
