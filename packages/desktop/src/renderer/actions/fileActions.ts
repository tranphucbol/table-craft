import type { TabArgs } from "@table-craft/desktop/renderer/actions/appActions.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { fileConsoles, renameConsole, saveConsole } from "@table-craft/desktop/renderer/actions/consoleCommands.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { fileNameOf } from "@table-craft/desktop/renderer/model/exportText.js";
import { unwrap } from "@table-craft/desktop/renderer/state/consoleFiles.js";
import { fileSourceOf } from "@table-craft/desktop/renderer/state/consoles.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";

export const FILE_ACTION_IDS = {
  open: "file.open",
  openRecent: "file.openRecent",
  save: "file.save",
  saveAs: "file.saveAs",
  rename: "console.rename",
  reload: "file.reload",
  keepMine: "file.keepMine",
} as const;

const OPEN_TITLE = "Open SQL Files";

const hasConsole = (context: ActionContext) => context.console !== null && context.activeTab !== null;
const hasFileConsole = (context: ActionContext) => context.console !== null && fileSourceOf(context.console) !== null;
const hasDiskChange = (context: ActionContext) => context.console?.diskChanged != null;

/** The data source a file opened now goes on, unless it remembers its own (decision 2). */
const targetDatasource = (context: ActionContext) => context.datasource?.view.id ?? null;

async function noticeFailure(title: string, cause: unknown): Promise<void> {
  await useModal.getState().ask({
    kind: "notice",
    title,
    message: cause instanceof Error ? cause.message : String(cause),
    hint: "Try again; if it keeps failing, check the log.",
  });
}

/** Opens the paths File → Recent Files sends, on the data source the window has in focus. */
export function openRecentFromMenu(context: () => ActionContext): () => void {
  return bridge().onOpenRecentFile((path) => {
    void fileConsoles.open([path], targetDatasource(context()));
  });
}

/**
 * Keeps file consoles and their files in step (decision 089): autosaves as typing pauses, writes
 * what is pending when the window loses focus, and looks for changes made on disk when it gains it.
 */
export function syncFileConsoles(target: Pick<Window, "addEventListener" | "removeEventListener">): () => void {
  const stopSaving = fileConsoles.autosave();
  const check = () => void fileConsoles.checkDisk();
  const flush = () => void fileConsoles.flush();
  target.addEventListener("focus", check);
  target.addEventListener("blur", flush);
  return () => {
    stopSaving();
    target.removeEventListener("focus", check);
    target.removeEventListener("blur", flush);
  };
}

export const FILE_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: FILE_ACTION_IDS.open,
    title: "Open File…",
    category: "App",
    icon: "folder",
    shortcut: "Mod+O",
    run: async (context) => {
      let paths: readonly string[];
      try {
        paths = await unwrap(bridge().chooseSqlFiles(OPEN_TITLE));
      } catch (cause) {
        await noticeFailure("Could not open the files", cause);
        return;
      }
      await fileConsoles.open(paths, targetDatasource(context));
    },
  }),
  defineAction({
    id: FILE_ACTION_IDS.openRecent,
    title: "Recent Files…",
    category: "App",
    run: async (context) => {
      let recent: readonly string[];
      try {
        recent = await unwrap(bridge().recentSqlFiles());
      } catch (cause) {
        await noticeFailure("Could not list the recent files", cause);
        return;
      }
      const path = await useModal.getState().ask({
        kind: "pick",
        title: "Recent Files",
        searchLabel: "Search recent files",
        items: recent.map((file) => ({ id: file, label: fileNameOf(file), detail: file })),
        empty: "No recent files. Open one with Open File….",
        confirm: "Open",
      });
      if (path !== null) await fileConsoles.open([path], targetDatasource(context));
    },
  }),
  defineAction({
    id: FILE_ACTION_IDS.save,
    title: "Save",
    category: "Console",
    shortcut: "Mod+S",
    when: hasConsole,
    run: async (context) => {
      if (context.activeTab === null || context.console === null) return;
      // DataGrip's Save on a scratch console asks where to keep it as a file (decision 089).
      if (fileSourceOf(context.console) === null) await fileConsoles.saveAs(context.activeTab.id);
      else await saveConsole(context.activeTab.id);
    },
  }),
  defineAction({
    id: FILE_ACTION_IDS.saveAs,
    title: "Save As…",
    category: "Console",
    shortcut: "Mod+Shift+S",
    when: hasConsole,
    run: async (context) => {
      if (context.activeTab !== null) await fileConsoles.saveAs(context.activeTab.id);
    },
  }),
  defineAction<TabArgs | undefined>({
    id: FILE_ACTION_IDS.rename,
    title: "Rename File…",
    category: "Console",
    // The tab menu passes the right-clicked tab, which need not be the active one.
    when: (context) => context.tabs.some((tab) => tab.kind === "console"),
    run: async (context, args) => {
      const id = args?.tabId ?? context.activeTab?.id;
      if (id !== undefined) await renameConsole(id);
    },
  }),
  defineAction({
    id: FILE_ACTION_IDS.reload,
    title: "Reload from Disk",
    category: "Console",
    icon: "revert",
    when: hasFileConsole,
    run: async (context) => {
      if (context.activeTab !== null) await fileConsoles.reload(context.activeTab.id);
    },
  }),
  defineAction({
    id: FILE_ACTION_IDS.keepMine,
    title: "Keep My Changes",
    category: "Console",
    when: hasDiskChange,
    run: async (context) => {
      if (context.activeTab !== null) await fileConsoles.keepMine(context.activeTab.id);
    },
  }),
];
