import redis from "@table-craft/plugin-redis";
import { PluginError, type ExecuteResult, type Session } from "@table-craft/plugin-api";
import { runPluginContract } from "@table-craft/plugin-api/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  databaseEnabled,
  REDIS6_CLUSTER_CONFIG,
  REDIS_CLUSTER_CONFIG,
  withWrongPassword,
} from "../support/databases.js";
import { REDIS_MANIFEST } from "../support/manifests.js";
import { REDIS_COMMANDS, REDIS_KEYSPACE, REDIS_STATEMENTS, redisSessions } from "../support/redisFixture.js";

const SLOTS = 16_384;
const CLUSTERS = [
  { version: "7.4", config: REDIS_CLUSTER_CONFIG, primaries: 3, replicas: 3 },
  { version: "6.2", config: REDIS6_CLUSTER_CONFIG, primaries: 3, replicas: 0 },
] as const;

const OPTIONS = { readOnly: false } as const;

async function rowsOf(result: ExecuteResult): Promise<unknown[][]> {
  const rows: unknown[][] = [];
  for await (const row of result.rows) rows.push([...row]);
  return rows;
}

async function rejection(promise: Promise<unknown>): Promise<PluginError> {
  const error: unknown = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  if (!(error instanceof PluginError)) throw new Error(`expected a PluginError, got ${String(error)}`);
  return error;
}

describe.runIf(databaseEnabled("redis")).each(CLUSTERS)("redis $version cluster", (cluster) => {
  runPluginContract(redis, {
    manifest: REDIS_MANIFEST,
    config: cluster.config,
    wrongPasswordConfig: withWrongPassword(cluster.config),
    commands: REDIS_COMMANDS,
    keyspace: REDIS_KEYSPACE,
    statements: REDIS_STATEMENTS,
    sessions: redisSessions(cluster.config),
  });

  describe("cluster", () => {
    let session: Session;

    beforeAll(async () => {
      session = await redis.connect(redis.connectionSchema.parse(cluster.config), OPTIONS);
    });

    afterAll(async () => {
      await session.close();
    });

    it("givenCluster_whenNodes_thenThreePrimariesCoveringEverySlot", async () => {
      const nodes = (await session.nodes?.()) ?? [];
      const primaries = nodes.filter((node) => node.role === "primary");
      expect(primaries).toHaveLength(cluster.primaries);
      expect(nodes.filter((node) => node.role === "replica")).toHaveLength(cluster.replicas);
      const covered = primaries.flatMap((node) => node.slots).reduce((sum, [from, to]) => sum + to - from + 1, 0);
      expect(covered).toBe(SLOTS);
      expect(nodes.slice(0, cluster.primaries).every((node) => node.role === "primary")).toBe(true);
    });

    it("givenCluster_whenDbsizeAllPrimaries_thenOneRowPerNodeWithNodeColumn", async () => {
      const result = await session.execute("DBSIZE");
      expect(result.columns.map((column) => column.name)).toEqual(["node", "value"]);
      const rows = await rowsOf(result);
      expect(rows).toHaveLength(cluster.primaries);
      expect(rows.reduce((sum, row) => sum + Number(row[1]), 0)).toBeGreaterThanOrEqual(5014);
    });

    it("givenCluster_whenScan_thenKeysFromEveryPrimary", async () => {
      const keyspace = session.keyspace;
      if (keyspace === undefined) throw new Error("no keyspace");
      const [database] = await keyspace.databases();
      expect(database).toMatchObject({ index: 0, current: true });
      expect(database?.keys).toBeGreaterThanOrEqual(5014);
      const cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const scan = await keyspace.scan({ database: 0, cursor, match: "page:*", type: null, count: 500 });
        cursor = scan.cursor;
        if (cursor !== null) cursors.add(cursor.split(" ")[0] ?? "");
      } while (cursor !== null);
      expect(cursors.size).toBe(cluster.primaries);
      await expect(keyspace.scan({ database: 1, cursor: null, match: "*", type: null })).rejects.toThrow(
        "database 0 only",
      );
    });

    it("givenPickedNode_whenDbsize_thenThatNodeAlone", async () => {
      const [primary] = (await session.nodes?.()) ?? [];
      const result = await session.execute("DBSIZE", [], { node: primary?.id ?? "" });
      expect(result.columns).toEqual([]);
      expect(result.reply?.text).toMatch(/^\(integer\) \d+$/);
    });

    it("givenCluster_whenCrossSlotMset_thenStatementFailedWithHashTagHint", async () => {
      const error = await rejection(session.execute("MSET a 1 b 2"));
      expect(error.code).toBe("statementFailed");
      expect(error.message).toContain("CROSSSLOT");
      expect(error.message).toContain("wrap the common part in `{…}`, e.g. `user:{42}:profile`");
    });

    it("givenHashTaggedKeys_whenMset_thenRunsOnTheirNode", async () => {
      const result = await session.execute("MSET probe:{7}:a 1 probe:{7}:b 2");
      expect(result.reply?.text).toBe("OK");
      expect((await session.execute("DEL probe:{7}:a probe:{7}:b")).reply?.text).toBe("(integer) 2");
    });

    it("givenCluster_whenRenameAcrossSlots_thenRefusedWithHashTagHint", async () => {
      const keyspace = session.keyspace;
      if (keyspace === undefined) throw new Error("no keyspace");
      await session.execute("SET rename:{1}:from x");
      try {
        const error = await rejection(
          keyspace.rename(0, { text: "rename:{1}:from", hex: null }, { text: "rename:{2}:to", hex: null }, false),
        );
        expect(error.code).toBe("statementFailed");
        expect(error.message).toContain("CROSSSLOT");
        expect(error.message).toContain("wrap the common part in `{…}`");
      } finally {
        await session.execute("DEL rename:{1}:from");
      }
    });

    it("givenCluster_whenSelect_thenRefused", async () => {
      const error = await rejection(session.execute("SELECT 1"));
      expect(error.code).toBe("statementFailed");
      expect(error.message).toMatch(/SELECT is not allowed in a cluster/);
    });
  });

  it("givenClusterAndSsh_whenConnect_thenConnectionFailedNamingTheTunnel", async () => {
    const error = await rejection(
      redis.connect(redis.connectionSchema.parse(cluster.config), { ...OPTIONS, serverName: cluster.config.host }),
    );
    expect(error.code).toBe("connectionFailed");
    expect(error.message).toMatch(/An SSH tunnel reaches one node; a cluster needs every node/);
  });

  it("givenUnreachableAnnouncedNode_whenConnect_thenConnectionFailedNamingTheAddress", async () => {
    const announced = `127.0.0.1:${String(cluster.config.port + 1)}`;
    const config = { ...cluster.config, nodeAddressMap: `${announced}=127.0.0.1:1` };
    const error = await rejection(redis.connect(redis.connectionSchema.parse(config), OPTIONS));
    expect(error.code).toBe("connectionFailed");
    expect(error.message).toContain(`Cannot reach cluster node ${announced} (mapped to 127.0.0.1:1)`);
    expect(error.message).toContain("Node address map");
  });
});
