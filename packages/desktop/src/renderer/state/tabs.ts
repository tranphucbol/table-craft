import { create } from "zustand";

/** A SQL console, a table open in the data editor (plan 008), or a relation's DDL (plan 010). */
export type TabKind = "console" | "table" | "ddl";

export interface Tab {
  readonly id: string;
  readonly kind: TabKind;
  readonly title: string;
}

export interface TabStrip {
  readonly tabs: readonly Tab[];
  readonly activeId: string | null;
}

export const EMPTY_STRIP: TabStrip = { tabs: [], activeId: null };

export function opened(strip: TabStrip, tab: Tab): TabStrip {
  return { tabs: [...strip.tabs, tab], activeId: tab.id };
}

export function activated(strip: TabStrip, id: string): TabStrip {
  if (strip.activeId === id || !strip.tabs.some((tab) => tab.id === id)) return strip;
  return { ...strip, activeId: id };
}

/** Closing the active tab activates its right neighbour, or its left one when it was last. */
export function closed(strip: TabStrip, id: string): TabStrip {
  const index = strip.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return strip;
  const tabs = strip.tabs.filter((tab) => tab.id !== id);
  if (strip.activeId !== id) return { tabs, activeId: strip.activeId };
  const neighbour = tabs[index] ?? tabs[index - 1] ?? null;
  return { tabs, activeId: neighbour?.id ?? null };
}

export function closedOthers(strip: TabStrip, id: string): TabStrip {
  const kept = strip.tabs.find((tab) => tab.id === id);
  return kept === undefined ? strip : { tabs: [kept], activeId: kept.id };
}

/** Activates the tab `delta` places away, wrapping at either end. */
export function cycled(strip: TabStrip, delta: number): TabStrip {
  const count = strip.tabs.length;
  const index = strip.tabs.findIndex((tab) => tab.id === strip.activeId);
  if (count < 2 || index === -1) return strip;
  const next = strip.tabs[(((index + delta) % count) + count) % count];
  return next === undefined ? strip : { ...strip, activeId: next.id };
}

/** `recent` with `activeId` first and the ids no longer in `tabs` gone: the strip's activation order. */
export function recency(recent: readonly string[], strip: TabStrip): readonly string[] {
  const open = new Set(strip.tabs.map((tab) => tab.id));
  const rest = recent.filter((id) => id !== strip.activeId && open.has(id));
  return strip.activeId === null ? rest : [strip.activeId, ...rest];
}

export interface TabsState extends TabStrip {
  /** Open tab ids, most recently active first. */
  readonly recent: readonly string[];
  readonly open: (tab: Tab) => void;
  readonly activate: (id: string) => void;
  /** Each returns the tabs it removed, so their owners can be released. */
  readonly close: (id: string) => readonly Tab[];
  readonly closeOthers: (id: string) => readonly Tab[];
  readonly closeAll: () => readonly Tab[];
  readonly cycle: (delta: number) => void;
  /** A console renamed or saved under another file name (plan 041). */
  readonly retitle: (id: string, title: string) => void;
}

export function createTabsStore() {
  return create<TabsState>()((set, get) => {
    function apply(next: TabStrip): readonly Tab[] {
      const before = get().tabs;
      set({ tabs: next.tabs, activeId: next.activeId, recent: recency(get().recent, next) });
      return before.filter((tab) => !next.tabs.includes(tab));
    }
    return {
      ...EMPTY_STRIP,
      recent: [],
      open: (tab) => void apply(opened(get(), tab)),
      activate: (id) => void apply(activated(get(), id)),
      close: (id) => apply(closed(get(), id)),
      closeOthers: (id) => apply(closedOthers(get(), id)),
      closeAll: () => apply(EMPTY_STRIP),
      cycle: (delta) => void apply(cycled(get(), delta)),
      retitle: (id, title) => {
        if (!get().tabs.some((tab) => tab.id === id && tab.title !== title)) return;
        set({ tabs: get().tabs.map((tab) => (tab.id === id ? { ...tab, title } : tab)) });
      },
    };
  });
}

export type TabsStore = ReturnType<typeof createTabsStore>;

export const useTabs = createTabsStore();

export function activeTab(strip: TabStrip): Tab | null {
  return strip.tabs.find((tab) => tab.id === strip.activeId) ?? null;
}
