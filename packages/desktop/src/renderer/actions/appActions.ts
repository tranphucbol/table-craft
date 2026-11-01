import { writeClipboard } from "@table-craft/desktop/renderer/state/clipboard.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { currentPlatform } from "@table-craft/desktop/renderer/actions/chords.js";
import {
  closeTabs,
  consoleFilePath,
  disconnectDatasource,
  duplicateConsole,
  openConsole,
  reopenClosedTab,
  revealConsoleFile,
  settleTransactions,
} from "@table-craft/desktop/renderer/actions/consoleCommands.js";
import {
  folderKeepingContent,
  type MoveRequest,
  type TreeItemRef,
} from "@table-craft/desktop/datasourceTree/arrange.js";
import {
  askMoveToFolder,
  askNewFolder,
  deleteItems,
  moveItems,
} from "@table-craft/desktop/renderer/actions/datasourceCommands.js";
import { arrangeTreeOf, stepRequest, type StepDirection } from "@table-craft/desktop/renderer/model/treeDrop.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { focusRegion } from "@table-craft/desktop/renderer/shell/focus.js";
import { canRun, OUTPUT_TAB, useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { useDataSourcesDialog } from "@table-craft/desktop/renderer/state/dataSourcesDialog.js";
import { useImportDataSourcesDialog } from "@table-craft/desktop/renderer/state/importDataSourcesDialog.js";
import { useManageShownSchemasDialog } from "@table-craft/desktop/renderer/state/manageShownSchemasDialog.js";
import { pluginOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { useLayout, type ToolWindowId } from "@table-craft/desktop/renderer/state/layout.js";
import { usePalette } from "@table-craft/desktop/renderer/state/palette.js";
import {
  groupOf,
  groupStrip,
  otherTabIds,
  rightTabIds,
  unpinnedTabIds,
  useTabs,
} from "@table-craft/desktop/renderer/state/tabs.js";

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
  closeTabsToRight: "tab.closeRight",
  togglePinTab: "tab.togglePin",
  reopenClosedTab: "tab.reopenClosed",
  duplicateTab: "tab.duplicate",
  splitLeft: "tab.splitLeft",
  splitRight: "tab.splitRight",
  unsplit: "tab.unsplit",
  copyTabPath: "tab.copyPath",
  revealTab: "tab.reveal",
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
  moveItems: "datasource.move",
  moveUp: "datasource.moveUp",
  moveDown: "datasource.moveDown",
  manageShownSchemas: "datasource.manageShownSchemas",
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
/** Saved, and its plugin lists namespaces for the tree (decision 007). */
const listsNamespaces = (context: ActionContext) =>
  isSaved(context) && context.datasource?.capabilities.includes("schemaTree") === true;
const isLive = (context: ActionContext) =>
  context.datasource?.connection.status === "connected" || context.datasource?.connection.status === "connecting";

function isEphemeral(context: ActionContext, item: TreeItemRef): boolean {
  return item.kind === "datasource" && context.datasources.some((view) => view.id === item.id && view.ephemeral);
}
/** Something selected, and none of it the datasource from the environment, which never moves (decision 018). */
const canMoveItems = (context: ActionContext) =>
  context.items.length > 0 && !context.items.some((item) => isEphemeral(context, item));
/** As `canMoveItems`, and no selected folder would keep something left out of the selection. */
const canDeleteItems = (context: ActionContext) =>
  canMoveItems(context) &&
  folderKeepingContent(
    arrangeTreeOf(context.datasources, context.folders),
    context.items.flatMap((item) => (item.kind === "datasource" ? [item.id] : [])),
    context.items.flatMap((item) => (item.kind === "folder" ? [item.path] : [])),
  ) === null;

function stepOf(context: ActionContext, direction: StepDirection): MoveRequest | null {
  if (!context.inDatabasePane || !canMoveItems(context)) return null;
  return stepRequest(arrangeTreeOf(context.datasources, context.folders), context.items, direction);
}

/** The folder New Folder and New Data Source put things in: the selected one, or the selected datasource's. */
function selectedFolder(context: ActionContext): string | null {
  if (context.selection?.kind === "folder") return context.selection.path;
  return context.focus === "database" ? (context.datasource?.view.folder ?? null) : null;
}
const hasSeveralTabs = (context: ActionContext) => context.tabs.length > 1;
const hasConsoleTab = (context: ActionContext) => context.tabs.some((tab) => tab.kind === "console");
const MAC_REVEAL_TITLE = "Reveal in Finder";
const OTHER_REVEAL_TITLE = "Show in Folder";

/** The file manager's own name for showing a file; the platform is read late, as tests load this without a window. */
function revealTitle(): string {
  return typeof navigator !== "undefined" && currentPlatform() === "mac" ? MAC_REVEAL_TITLE : OTHER_REVEAL_TITLE;
}

async function noticeTabFailure(title: string, cause: unknown): Promise<void> {
  await useModal.getState().ask({
    kind: "notice",
    title,
    message: cause instanceof Error ? cause.message : String(cause),
    hint: "Check that the profile directory is readable, then try again.",
  });
}
const canRunConsole = (context: ActionContext) => context.console !== null && canRun(context.console.status);
/** Asking about a failed statement waits on the user, not the server, so it is not busy (plan 112 decision 2). */
const consoleBusy = (context: ActionContext) =>
  context.console?.status === "running" && context.console.question === null;
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
  ...(["left", "right"] as const).map((side) =>
    defineAction<TabArgs | undefined>({
      id: side === "left" ? ACTION_IDS.splitLeft : ACTION_IDS.splitRight,
      title: side === "left" ? "Split Left" : "Split Right",
      category: "Editor Tabs",
      when: hasSeveralTabs,
      run: (context, args) => {
        const id = targetTab(context, args);
        if (id !== null) useTabs.getState().moveToGroup(id, side);
      },
    }),
  ),
  defineAction({
    id: ACTION_IDS.unsplit,
    title: "Unsplit",
    category: "Editor Tabs",
    when: () => useTabs.getState().tabs.some((tab) => groupOf(tab) === "right"),
    run: () => useTabs.getState().unsplit(),
  }),
  defineAction({
    id: ACTION_IDS.run,
    title: "Run",
    category: "Console",
    icon: "run",
    shortcut: "Mod+Enter",
    tabKind: "console",
    when: canRunConsole,
    busy: consoleBusy,
    run: (context) => runActive(context, "caret"),
  }),
  defineAction({
    id: ACTION_IDS.runAll,
    title: "Run All",
    category: "Console",
    icon: "runAll",
    shortcut: "Mod+Shift+Enter",
    when: canRunConsole,
    busy: consoleBusy,
    run: (context) => runActive(context, "all"),
  }),
  defineAction({
    id: ACTION_IDS.reformat,
    title: "Reformat Code",
    category: "Console",
    icon: "reformat",
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
      const strip = groupStrip(useTabs.getState(), groupOf(context.tabs.find((tab) => tab.id === id)));
      await closeTabs(otherTabIds(strip, id), () => useTabs.getState().closeOthers(id));
    },
  }),
  defineAction({
    id: ACTION_IDS.closeAllTabs,
    title: "Close All Tabs",
    category: "Editor Tabs",
    when: hasTabs,
    run: async (context) => {
      const strip = groupStrip(useTabs.getState(), groupOf(context.activeTab));
      await closeTabs(unpinnedTabIds(strip), () => useTabs.getState().closeAll());
    },
  }),
  defineAction<TabArgs | undefined>({
    id: ACTION_IDS.closeTabsToRight,
    title: "Close Tabs to the Right",
    category: "Editor Tabs",
    when: hasSeveralTabs,
    run: async (context, args) => {
      const id = targetTab(context, args);
      if (id === null) return;
      const strip = groupStrip(useTabs.getState(), groupOf(context.tabs.find((tab) => tab.id === id)));
      await closeTabs(rightTabIds(strip, id), () => useTabs.getState().closeRight(id));
    },
  }),
  defineAction<TabArgs | undefined>({
    id: ACTION_IDS.copyTabPath,
    title: "Copy Path",
    category: "Editor Tabs",
    icon: "copy",
    when: hasConsoleTab,
    run: async (context, args) => {
      const id = targetTab(context, args);
      if (id === null) return;
      try {
        const path = await consoleFilePath(id);
        if (path !== null) await writeClipboard(path);
      } catch (cause) {
        await noticeTabFailure("Could not copy the path", cause);
      }
    },
  }),
  defineAction<TabArgs | undefined>({
    id: ACTION_IDS.togglePinTab,
    title: "Pin Tab",
    category: "Editor Tabs",
    icon: "pin",
    when: hasTabs,
    run: (context, args) => {
      const id = targetTab(context, args);
      if (id !== null) useTabs.getState().togglePin(id);
    },
  }),
  defineAction({
    id: ACTION_IDS.reopenClosedTab,
    title: "Reopen Closed Tab",
    category: "Editor Tabs",
    icon: "reopen",
    shortcut: "Mod+Shift+T",
    when: () => useTabs.getState().closedConsoles.length > 0,
    run: () => reopenClosedTab(),
  }),
  defineAction<TabArgs | undefined>({
    id: ACTION_IDS.duplicateTab,
    title: "Duplicate",
    category: "Editor Tabs",
    icon: "duplicate",
    when: hasConsoleTab,
    run: async (context, args) => {
      const id = targetTab(context, args);
      if (id !== null) await duplicateConsole(id);
    },
  }),
  defineAction<TabArgs | undefined>({
    id: ACTION_IDS.revealTab,
    get title() {
      return revealTitle();
    },
    category: "Editor Tabs",
    icon: "folder",
    when: hasConsoleTab,
    run: async (context, args) => {
      const id = targetTab(context, args);
      if (id === null) return;
      try {
        await revealConsoleFile(id);
      } catch (cause) {
        await noticeTabFailure("Could not show the file", cause);
      }
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
    // A first Escape in the Database pane drops a multiple selection to its lead (plan 136).
    when: (context) =>
      inToolWindow(context) && !context.speedSearching && !(context.focus === "database" && context.items.length > 1),
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
      if (answer.ok) await writeClipboard(answer.value);
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
    when: canDeleteItems,
    run: (context) => deleteItems(context.items),
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
    when: canMoveItems,
    run: (context) => askMoveToFolder(context.items),
  }),
  defineAction<MoveRequest>({
    id: ACTION_IDS.moveItems,
    title: "Move Data Sources",
    category: "Database",
    inPalette: false,
    run: async (_context, request) => {
      await moveItems(request);
    },
  }),
  defineAction({
    id: ACTION_IDS.moveUp,
    title: "Move Up",
    category: "Database",
    shortcut: "Alt+Shift+ArrowUp",
    shortcutRegion: "database",
    when: (context) => stepOf(context, "up") !== null,
    run: async (context) => {
      const request = stepOf(context, "up");
      if (request !== null) await moveItems(request);
    },
  }),
  defineAction({
    id: ACTION_IDS.moveDown,
    title: "Move Down",
    category: "Database",
    shortcut: "Alt+Shift+ArrowDown",
    shortcutRegion: "database",
    when: (context) => stepOf(context, "down") !== null,
    run: async (context) => {
      const request = stepOf(context, "down");
      if (request !== null) await moveItems(request);
    },
  }),
  defineAction({
    id: ACTION_IDS.manageShownSchemas,
    title: "Manage Shown Schemas…",
    category: "Database",
    when: listsNamespaces,
    run: (context) => {
      if (context.datasource !== null) useManageShownSchemasDialog.getState().show(context.datasource.view.id);
    },
  }),
];
