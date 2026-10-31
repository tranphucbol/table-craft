import { describe, expect, it } from "vitest";
import { menuActionIds, menuActionItems, menuFor, type MenuEntry } from "@table-craft/desktop/preload/menu.js";
import { ALL_ACTIONS } from "@table-craft/desktop/renderer/actions/allActions.js";
import { MCP_NOTICE_ACTIONS } from "@table-craft/desktop/settings/mcpNotice.js";

const ELECTRON_MOD = "CmdOrCtrl";

function electronAccelerator(chord: string): string {
  return chord.replace(/^Mod\+/, `${ELECTRON_MOD}+`);
}

function labelsOf(entries: readonly MenuEntry[]): string[] {
  return entries.map((entry) => {
    if (entry.kind === "separator") return "-";
    if (entry.kind === "role") return `(${entry.role})`;
    return entry.label;
  });
}

describe("application menu", () => {
  it("givenMac_whenBuilt_thenAppMenuLeadsWithSettingsWhereMacUsersLook", () => {
    const [appMenu, file] = menuFor(true);

    expect(appMenu?.kind === "submenu" ? labelsOf(appMenu.items) : []).toEqual([
      "(about)",
      "-",
      "Settings…",
      "-",
      "(services)",
      "-",
      "(hide)",
      "(hideOthers)",
      "(unhide)",
      "-",
      "(quit)",
    ]);
    expect(file?.kind === "submenu" ? labelsOf(file.items) : []).not.toContain("Settings…");
  });

  it("givenWindowsOrLinux_whenBuilt_thenFileHoldsSettingsAboveItsLastSeparator", () => {
    const [file] = menuFor(false);
    const items = file?.kind === "submenu" ? labelsOf(file.items) : [];

    expect(file?.kind === "submenu" ? file.label : "").toBe("File");
    expect(items.slice(-4)).toEqual(["Settings…", "-", "Close Tab", "Reopen Closed Tab"]);
    expect(menuActionIds(menuFor(false)).filter((id) => id === "settings.show")).toHaveLength(1);
  });

  it("givenWindowsOrLinux_whenBuilt_thenHelpEndsWithAbout", () => {
    const help = menuFor(false).find((entry) => entry.kind === "submenu" && entry.label === "Help");
    const macHelp = menuFor(true).find((entry) => entry.kind === "submenu" && entry.label === "Help");

    const diagnostics = ["Show Log", "Reveal Log File", "Export Diagnostics…", "-", "Check for Updates…"];
    expect(help?.kind === "submenu" ? labelsOf(help.items) : []).toEqual([
      "Find Action…",
      "-",
      ...diagnostics,
      "-",
      "About TableCraft",
    ]);
    expect(macHelp?.kind === "submenu" ? labelsOf(macHelp.items) : []).toEqual(["Find Action…", "-", ...diagnostics]);
  });

  it("givenMenuDeclaration_whenComparedWithRegistry_thenEveryActionIdExists", () => {
    const registered = new Set(ALL_ACTIONS.map((action) => action.id));

    expect(menuActionIds().filter((id) => !registered.has(id))).toEqual([]);
  });

  it("givenMcpNoticeActions_whenComparedWithRegistry_thenBothExist", () => {
    const registered = new Set(ALL_ACTIONS.map((action) => action.id));

    expect(Object.values(MCP_NOTICE_ACTIONS).filter((id) => !registered.has(id))).toEqual([]);
  });

  it("givenMenuAccelerator_whenComparedWithAction_thenItShowsTheActionChord", () => {
    const shortcuts = new Map(ALL_ACTIONS.map((action) => [action.id, action.shortcut]));

    for (const item of menuActionItems()) {
      if (item.accelerator === undefined) continue;
      const shortcut = shortcuts.get(item.actionId);
      expect(shortcut, item.actionId).toBeDefined();
      expect(item.accelerator, item.actionId).toBe(electronAccelerator(shortcut ?? ""));
    }
  });
});
