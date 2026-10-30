import { openConsole } from "@table-craft/desktop/renderer/actions/consoleCommands.js";
import { openAdmin } from "@table-craft/desktop/renderer/keyAdmin/actions.js";
import { useKeyAdmin } from "@table-craft/desktop/renderer/keyAdmin/store.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import {
  selectedSlowCommand,
  serverTabOf,
  useServer,
  type ServerStore,
} from "@table-craft/desktop/renderer/state/server.js";
import { useTabs, type TabsStore } from "@table-craft/desktop/renderer/state/tabs.js";

export const SERVER_ACTION_IDS = {
  show: "server.show",
  details: "server.details",
  refresh: "server.refresh",
  openSlowCommand: "server.openSlowCommand",
} as const;

/** Which slow command Open in Console opens: its text as the slow log shows it. */
export interface SlowCommandArgs {
  readonly command: string;
}

const SERVER_ID_PREFIX = "server-";
const SERVER_TITLE = "Server";
let serverOpened = 0;

/** Opens the datasource's Server tab, or brings its open one forward and reads again. */
export async function openServerIn(
  stores: { readonly tabs: TabsStore; readonly server: ServerStore },
  datasourceId: string,
): Promise<void> {
  const existing = serverTabOf(stores.server.getState().tabs, datasourceId);
  if (existing !== null) {
    stores.tabs.getState().activate(existing);
    await stores.server.getState().refresh(existing);
    return;
  }
  const id = `${SERVER_ID_PREFIX}${String(serverOpened++)}`;
  stores.tabs.getState().open({ id, kind: "server", title: SERVER_TITLE });
  await stores.server.getState().open(id, datasourceId);
}

export const SERVER_ACTIONS: readonly AnyAction[] = [
  defineAction<{ readonly datasourceId: string } | undefined>({
    id: SERVER_ACTION_IDS.details,
    title: "Server Details",
    category: "Database",
    icon: "server",
    tabKind: "keyAdmin",
    available: (context) => context.capabilities.includes("serverInfo"),
    run: async (context, args) => {
      const datasourceId =
        args?.datasourceId ??
        (context.activeTab === null ? undefined : useKeyAdmin.getState().tabs[context.activeTab.id]?.datasourceId);
      if (datasourceId !== undefined) await openServerIn({ tabs: useTabs, server: useServer }, datasourceId);
    },
  }),
  defineAction({
    id: SERVER_ACTION_IDS.show,
    title: "Server Info",
    category: "Database",
    icon: "server",
    available: (context) =>
      context.datasource === null ||
      context.datasource.capabilities.some((cap) => cap === "serverInfo" || cap === "members" || cap === "maintenance"),
    when: (context) => context.datasource !== null,
    run: async (context) => {
      if (context.datasource !== null) {
        if (context.datasource.capabilities.includes("members")) await openAdmin(context.datasource.view.id, "members");
        else if (context.datasource.capabilities.includes("maintenance"))
          await openAdmin(context.datasource.view.id, "maintenance");
        else await openServerIn({ tabs: useTabs, server: useServer }, context.datasource.view.id);
      }
    },
  }),
  defineAction({
    id: SERVER_ACTION_IDS.refresh,
    title: "Refresh Server Info",
    category: "Database",
    icon: "synchronize",
    tabKind: "server",
    when: (context) => context.serverTab !== null && !context.serverTab.loading,
    run: async (context) => {
      if (context.activeTab?.kind === "server") await useServer.getState().refresh(context.activeTab.id);
    },
  }),
  defineAction<SlowCommandArgs | undefined>({
    id: SERVER_ACTION_IDS.openSlowCommand,
    title: "Open Slow Command in Console",
    category: "Database",
    icon: "newConsole",
    tabKind: "server",
    when: (context) => selectedSlowCommand(context.serverTab ?? undefined) !== null,
    run: async (context, args) => {
      const command = args?.command ?? selectedSlowCommand(context.serverTab ?? undefined)?.command;
      if (context.serverTab !== null && command !== undefined)
        await openConsole(context.serverTab.datasourceId, command);
    },
  }),
];
