import { create } from "zustand";

/** The Settings dialog's pages, in the order its list shows them (plan 013 decision 15). */
export const SETTINGS_PAGES = ["appearance", "editor", "dataEditor", "advanced", "plugins", "mcp"] as const;
export type SettingsPage = (typeof SETTINGS_PAGES)[number];
/** The list draws a Tools heading above this page; it and every page after it are tools (plan 117). */
export const TOOLS_GROUP_START: SettingsPage = "plugins";
export const TOOLS_GROUP_TITLE = "Tools";

export interface SettingsDialogState {
  /** Null while closed. */
  readonly page: SettingsPage | null;
  readonly show: (page?: SettingsPage) => void;
  readonly hide: () => void;
}

export const useSettingsDialog = create<SettingsDialogState>()((set) => ({
  page: null,
  show: (page = "appearance") => set({ page }),
  hide: () => set({ page: null }),
}));
