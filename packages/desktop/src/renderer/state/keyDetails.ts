import { create } from "zustand";

/** Which key tabs have their Details panel open; closed until asked for. */
export interface KeyDetailsState {
  readonly open: Readonly<Record<string, true>>;
  readonly toggle: (tabId: string) => void;
}

export const useKeyDetails = create<KeyDetailsState>()((set) => ({
  open: {},
  toggle: (tabId) =>
    set(({ open }) => {
      if (open[tabId] === undefined) return { open: { ...open, [tabId]: true } };
      const { [tabId]: _closed, ...rest } = open;
      return { open: rest };
    }),
}));
