import { describe, expect, it } from "vitest";
import type { KeyDatabase, KeyName, ServerNode } from "@table-craft/desktop/engine/protocol.js";
import { buildTree } from "@table-craft/desktop/renderer/model/datasourceTree.js";
import { datasourceKey, explorerRows, keyTreeKey } from "@table-craft/desktop/renderer/model/explorerTree.js";
import {
  appendKeys,
  EMPTY_KEYSPACE,
  groupKeys,
  keyIdentity,
  loadMoreText,
  ttlText,
  undescribedKeys,
  UNLISTED_FOLDER,
  unloadedKeysText,
  UNSCANNED_KEYS,
  type DatabaseKeys,
  type DatasourceKeyspace,
} from "@table-craft/desktop/renderer/model/keyTree.js";
import { outline } from "./catalogFixtures.js";
import { view } from "./datasourceViews.js";

const REDIS_VIEW = view({ id: "cache", name: "cache", pluginId: "redis" });
const DB0_KEY = keyTreeKey("cache", "keyDatabase", 0);
const USER_KEY = keyTreeKey("cache", "keyFolder", 0, "user:");

function name(text: string): KeyName {
  return { text, hex: null };
}

function database(index: number, keys: number, current = false): KeyDatabase {
  return { index, keys, expires: 0, current };
}

function scanned(keys: readonly string[], overrides: Partial<DatabaseKeys> = {}): DatabaseKeys {
  return { ...UNSCANNED_KEYS, started: true, keys: keys.map(name), ...overrides };
}

const KEYSPACE: DatasourceKeyspace = {
  ...EMPTY_KEYSPACE,
  delimiter: ":",
  databases: [database(0, 6, true), database(1, 0), database(2, 220)],
  byDatabase: { 0: scanned(["user:42:session", "queue", "user:42:profile", "order:7", "user:43:profile"]) },
};

function node(
  id: string,
  port: number,
  role: ServerNode["role"],
  primaryId: string | null,
  slots: ServerNode["slots"] = [],
): ServerNode {
  return { id, address: `127.0.0.1:${String(port)}`, role, slots, primaryId, state: "connected" };
}

function rowsOf(expanded: readonly string[], keyspace: DatasourceKeyspace = KEYSPACE, showEmptyDatabases = false) {
  return explorerRows({
    tree: buildTree([REDIS_VIEW]),
    catalogs: {},
    expanded: new Set([datasourceKey("cache"), ...expanded]),
    collapsedFolders: new Set(),
    showSystem: false,
    canExpand: () => true,
    keyspaces: { cache: keyspace },
    browsesKeys: () => true,
    showEmptyDatabases,
  });
}

describe("key tree", () => {
  it("givenKeys_whenGrouped_thenFoldersByDelimiterFirst", () => {
    expect(outline(rowsOf([DB0_KEY, USER_KEY]))).toEqual([
      "0 cache",
      "1 db0",
      "2 ",
      "2 order:",
      "2 user:",
      "3 user:42:",
      "3 user:43:",
      "2 queue",
      "1 db2",
    ]);
    const folder = rowsOf([DB0_KEY]).find((row) => row.label === "user:");
    expect(folder?.node).toMatchObject({ kind: "keyFolder", count: 3 });
  });

  it("givenLoadMore_whenMoreKeys_thenAppended", () => {
    const first = scanned(["page:1", "page:2"], { cursor: "17" });
    const more = { ...first, keys: appendKeys(first.keys, [name("page:2"), name("page:3")]), cursor: null };
    const page = keyTreeKey("cache", "keyFolder", 0, "page:");
    const before = rowsOf([DB0_KEY, page], { ...KEYSPACE, byDatabase: { 0: first } });
    expect(before.at(-2)?.label).toBe(loadMoreText({ loaded: 2, estimate: 6 }));
    const after = rowsOf([DB0_KEY, page], { ...KEYSPACE, byDatabase: { 0: more } });
    expect(outline(after).slice(2)).toEqual(["2 ", "2 page:", "3 1", "3 2", "3 3", "1 db2"]);
  });

  it("givenEmptyDatabase_whenShowEmpty_thenListed", () => {
    expect(outline(rowsOf([], KEYSPACE, true))).toEqual(["0 cache", "1 db0", "1 db1", "1 db2"]);
  });

  it("givenUnscannedDatabase_whenExpanded_thenFilterAndLoadingRows", () => {
    const rows = rowsOf([keyTreeKey("cache", "keyDatabase", 2)]);
    expect(rows.slice(-2).map((row) => row.node.kind)).toEqual(["keyFilter", "loading"]);
  });

  it("givenCluster_whenRows_thenClusterNodesGroupAfterDatabases", () => {
    const nodes = [node("a", 7001, "primary", null, [[0, 5460]]), node("b", 7004, "replica", "a")];
    const rows = rowsOf([keyTreeKey("cache", "clusterNodes")], {
      ...KEYSPACE,
      databases: [database(0, 6, true)],
      nodes,
    });
    expect(outline(rows)).toEqual([
      "0 cache",
      "1 db0",
      "1 Cluster nodes",
      "2 127.0.0.1:7001 primary 0–5460",
      "2 127.0.0.1:7004 replica of 127.0.0.1:7001",
    ]);
  });

  it("givenPrimaryWithReplicas_whenRows_thenNodesGroup", () => {
    const nodes = [
      node("127.0.0.1:6379", 6379, "primary", null),
      node("127.0.0.1:6380", 6380, "replica", "127.0.0.1:6379"),
    ];
    const rows = rowsOf([keyTreeKey("cache", "clusterNodes")], {
      ...KEYSPACE,
      databases: [database(0, 6, true)],
      nodes,
    });
    expect(outline(rows)).toEqual([
      "0 cache",
      "1 db0",
      "1 Nodes",
      "2 127.0.0.1:6379 primary",
      "2 127.0.0.1:6380 replica of 127.0.0.1:6379",
    ]);
  });

  it("givenNoDelimiter_whenGrouped_thenFlat", () => {
    const root = groupKeys([name("b:1"), name("a:2")], "");
    expect(root.folders).toEqual([]);
    expect(root.keys.map((leaf) => leaf.name)).toEqual(["a:2", "b:1"]);
  });

  it("givenVisibleKeys_whenUndescribed_thenGroupedByDatabase", () => {
    const rows = rowsOf([DB0_KEY]);
    expect(undescribedKeys(rows)).toEqual([{ datasourceId: "cache", database: 0, keys: [name("queue")] }]);
  });

  it.each([
    [null, "no TTL"],
    [400, "0 s"],
    [14 * 60_000 + 5000, "14 m"],
    [3 * 86_400_000, "3 d"],
  ])("givenTtl_whenText_thenShort %s", (ttl, text) => {
    expect(ttlText(ttl)).toBe(text);
  });
});

const ON_DEMAND_VIEW = view({ id: "cache", name: "cache", pluginId: "redis", loadKeysOnDemand: true });
const CHILDREN_FEATURES = { children: true, countRange: true, prepareDelete: true, history: false };

function onDemandRowsOf(expanded: readonly string[], keyspace: DatasourceKeyspace, datasource = ON_DEMAND_VIEW) {
  return explorerRows({
    tree: buildTree([datasource]),
    catalogs: {},
    expanded: new Set([datasourceKey("cache"), ...expanded]),
    collapsedFolders: new Set(),
    showSystem: false,
    canExpand: () => true,
    keyspaces: { cache: keyspace },
    browsesKeys: () => true,
    showEmptyDatabases: false,
  });
}

describe("key tree on demand", () => {
  it("givenLoadOnDemandUnscanned_whenRows_thenScanRowWithEstimateNotLoading", () => {
    const rows = onDemandRowsOf([DB0_KEY], { ...KEYSPACE, byDatabase: {} });
    expect(outline(rows)).toEqual(["0 cache", "1 db0", "2 ", "2 Not scanned · ~6 keys · Scan", "1 db2"]);
    expect(rows[3]?.node).toMatchObject({ kind: "keyLoadMore", loaded: 0, estimate: 6, unloaded: true });
    expect(rows.some((row) => row.node.kind === "loading")).toBe(false);
  });

  it("givenLoadOnDemandScanned_whenRows_thenSameRowsAsLoadOnOpen", () => {
    expect(outline(onDemandRowsOf([DB0_KEY, USER_KEY], KEYSPACE))).toEqual(outline(rowsOf([DB0_KEY, USER_KEY])));
  });

  it("givenLoadOnDemandRememberedKey_whenRows_thenKeyAboveScanRow", () => {
    const rows = onDemandRowsOf([DB0_KEY], {
      ...KEYSPACE,
      byDatabase: { 0: { ...UNSCANNED_KEYS, keys: [name("queue")] } },
    });
    expect(outline(rows).slice(1, 5)).toEqual(["1 db0", "2 ", "2 queue", "2 Not scanned · ~6 keys · Scan"]);
  });

  it("givenLoadOnDemandChildrenUnlisted_whenRows_thenRememberedKeysThenListRow", () => {
    const keyspace: DatasourceKeyspace = {
      ...EMPTY_KEYSPACE,
      features: CHILDREN_FEATURES,
      delimiter: "/",
      databases: [database(0, 1204, true)],
      byDatabase: { 0: { ...UNSCANNED_KEYS, keys: [name("/app/config")] } },
    };
    const rows = onDemandRowsOf([DB0_KEY], keyspace);
    expect(outline(rows)).toEqual(["0 cache", "1 Keys", "2 ", "2 /app/config", "2 Not listed · ~1,204 keys · List"]);
    expect(rows[3]?.node).toMatchObject({ kind: "keyEntry", serverChildren: true });
    expect(rows[4]?.node).toMatchObject({ kind: "keyLoadMore", unloaded: true });
    expect(rows[4]?.node).not.toHaveProperty("parent");
  });

  it("givenLoadOnDemandChildrenListed_whenRows_thenSameRowsAsLoadOnOpen", () => {
    const keyspace: DatasourceKeyspace = {
      ...EMPTY_KEYSPACE,
      features: CHILDREN_FEATURES,
      delimiter: "/",
      databases: [database(0, 2, true)],
      byDatabase: {
        0: {
          ...UNSCANNED_KEYS,
          started: true,
          folders: {
            [keyIdentity(name(""))]: {
              ...UNLISTED_FOLDER,
              started: true,
              children: [
                { kind: "folder", key: name("/app/") },
                { kind: "key", key: name("/top") },
              ],
            },
          },
        },
      },
    };
    expect(outline(onDemandRowsOf([DB0_KEY], keyspace))).toEqual(
      outline(onDemandRowsOf([DB0_KEY], keyspace, REDIS_VIEW)),
    );
    expect(outline(onDemandRowsOf([DB0_KEY], keyspace))).toEqual(["0 cache", "1 Keys", "2 ", "2 app/", "2 top"]);
  });

  it("givenFlatAndChildren_whenUnloadedKeysText_thenScanAndListWording", () => {
    expect(unloadedKeysText(48_213, false)).toBe("Not scanned · ~48,213 keys · Scan");
    expect(unloadedKeysText(1204, true)).toBe("Not listed · ~1,204 keys · List");
    expect(unloadedKeysText(1, false)).toBe("Not scanned · ~1 key · Scan");
  });
});
