import { describe, expect, it, vi } from "vitest";
import type { DescribedCatalog, EngineError, OpenedSession } from "@table-craft/desktop/engine/protocol.js";
import { EngineRequestError, type EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { datasourceKey, namespaceKey, pathKey } from "@table-craft/desktop/renderer/model/explorerTree.js";
import { relativeTime, syncFailedText, syncText } from "@table-craft/desktop/renderer/model/format.js";
import { tablesProvider } from "@table-craft/desktop/renderer/palette/tablesProvider.js";
import { createCatalogStore } from "@table-craft/desktop/renderer/state/catalog.js";
import { createConsolesStore } from "@table-craft/desktop/renderer/state/consoles.js";
import { createDatasourcesStore } from "@table-craft/desktop/renderer/state/datasources.js";
import { createTabsStore } from "@table-craft/desktop/renderer/state/tabs.js";
import { wireStores } from "@table-craft/desktop/renderer/state/wiring.js";
import { LOADED_PG, PG_NAMESPACES, PG_VIEW, PUBLIC_CATALOG, PUBLIC_PATH } from "./catalogFixtures.js";
import { POSTGRES_PLUGIN } from "./datasourceViews.js";

const DENIED: EngineError = {
  code: "introspectionFailed",
  message: "permission denied for schema public",
  hint: "Check that this user may read the schema.",
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** An engine whose describe answers come from `describe`, so a test can hold or fail one. */
function catalogClient(describe: () => Promise<DescribedCatalog> = () => Promise.resolve(PUBLIC_CATALOG)) {
  const calls: { type: string; params: Record<string, unknown> }[] = [];
  const client = {
    call(type: string, params: Record<string, unknown>): Promise<unknown> {
      calls.push({ type, params });
      if (type === "session.open") {
        const opened: OpenedSession = {
          sessionId: "s1",
          pluginName: "PostgreSQL",
          capabilities: ["sql", "schemaTree"],
          serverVersion: "17",
          serverBrand: null,
          namespace: null,
        };
        return Promise.resolve(opened);
      }
      if (type === "catalog.namespaces") return Promise.resolve(PG_NAMESPACES);
      if (type === "catalog.describe") return describe();
      return Promise.resolve(null);
    },
    fail: () => undefined,
    onEvent: () => () => undefined,
  };
  return { client: client as EngineClient, calls };
}

function catalogStore(client: EngineClient) {
  return createCatalogStore({ connect: () => Promise.resolve(client) });
}

/** The renderer's stores wired as `installDatasourceSync` wires them, over one fake engine. */
function wired() {
  const { client } = catalogClient();
  const datasources = createDatasourcesStore({
    connectEngine: () => Promise.resolve({ status: "connected", client }),
    disconnectEngine: () => Promise.resolve(),
    promptSecrets: () => Promise.resolve(null),
    rememberBrand: () => Promise.resolve(),
  });
  datasources.getState().setPlugins([POSTGRES_PLUGIN]);
  datasources.getState().applyList({
    datasources: [PG_VIEW],
    warning: null,
    encryption: { available: true, reason: null },
  });
  const catalog = createCatalogStore({ connect: (id) => datasources.getState().connect(id) });
  const consoles = createConsolesStore({ connect: (id) => datasources.getState().connect(id), now: () => 0 });
  const unwire = wireStores({ datasources, consoles, tabs: createTabsStore(), catalog });
  return { datasources, consoles, catalog, unwire };
}

describe("catalog store", () => {
  it("givenFirstExpand_whenNamespacesListed_thenTheCurrentOneIsExpandedAndDescribed", async () => {
    const { client, calls } = catalogClient();
    const store = catalogStore(client);

    await store.getState().expandDatasource("pg");

    const { catalogs, expanded } = store.getState();
    expect(catalogs.pg?.namespaces).toEqual(PG_NAMESPACES);
    expect(catalogs.pg?.namespaceStates[pathKey(PUBLIC_PATH)]?.described).toEqual(PUBLIC_CATALOG);
    expect([...expanded]).toEqual([
      datasourceKey("pg"),
      namespaceKey("pg", ["table_craft"]),
      namespaceKey("pg", PUBLIC_PATH),
    ]);
    expect(calls.filter((call) => call.type === "catalog.describe")).toHaveLength(1);
  });

  it("givenDescribeFails_whenSynchronized_thenItRetriesAndRecovers", async () => {
    let fails = true;
    const { client } = catalogClient(() =>
      fails ? Promise.reject(new EngineRequestError(DENIED)) : Promise.resolve(PUBLIC_CATALOG),
    );
    const store = catalogStore(client);
    await store.getState().expandDatasource("pg");
    expect(store.getState().catalogs.pg?.namespaceStates[pathKey(PUBLIC_PATH)]?.error).toEqual(DENIED);

    fails = false;
    await store.getState().synchronize("pg", PUBLIC_PATH);

    expect(store.getState().catalogs.pg?.namespaceStates[pathKey(PUBLIC_PATH)]).toEqual({
      described: PUBLIC_CATALOG,
      loading: false,
      error: null,
    });
  });

  it("givenSynchronizeOnSchema_whenRun_thenDescribesWithRefresh", async () => {
    const { client, calls } = catalogClient();
    const store = catalogStore(client);
    await store.getState().expandDatasource("pg");

    await store.getState().synchronize("pg", PUBLIC_PATH);
    await store.getState().synchronize("pg", null);

    expect(calls.slice(-2).map((call) => [call.type, call.params])).toEqual([
      ["catalog.describe", { path: PUBLIC_PATH, refresh: true }],
      ["catalog.namespaces", { refresh: true }],
    ]);
  });

  it("givenDescribeInFlight_whenCleared_thenItsLateAnswerIsDropped", async () => {
    const held = deferred<DescribedCatalog>();
    const { client } = catalogClient(() => held.promise);
    const store = catalogStore(client);
    const expanding = store.getState().expandDatasource("pg");
    await vi.waitFor(() => {
      expect(store.getState().catalogs.pg?.namespaceStates[pathKey(PUBLIC_PATH)]?.loading).toBe(true);
    });

    store.getState().clear("pg");
    held.resolve(PUBLIC_CATALOG);
    await expanding;

    expect(store.getState().catalogs.pg).toBeUndefined();
    expect(store.getState().expanded.size).toBe(0);
  });

  it("givenDatasourceDetached_whenCatalogStoreNotified_thenItsCatalogsAreCleared", async () => {
    const { datasources, catalog, unwire } = wired();
    await catalog.getState().expandDatasource("pg");
    expect(catalog.getState().catalogs.pg?.namespaces).toEqual(PG_NAMESPACES);

    await datasources.getState().disconnect("pg");

    expect(catalog.getState().catalogs.pg).toBeUndefined();
    expect(catalog.getState().expanded.has(datasourceKey("pg"))).toBe(false);
    unwire();
  });

  it("givenConsoleConnectsDatasource_whenAttached_thenTreeOpensOnTheCurrentNamespace", async () => {
    const { consoles, catalog, unwire } = wired();

    await consoles.getState().open("c1", "pg", { sql: "SELECT 1" });

    await vi.waitFor(() => {
      expect(catalog.getState().catalogs.pg?.namespaceStates[pathKey(PUBLIC_PATH)]?.described).toEqual(PUBLIC_CATALOG);
    });
    expect(catalog.getState().expanded.has(datasourceKey("pg"))).toBe(true);
    expect(catalog.getState().expanded.has(namespaceKey("pg", PUBLIC_PATH))).toBe(true);
    unwire();
  });

  it("givenLoadedCatalogs_whenTablesProviderSearched_thenReturnsRelationsWithPath", () => {
    const open = vi.fn();
    const provider = tablesProvider({
      catalogs: () => ({ pg: LOADED_PG }),
      datasources: () => [PG_VIEW],
      open,
    });

    const items = provider.search("ord");
    items[0]?.run();

    expect(items.map((item) => [item.title, item.detail])).toEqual([["orders", "pg › table_craft › public"]]);
    expect(open).toHaveBeenCalledWith({ datasourceId: "pg", path: PUBLIC_PATH, name: "orders", kind: "table" });
  });

  it("givenDescribedCatalog_whenStatusShown_thenItSaysWhenAndHowLong", () => {
    const minute = 60_000;

    expect(syncText("public", 0, 38, 2 * minute + 5)).toBe("public synchronized (38 ms) · 2 min ago");
    expect(relativeTime(0, 30_000)).toBe("just now");
    expect(relativeTime(0, 3 * 60 * minute)).toBe("3 h ago");
    expect(syncFailedText("public", DENIED)).toBe(
      "public failed: permission denied for schema public Check that this user may read the schema.",
    );
  });
});
