import { basename } from "node:path";
import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import { CHANNELS } from "@table-craft/desktop/preload/bridge.js";
import { menuFor, type MenuEntry } from "@table-craft/desktop/preload/menu.js";

const MAC_PLATFORM = "darwin";
const NO_RECENT_FILES = "No Recent Files";

function recentItems(recent: readonly string[], target: () => BrowserWindow | null): MenuItemConstructorOptions[] {
  if (recent.length === 0) return [{ label: NO_RECENT_FILES, enabled: false }];
  return recent.map((path) => ({
    label: basename(path),
    sublabel: path,
    toolTip: path,
    click: () => target()?.webContents.send(CHANNELS.openRecentFile, path),
  }));
}

function toTemplate(
  entry: MenuEntry,
  target: () => BrowserWindow | null,
  recent: readonly string[],
): MenuItemConstructorOptions {
  switch (entry.kind) {
    case "separator":
      return { type: "separator" };
    case "role":
      return { role: entry.role };
    case "submenu":
      return { label: entry.label, submenu: entry.items.map((item) => toTemplate(item, target, recent)) };
    case "recentFiles":
      return { label: entry.label, submenu: recentItems(recent, target) };
    case "action":
      return {
        label: entry.label,
        ...(entry.accelerator === undefined ? {} : { accelerator: entry.accelerator }),
        // The renderer keymap dispatches every chord; the menu only shows it. macOS ignores this
        // flag, and there an unhandled key equivalent reaches the menu, whose click runs the same
        // action through the same `invoke` (decision 9).
        registerAccelerator: false,
        click: () => target()?.webContents.send(CHANNELS.invokeAction, entry.actionId),
      };
  }
}

/**
 * Builds and installs the application menu; `target` is the window a click acts on. Called again
 * whenever the recent SQL files move, since a native menu cannot change one submenu in place.
 */
export function installApplicationMenu(target: () => BrowserWindow | null, recent: readonly string[] = []): void {
  const mac = process.platform === MAC_PLATFORM;
  const template = menuFor(mac).map((entry) => toTemplate(entry, target, recent));
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
