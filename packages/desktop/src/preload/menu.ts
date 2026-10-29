/**
 * The application menu as data (plan 003, decision 8). Declarations only: main builds it, and a
 * click sends the item's action id to the renderer, which runs it through the action registry.
 * Main never decides whether an action is enabled.
 */

/** Which platforms show an entry; every platform when absent. */
export type MenuPlatform = "mac" | "notMac";

interface PlatformEntry {
  readonly only?: MenuPlatform;
}

/** An item that runs a renderer action. `accelerator` is Electron's spelling of the action's chord. */
export interface ActionMenuItem extends PlatformEntry {
  readonly kind: "action";
  readonly label: string;
  readonly actionId: string;
  readonly accelerator?: string;
}

/** Electron's built-in menu or item roles that this menu uses. */
export type MenuRole =
  "editMenu" | "windowMenu" | "toggleDevTools" | "about" | "services" | "hide" | "hideOthers" | "unhide" | "quit";

export interface RoleMenuItem extends PlatformEntry {
  readonly kind: "role";
  readonly role: MenuRole;
}

export interface SubmenuItem extends PlatformEntry {
  readonly kind: "submenu";
  readonly label: string;
  readonly items: readonly MenuEntry[];
}

export interface SeparatorItem extends PlatformEntry {
  readonly kind: "separator";
}

/** The recent SQL files (plan 041), filled in by main each time the list moves; a click opens the file. */
export interface RecentFilesItem extends PlatformEntry {
  readonly kind: "recentFiles";
  readonly label: string;
}

export type MenuEntry = ActionMenuItem | RoleMenuItem | SubmenuItem | SeparatorItem | RecentFilesItem;

const SEPARATOR: SeparatorItem = { kind: "separator" };
const SETTINGS_ACCELERATOR = "CmdOrCtrl+,";

/**
 * The menu bar. On macOS the app menu is spelled out rather than taken from the `appMenu` role,
 * so Settings… sits where macOS users look for it (plan 013 decision 16); macOS titles it with
 * the app's name whatever the label says.
 */
export const APPLICATION_MENU: readonly MenuEntry[] = [
  {
    kind: "submenu",
    label: "TableCraft",
    only: "mac",
    items: [
      { kind: "role", role: "about" },
      SEPARATOR,
      { kind: "action", label: "Settings…", actionId: "settings.show", accelerator: SETTINGS_ACCELERATOR },
      SEPARATOR,
      { kind: "role", role: "services" },
      SEPARATOR,
      { kind: "role", role: "hide" },
      { kind: "role", role: "hideOthers" },
      { kind: "role", role: "unhide" },
      SEPARATOR,
      { kind: "role", role: "quit" },
    ],
  },
  {
    kind: "submenu",
    label: "File",
    items: [
      // No accelerator: ⌘N belongs to the Database tool window alone (plan 004).
      { kind: "action", label: "New Data Source…", actionId: "datasource.new" },
      { kind: "action", label: "Import Data Sources…", actionId: "datasource.import" },
      { kind: "action", label: "New Console", actionId: "console.new", accelerator: "CmdOrCtrl+Shift+L" },
      { kind: "action", label: "Open File…", actionId: "file.open", accelerator: "CmdOrCtrl+O" },
      { kind: "recentFiles", label: "Recent Files" },
      SEPARATOR,
      { kind: "action", label: "Save", actionId: "file.save", accelerator: "CmdOrCtrl+S" },
      { kind: "action", label: "Save As…", actionId: "file.saveAs", accelerator: "CmdOrCtrl+Shift+S" },
      { kind: "action", label: "Rename File…", actionId: "console.rename" },
      SEPARATOR,
      {
        kind: "action",
        label: "Data Source Properties…",
        actionId: "datasource.properties",
        accelerator: "CmdOrCtrl+;",
      },
      { kind: "action", label: "Disconnect", actionId: "datasource.disconnect", accelerator: "CmdOrCtrl+F2" },
      { kind: "action", label: "Synchronize", actionId: "database.synchronize", accelerator: "CmdOrCtrl+Alt+Y" },
      { kind: "separator", only: "notMac" },
      {
        kind: "action",
        label: "Settings…",
        actionId: "settings.show",
        accelerator: SETTINGS_ACCELERATOR,
        only: "notMac",
      },
      SEPARATOR,
      { kind: "action", label: "Close Tab", actionId: "tab.close", accelerator: "CmdOrCtrl+W" },
      {
        kind: "action",
        label: "Reopen Closed Tab",
        actionId: "tab.reopenClosed",
        accelerator: "CmdOrCtrl+Shift+T",
      },
    ],
  },
  { kind: "role", role: "editMenu" },
  {
    kind: "submenu",
    label: "View",
    items: [
      {
        kind: "submenu",
        label: "Tool Windows",
        items: [
          { kind: "action", label: "Database", actionId: "toolWindow.database.toggle", accelerator: "CmdOrCtrl+1" },
          { kind: "action", label: "Services", actionId: "toolWindow.services.toggle", accelerator: "CmdOrCtrl+8" },
          { kind: "action", label: "Log", actionId: "toolWindow.log.toggle" },
        ],
      },
      {
        kind: "action",
        label: "Hide All Tool Windows",
        actionId: "toolWindow.hideAll",
        accelerator: "CmdOrCtrl+Shift+F12",
      },
      { kind: "action", label: "Show System Schemas", actionId: "explorer.toggleSystemSchemas" },
      { kind: "action", label: "Brand Icons", actionId: "appearance.toggleBrandIcons" },
      SEPARATOR,
      { kind: "action", label: "Query History…", actionId: "history.show", accelerator: "CmdOrCtrl+Alt+E" },
      { kind: "action", label: "Open Closed Console…", actionId: "console.reopen" },
      SEPARATOR,
      { kind: "action", label: "Find Action…", actionId: "palette.findAction", accelerator: "CmdOrCtrl+Shift+A" },
      // No accelerator: Electron cannot express a double Shift.
      { kind: "action", label: "Search Everywhere", actionId: "palette.searchEverywhere" },
      SEPARATOR,
      { kind: "role", role: "toggleDevTools" },
    ],
  },
  // Elsewhere the role adds Close with a registered Ctrl+W, which would close the window instead of the tab.
  { kind: "role", role: "windowMenu", only: "mac" },
  {
    kind: "submenu",
    label: "Help",
    items: [
      { kind: "action", label: "Find Action…", actionId: "palette.findAction" },
      SEPARATOR,
      { kind: "action", label: "Show Log", actionId: "log.show" },
      { kind: "action", label: "Reveal Log File", actionId: "log.reveal" },
      { kind: "action", label: "Export Diagnostics…", actionId: "diagnostics.export" },
      SEPARATOR,
      { kind: "action", label: "Check for Updates…", actionId: "update.check" },
      { kind: "separator", only: "notMac" },
      { kind: "action", label: "About TableCraft", actionId: "app.about", only: "notMac" },
    ],
  },
];

/** The entries one platform shows, at every depth. */
export function menuFor(mac: boolean, entries: readonly MenuEntry[] = APPLICATION_MENU): readonly MenuEntry[] {
  const shown = mac ? "mac" : "notMac";
  return entries
    .filter((entry) => entry.only === undefined || entry.only === shown)
    .map((entry) => (entry.kind === "submenu" ? { ...entry, items: menuFor(mac, entry.items) } : entry));
}

/** Every action id the menu names, for the test that checks each one is registered. */
export function menuActionIds(entries: readonly MenuEntry[] = APPLICATION_MENU): readonly string[] {
  return entries.flatMap((entry) => {
    if (entry.kind === "action") return [entry.actionId];
    if (entry.kind === "submenu") return menuActionIds(entry.items);
    return [];
  });
}

export function menuActionItems(entries: readonly MenuEntry[] = APPLICATION_MENU): readonly ActionMenuItem[] {
  return entries.flatMap((entry) => {
    if (entry.kind === "action") return [entry];
    if (entry.kind === "submenu") return menuActionItems(entry.items);
    return [];
  });
}
