import { create } from "zustand";

/** The Settings dialog's pages, in the order its list shows them (plan 013 decision 15). */
export const SETTINGS_PAGES = ["appearance", "editor", "dataEditor", "plugins", "advanced"] as const;
export type SettingsPage = (typeof SETTINGS_PAGES)[number];

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
