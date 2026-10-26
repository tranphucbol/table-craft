import { writeClipboard } from "@table-craft/desktop/renderer/state/clipboard.js";
import type { DatasourceView, HistoryStatement } from "@table-craft/desktop/preload/bridge.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import {
  closedConsoles,
  deleteConsoleFile,
  openConsole,
  readConsole,
  reopenConsole,
} from "@table-craft/desktop/renderer/actions/consoleCommands.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { pluginOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useExecutions, type Execution } from "@table-craft/desktop/renderer/state/executions.js";
import { history } from "@table-craft/desktop/renderer/state/history.js";
import {
  CLOSED_CONSOLE_CHOICES,
  HISTORY_CHOICES,
  parsePickerAnswer,
  useModal,
} from "@table-craft/desktop/renderer/state/modal.js";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";
import { useTables } from "@table-craft/desktop/renderer/state/tables.js";

export const HISTORY_ACTION_IDS = {
  show: "history.show",
  clear: "history.clear",
  reopen: "console.reopen",
  cancel: "services.cancel",
  clearExecutions: "services.clearExecutions",
  copySql: "services.copySql",
  openInConsole: "services.openInConsole",
} as const;

const INSERT = "Insert";
const OPEN_IN_CONSOLE = "Open in Console";

/** Names the Services row an action runs on; absent, it runs on the active tab's session and its newest execution. */
export interface ServiceArgs {
  readonly tabId?: string;
  readonly executionId?: number;
}

function highlightOf(view: DatasourceView): string | null | undefined {
  return pluginOf(useDatasources.getState().plugins, view.pluginId)?.highlight;
}

async function notice(title: string, cause: unknown): Promise<void> {
  const error = toError(cause);
  const hint = "hint" in error && typeof error.hint === "string" ? error.hint : "Try again.";
  await useModal.getState().ask({ kind: "notice", title, message: error.message, hint });
}

/** Asks first; false when the user kept the history or clearing failed, which a notice explains. */
async function clearHistory(view: DatasourceView): Promise<boolean> {
  const confirmed = await useModal.getState().ask({
    kind: "confirm",
    title: "Clear Query History",
    message: `Clear the query history of ${view.name}? This cannot be undone.`,
    confirm: "Clear",
    destructive: true,
  });
  if (confirmed === null) return false;
  try {
    await history.clear(view.id);
    return true;
  } catch (cause) {
    await notice("Could not clear the query history", cause);
    return false;
  }
}

/**
 * Query History (plan 011 decisions 8 and 9). From a console on the datasource the chosen statement
 * goes in at its caret; from anywhere else it opens in a new console. Clearing reopens the dialog.
 */
async function showHistory(context: ActionContext): Promise<void> {
  const view = context.datasource?.view;
  if (view === undefined) return;
  const into =
    context.console !== null && !context.inDatabasePane && context.console.datasourceId === view.id
      ? context.activeTab?.id
      : undefined;
  let listed: readonly HistoryStatement[] = [];
  for (;;) {
    const answer = await useModal.getState().ask({
      kind: "history",
      title: `Query History: ${view.name}`,
      search: async (query) => (listed = await history.search(view.id, query)),
      highlight: highlightOf(view),
      restore: into === undefined ? OPEN_IN_CONSOLE : INSERT,
      now: Date.now(),
    });
    if (answer === null) return;
    const { choice, value } = parsePickerAnswer(answer);
    if (choice === HISTORY_CHOICES.clear) {
      await clearHistory(view);
      continue;
    }
    const values = listed.find((statement) => statement.sql === value)?.lastParameters ?? undefined;
    if (choice === HISTORY_CHOICES.copy) await writeClipboard(value);
    else if (into !== undefined) useConsoles.getState().insert(into, value, values);
    else await openConsole(view.id, value, values);
    return;
  }
}

/** Open Closed Console (plan 011 decision 14); deleting a file reopens the list without it. */
async function showClosedConsoles(view: DatasourceView): Promise<void> {
  for (;;) {
    let names: readonly string[];
    try {
      names = await closedConsoles(view.id);
    } catch (cause) {
      await notice("Could not list the saved consoles", cause);
      return;
    }
    const answer = await useModal.getState().ask({
      kind: "closedConsoles",
      title: `Open Closed Console: ${view.name}`,
      names,
      read: (name) => readConsole(view.id, name),
      highlight: highlightOf(view),
    });
    if (answer === null) return;
    const { choice, value } = parsePickerAnswer(answer);
    if (choice === CLOSED_CONSOLE_CHOICES.open) {
      await reopenConsole(view.id, value).catch((cause: unknown) => notice("Could not open the console", cause));
      return;
    }
    const confirmed = await useModal.getState().ask({
      kind: "confirm",
      title: "Delete Console",
      message: `Delete the saved console ${value}? This cannot be undone.`,
      confirm: "Delete",
      destructive: true,
    });
    if (confirmed !== null) {
      await deleteConsoleFile(view.id, value).catch((cause: unknown) => notice("Could not delete the console", cause));
    }
  }
}

function serviceTab(context: ActionContext, args: ServiceArgs | undefined): string | null {
  return args?.tabId ?? context.activeTab?.id ?? null;
}

function datasourceOfTab(tabId: string): string | undefined {
  return useConsoles.getState().consoles[tabId]?.datasourceId ?? useTables.getState().tables[tabId]?.datasourceId;
}

/** The named execution, or the tab's newest that has SQL. */
function serviceExecution(context: ActionContext, args: ServiceArgs | undefined): Execution | null {
  const tabId = serviceTab(context, args);
  if (tabId === null) return null;
  const executions = useExecutions.getState().byTab[tabId] ?? [];
  const found =
    args?.executionId === undefined
      ? executions.find((execution) => execution.sql !== null)
      : executions.find((execution) => execution.id === args.executionId);
  return found ?? null;
}

const hasTabs = (context: ActionContext) => context.tabs.length > 0;
const isSaved = (context: ActionContext) => context.datasource !== null && !context.datasource.view.ephemeral;

export const HISTORY_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: HISTORY_ACTION_IDS.show,
    title: "Query History…",
    category: "Console",
    icon: "history",
    shortcut: "Mod+Alt+E",
    when: (context) => context.datasource !== null,
    run: showHistory,
  }),
  defineAction({
    id: HISTORY_ACTION_IDS.clear,
    title: "Clear Query History…",
    category: "Database",
    when: isSaved,
    run: async (context) => {
      if (context.datasource !== null) await clearHistory(context.datasource.view);
    },
  }),
  defineAction({
    id: HISTORY_ACTION_IDS.reopen,
    title: "Open Closed Console…",
    category: "Console",
    icon: "reopen",
    when: isSaved,
    run: async (context) => {
      if (context.datasource !== null) await showClosedConsoles(context.datasource.view);
    },
  }),
  defineAction<ServiceArgs | undefined>({
    id: HISTORY_ACTION_IDS.cancel,
    title: "Cancel Running Statement",
    category: "Tool Windows",
    icon: "cancel",
    when: hasTabs,
    run: async (context, args) => {
      const tabId = serviceTab(context, args);
      if (tabId !== null && useConsoles.getState().consoles[tabId]?.status === "running") {
        await useConsoles.getState().cancel(tabId);
      }
    },
  }),
  defineAction<ServiceArgs | undefined>({
    id: HISTORY_ACTION_IDS.clearExecutions,
    title: "Clear Executions",
    category: "Tool Windows",
    icon: "delete",
    when: hasTabs,
    run: (context, args) => {
      const tabId = serviceTab(context, args);
      if (tabId !== null) useExecutions.getState().clear(tabId);
    },
  }),
  defineAction<ServiceArgs | undefined>({
    id: HISTORY_ACTION_IDS.copySql,
    title: "Copy Execution SQL",
    category: "Tool Windows",
    icon: "copy",
    when: hasTabs,
    run: async (context, args) => {
      const sql = serviceExecution(context, args)?.sql;
      if (sql != null) await writeClipboard(sql);
    },
  }),
  defineAction<ServiceArgs | undefined>({
    id: HISTORY_ACTION_IDS.openInConsole,
    title: "Open Execution in Console",
    category: "Tool Windows",
    icon: "newConsole",
    when: hasTabs,
    run: async (context, args) => {
      const tabId = serviceTab(context, args);
      const sql = serviceExecution(context, args)?.sql;
      const datasourceId = tabId === null ? undefined : datasourceOfTab(tabId);
      if (sql != null && datasourceId !== undefined) await openConsole(datasourceId, sql);
    },
  }),
];
