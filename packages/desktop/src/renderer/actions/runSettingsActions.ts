import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import type { RunSettings } from "@table-craft/desktop/renderer/model/runSettings.js";
import { useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { useRunSettingsPopover } from "@table-craft/desktop/renderer/state/runSettingsPopover.js";

export const RUN_SETTINGS_ACTION_IDS = {
  show: "console.runSettings",
  set: "console.setRunSettings",
} as const;

/** The console's row limit and statement timeout over Settings' (decision 148). */
export const RUN_SETTINGS_ACTIONS: readonly AnyAction[] = [
  defineAction({
    // No chord: the toolbar gear and the palette reach it.
    id: RUN_SETTINGS_ACTION_IDS.show,
    title: "Run Settings…",
    category: "Console",
    icon: "runSettings",
    tabKind: "console",
    run: (context) => {
      const consoleId = context.activeTab?.id;
      if (consoleId === undefined) return;
      const popover = useRunSettingsPopover.getState();
      if (popover.consoleId === consoleId) popover.hide();
      else popover.show(consoleId);
    },
  }),
  defineAction<Partial<RunSettings>>({
    id: RUN_SETTINGS_ACTION_IDS.set,
    title: "Change Run Settings",
    category: "Console",
    tabKind: "console",
    inPalette: false,
    run: (context, change) => {
      const consoleId = context.activeTab?.id;
      if (consoleId !== undefined) useConsoles.getState().setRunSettings(consoleId, change);
    },
  }),
];
