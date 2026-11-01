import { create } from "zustand";

/** The console toolbar's Run Settings popover (plan 141): at most one open, on one console. */
export interface RunSettingsPopoverState {
  /** The console whose popover is open; null when none is. */
  readonly consoleId: string | null;
  readonly show: (consoleId: string) => void;
  readonly hide: () => void;
}

export const useRunSettingsPopover = create<RunSettingsPopoverState>()((set) => ({
  consoleId: null,
  show: (consoleId) => set({ consoleId }),
  hide: () => set({ consoleId: null }),
}));
