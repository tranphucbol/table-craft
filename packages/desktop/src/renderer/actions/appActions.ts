import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import {
  closeTabs,
  disconnectDatasource,
  openConsole,
  settleTransactions,
} from "@table-craft/desktop/renderer/actions/consoleCommands.js";
import {
  askMoveToFolder,
  askNewFolder,
  deleteDatasource,
} from "@table-craft/desktop/renderer/actions/datasourceCommands.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { focusRegion } from "@table-craft/desktop/renderer/shell/focus.js";
import { canRun, OUTPUT_TAB, useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { useDataSourcesDialog } from "@table-craft/desktop/renderer/state/dataSourcesDialog.js";
import { useImportDataSourcesDialog } from "@table-craft/desktop/renderer/state/importDataSourcesDialog.js";
import { pluginOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { useLayout, type ToolWindowId } from "@table-craft/desktop/renderer/state/layout.js";
import { usePalette } from "@table-craft/desktop/renderer/state/palette.js";
import { useTabs } from "@table-craft/desktop/renderer/state/tabs.js";

/** Action ids other modules name: the menu declaration, toolbar buttons, the palette. */
export const ACTION_IDS = {
  run: "console.run",
  runAll: "console.runAll",
  reformat: "console.reformat",
  cancel: "console.cancel",
  commit: "transaction.commit",
  rollback: "transaction.rollback",
  toggleTransactionMode: "transaction.toggleMode",
  pinResult: "result.pin",
  newConsole: "console.new",
  closeTab: "tab.close",
  closeOtherTabs: "tab.closeOthers",
  closeAllTabs: "tab.closeAll",
  nextTab: "tab.next",
  previousTab: "tab.previous",
  toggleDatabase: "toolWindow.database.toggle",
  toggleServices: "toolWindow.services.toggle",
  toggleLog: "toolWindow.log.toggle",
  hideAllToolWindows: "toolWindow.hideAll",
  focusEditor: "focus.editor",
  findAction: "palette.findAction",
  searchEverywhere: "palette.searchEverywhere",
  newDatasource: "datasource.new",
  importDatasources: "datasource.import",
  datasourceProperties: "datasource.properties",
  duplicateDatasource: "datasource.duplicate",
  copyDatasourceUrl: "datasource.copyUrl",
  deleteDatasource: "datasource.delete",
  connect: "datasource.connect",
  disconnect: "datasource.disconnect",
  newFolder: "datasource.newFolder",
  moveToFolder: "datasource.moveToFolder",
  synchronize: "database.synchronize",
  collapseAll: "explorer.collapseAll",
  toggleSystemSchemas: "explorer.toggleSystemSchemas",
  copyName: "explorer.copyName",
  reveal: "explorer.reveal",
} as const;

/** Names a tab when an action runs on one other than the active tab, as the tab menu does. */
export interface TabArgs {
  readonly tabId?: string;
}

/** Names a result tab when an action runs on one other than the active one, as its context menu does. */
export interface ResultArgs {
  readonly resultId?: string;
}

function targetTab(context: ActionContext, args: TabArgs | undefined): string | null {
  return args?.tabId ?? context.activeTab?.id ?? null;
}

function toggleToolWindow(id: ToolWindowId, context: ActionContext): void {
  const wasFocused = context.focus === id;
  useLayout.getState().toggle(id);
  if (wasFocused) focusRegion("editor");
}

const inToolWindow = (context: ActionContext) =>
  context.focus === "database" || context.focus === "services" || context.focus === "log";
const hasTabs = (context: ActionContext) => context.tabs.length > 0;
const hasDatasource = (context: ActionContext) => context.datasource !== null;
const isSaved = (context: ActionContext) => context.datasource !== null && !context.datasource.view.ephemeral;
/** Saved, and its plugin reads connection URLs (decision 055). */
const hasUrl = (context: ActionContext) =>
  isSaved(context) &&
  (pluginOf(useDatasources.getState().plugins, context.datasource?.view.pluginId ?? "")?.url ?? null) !== null;
const isLive = (context: ActionContext) =>
  context.datasource?.connection.status === "connected" || context.datasource?.connection.status === "connecting";

/** The folder New Folder and New Data Source put things in: the selected one, or the selected datasource's. */
function selectedFolder(context: ActionContext): string | null {
  if (context.selection?.kind === "folder") return context.selection.path;
  return context.focus === "database" ? (context.datasource?.view.folder ?? null) : null;
}
const hasSeveralTabs = (context: ActionContext) => context.tabs.length > 1;
const canRunConsole = (context: ActionContext) => context.console !== null && canRun(context.console.status);
const hasTransactionsCapability = (context: ActionContext) => context.capabilities.includes("transactions");
const hasTransactions = (context: ActionContext) => context.console !== null && hasTransactionsCapability(context);
/** Commit and Rollback are offered only while a transaction is open (decision 14). */
const canEndTransaction = (context: ActionContext) =>
  hasTransactions(context) && context.console?.transactionOpen === true && context.console.status === "ready";

function runActive(context: ActionContext, scope: "caret" | "all"): void {
  if (context.activeTab !== null) void useConsoles.getState().run(context.activeTab.id, scope);
}

/** Switches the console between Auto and Manual; leaving Manual with a transaction open asks first. */
async function toggleTransactionMode(consoleId: string): Promise<void> {
  const session = useConsoles.getState().consoles[consoleId];
  if (session === undefined) return;
  const mode = session.txMode === "auto" ? "manual" : "auto";
  if (mode === "auto" && !(await settleTransactions([consoleId], "switch to Auto"))) return;
  await useConsoles.getState().setTransactionMode(consoleId, mode);
}

export const APP_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: ACTION_IDS.run,
    title: "Run",
    category: "Console",
    icon: "run",
    shortcut: "Mod+Enter",
    tabKind: "console",
    when: canRunConsole,
    run: (context) => runActive(context, "caret"),
  }),
  defineAction({
    id: ACTION_IDS.runAll,
    title: "Run All",
    category: "Console",
    icon: "runAll",
    shortcut: "Mod+Shift+Enter",
    when: canRunConsole,
    run: (context) => runActive(context, "all"),
  }),
  defineAction({
    id: ACTION_IDS.reformat,
    title: "Reformat Code",
    category: "Console",
    shortcut: "Mod+Alt+L",
    tabKind: "console",
    available: (context) => context.capabilities.includes("sql"),
    when: (context) => context.console !== null,
    run: async (context) => {
      if (context.activeTab !== null) await useConsoles.getState().reformat(context.activeTab.id);
    },
  }),
  defineAction({
    id: ACTION_IDS.commit,
    title: "Commit",
    category: "Console",
    icon: "commit",
    shortcut: "Mod+Alt+Shift+Enter",
    available: hasTransactionsCapability,
    when: canEndTransaction,
    run: async (context) => {
      if (context.activeTab !== null) await useConsoles.getState().commit(context.activeTab.id);
    },
  }),
  defineAction({
    id: ACTION_IDS.rollback,
    title: "Rollback",
    category: "Console",
    icon: "rollback",
    available: hasTransactionsCapability,
    when: canEndTransaction,
    run: async (context) => {
      if (context.activeTab !== null) await useConsoles.getState().rollback(context.activeTab.id);
    },
  }),
  defineAction({
    id: ACTION_IDS.toggleTransactionMode,
    title: "Toggle Transaction Mode (Auto/Manual)",
    category: "Console",
    when: (context) =>
      hasTransactions(context) && context.console?.status !== "running" && context.console?.status !== "confirming",
    run: async (context) => {
      if (context.activeTab !== null) await toggleTransactionMode(context.activeTab.id);
    },
  }),
  defineAction<ResultArgs | undefined>({
    id: ACTION_IDS.pinResult,
    title: "Pin Result Tab",
    category: "Console",
    icon: "pin",
    when: (context) => context.console !== null && context.console.activeResult !== OUTPUT_TAB,
    run: (context, args) => {
      const id = context.activeTab?.id;
      const resultId = args?.resultId ?? context.console?.activeResult;
      if (id !== undefined && resultId !== undefined) useConsoles.getState().togglePin(id, resultId);
    },
  }),
  defineAction({
    id: ACTION_IDS.cancel,
    title: "Cancel",
    category: "Console",
    icon: "cancel",
    available: (context) => context.capabilities.includes("cancel"),
    when: (context) =>
      (context.console?.status === "running" || context.console?.question != null) &&
      context.capabilities.includes("cancel"),
    run: (context) => {
      if (context.activeTab !== null) void useConsoles.getState().cancel(context.activeTab.id);
    },
  }),
  defineAction({
    id: ACTION_IDS.newConsole,
    title: "New Console",
    category: "Console",
    icon: "newConsole",
    shortcut: "Mod+Shift+L",
    when: hasDatasource,
    run: async (context) => {
      if (context.datasource !== null) await openConsole(context.datasource.view.id);
    },
  }),
  defineAction<TabArgs | undefined>({
    id: ACTION_IDS.closeTab,
    title: "Close Tab",
    category: "Editor Tabs",
    icon: "close",
    shortcut: "Mod+W",
    when: hasTabs,
    run: async (context, args) => {
      const id = targetTab(context, args);
      if (id !== null) await closeTabs([id], () => useTabs.getState().close(id));
    },
  }),
  defineAction<TabArgs | undefined>({
    id: ACTION_IDS.closeOtherTabs,
    title: "Close Other Tabs",
    category: "Editor Tabs",
    when: hasSeveralTabs,
    run: async (context, args) => {
      const id = targetTab(context, args);
      if (id === null) return;
      const others = context.tabs.filter((tab) => tab.id !== id).map((tab) => tab.id);
      await closeTabs(others, () => useTabs.getState().closeOthers(id));
    },
  }),
  defineAction({
    id: ACTION_IDS.closeAllTabs,
    title: "Close All Tabs",
    category: "Editor Tabs",
    when: hasTabs,
    run: async (context) => {
      await closeTabs(
        context.tabs.map((tab) => tab.id),
        () => useTabs.getState().closeAll(),
      );
    },
  }),
  defineAction({
    id: ACTION_IDS.nextTab,
    title: "Select Next Tab",
    category: "Editor Tabs",
    shortcut: "Mod+Shift+]",
    when: hasSeveralTabs,
    run: () => useTabs.getState().cycle(1),
  }),
  defineAction({
    id: ACTION_IDS.previousTab,
    title: "Select Previous Tab",
    category: "Editor Tabs",
    shortcut: "Mod+Shift+[",
    when: hasSeveralTabs,
    run: () => useTabs.getState().cycle(-1),
  }),
  defineAction({
    id: ACTION_IDS.toggleDatabase,
    title: "Database",
    category: "Tool Windows",
    icon: "database",
    shortcut: "Mod+1",
    run: (context) => toggleToolWindow("database", context),
  }),
  defineAction({
    id: ACTION_IDS.toggleServices,
    title: "Services",
    category: "Tool Windows",
    icon: "services",
    shortcut: "Mod+8",
    run: (context) => toggleToolWindow("services", context),
  }),
  defineAction({
    id: ACTION_IDS.toggleLog,
    title: "Log",
    category: "Tool Windows",
    icon: "log",
    run: (context) => toggleToolWindow("log", context),
  }),
  defineAction({
    id: ACTION_IDS.hideAllToolWindows,
    title: "Hide All Tool Windows",
    category: "Tool Windows",
    shortcut: "Mod+Shift+F12",
    run: (context) => {
      const wasInToolWindow = inToolWindow(context);
      useLayout.getState().hideAll();
      if (wasInToolWindow) focusRegion("editor");
    },
  }),
  defineAction({
    id: ACTION_IDS.focusEditor,
    title: "Back to Editor",
    category: "Navigation",
    shortcut: "Escape",
    shortcutRegion: ["database", "services", "log"],
    when: (context) => inToolWindow(context) && !context.speedSearching,
    run: () => focusRegion("editor"),
  }),
  defineAction({
    id: ACTION_IDS.findAction,
    title: "Find Action…",
    category: "Navigation",
    icon: "search",
    shortcut: "Mod+Shift+A",
    run: () => usePalette.getState().show("findAction"),
  }),
  defineAction({
    id: ACTION_IDS.searchEverywhere,
    title: "Search Everywhere",
    category: "Navigation",
    icon: "search",
    shortcut: "Shift Shift",
    run: () => usePalette.getState().show("searchEverywhere"),
  }),
  defineAction({
    id: ACTION_IDS.newDatasource,
    title: "New Data Source…",
    category: "Database",
    icon: "add",
    shortcut: "Mod+N",
    shortcutRegion: "database",
    run: (context) =>
      useDataSourcesDialog.getState().show({ kind: "new", pluginId: null, folder: selectedFolder(context) ?? "" }),
  }),
  defineAction({
    id: ACTION_IDS.importDatasources,
    title: "Import Data Sources…",
    category: "Database",
    icon: "import",
    run: () => {
      useDataSourcesDialog.getState().hide();
      useImportDataSourcesDialog.getState().show();
    },
  }),
  defineAction({
    id: ACTION_IDS.datasourceProperties,
    title: "Data Source Properties…",
    category: "Database",
    icon: "properties",
    shortcut: "Mod+;",
    run: (context) => useDataSourcesDialog.getState().show({ kind: "edit", id: context.datasource?.view.id ?? null }),
  }),
  defineAction({
    id: ACTION_IDS.duplicateDatasource,
    title: "Duplicate Data Source",
    category: "Database",
    icon: "duplicate",
    shortcut: "Mod+D",
    shortcutRegion: "database",
    when: hasDatasource,
    run: (context) => {
      if (context.datasource !== null) {
        useDataSourcesDialog.getState().show({ kind: "duplicate", id: context.datasource.view.id });
      }
    },
  }),
  defineAction({
    id: ACTION_IDS.copyDatasourceUrl,
    title: "Copy as URL",
    category: "Database",
    icon: "copy",
    when: hasUrl,
    run: async (context) => {
      if (context.datasource === null) return;
      const answer = await bridge().datasourceUrl(context.datasource.view.id);
      if (answer.ok) await navigator.clipboard.writeText(answer.value);
      else {
        await useModal.getState().ask({
          kind: "notice",
          title: "Could not copy the URL",
          message: answer.error.message,
          hint: answer.error.hint,
        });
      }
    },
  }),
  defineAction({
    id: ACTION_IDS.deleteDatasource,
    title: "Delete Data Source",
    category: "Database",
    icon: "delete",
    shortcut: "Delete",
    shortcutRegion: "database",
    when: isSaved,
    run: async (context) => {
      if (context.datasource !== null) await deleteDatasource(context.datasource.view);
    },
  }),
  defineAction({
    id: ACTION_IDS.connect,
    title: "Connect",
    category: "Database",
    icon: "connect",
    when: (context) => hasDatasource(context) && !isLive(context),
    run: (context) => {
      if (context.datasource !== null) {
        // The tree and status bar show a failure; nothing else waits on it.
        useDatasources
          .getState()
          .connect(context.datasource.view.id)
          .catch(() => undefined);
      }
    },
  }),
  defineAction({
    id: ACTION_IDS.disconnect,
    title: "Disconnect",
    category: "Database",
    icon: "disconnect",
    shortcut: "Mod+F2",
    when: isLive,
    run: async (context) => {
      if (context.datasource !== null) await disconnectDatasource(context.datasource.view.id);
    },
  }),
  defineAction({
    id: ACTION_IDS.newFolder,
    title: "New Folder…",
    category: "Database",
    icon: "folder",
    run: (context) => askNewFolder(selectedFolder(context)),
  }),
  defineAction({
    id: ACTION_IDS.moveToFolder,
    title: "Move to Folder…",
    category: "Database",
    when: isSaved,
    run: async (context) => {
      if (context.datasource !== null) await askMoveToFolder(context.datasource.view);
    },
  }),
];
