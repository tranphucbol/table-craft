import { describe, expect, it, vi } from "vitest";
import type { KeyTask, KeyWatchSummary } from "@table-craft/desktop/engine/protocol.js";
import type { DatasourceList } from "@table-craft/desktop/preload/bridge.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { createTransactionStore } from "@table-craft/desktop/renderer/console/transaction/store.js";
import { createConsolesStore, type ConsoleSession } from "@table-craft/desktop/renderer/state/consoles.js";
import { createDatasourcesStore } from "@table-craft/desktop/renderer/state/datasources.js";
import { followCommandTxn } from "@table-craft/desktop/renderer/state/wiring.js";
import { createAdminStore } from "@table-craft/desktop/renderer/keyAdmin/store.js";
import { createWatchStore, exportRunning } from "@table-craft/desktop/renderer/watch/store.js";
import { exportStatusText } from "@table-craft/desktop/renderer/watch/WatchPane.js";
import { ALL_ACTIONS } from "@table-craft/desktop/renderer/actions/allActions.js";
import { KEY_LEASE_EDITOR_IDS } from "@table-craft/desktop/renderer/actions/keyLeaseEditorActions.js";
import { COMMAND_TXN_ACTION_IDS } from "@table-craft/desktop/renderer/actions/commandTxnActions.js";
import {
  MANAGED_INTENT_ACTION_ID,
  MANAGED_INTENT_INSPECTION_PREFIX,
  MANAGED_INTENT_KINDS,
  managedIntentOf,
  managedIntentRoute,
} from "@table-craft/desktop/renderer/keyAdmin/consoleIntents.js";
import { WATCH_ACTION_IDS } from "@table-craft/desktop/renderer/watch/actions.js";
import { ACTION_IDS } from "@table-craft/desktop/renderer/actions/appActions.js";
import { ACTION_ICONS } from "@table-craft/desktop/renderer/ui/icons.js";
import { REDIS_PLUGIN, view } from "./datasourceViews.js";

const summary: KeyWatchSummary = {
  watchId: "watch-1",
  request: { database: 0, range: { kind: "all" }, from: { kind: "now" } },
  state: "live",
  completedRevision: null,
  gap: null,
  evictedEvents: "0",
};
const task = (state: KeyTask["state"], completed = "0"): KeyTask => ({
  taskId: "task-1",
  kind: "watchExport",
  state,
  completed,
  total: "3",
  error: state === "failed" ? "disk full" : null,
  outcome: "confirmed",
  resumable: false,
});
function client(call: (method: string, params: unknown) => Promise<unknown>): EngineClient {
  return { call } as unknown as EngineClient;
}
function list(): DatasourceList {
  return {
    datasources: [view({ id: "kv", name: "kv", pluginId: "redis" })],
    warning: null,
    encryption: { available: true, reason: null },
    folders: [],
  };
}

describe("managed console intents", () => {
  it("givenEveryIntentKind_whenRouting_thenOpensAManagerWithoutConsoleText", () => {
    const actionIds = new Set(ALL_ACTIONS.map((action) => action.id));
    expect(actionIds.has(MANAGED_INTENT_ACTION_ID)).toBe(true);
    for (const kind of MANAGED_INTENT_KINDS) {
      const route = managedIntentRoute(`${MANAGED_INTENT_INSPECTION_PREFIX}${kind}`, "kv");
      expect(route?.kind).toBe(kind);
      expect(actionIds.has(route!.actionId)).toBe(true);
      expect(route!.args).toMatchObject({ datasourceId: "kv" });
      expect(Object.keys(route!.args).every((key) => ["datasourceId", "view"].includes(key))).toBe(true);
    }
    expect(managedIntentRoute(`${MANAGED_INTENT_INSPECTION_PREFIX}watch`, "kv")?.actionId).toBe(WATCH_ACTION_IDS.start);
    expect(managedIntentRoute(`${MANAGED_INTENT_INSPECTION_PREFIX}snapshot`, "kv")?.args).toMatchObject({
      view: "maintenance",
    });
  });

  it("givenOtherInspections_whenRouting_thenNotManaged", () => {
    expect(managedIntentOf("costly")).toBeNull();
    expect(managedIntentOf(`${MANAGED_INTENT_INSPECTION_PREFIX}unknown`)).toBeNull();
    expect(managedIntentRoute("EtcdConsoleIntentwatch", "kv")).toBeNull();
  });
});

describe("key admin shell integration", () => {
  it("givenWatchAndServices_whenResolvingRailActions_thenKeepDistinctNamesAndGlyphs", () => {
    const watch = ALL_ACTIONS.find((action) => action.id === WATCH_ACTION_IDS.toggle)!;
    const services = ALL_ACTIONS.find((action) => action.id === ACTION_IDS.toggleServices)!;
    expect(watch).toMatchObject({ title: "Watch", icon: "watch" });
    expect(services).toMatchObject({ title: "Services", icon: "services" });
    expect(ACTION_ICONS[watch.icon!]).not.toBe(ACTION_ICONS[services.icon!]);
    expect(ALL_ACTIONS.find((action) => action.id === WATCH_ACTION_IDS.start)?.icon).toBe("watch");
  });

  it("givenLeaseEditorAndTxnActions_whenRegistering_thenEveryIdIsInTheRegistry", () => {
    const ids = new Set(ALL_ACTIONS.map((action) => action.id));
    for (const id of [...Object.values(KEY_LEASE_EDITOR_IDS), ...Object.values(COMMAND_TXN_ACTION_IDS)])
      expect(ids.has(id)).toBe(true);
    expect(ids.size).toBe(ALL_ACTIONS.length);
  });

  it("givenLeaseRequestedTwice_whenSelecting_thenFocusAdvancesSoTheViewReselects", async () => {
    const store = createAdminStore(() => Promise.resolve(client(() => Promise.resolve([]))));
    await store.getState().open("tab", "kv", "leases");
    store.getState().selectLease("tab", "7");
    store.getState().selectLease("tab", "7");
    expect(store.getState().tabs.tab).toMatchObject({ leaseId: "7", leaseFocus: 2 });
  });

  it("givenRetainedWatch_whenExporting_thenUsesTheGrantAndSaysSavedOnlyWhenCompleted", async () => {
    const calls: [string, unknown][] = [];
    let listed = task("running", "1");
    const store = createWatchStore(() =>
      Promise.resolve(
        client(async (method, params) => {
          await Promise.resolve();
          calls.push([method, params]);
          if (method === "watch.start") return summary;
          if (method === "watch.window")
            return {
              watchId: "watch-1",
              rows: [],
              oldestSequence: null,
              newestSequence: null,
              evictedEvents: "0",
              state: "live",
              completedRevision: null,
              gap: null,
            };
          if (method === "watch.exportStart") return task("running");
          if (method === "watch.exportList") return [listed];
          return null;
        }),
      ),
    );
    await store.getState().start("kv", summary.request);
    await store.getState().exportStart("watch-1", "grant-1");
    expect(calls).toContainEqual(["watch.exportStart", { watchId: "watch-1", fileGrantId: "grant-1" }]);
    expect(exportRunning(store.getState().exports["watch-1"])).toBe(true);
    await expect(store.getState().exportStart("watch-1", "grant-2")).rejects.toThrow(/already being exported/);

    await store.getState().exportPoll();
    expect(exportStatusText(store.getState().exports["watch-1"]!)).not.toMatch(/Saved/);
    listed = task("completed", "3");
    await store.getState().exportPoll();
    expect(exportStatusText(store.getState().exports["watch-1"]!)).toMatch(/^Saved 3/);

    const before = calls.length;
    await store.getState().exportPoll();
    expect(calls.length).toBe(before);
  });

  it("givenRunningExport_whenDisconnected_thenOutcomeIsUncertainNotSaved", async () => {
    const store = createWatchStore(() =>
      Promise.resolve(
        client(async (method) => {
          await Promise.resolve();
          if (method === "watch.start") return summary;
          if (method === "watch.exportStart") return task("running");
          if (method === "watch.window")
            return {
              watchId: "watch-1",
              rows: [],
              oldestSequence: null,
              newestSequence: null,
              evictedEvents: "0",
              state: "live",
              completedRevision: null,
              gap: null,
            };
          return null;
        }),
      ),
    );
    await store.getState().start("kv", summary.request);
    await store.getState().exportStart("watch-1", "grant-1");
    store.getState().detach("kv");
    const exported = store.getState().exports["watch-1"]!;
    expect(exported).toMatchObject({ state: "failed", outcome: "uncertain" });
    expect(exportStatusText(exported)).not.toMatch(/Saved/);
  });

  it("givenTxnDrafts_whenConsoleClosesOrPluginGoes_thenDraftForgottenAndProbeRepeated", async () => {
    const datasources = createDatasourcesStore({
      connectEngine: () => Promise.resolve({ status: "connected", client: client(() => Promise.resolve(null)) }),
      disconnectEngine: () => Promise.resolve(undefined),
      promptSecrets: () => Promise.resolve(null),
      rememberServer: () => Promise.resolve(),
    });
    datasources.getState().setPlugins([REDIS_PLUGIN]);
    datasources.getState().applyList(list());
    const consoles = createConsolesStore({ connect: (id) => datasources.getState().connect(id), now: () => 0 });
    const parse = vi.fn(() => Promise.resolve({ kind: "unparsed" as const, reason: "empty" }));
    const txn = createTransactionStore({
      snapshot: (id) => consoles.getState().consoles[id],
      parse,
      serialize: () => Promise.resolve({ text: "", operationCount: 0, operationLimit: null, errors: [] }),
      insert: () => undefined,
    });
    const off = followCommandTxn(datasources, consoles, txn);
    const session = { datasourceId: "kv", sql: "", selection: { from: 0, to: 0 } } as unknown as ConsoleSession;
    consoles.setState({ consoles: { c1: session } });
    txn.setState({ supported: { kv: true } });
    await txn.getState().toggle("c1");
    expect(txn.getState().drafts.c1).toBeDefined();

    await datasources.getState().disconnect("kv");
    expect(txn.getState().supported.kv).toBeUndefined();

    parse.mockClear();
    datasources.setState({
      connections: {
        ...datasources.getState().connections,
        kv: { status: "connected", error: null, serverVersion: null, serverBrand: null },
      },
    });
    await vi.waitFor(() => expect(parse).toHaveBeenCalled());

    consoles.setState({ consoles: {} });
    expect(txn.getState().drafts.c1).toBeUndefined();
    off();
  });
});
