import type { ListedSession } from "@table-craft/desktop/engine/protocol.js";
import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { openConsole } from "@table-craft/desktop/renderer/actions/consoleCommands.js";
import type { ServiceArgs } from "@table-craft/desktop/renderer/actions/historyActions.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { openSessions } from "@table-craft/desktop/renderer/actions/sessionsCommands.js";
import { useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { capabilitiesOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useModal, type ModalItem } from "@table-craft/desktop/renderer/state/modal.js";
import { selectedSession, useSessions, type SessionStop } from "@table-craft/desktop/renderer/state/sessions.js";

export const SESSIONS_ACTION_IDS = {
  show: "sessions.show",
  showInSessions: "sessions.showInSessions",
  refresh: "sessions.refresh",
  autoRefresh: "sessions.autoRefresh",
  openInConsole: "sessions.openInConsole",
  explain: "sessions.explain",
  copySql: "sessions.copySql",
  cancel: "sessions.cancel",
  terminate: "sessions.terminate",
} as const;

/** A data source of this colour is treated as production: terminating asks for the PID typed (plan 045 decision 6). */
const PRODUCTION_COLOR = "red";

/** Why Cancel Query and Terminate Session are off on a read-only data source, for their tooltips. */
export const READ_ONLY_REASON = "The data source is read-only.";

/** The Sessions tab's data source, as the window knows it now. */
function tabDatasource(context: ActionContext): DatasourceView | null {
  const { sessions } = context;
  if (sessions === null) return null;
  return context.datasources.find((view) => view.id === sessions.datasourceId) ?? null;
}

function selected(context: ActionContext): ListedSession | null {
  return selectedSession(context.sessions ?? undefined);
}

function selectedQuery(context: ActionContext): string | null {
  const query = selected(context)?.query ?? null;
  return query === null || query.trim() === "" ? null : query;
}

/** The row's statement for `stop`, when the plugin offers one and the data source may be changed. */
function canStop(context: ActionContext, stop: SessionStop): boolean {
  const session = selected(context);
  const view = tabDatasource(context);
  return session !== null && view !== null && !view.readOnly && session[stop] !== null;
}

/** The console's datasource and engine session, when its plugin lists sessions. */
function consoleInSessions(tabId: string): { readonly datasourceId: string; readonly sessionId: string } | null {
  const console = useConsoles.getState().consoles[tabId];
  if (console?.sessionId == null) return null;
  const { datasources, plugins } = useDatasources.getState();
  const view = datasources.find((datasource) => datasource.id === console.datasourceId);
  if (view === undefined || !capabilitiesOf(plugins, view.pluginId).includes("sessions")) return null;
  return { datasourceId: view.id, sessionId: console.sessionId };
}

/** Whether a Services execution of tab `tabId` can be shown in Sessions. */
export function showableInSessions(tabId: string): boolean {
  return consoleInSessions(tabId) !== null;
}

/**
 * The confirmation Terminate Session asks (plan 045 decision 6): it names the exact statement the
 * plugin runs, warns when the row is one of TableCraft's own sessions, and on a production (red)
 * data source asks for the PID typed.
 */
export function terminateRequest(view: DatasourceView, session: ListedSession, statement: string) {
  const items: ModalItem[] = [{ label: statement, detail: `runs on ${view.name}`, tone: "info" }];
  const own = session.own
    ? " This is one of TableCraft's own sessions: its console or the Database pane loses its connection."
    : "";
  return {
    kind: "confirm" as const,
    title: "Terminate Session",
    message: `Terminate session ${session.id} on ${view.name}? Its running query stops and its open transaction rolls back.${own}`,
    items,
    confirm: "Terminate",
    destructive: true,
    ...(view.color === PRODUCTION_COLOR ? { typed: session.id } : {}),
  };
}

async function stopSelected(context: ActionContext, stop: SessionStop): Promise<void> {
  const session = selected(context);
  const view = tabDatasource(context);
  const statement = session?.[stop] ?? null;
  if (context.activeTab?.kind !== "sessions" || session === null || view === null || statement === null) return;
  if (stop === "terminate" && (await useModal.getState().ask(terminateRequest(view, session, statement))) === null) {
    return;
  }
  await useSessions.getState().stop(context.activeTab.id, session, stop);
}

const inSessionsTab = (context: ActionContext) => context.sessions !== null;

export const SESSIONS_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: SESSIONS_ACTION_IDS.show,
    title: "Show Sessions…",
    category: "Database",
    icon: "sessions",
    available: (context) => context.datasource === null || context.datasource.capabilities.includes("sessions"),
    when: (context) => context.datasource !== null,
    run: async (context) => {
      if (context.datasource !== null) await openSessions(context.datasource.view.id);
    },
  }),
  defineAction<ServiceArgs | undefined>({
    id: SESSIONS_ACTION_IDS.showInSessions,
    title: "Show in Sessions",
    category: "Tool Windows",
    icon: "sessions",
    when: (context) => context.tabs.some((tab) => showableInSessions(tab.id)),
    run: async (context, args) => {
      const tabId = args?.tabId ?? context.activeTab?.id;
      const target = tabId === undefined ? null : consoleInSessions(tabId);
      if (target !== null) await openSessions(target.datasourceId, target.sessionId);
    },
  }),
  defineAction({
    id: SESSIONS_ACTION_IDS.refresh,
    title: "Refresh Sessions",
    category: "Database",
    icon: "synchronize",
    tabKind: "sessions",
    when: (context) => context.sessions !== null && !context.sessions.loading,
    run: async (context) => {
      if (context.activeTab?.kind === "sessions") await useSessions.getState().refresh(context.activeTab.id);
    },
  }),
  defineAction({
    id: SESSIONS_ACTION_IDS.autoRefresh,
    title: "Auto-Refresh Sessions",
    category: "Database",
    icon: "rerun",
    tabKind: "sessions",
    when: inSessionsTab,
    run: (context) => {
      if (context.activeTab?.kind === "sessions" && context.sessions !== null) {
        useSessions.getState().setAutoRefresh(context.activeTab.id, !context.sessions.autoRefresh);
      }
    },
  }),
  defineAction({
    id: SESSIONS_ACTION_IDS.openInConsole,
    title: "Open Session Query in Console",
    category: "Database",
    icon: "newConsole",
    tabKind: "sessions",
    when: (context) => selectedQuery(context) !== null,
    run: async (context) => {
      const query = selectedQuery(context);
      if (context.sessions !== null && query !== null) await openConsole(context.sessions.datasourceId, query);
    },
  }),
  defineAction({
    id: SESSIONS_ACTION_IDS.explain,
    title: "Explain Session Query",
    category: "Database",
    icon: "explain",
    tabKind: "sessions",
    available: (context) => context.sessions === null || context.capabilities.includes("explain"),
    when: (context) => selectedQuery(context) !== null,
    run: async (context) => {
      const query = selectedQuery(context);
      if (context.sessions === null || query === null) return;
      const consoleId = await openConsole(context.sessions.datasourceId, query);
      await useConsoles.getState().explain(consoleId, false);
    },
  }),
  defineAction({
    id: SESSIONS_ACTION_IDS.copySql,
    title: "Copy Session Query",
    category: "Database",
    icon: "copy",
    tabKind: "sessions",
    when: (context) => selectedQuery(context) !== null,
    run: async (context) => {
      const query = selectedQuery(context);
      if (query !== null) await navigator.clipboard.writeText(query);
    },
  }),
  defineAction({
    id: SESSIONS_ACTION_IDS.cancel,
    title: "Cancel Session Query",
    category: "Database",
    icon: "cancel",
    tabKind: "sessions",
    when: (context) => canStop(context, "cancel"),
    run: (context) => stopSelected(context, "cancel"),
  }),
  defineAction({
    id: SESSIONS_ACTION_IDS.terminate,
    title: "Terminate Session…",
    category: "Database",
    icon: "terminate",
    tabKind: "sessions",
    when: (context) => canStop(context, "terminate"),
    run: (context) => stopSelected(context, "terminate"),
  }),
];
