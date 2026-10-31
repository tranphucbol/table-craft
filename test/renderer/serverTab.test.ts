import { describe, expect, it, vi } from "vitest";
import { SERVER_ACTION_IDS, SERVER_ACTIONS } from "@table-craft/desktop/renderer/actions/serverActions.js";
import { useServer } from "@table-craft/desktop/renderer/state/server.js";
import { useTabs } from "@table-craft/desktop/renderer/state/tabs.js";
import { useKeyAdmin } from "@table-craft/desktop/renderer/keyAdmin/store.js";
import { IDLE_CONTEXT } from "./support.js";
import { view } from "./datasourceViews.js";
import type { ServerInfo, ServerNode, SlowCommand } from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { keyspaceStatusText, EMPTY_KEYSPACE } from "@table-craft/desktop/renderer/model/keyTree.js";
import { durationText, hitRatio, overviewRows, serverCards } from "@table-craft/desktop/renderer/model/serverInfo.js";
import {
  createServerStore,
  selectedSlowCommand,
  showsOverview,
  slowCommandKey,
} from "@table-craft/desktop/renderer/state/server.js";

const PRIMARY: ServerNode = {
  id: "a",
  address: "127.0.0.1:7001",
  role: "primary",
  slots: [[0, 5460]],
  primaryId: null,
  state: "connected",
};
const REPLICA: ServerNode = {
  ...PRIMARY,
  id: "b",
  address: "127.0.0.1:7004",
  role: "replica",
  slots: [],
  primaryId: "a",
};

const INFO: ServerInfo = {
  node: null,
  sections: [
    { title: "Server", entries: [{ name: "redis_version", value: "7.4.1" }] },
    {
      title: "Stats",
      entries: [
        { name: "instantaneous_ops_per_sec", value: "12" },
        { name: "keyspace_hits", value: "973" },
        { name: "keyspace_misses", value: "27" },
      ],
    },
    { title: "Memory", entries: [{ name: "used_memory_human", value: "1.2M" }] },
    { title: "Errorstats", entries: [{ name: "errorstat_ERR", value: "count=1" }] },
  ],
};

const SLOW: SlowCommand = {
  id: 7,
  at: "2026-10-25T10:00:00.000Z",
  durationMicros: 12_500,
  command: "KEYS *",
  client: null,
  node: "127.0.0.1:7001",
};

function serverEngine(nodes: readonly ServerNode[]) {
  const call = vi.fn((type: string, params: { node?: string | null }): Promise<unknown> => {
    if (type === "server.nodes") return Promise.resolve(nodes);
    if (type === "server.info") return Promise.resolve({ ...INFO, node: params.node ?? null });
    if (type === "server.slowLog") return Promise.resolve([SLOW]);
    return Promise.reject(new Error(`unexpected ${type}`));
  });
  const client = { call } as unknown as EngineClient;
  return { call, store: createServerStore({ connect: () => Promise.resolve(client), now: () => 1 }) };
}

describe("server tab", () => {
  it("givenMembersAndServerInfo_whenServerDetailsInvoked_thenFactsTabIsReachableWithoutReplacingMembers", async () => {
    const context = {
      ...IDLE_CONTEXT,
      capabilities: ["serverInfo", "members"] as const,
      datasource: {
        view: view({ id: "kv", name: "kv" }),
        capabilities: ["serverInfo", "members"] as const,
        connection: { status: "connected", error: null, serverVersion: "3.6", serverBrand: null } as const,
      },
    };
    const details = SERVER_ACTIONS.find((action) => action.id === SERVER_ACTION_IDS.details)!;
    const show = SERVER_ACTIONS.find((action) => action.id === SERVER_ACTION_IDS.show)!;
    const openTab = vi.spyOn(useTabs.getState(), "open").mockImplementation(() => undefined);
    const openInfo = vi.spyOn(useServer.getState(), "open").mockResolvedValue(undefined);
    const openAdmin = vi.spyOn(useKeyAdmin.getState(), "open").mockResolvedValue(undefined);
    try {
      expect(details.available?.(context)).toBe(true);
      await show.run(context, undefined as never);
      expect(openAdmin).toHaveBeenCalledWith(expect.any(String), "kv", "members");
      await details.run(context, { datasourceId: "kv" } as never);
      expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ kind: "server", title: "Server" }));
      expect(openInfo).toHaveBeenCalledWith(expect.any(String), "kv");
      expect(details.available?.({ ...context, capabilities: ["members"] })).toBe(false);
    } finally {
      openTab.mockRestore();
      openInfo.mockRestore();
      openAdmin.mockRestore();
    }
  });

  it("givenInfo_whenCards_thenMemoryFirstStatsWithHitRatioUnknownLast", () => {
    const cards = serverCards(INFO);
    expect(cards.map((card) => card.title)).toEqual(["Memory", "Stats", "Server", "Errorstats"]);
    expect(cards[1]?.headline).toContainEqual({ name: "hit ratio", value: "97.3 %" });
    expect(cards[1]?.rest.map((figure) => figure.name)).toEqual(["keyspace_hits", "keyspace_misses"]);
  });

  it("givenNoLookups_whenHitRatio_thenNull", () => {
    expect(hitRatio({ title: "Stats", entries: [] })).toBeNull();
  });

  it("givenClusterNodes_whenOverview_thenRolesSlotsAndFigures", () => {
    const rows = overviewRows([PRIMARY, REPLICA], { a: INFO });
    expect(rows.map((row) => [row.role, row.slots, row.memory, row.opsPerSecond])).toEqual([
      ["primary", "0–5460", "1.2M", "12"],
      ["replica of 127.0.0.1:7001", "", null, null],
    ]);
  });

  it.each([
    [840, "840 µs"],
    [12_500, "12.5 ms"],
  ])("givenMicros_whenDuration_then%s", (micros, text) => {
    expect(durationText(micros)).toBe(text);
  });

  it("givenCluster_whenOpened_thenOverviewReadsEveryNode", async () => {
    const { call, store } = serverEngine([PRIMARY, REPLICA]);
    await store.getState().open("server-0", "cache");
    const tab = store.getState().tabs["server-0"];
    expect(tab !== undefined && showsOverview(tab, store.getState().nodes.cache)).toBe(true);
    expect(Object.keys(tab?.infos ?? {})).toEqual(["a", "b"]);
    expect(call).toHaveBeenCalledWith("server.info", { node: "b" });
  });

  it("givenStandalone_whenOpened_thenOneInfo", async () => {
    const { store } = serverEngine([{ ...PRIMARY, slots: [] }]);
    await store.getState().open("server-0", "cache");
    expect(store.getState().tabs["server-0"]?.info?.sections).toHaveLength(4);
  });

  it("givenSlowLogView_whenSelected_thenSelectedCommand", async () => {
    const { store } = serverEngine([PRIMARY]);
    await store.getState().open("server-0", "cache");
    await store.getState().setView("server-0", "slowLog");
    store.getState().selectSlow("server-0", slowCommandKey(SLOW));
    expect(selectedSlowCommand(store.getState().tabs["server-0"])?.command).toBe("KEYS *");
  });

  it("givenKeyspaceAndNodes_whenStatus_thenDatabaseKeysOrPrimaries", () => {
    const keyspace = {
      ...EMPTY_KEYSPACE,
      databases: [{ index: 0, keys: 48_213, expires: 0, current: true }],
    };
    expect(keyspaceStatusText(keyspace, [PRIMARY])).toBe("db0 · 48,213 keys");
    expect(keyspaceStatusText(keyspace, [PRIMARY, REPLICA, { ...PRIMARY, id: "c" }])).toBe("cluster · 2 primaries");
    expect(keyspaceStatusText(undefined, [])).toBeNull();
  });

  it("givenPrimaryWithReplicas_whenStatusText_thenDatabaseLine", () => {
    const keyspace = {
      ...EMPTY_KEYSPACE,
      databases: [{ index: 1, keys: 3, expires: 0, current: true }],
    };
    const primary = { ...PRIMARY, slots: [] };
    const replica = { ...REPLICA, slots: [] };
    expect(keyspaceStatusText(keyspace, [primary, replica])).toBe("db1 · 3 keys");
  });
});
