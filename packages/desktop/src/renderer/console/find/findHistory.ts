import { create } from "zustand";

export const FIND_HISTORY_LIMIT = 20;

export type FindHistoryKind = "queries" | "replacements";

interface FindHistoryState {
  /** Newest first, without repeats. */
  readonly queries: readonly string[];
  readonly replacements: readonly string[];
  record(kind: FindHistoryKind, text: string): void;
}

export function recorded(list: readonly string[], text: string): readonly string[] {
  if (text === "" || list[0] === text) return list;
  return [text, ...list.filter((item) => item !== text)].slice(0, FIND_HISTORY_LIMIT);
}

/** The console find bar's recent queries and replacements, shared by every console for this session. */
export const useFindHistory = create<FindHistoryState>((set) => ({
  queries: [],
  replacements: [],
  record: (kind, text) =>
    set((state) => {
      const next = recorded(state[kind], text);
      return next === state[kind] ? state : { [kind]: next };
    }),
}));
