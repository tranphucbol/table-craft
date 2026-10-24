import { bridge } from "@table-craft/desktop/renderer/bridge.js";
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
import {
  IMPORT_EVENT_TYPES,
  SCRIPT_EVENT_TYPES,
  type EngineEvent,
  type ImportEvent,
  type ScriptEvent,
} from "@table-craft/desktop/engine/protocol.js";
import { followObjectFeatures, useObjects, type ObjectsStore } from "@table-craft/desktop/renderer/state/objects.js";
import { useScripts, type ScriptsStore } from "@table-craft/desktop/renderer/state/scripts.js";
import { themeOf, useSettings, type SettingsStore } from "@table-craft/desktop/renderer/state/settings.js";
import { tablesOf, useTables, type TablesStore } from "@table-craft/desktop/renderer/state/tables.js";
import { useTabs, type TabsStore } from "@table-craft/desktop/renderer/state/tabs.js";

export interface WiredStores {
  readonly datasources: DatasourcesStore;
  readonly consoles: ConsolesStore;
  readonly tabs: TabsStore;
  readonly catalog?: CatalogStore;
  readonly tables?: TablesStore;
  readonly ddl?: DdlStore;
  readonly executions?: ExecutionsStore;
  readonly exports?: ExportsStore;
  readonly imports?: ImportsStore;
  readonly scripts?: ScriptsStore;
  readonly objects?: ObjectsStore;
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
  tables,
  ddl,
  executions,
  exports,
  imports,
  scripts,
  objects,
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
    catalog?.getState().clear(id);
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
    }
  });
  const offAttached = catalog === undefined ? () => undefined : followAttaches(datasources, catalog);
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
 * the current namespace, described (plan 005, decision 7).
 */
function followAttaches(datasources: DatasourcesStore, catalog: CatalogStore): () => void {
  return datasources.subscribe((state, previous) => {
    for (const [id, connection] of Object.entries(state.connections)) {
      if (connection.status !== "connected" || previous.connections[id]?.status === "connected") continue;
      const datasource = state.datasources.find((candidate) => candidate.id === id);
      if (datasource === undefined) continue;
      if (!capabilitiesOf(state.plugins, datasource.pluginId).includes("schemaTree")) continue;
      void catalog.getState().expandDatasource(id);
    }
  });
}

/** Loads the list and plugins from main and follows main's broadcasts; returns the unsubscribe. */
export function installDatasourceSync(onFirstList: () => void): () => void {
  const store = useDatasources.getState();
  const offWired = wireStores({
    datasources: useDatasources,
    consoles: useConsoles,
    tabs: useTabs,
    catalog: useCatalog,
    tables: useTables,
    ddl: useDdl,
    executions: useExecutions,
    exports: useExports,
    imports: useImports,
    scripts: useScripts,
    objects: useObjects,
  });
  const offChanged = bridge().onDatasourcesChanged((list) => useDatasources.getState().applyList(list));
  const offExited = bridge().onEngineExited((exited) => useDatasources.getState().engineExited(exited));
  void (async () => {
    const plugins = await bridge().listPlugins();
    if (plugins.ok) store.setPlugins(plugins.value);
    const list = await bridge().listDatasources();
    if (list.ok) useDatasources.getState().applyList(list.value);
    onFirstList();
  })();
  return () => {
    offWired();
    offChanged();
    offExited();
  };
}

const DARK_QUERY = "(prefers-color-scheme: dark)";
const MORE_CONTRAST_QUERY = "(prefers-contrast: more)";

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
 * every change, and whenever the OS's scheme or contrast preference changes, which a `"system"`
 * theme follows (plan 013 decision 8). Returns the unsubscribe.
 */
export function installAppearance(
  store: SettingsStore = useSettings,
  target: AppearanceTarget = { matchMedia: (query) => window.matchMedia(query), apply: applyAppearance },
): () => void {
  const dark = target.matchMedia(DARK_QUERY);
  const contrast = target.matchMedia(MORE_CONTRAST_QUERY);
  const readSystem = () =>
    store.getState().setSystem({ prefersDark: dark.matches, prefersMoreContrast: contrast.matches });
  const apply = () => {
    const state = store.getState();
    const { theme } = themeOf(state);
    target.apply(appearanceOf(state.settings, theme), theme.colorScheme);
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
  return () => {
    offStore();
    dark.removeEventListener("change", readSystem);
    contrast.removeEventListener("change", readSystem);
  };
}

/** Follows main's broadcasts of saved settings and reread themes; returns the unsubscribe. */
export function installSettingsSync(store: SettingsStore = useSettings): () => void {
  return bridge().onSettingsChanged((changed) => store.getState().changed(changed));
}
