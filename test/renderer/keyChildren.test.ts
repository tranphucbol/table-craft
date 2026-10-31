import { describe, expect, it, vi } from "vitest";
import type { KeyChildrenPage, KeyChildrenRequest, KeyDeletePreview } from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { datasourceKey, explorerRows, keyTreeKey } from "@table-craft/desktop/renderer/model/explorerTree.js";
import { buildTree } from "@table-craft/desktop/renderer/model/datasourceTree.js";
import {
  CHILDREN_PER_PAGE,
  EMPTY_KEYSPACE,
  keyFilterRange,
  keyIdentity,
  orderedChildren,
  ROOT_KEY,
  UNLISTED_FOLDER,
  UNSCANNED_KEYS,
} from "@table-craft/desktop/renderer/model/keyTree.js";
import { createKeysStore } from "@table-craft/desktop/renderer/state/keys.js";
import { createKeyDeletesStore, keyDeleteText } from "@table-craft/desktop/renderer/state/keyDeletes.js";
import { view } from "./datasourceViews.js";

const name = (text: string) => ({ text, hex: null });
const FEATURES = { children: true, countRange: true, prepareDelete: true, history: false };
const REVISION = "9007199254740993";
const revision = (lease = "0") => ({ createRevision: "1", modRevision: REVISION, version: "14", lease });
const page = (children: KeyChildrenPage["children"] = [], cursor: string | null = null): KeyChildrenPage => ({
  revision: REVISION,
  children,
  cursor,
});

function fixture(children: (request: KeyChildrenRequest) => Promise<KeyChildrenPage> = () => Promise.resolve(page())) {
  const call = vi.fn(async (method: string, params: unknown): Promise<unknown> => {
    if (method === "keyspace.databases")
      return { delimiter: "/", databases: [{ index: 0, keys: 0, expires: 0, current: true }] };
    if (method === "keyspace.features") return FEATURES;
    if (method === "keyspace.children") return children(params as KeyChildrenRequest);
    if (method === "keyspace.countRange") return { revision: REVISION, keys: "9007199254740993", leasedKeys: null };
    if (method === "leases.get") return { remainingTtlSeconds: "42" };
    throw new Error(`Unexpected method: ${method}`);
  });
  const store = createKeysStore({
    connect: () => Promise.resolve({ call } as unknown as EngineClient),
    expand: vi.fn(),
    collapse: vi.fn(),
    nodes: () => Promise.resolve([]),
    loadsOnDemand: () => false,
  });
  return { store, call };
}

describe("server children tree", () => {
  it("givenOptionalChildrenWithoutRevisionGuard_whenExpanded_thenUses500ChildPagesNeverScan", async () => {
    const { store, call } = fixture(() => Promise.resolve(page([{ kind: "folder", key: name("/config/") }], "next")));
    await store.getState().expandDatasource("ds");
    expect(call).toHaveBeenCalledWith("keyspace.children", {
      database: 0,
      range: { kind: "all" },
      parent: ROOT_KEY,
      cursor: null,
      count: CHILDREN_PER_PAGE,
      timeoutMs: 5000,
    });
    await store.getState().loadMore("ds", 0);
    expect(call).toHaveBeenLastCalledWith("keyspace.children", expect.objectContaining({ cursor: "next" }));
    expect(call.mock.calls.some(([method]) => method === "keyspace.scan")).toBe(false);
  });

  it("givenFolderCache_whenExpandedAgain_thenNoRescanAndFolderRefreshStaysLocal", async () => {
    const folder = name("/config/");
    const { store, call } = fixture((request) =>
      Promise.resolve(
        page(
          request.parent.text === ""
            ? [{ kind: "folder", key: folder }]
            : [{ kind: "key", key: name("/config/a"), revision: revision() }],
        ),
      ),
    );
    await store.getState().expandDatasource("ds");
    await store.getState().expandFolder("ds", 0, folder);
    const before = call.mock.calls.length;
    await store.getState().expandFolder("ds", 0, folder);
    expect(call).toHaveBeenCalledTimes(before);
    await store.getState().loadChildren("ds", 0, folder, true);
    expect(call).toHaveBeenCalledTimes(before + 1);
    expect(call).toHaveBeenLastCalledWith(
      "keyspace.children",
      expect.objectContaining({ parent: folder, cursor: null }),
    );
    expect(store.getState().keyspaces.ds?.byDatabase[0]?.folders?.[keyIdentity(ROOT_KEY)]?.children).toHaveLength(1);
  });

  it("givenChangedPageRevision_whenAppending_thenKeepsPinnedRowsAndOffersRestart", async () => {
    const { store } = fixture((request) =>
      Promise.resolve(
        request.cursor === null
          ? page([{ kind: "key", key: name("a"), revision: revision() }], "next")
          : { ...page([{ kind: "key", key: name("b"), revision: revision() }]), revision: "9007199254740994" },
      ),
    );
    await store.getState().expandDatasource("ds");
    await store.getState().loadMore("ds", 0);
    const folder = store.getState().keyspaces.ds?.byDatabase[0]?.folders?.[keyIdentity(ROOT_KEY)];
    expect(folder?.children.map((child) => child.key.text)).toEqual(["a"]);
    expect(folder?.error?.message).toContain("revision changed");
    await store.getState().loadChildren("ds", 0, ROOT_KEY, true);
    expect(store.getState().keyspaces.ds?.byDatabase[0]?.folders?.[keyIdentity(ROOT_KEY)]?.error).toBeNull();
  });

  it("givenLoadedNameAndLeaseFilters_whenApplied_thenNoServerNameScan", async () => {
    const { store, call } = fixture();
    await store.getState().expandDatasource("ds");
    const before = call.mock.calls.length;
    await store
      .getState()
      .setFilter("ds", 0, { mode: "loadedName", match: "literal[*]", leasedOnly: true, type: null });
    expect(call).toHaveBeenCalledTimes(before);
    expect(keyFilterRange({ mode: "prefix", match: "*", type: null })).toEqual({ kind: "prefix", prefix: name("*") });
    expect(keyFilterRange({ mode: "range", match: "/a", end: "/z", type: null })).toEqual({
      kind: "range",
      from: name("/a"),
      to: name("/z"),
    });
  });

  it("givenVisibleFolderAndSharedLease_whenMetadataRequestedTwice_thenExactCountAndOneLeaseRead", async () => {
    const { store, call } = fixture();
    await store.getState().expandDatasource("ds");
    await Promise.all([
      store.getState().countFolder("ds", 0, name("/a/")),
      store.getState().countFolder("ds", 0, name("/a/")),
      store.getState().readLeaseTtl("ds", "42"),
      store.getState().readLeaseTtl("ds", "42"),
    ]);
    expect(store.getState().keyspaces.ds?.byDatabase[0]?.counts?.[keyIdentity(name("/a/"))]).toBe("9007199254740993");
    expect(call.mock.calls.filter(([method]) => method === "leases.get")).toHaveLength(1);
    expect(call.mock.calls.filter(([method]) => method === "keyspace.countRange")).toHaveLength(1);
  });

  it("givenLatePageAfterDisconnect_whenResolved_thenDoesNotRecreateKeyspace", async () => {
    let release: ((value: KeyChildrenPage) => void) | undefined;
    const { store } = fixture(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    store.setState({ keyspaces: { ds: { ...EMPTY_KEYSPACE, features: FEATURES } } });
    const pending = store.getState().loadChildren("ds", 0, ROOT_KEY, true);
    await Promise.resolve();
    store.getState().clear("ds");
    release?.(page());
    await pending;
    expect(store.getState().keyspaces.ds).toBeUndefined();
  });

  it("givenDeletedSubfolder_whenRangeRefreshed_thenRelistsOnlyItsParentAndDropsStaleCounts", async () => {
    const config = name("/config/");
    const other = name("/other/");
    const { store, call } = fixture((request) =>
      Promise.resolve(
        page(
          request.parent.text === ""
            ? [
                { kind: "folder", key: config },
                { kind: "folder", key: other },
              ]
            : request.parent.text === "/config/"
              ? [
                  { kind: "folder", key: name("/config/db/") },
                  { kind: "key", key: name("/config/a"), revision: revision() },
                ]
              : [{ kind: "key", key: name("/other/b"), revision: revision() }],
        ),
      ),
    );
    await store.getState().expandDatasource("ds");
    await store.getState().expandFolder("ds", 0, config);
    await store.getState().expandFolder("ds", 0, other);
    await store.getState().countFolder("ds", 0, config);
    const before = call.mock.calls.length;
    await store.getState().refreshRange("ds", 0, name("/config/db/"));
    const relisted = call.mock.calls.slice(before).filter(([method]) => method === "keyspace.children");
    expect(relisted).toEqual([["keyspace.children", expect.objectContaining({ parent: config, cursor: null })]]);
    expect(store.getState().keyspaces.ds?.byDatabase[0]?.counts).toEqual({});
    expect(store.getState().keyspaces.ds?.byDatabase[0]?.folders?.[keyIdentity(other)]?.started).toBe(true);
  });

  it("givenKeysNamingAFolderAfterIt_whenOrdered_thenEachKeySitsJustAboveItsFolder", () => {
    const ordered = orderedChildren(
      [
        { kind: "folder", key: name("/config/") },
        { kind: "key", key: name("/a") },
        { kind: "key", key: name("/config/") },
        { kind: "key", key: name("/config") },
      ],
      "/",
    );
    expect(ordered.map((child) => `${child.kind}:${child.key.text}`)).toEqual([
      "key:/config/",
      "key:/config",
      "folder:/config/",
      "key:/a",
    ]);
  });

  it("givenLiteralPrefixKeyAndFolder_whenRendered_thenDistinctRowsAndUnknownCountBlank", () => {
    const key = name("/config/");
    const rows = explorerRows({
      tree: buildTree([view({ id: "ds", name: "ds" })]),
      catalogs: {},
      expanded: new Set([datasourceKey("ds"), keyTreeKey("ds", "keyDatabase", 0)]),
      collapsedFolders: new Set(),
      showSystem: false,
      canExpand: () => true,
      browsesKeys: () => true,
      keyspaces: {
        ds: {
          ...EMPTY_KEYSPACE,
          features: FEATURES,
          delimiter: "/",
          databases: [{ index: 0, keys: 0, expires: 0, current: true }],
          byDatabase: {
            0: {
              ...UNSCANNED_KEYS,
              started: true,
              folders: {
                [keyIdentity(ROOT_KEY)]: {
                  ...UNLISTED_FOLDER,
                  started: true,
                  children: [
                    { kind: "key", key, revision: revision() },
                    { kind: "folder", key },
                  ],
                },
              },
            },
          },
        },
      },
    });
    const matching = rows.filter((row) => row.node.kind === "keyEntry" || row.node.kind === "keyFolder");
    expect(matching).toHaveLength(2);
    expect(new Set(matching.map((row) => row.key)).size).toBe(2);
    expect(matching.find((row) => row.node.kind === "keyFolder")?.node).toMatchObject({ exactCount: null });
  });
});

describe("prepared deletion Services task", () => {
  const preview: KeyDeletePreview = {
    token: "opaque-range-token",
    revision: REVISION,
    counts: { revision: REVISION, keys: "9007199254740993", leasedKeys: null },
    sampleKeys: [],
    guard: "noNewOrModifiedKeys",
  };
  it("givenPreparedRange_whenCommitted_thenOnlyTokenSentAndDecimalProgressPreserved", async () => {
    const call = vi.fn(() => Promise.resolve({ revision: "9007199254740994", deleted: "9007199254740993" }));
    const refreshed = vi.fn(() => Promise.resolve());
    const store = createKeyDeletesStore({
      connect: () => Promise.resolve({ call } as unknown as EngineClient),
      refreshed,
    });
    const task = await store.getState().startPrepared("ds", 0, name("/"), preview);
    expect(call).toHaveBeenCalledExactlyOnceWith("keyspace.deletePrepared", { token: "opaque-range-token" });
    expect(task).toMatchObject({ state: "completed", atomic: true, exactDeleted: "9007199254740993" });
    expect(keyDeleteText(task)).toBe("9007199254740993 of 9007199254740993");
    expect(refreshed).toHaveBeenCalledExactlyOnceWith("ds", 0, name("/"));
  });

  it("givenGuardFailure_whenCommitted_thenFailsWithoutLegacyRemoveFallback", async () => {
    const call = vi.fn(() => Promise.reject(new Error("Keys were modified after preview")));
    const store = createKeyDeletesStore({ connect: () => Promise.resolve({ call } as unknown as EngineClient) });
    const task = await store.getState().startPrepared("ds", 0, name("/"), preview);
    expect(task.state).toBe("failed");
    expect(task.error?.message).toContain("modified after preview");
    expect(call).toHaveBeenCalledTimes(1);
  });
});
