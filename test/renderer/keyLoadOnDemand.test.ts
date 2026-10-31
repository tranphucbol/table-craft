import { describe, expect, it, vi } from "vitest";
import type { KeyChildrenPage, KeyScan } from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { keyIdentity, ROOT_KEY } from "@table-craft/desktop/renderer/model/keyTree.js";
import { createKeysStore } from "@table-craft/desktop/renderer/state/keys.js";

const name = (text: string) => ({ text, hex: null });
const FLAT_FEATURES = { children: false, countRange: false, prepareDelete: false, history: false };
const CHILDREN_FEATURES = { children: true, countRange: true, prepareDelete: true, history: false };
const SCAN: KeyScan = { keys: [name("user:1"), name("user:2")], cursor: null, scanned: 2 };
const PAGE: KeyChildrenPage = {
  revision: "7",
  children: [
    { kind: "folder", key: name("/app/") },
    { kind: "key", key: name("/top") },
  ],
  cursor: null,
};

function fixture(options: { readonly children?: boolean; readonly onDemand?: boolean } = {}) {
  const children = options.children === true;
  const answer = (method: string): unknown => {
    if (method === "keyspace.databases")
      return {
        delimiter: children ? "/" : ":",
        databases: children
          ? [{ index: 0, keys: 1204, expires: 0, current: true }]
          : [
              { index: 0, keys: 48_213, expires: 0, current: true },
              { index: 2, keys: 9, expires: 0, current: false },
            ],
      };
    if (method === "keyspace.features") return children ? CHILDREN_FEATURES : FLAT_FEATURES;
    if (method === "keyspace.scan") return SCAN;
    if (method === "keyspace.children") return PAGE;
    if (method === "keyspace.countRange") return { revision: "7", keys: "5", leasedKeys: null };
    throw new Error(`Unexpected method: ${method}`);
  };
  const call = vi.fn((method: string, _params?: unknown) => Promise.resolve(answer(method)));
  const expand = vi.fn();
  const store = createKeysStore({
    connect: () => Promise.resolve({ call } as unknown as EngineClient),
    expand,
    collapse: vi.fn(),
    nodes: () => Promise.resolve([]),
    loadsOnDemand: () => options.onDemand !== false,
  });
  const calls = (method: string) => call.mock.calls.filter(([called]) => called === method);
  return { store, call, calls, expand };
}

describe("key tree loads on demand, flat keyspace", () => {
  it("givenLoadOnDemand_whenExpandDatasource_thenDatabasesListedAndScanNeverCalled", async () => {
    const { store, calls } = fixture();
    await store.getState().expandDatasource("ds");
    expect(store.getState().keyspaces.ds?.databases).toHaveLength(2);
    expect(calls("keyspace.scan")).toHaveLength(0);
  });

  it("givenLoadOnDemand_whenExpandDatabase_thenNotStartedAndScanNeverCalled", async () => {
    const { store, calls, expand } = fixture();
    await store.getState().expandDatasource("ds");
    await store.getState().expandDatabase("ds", 2);
    expect(store.getState().keyspaces.ds?.byDatabase[2]?.started ?? false).toBe(false);
    expect(expand).toHaveBeenCalledWith([expect.stringContaining("keyDatabase")]);
    expect(calls("keyspace.scan")).toHaveLength(0);
  });

  it("givenLoadOnDemandUnscanned_whenLoadMore_thenOneFreshPass", async () => {
    const { store, calls } = fixture();
    await store.getState().expandDatasource("ds");
    await store.getState().loadMore("ds", 0);
    expect(calls("keyspace.scan")).toEqual([
      ["keyspace.scan", { database: 0, cursor: null, match: "*", keyType: null }],
    ]);
    expect(store.getState().keyspaces.ds?.byDatabase[0]).toMatchObject({ started: true, loading: false, cursor: null });
    expect(store.getState().keyspaces.ds?.byDatabase[0]?.keys).toEqual(SCAN.keys);
  });

  it("givenLoadOnDemandUnscanned_whenSetFilter_thenPassUnderFilter", async () => {
    const { store, calls } = fixture();
    await store.getState().expandDatasource("ds");
    await store.getState().setFilter("ds", 0, { match: "user:*", type: "hash" });
    expect(calls("keyspace.scan")).toEqual([
      ["keyspace.scan", { database: 0, cursor: null, match: "user:*", keyType: "hash" }],
    ]);
  });

  it("givenLoadOnDemand_whenSynchronize_thenOnlyScannedDatabasesRescanned", async () => {
    const { store, calls } = fixture();
    await store.getState().expandDatasource("ds");
    await store.getState().loadMore("ds", 2);
    await store.getState().synchronize("ds");
    expect(calls("keyspace.scan").map(([, params]) => (params as { database: number }).database)).toEqual([2, 2]);
  });

  it("givenLoadOnDemand_whenRememberThenExpand_thenKeyKeptAndScanNeverCalled", async () => {
    const { store, calls } = fixture();
    await store.getState().expandDatasource("ds");
    store.getState().remember("ds", 0, [name("order:7")]);
    await store.getState().expandDatabase("ds", 0);
    expect(store.getState().keyspaces.ds?.byDatabase[0]?.keys).toEqual([name("order:7")]);
    expect(calls("keyspace.scan")).toHaveLength(0);
  });

  it("givenLoadOnOpen_whenExpandDatasource_thenConfiguredDatabaseScanned", async () => {
    const { store, calls } = fixture({ onDemand: false });
    await store.getState().expandDatasource("ds");
    expect(calls("keyspace.scan")).toHaveLength(1);
    expect(store.getState().keyspaces.ds?.byDatabase[0]?.started).toBe(true);
  });
});

describe("key tree loads on demand, server-listed keyspace", () => {
  it("givenLoadOnDemandChildren_whenExpandDatasource_thenChildrenAndCountRangeNeverCalled", async () => {
    const { store, calls } = fixture({ children: true });
    await store.getState().expandDatasource("ds");
    expect(store.getState().keyspaces.ds?.databases).toHaveLength(1);
    expect(calls("keyspace.children")).toHaveLength(0);
    expect(calls("keyspace.countRange")).toHaveLength(0);
  });

  it("givenLoadOnDemandChildrenUnlisted_whenLoadMore_thenRootListedOnceInPrefixMode", async () => {
    const { store, calls } = fixture({ children: true });
    await store.getState().expandDatasource("ds");
    await store.getState().loadMore("ds", 0);
    expect(calls("keyspace.children")).toEqual([
      ["keyspace.children", expect.objectContaining({ parent: ROOT_KEY, cursor: null, range: { kind: "all" } })],
    ]);
    const keys = store.getState().keyspaces.ds?.byDatabase[0];
    expect(keys?.filter.mode).toBe("prefix");
    expect(keys?.folders?.[keyIdentity(ROOT_KEY)]?.children).toEqual(PAGE.children);
  });

  it("givenLoadOnDemandChildrenUnlisted_whenSetFilterSameAsDefault_thenRootListed", async () => {
    const { store, calls } = fixture({ children: true });
    await store.getState().expandDatasource("ds");
    await store.getState().setFilter("ds", 0, { match: "*", type: null });
    expect(calls("keyspace.children")).toHaveLength(1);
  });

  it("givenLoadOnDemandChildrenUnlisted_whenSetFilterLoadedName_thenChildrenNeverCalled", async () => {
    const { store, calls } = fixture({ children: true });
    await store.getState().expandDatasource("ds");
    await store.getState().setFilter("ds", 0, { match: "app", type: null, mode: "loadedName" });
    expect(calls("keyspace.children")).toHaveLength(0);
  });

  it("givenLoadOnDemandChildren_whenSynchronize_thenUnlistedRootNotListed", async () => {
    const { store, calls } = fixture({ children: true });
    await store.getState().expandDatasource("ds");
    await store.getState().synchronize("ds");
    expect(calls("keyspace.databases")).toHaveLength(2);
    expect(calls("keyspace.children")).toHaveLength(0);
  });

  it("givenLoadOnDemandChildren_whenRememberThenExpand_thenChildrenNeverCalled", async () => {
    const { store, calls } = fixture({ children: true });
    await store.getState().expandDatasource("ds");
    store.getState().remember("ds", 0, [name("/app/config")]);
    await store.getState().expandDatabase("ds", 0);
    expect(store.getState().keyspaces.ds?.byDatabase[0]?.keys).toEqual([name("/app/config")]);
    expect(calls("keyspace.children")).toHaveLength(0);
  });
});
