import { create } from "zustand";
import type { RegistryCheck } from "@table-craft/desktop/preload/bridge.js";

/** The key of the Add/Edit form's Test connection; a saved registry's card uses its id. */
export const REGISTRY_FORM_KEY = "form";

/**
 * Settings → Plugins' registry tests in flight and their results (plan 154). A saved registry's
 * card shows the newer of its result here and the one main reports after a download.
 */
export interface RegistryTestsState {
  readonly running: ReadonlySet<string>;
  readonly results: Readonly<Record<string, RegistryCheck>>;
  readonly start: (key: string) => void;
  readonly finish: (key: string, check: RegistryCheck) => void;
  readonly forget: (key: string) => void;
}

export const useRegistryTests = create<RegistryTestsState>()((set) => ({
  running: new Set(),
  results: {},
  start: (key) => set((state) => ({ running: new Set([...state.running, key]) })),
  finish: (key, check) =>
    set((state) => {
      const running = new Set(state.running);
      running.delete(key);
      return { running, results: { ...state.results, [key]: check } };
    }),
  forget: (key) =>
    set((state) => {
      const results = { ...state.results };
      delete results[key];
      return { results };
    }),
}));
