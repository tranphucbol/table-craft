import type { InvokeResult, MenuPoint } from "@table-craft/desktop/preload/bridge.js";
import { currentPlatform } from "@table-craft/desktop/renderer/actions/chords.js";
import { openConsole } from "@table-craft/desktop/renderer/actions/consoleCommands.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { useTables } from "@table-craft/desktop/renderer/state/tables.js";
import { useTabs } from "@table-craft/desktop/renderer/state/tabs.js";

export const WINDOW_ACTION_IDS = {
  mainMenu: "app.mainMenu",
  relaunch: "app.relaunch",
  switchTo: "datasource.switchTo",
} as const;

/** The main-menu button carries this attribute; the menu opens under it however it was invoked. */
export const MAIN_MENU_ANCHOR_ATTRIBUTE = "data-main-menu";

export interface SwitchToArgs {
  readonly datasourceId: string;
}

export interface SwitchToDependencies {
  /** Open tab ids, most recently active first. */
  readonly recent: readonly string[];
  /** The datasource of a console or table tab; undefined for any other tab. */
  readonly datasourceOf: (tabId: string) => string | undefined;
  readonly activate: (tabId: string) => void;
  readonly openConsole: (datasourceId: string) => Promise<void>;
}

/**
 * The datasource widget's choice (decision 034): the datasource's most recently active console or
 * table tab comes forward, or a new console opens on it.
 */
export async function switchToDatasource(datasourceId: string, dependencies: SwitchToDependencies): Promise<void> {
  const target = dependencies.recent.find((tabId) => dependencies.datasourceOf(tabId) === datasourceId);
  if (target === undefined) await dependencies.openConsole(datasourceId);
  else dependencies.activate(target);
}

function tabDatasource(tabId: string): string | undefined {
  return useConsoles.getState().consoles[tabId]?.datasourceId ?? useTables.getState().tables[tabId]?.datasourceId;
}

function isSwitchToArgs(args: unknown): args is SwitchToArgs {
  return typeof args === "object" && args !== null && typeof (args as SwitchToArgs).datasourceId === "string";
}

function isMenuPoint(args: unknown): args is MenuPoint {
  return typeof args === "object" && args !== null && "x" in args && "y" in args;
}

/** The main-menu button's bottom-left, so a palette or Alt invocation opens where a click would. */
function menuButtonAnchor(): MenuPoint {
  const rect = document.querySelector(`[${MAIN_MENU_ANCHOR_ATTRIBUTE}]`)?.getBoundingClientRect();
  return rect === undefined ? { x: 0, y: 0 } : { x: Math.round(rect.left), y: Math.round(rect.bottom) };
}

async function reportFailure(title: string, answer: InvokeResult<unknown>): Promise<void> {
  if (!answer.ok) await useModal.getState().ask({ kind: "notice", title, ...answer.error });
}

/** The window's own commands: the Windows and Linux main menu, Restart Now and the datasource widget. */
export const WINDOW_ACTIONS: readonly AnyAction[] = [
  defineAction<MenuPoint | undefined>({
    id: WINDOW_ACTION_IDS.mainMenu,
    title: "Main Menu",
    category: "App",
    icon: "menu",
    available: (context) => currentPlatform() !== "mac" && context.customTitleBar,
    run: async (_context, args) => {
      const point = isMenuPoint(args) ? args : menuButtonAnchor();
      await reportFailure("Could not open the main menu", await bridge().popupMenu(point));
    },
  }),
  defineAction({
    id: WINDOW_ACTION_IDS.relaunch,
    title: "Restart Now",
    category: "App",
    run: async () => reportFailure("Could not restart TableCraft", await bridge().relaunch()),
  }),
  defineAction<SwitchToArgs | undefined>({
    id: WINDOW_ACTION_IDS.switchTo,
    title: "Switch to Data Source",
    category: "Database",
    icon: "database",
    when: (context) => context.datasources.length > 0,
    run: async (context, args) => {
      const datasourceId = isSwitchToArgs(args) ? args.datasourceId : context.datasource?.view.id;
      if (datasourceId === undefined) return;
      await switchToDatasource(datasourceId, {
        recent: useTabs.getState().recent,
        datasourceOf: tabDatasource,
        activate: (tabId) => useTabs.getState().activate(tabId),
        openConsole: async (id) => {
          await openConsole(id);
        },
      });
    },
  }),
];
