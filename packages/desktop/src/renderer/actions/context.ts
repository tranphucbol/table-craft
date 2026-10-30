import type { Capability } from "@table-craft/desktop/engine/protocol.js";
import { useKeyAdmin } from "@table-craft/desktop/renderer/keyAdmin/store.js";
import { useWatch } from "@table-craft/desktop/renderer/watch/store.js";
import { useAdminSecret } from "@table-craft/desktop/renderer/keyAdmin/SecretPrompt.js";
import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import {
  activeResultOf,
  useConsoles,
  type ConsoleSession,
  type ResultTab,
} from "@table-craft/desktop/renderer/state/consoles.js";
import { useDdl, type DdlTab } from "@table-craft/desktop/renderer/state/ddl.js";
import { useDataSourcesDialog } from "@table-craft/desktop/renderer/state/dataSourcesDialog.js";
import { useImportDataSourcesDialog } from "@table-craft/desktop/renderer/state/importDataSourcesDialog.js";
import { useManageShownSchemasDialog } from "@table-craft/desktop/renderer/state/manageShownSchemasDialog.js";
import { useSettingsDialog } from "@table-craft/desktop/renderer/state/settingsDialog.js";
import { useSnippetsDialog } from "@table-craft/desktop/renderer/state/snippetsDialog.js";
import {
  capabilitiesOf,
  connectionOf,
  datasourceById,
  selectedDatasourceId,
  useDatasources,
  type Connection,
  type TreeSelection,
} from "@table-craft/desktop/renderer/state/datasources.js";
import { useLayout, type ToolWindowId } from "@table-craft/desktop/renderer/state/layout.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { usePalette } from "@table-craft/desktop/renderer/state/palette.js";
import { useHostKeyPrompt } from "@table-craft/desktop/renderer/state/hostKeyPrompt.js";
import { useSecretPrompt } from "@table-craft/desktop/renderer/state/secretPrompt.js";
import { useKeyTabs, type KeyTab } from "@table-craft/desktop/renderer/state/keyTabs.js";
import { useServer, type ServerTab } from "@table-craft/desktop/renderer/state/server.js";
import { useSessions, type SessionsTab } from "@table-craft/desktop/renderer/state/sessions.js";
import { activeTab, useTabs, type Tab } from "@table-craft/desktop/renderer/state/tabs.js";
import { useTables, type TableSession } from "@table-craft/desktop/renderer/state/tables.js";
import { useWindowState } from "@table-craft/desktop/renderer/state/windowState.js";

/** The regions focus can be in; each is a `data-region` attribute on its container. */
export type FocusRegion =
  "editor" | "tableEditor" | "grid" | "gridFind" | "valuePanel" | "database" | "services" | "log" | "watch" | "other";

const REGIONS: readonly FocusRegion[] = [
  "editor",
  "tableEditor",
  "grid",
  "gridFind",
  "valuePanel",
  "database",
  "services",
  "log",
  "watch",
];

export const REGION_ATTRIBUTE = "data-region";

/** A datasource with what the window knows of it now. */
export interface DatasourceTarget {
  readonly view: DatasourceView;
  readonly connection: Connection;
  readonly capabilities: readonly Capability[];
}

/** A plain snapshot of the stores, taken at invoke time. Actions read this, never components. */
export interface ActionContext {
  readonly tabs: readonly Tab[];
  readonly activeTab: Tab | null;
  /** The active tab's console, when the active tab is one. */
  readonly console: ConsoleSession | null;
  /** The active tab's table, when the active tab shows one in the data editor. */
  readonly table: TableSession | null;
  /** The active tab's relation definition, when the active tab is a DDL tab. */
  readonly ddl: DdlTab | null;
  /** The active tab's server sessions, when the active tab is a Sessions tab. */
  readonly sessions: SessionsTab | null;
  /** The active tab's key, when the active tab is a key tab (plan 058). */
  readonly keyTab: KeyTab | null;
  /** The active tab's server figures, when the active tab is a Server tab (plan 058). */
  readonly serverTab: ServerTab | null;
  /** The grid's result: the active console's shown result tab, or the active table's or key's rows. */
  readonly result: ResultTab | null;
  readonly datasources: readonly DatasourceView[];
  readonly selection: TreeSelection | null;
  /**
   * What "the datasource" means to an action: the tree's selection while the Database pane has
   * focus, otherwise the active console's datasource, otherwise the tree's selection.
   */
  readonly datasource: DatasourceTarget | null;
  /** The active console's, table's, DDL or Sessions tab's datasource's capabilities. */
  readonly capabilities: readonly Capability[];
  readonly focus: FocusRegion;
  /** Focus is in the Database pane, or was when a menu or dialog took it: `datasource` is the tree's. */
  readonly inDatabasePane: boolean;
  readonly toolWindows: Readonly<Record<ToolWindowId, boolean>>;
  /** The palette or any dialog is open; it owns the keyboard. */
  readonly paletteOpen: boolean;
  /** The Database pane's speed search field is open; Escape closes it rather than leaving the pane. */
  readonly speedSearching: boolean;
  /** The main toolbar is the window's title bar (decision 034), rather than the system's. */
  readonly customTitleBar: boolean;
}

function regionOf(element: Element | null | undefined): FocusRegion {
  const region = element?.closest(`[${REGION_ATTRIBUTE}]`)?.getAttribute(REGION_ATTRIBUTE);
  return REGIONS.find((candidate) => candidate === region) ?? "other";
}

export function focusedRegion(): FocusRegion {
  return regionOf(document.activeElement);
}

/** The last region focus was in before a menu, dialog or the palette took it. */
let lastRegion: FocusRegion = "editor";

/** Remembers the last real region, so a context menu opened on the tree still means the tree. */
export function trackFocus(target: Pick<Document, "addEventListener" | "removeEventListener">): () => void {
  const listener = (event: FocusEvent) => {
    const region = regionOf(event.target instanceof Element ? event.target : null);
    if (region !== "other") lastRegion = region;
  };
  target.addEventListener("focusin", listener);
  return () => target.removeEventListener("focusin", listener);
}

/** Whether something modal holds the keyboard: the palette, a dialog or a prompt. */
export function modalOpen(): boolean {
  return (
    usePalette.getState().mode !== null ||
    useDataSourcesDialog.getState().target !== null ||
    useImportDataSourcesDialog.getState().session !== null ||
    useManageShownSchemasDialog.getState().datasourceId !== null ||
    useSettingsDialog.getState().page !== null ||
    useSnippetsDialog.getState().open ||
    useSecretPrompt.getState().pending !== null ||
    useHostKeyPrompt.getState().queue.length > 0 ||
    useModal.getState().pending !== null ||
    useAdminSecret.getState().pending !== null
  );
}

export function currentContext(tabId?: string): ActionContext {
  const strip = useTabs.getState();
  const active = tabId === undefined ? activeTab(strip) : (strip.tabs.find((tab) => tab.id === tabId) ?? null);
  const { consoles } = useConsoles.getState();
  const datasources = useDatasources.getState();
  const console = active?.kind === "console" ? (consoles[active.id] ?? null) : null;
  const table = active?.kind === "table" ? (useTables.getState().tables[active.id] ?? null) : null;
  const ddl = active?.kind === "ddl" ? (useDdl.getState().ddls[active.id] ?? null) : null;
  const sessions = active?.kind === "sessions" ? (useSessions.getState().tabs[active.id] ?? null) : null;
  const keyTab = active?.kind === "key" ? (useKeyTabs.getState().tabs[active.id] ?? null) : null;
  const serverTab = active?.kind === "server" ? (useServer.getState().tabs[active.id] ?? null) : null;
  const tabDatasourceId =
    console?.datasourceId ??
    table?.datasourceId ??
    ddl?.datasourceId ??
    sessions?.datasourceId ??
    keyTab?.datasourceId ??
    serverTab?.datasourceId ??
    (active === null ? undefined : useKeyAdmin.getState().tabs[active.id]?.datasourceId);
  const focus = focusedRegion();
  const selected = selectedDatasourceId(datasources.selection);
  const inTree = tabId === undefined && (focus === "database" || (focus === "other" && lastRegion === "database"));
  const watchState = useWatch.getState();
  const watchSource =
    focus === "watch" && watchState.activeId !== null
      ? watchState.entries[watchState.activeId]?.datasourceId
      : undefined;
  const targetId = inTree ? selected : (watchSource ?? tabDatasourceId ?? selected);
  const target = datasourceById(datasources, targetId);
  return {
    tabs: strip.tabs,
    activeTab: active,
    console,
    table,
    ddl,
    sessions,
    keyTab,
    serverTab,
    result: console === null ? (table?.result ?? keyTab?.result ?? null) : (activeResultOf(console) ?? null),
    datasources: datasources.datasources,
    selection: datasources.selection,
    datasource:
      target === undefined
        ? null
        : {
            view: target,
            connection: connectionOf(datasources, target.id),
            capabilities: capabilitiesOf(datasources.plugins, target.pluginId),
          },
    capabilities:
      tabDatasourceId === undefined
        ? []
        : capabilitiesOf(datasources.plugins, datasourceById(datasources, tabDatasourceId)?.pluginId ?? ""),
    focus,
    inDatabasePane: inTree,
    toolWindows: useLayout.getState().layout.visible,
    paletteOpen: modalOpen(),
    speedSearching: useCatalog.getState().speedSearch !== null,
    customTitleBar: useWindowState.getState().customTitleBar,
  };
}
