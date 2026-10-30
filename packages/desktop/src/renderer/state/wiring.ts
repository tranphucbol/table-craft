import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { useWatch } from "@table-craft/desktop/renderer/watch/store.js";
import { useKeyAdmin } from "@table-craft/desktop/renderer/keyAdmin/store.js";
import { installDesktopAdminHost } from "@table-craft/desktop/renderer/keyAdmin/host.js";
import { useCommandTxn } from "@table-craft/desktop/renderer/console/transaction/store.js";
import { useCatalog, type CatalogStore } from "@table-craft/desktop/renderer/state/catalog.js";
import {
  consolesOf,
  fileSourceOf,
  useConsoles,
  type ConsolesStore,
} from "@table-craft/desktop/renderer/state/consoles.js";
import { ddlsOf, followRedescribes, useDdl, type DdlStore } from "@table-craft/desktop/renderer/state/ddl.js";
import {
  capabilitiesOf,
  useDatasources,
  type DatasourcesStore,
} from "@table-craft/desktop/renderer/state/datasources.js";
import { applyAppearance } from "@table-craft/desktop/renderer/appearance/apply.js";
import { appearanceOf } from "@table-craft/desktop/renderer/appearance/tokens.js";
import { useExecutions, type ExecutionsStore } from "@table-craft/desktop/renderer/state/executions.js";
import { useExports, type ExportsStore } from "@table-craft/desktop/renderer/state/exports.js";
import { useImports, type ImportsStore } from "@table-craft/desktop/renderer/state/imports.js";
import { useKeys, type KeysStore } from "@table-craft/desktop/renderer/state/keys.js";
import {
  IMPORT_EVENT_TYPES,
  SCRIPT_EVENT_TYPES,
  type EngineEvent,
  type ImportEvent,
  type ScriptEvent,
} from "@table-craft/desktop/engine/protocol.js";
import { followObjectFeatures, useObjects, type ObjectsStore } from "@table-craft/desktop/renderer/state/objects.js";
import { useScripts, type ScriptsStore } from "@table-craft/desktop/renderer/state/scripts.js";
import { serverTabOf, useServer, type ServerStore } from "@table-craft/desktop/renderer/state/server.js";
import { sessionsTabOf, useSessions, type SessionsStore } from "@table-craft/desktop/renderer/state/sessions.js";
import { keyTabsOf, useKeyTabs, type KeyTabsStore } from "@table-craft/desktop/renderer/state/keyTabs.js";
import { themeOf, useSettings, type SettingsStore } from "@table-craft/desktop/renderer/state/settings.js";
import { tablesOf, useTables, type TablesStore } from "@table-craft/desktop/renderer/state/tables.js";
import { useTabs, type TabsStore } from "@table-craft/desktop/renderer/state/tabs.js";

export interface WiredStores {
  readonly datasources: DatasourcesStore;
  readonly consoles: ConsolesStore;
  readonly tabs: TabsStore;
  readonly catalog?: CatalogStore;
  readonly keys?: KeysStore;
  readonly keyTabs?: KeyTabsStore;
  readonly tables?: TablesStore;
  readonly ddl?: DdlStore;
  readonly executions?: ExecutionsStore;
  readonly exports?: ExportsStore;
  readonly imports?: ImportsStore;
  readonly scripts?: ScriptsStore;
  readonly objects?: ObjectsStore;
  readonly sessions?: SessionsStore;
  readonly server?: ServerStore;
}

function isImportEvent(event: EngineEvent): event is ImportEvent {
  return (IMPORT_EVENT_TYPES as readonly string[]).includes(event.type);
}

function isScriptEvent(event: EngineEvent): event is ScriptEvent {
  return (SCRIPT_EVENT_TYPES as readonly string[]).includes(event.type);
}

/**
 * What one store's change means for the others: a datasource whose engine went away leaves its
 * consoles and tables disconnected and its catalog forgotten, a deleted one takes its tabs with it,
 * a namespace described anew refreshes the DDL tabs showing its relations, and a closed tab's
 * executions leave Services with it; engine events reach the exports, imports and scripts lists.
 */
export function wireStores({
  datasources,
  consoles,
  tabs,
  catalog,
  keys,
  keyTabs,
  tables,
  ddl,
  executions,
  exports,
  imports,
  scripts,
  objects,
  sessions,
  server,
}: WiredStores): () => void {
  const offEvents = datasources.onEngineEvent((id, event) => {
    if (isImportEvent(event)) imports?.getState().received(id, event);
    else if (isScriptEvent(event)) scripts?.getState().received(id, event);
    else exports?.getState().received(id, event);
  });
  const offDetached = datasources.onDetached((id, error) => {
    exports?.getState().detached(id, error);
    imports?.getState().detached(id, error);
    scripts?.getState().detached(id, error);
    consoles.getState().detach(id, error);
    tables?.getState().detach(id, error);
    keyTabs?.getState().detach(id, error);
    catalog?.getState().clear(id);
    keys?.getState().clear(id);
  });
  const offRemoved = datasources.onRemoved((ids) => {
    for (const id of ids) {
      for (const consoleId of consolesOf(consoles.getState().consoles, id)) {
        if (fileSourceOf(consoles.getState().consoles[consoleId]) !== null) {
          consoles.getState().release(consoleId);
          continue;
        }
        tabs.getState().close(consoleId);
        consoles.getState().close(consoleId);
      }
      for (const tableId of tables === undefined ? [] : tablesOf(tables.getState().tables, id)) {
        tabs.getState().close(tableId);
        tables?.getState().close(tableId);
      }
      for (const ddlId of ddl === undefined ? [] : ddlsOf(ddl.getState().ddls, id)) {
        tabs.getState().close(ddlId);
        ddl?.getState().close(ddlId);
      }
      for (const keyId of keyTabs === undefined ? [] : keyTabsOf(keyTabs.getState().tabs, id)) {
        tabs.getState().close(keyId);
        keyTabs?.getState().close(keyId);
      }
      const sessionsId = sessions === undefined ? null : sessionsTabOf(sessions.getState().tabs, id);
      if (sessionsId !== null) {
        tabs.getState().close(sessionsId);
        sessions?.getState().close(sessionsId);
      }
      const serverId = server === undefined ? null : serverTabOf(server.getState().tabs, id);
      if (serverId !== null) {
        tabs.getState().close(serverId);
        server?.getState().close(serverId);
      }
    }
  });
  const offAttached = catalog === undefined ? () => undefined : followAttaches(datasources, catalog, keys);
  const offRedescribes = catalog === undefined || ddl === undefined ? () => undefined : followRedescribes(ddl, catalog);
  const offClosed = executions === undefined ? () => undefined : dropClosedExecutions(tabs, executions);
  const offFeatures = objects === undefined ? () => undefined : followObjectFeatures(datasources, objects);
  return () => {
    offFeatures();
    offEvents();
    offDetached();
    offRemoved();
    offAttached();
    offRedescribes();
    offClosed();
  };
}

/** Services lists open tabs only: a tab leaving the strip takes its executions (plan 011, decision 11). */
export function dropClosedExecutions(tabs: TabsStore, executions: ExecutionsStore): () => void {
  return tabs.subscribe((state, previous) => {
    if (state.tabs === previous.tabs) return;
    const open = new Set(state.tabs.map((tab) => tab.id));
    for (const tab of previous.tabs) if (!open.has(tab.id)) executions.getState().drop(tab.id);
  });
}

/**
 * However a datasource got connected (a console, Connect, expanding its node), its tree opens on
 * the current namespace, described (plan 005, decision 7), or on the configured database's keys.
 */
function followAttaches(datasources: DatasourcesStore, catalog: CatalogStore, keys?: KeysStore): () => void {
  return datasources.subscribe((state, previous) => {
    for (const [id, connection] of Object.entries(state.connections)) {
      if (connection.status !== "connected" || previous.connections[id]?.status === "connected") continue;
      const datasource = state.datasources.find((candidate) => candidate.id === id);
      if (datasource === undefined) continue;
      const capabilities = capabilitiesOf(state.plugins, datasource.pluginId);
      if (capabilities.includes("keyValue")) void keys?.getState().expandDatasource(id);
      if (!capabilities.includes("schemaTree")) continue;
      void catalog.getState().expandDatasource(id);
    }
  });
}

type CommandTxnStore = typeof useCommandTxn;

/**
 * A closed console drops its transaction draft; a datasource whose engine went away or whose
 * plugins were replaced is probed again on its next connect, because the probe answer belongs to
 * the plugin that gave it.
 */
export function followCommandTxn(
  datasources: DatasourcesStore,
  consoles: ConsolesStore,
  txn: CommandTxnStore,
): () => void {
  const offConsoles = consoles.subscribe((state, previous) => {
    if (state.consoles === previous.consoles) return;
    for (const id of Object.keys(previous.consoles)) if (!(id in state.consoles)) txn.getState().forget(id);
  });
  const offDetached = datasources.onDetached((id) => txn.getState().invalidate(id));
  const offSources = datasources.subscribe((state, previous) => {
    if (state.plugins !== previous.plugins) txn.getState().invalidate();
    for (const [id, connection] of Object.entries(state.connections)) {
      if (connection.status !== "connected" || previous.connections[id]?.status === "connected") continue;
      if (txn.getState().supported[id] !== undefined) continue;
      const source = state.datasources.find((candidate) => candidate.id === id);
      if (source === undefined || !capabilitiesOf(state.plugins, source.pluginId).includes("commands")) continue;
      if (consolesOf(consoles.getState().consoles, id).length !== 0) void txn.getState().probe(id);
    }
  });
  return () => {
    offConsoles();
    offDetached();
    offSources();
  };
}

/** Loads the list and plugins from main and follows main's broadcasts; returns the unsubscribe. */
export function installDatasourceSync(onFirstList: () => void): () => void {
  const offAdminHost = installDesktopAdminHost();
  const offCommandTxn = followCommandTxn(useDatasources, useConsoles, useCommandTxn);
  const offAdvancedDetached = useDatasources.onDetached((id) => {
    useWatch.getState().detach(id);
    useKeyAdmin.getState().detach(id);
  });
  const offAdvancedRemoved = useDatasources.onRemoved((ids) => {
    for (const id of ids) {
      useWatch.getState().detach(id);
      useKeyAdmin.getState().detach(id);
      for (const [tabId, tab] of Object.entries(useKeyAdmin.getState().tabs))
        if (tab.datasourceId === id) {
          useTabs.getState().close(tabId);
          useKeyAdmin.getState().close(tabId);
        }
    }
  });
  let advancedTick = 0;
  const advancedTimer = setInterval(() => {
    advancedTick++;
    for (const [id, entry] of Object.entries(useWatch.getState().entries))
      if (entry.summary.state !== "stopped") void useWatch.getState().poll(id);
    void useWatch.getState().exportPoll();
    for (const [id, connection] of Object.entries(useDatasources.getState().connections)) {
      if (connection.status !== "connected") continue;
      const source = useDatasources.getState().datasources.find((source) => source.id === id);
      const caps = capabilitiesOf(useDatasources.getState().plugins, source?.pluginId ?? "");
      if (advancedTick % CLUSTER_REFRESH_TICKS === 0 && (caps.includes("members") || caps.includes("maintenance")))
        void useKeyAdmin.getState().refresh(id, "members");
      if (caps.includes("bulkTransfer") || caps.includes("maintenance")) void useKeyAdmin.getState().tasks(id);
      void useKeyAdmin.getState().pollQueues(id);
    }
  }, ADVANCED_POLL_MS);
  const store = useDatasources.getState();
  const offWired = wireStores({
    datasources: useDatasources,
    consoles: useConsoles,
    tabs: useTabs,
    catalog: useCatalog,
    keys: useKeys,
    keyTabs: useKeyTabs,
    tables: useTables,
    ddl: useDdl,
    sessions: useSessions,
    server: useServer,
    executions: useExecutions,
    exports: useExports,
    imports: useImports,
    scripts: useScripts,
    objects: useObjects,
  });
  const offChanged = bridge().onDatasourcesChanged((list) => useDatasources.getState().applyList(list));
  const offExited = bridge().onEngineExited((exited) => useDatasources.getState().engineExited(exited));
  const offPlugins = bridge().onPluginsChanged((state) => useDatasources.getState().applyPlugins(state));
  void (async () => {
    const plugins = await bridge().pluginsState();
    if (plugins.ok) store.applyPlugins(plugins.value);
    const list = await bridge().listDatasources();
    if (list.ok) useDatasources.getState().applyList(list.value);
    onFirstList();
  })();
  return () => {
    clearInterval(advancedTimer);
    offAdminHost();
    offCommandTxn();
    offAdvancedDetached();
    offAdvancedRemoved();
    offWired();
    offChanged();
    offExited();
    offPlugins();
  };
}

const ADVANCED_POLL_MS = 1_000;
const CLUSTER_REFRESH_TICKS = 5;

const DARK_QUERY = "(prefers-color-scheme: dark)";
const MORE_CONTRAST_QUERY = "(prefers-contrast: more)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** The part of a `MediaQueryList` the appearance follows. */
export interface MediaQuery {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

export interface AppearanceTarget {
  readonly matchMedia: (query: string) => MediaQuery;
  readonly apply: typeof applyAppearance;
}

/**
 * Keeps the window's look in step with the settings (decision 032): applies them now, again on
 * every change, and whenever the OS's scheme, contrast or motion preference changes, which a
 * `"system"` theme (plan 013 decision 8) and a `"system"` motion (plan 109) follow. Returns the unsubscribe.
 */
export function installAppearance(
  store: SettingsStore = useSettings,
  target: AppearanceTarget = { matchMedia: (query) => window.matchMedia(query), apply: applyAppearance },
): () => void {
  const dark = target.matchMedia(DARK_QUERY);
  const contrast = target.matchMedia(MORE_CONTRAST_QUERY);
  const reducedMotion = target.matchMedia(REDUCED_MOTION_QUERY);
  const readSystem = () =>
    store.getState().setSystem({
      prefersDark: dark.matches,
      prefersMoreContrast: contrast.matches,
      prefersReducedMotion: reducedMotion.matches,
    });
  const apply = () => {
    const state = store.getState();
    const { theme } = themeOf(state);
    target.apply(appearanceOf(state.settings, theme, state.system), theme.colorScheme);
  };
  readSystem();
  apply();
  const offStore = store.subscribe((state, previous) => {
    if (
      state.settings !== previous.settings ||
      state.system !== previous.system ||
      state.themes !== previous.themes ||
      state.previewTheme !== previous.previewTheme
    ) {
      apply();
    }
  });
  dark.addEventListener("change", readSystem);
  contrast.addEventListener("change", readSystem);
  reducedMotion.addEventListener("change", readSystem);
  return () => {
    offStore();
    dark.removeEventListener("change", readSystem);
    contrast.removeEventListener("change", readSystem);
    reducedMotion.removeEventListener("change", readSystem);
  };
}

/** Follows main's broadcasts of saved settings and reread themes; returns the unsubscribe. */
export function installSettingsSync(store: SettingsStore = useSettings): () => void {
  return bridge().onSettingsChanged((changed) => store.getState().changed(changed));
}
