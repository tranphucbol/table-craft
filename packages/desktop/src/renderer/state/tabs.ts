import { create } from "zustand";

/** A SQL console, a table open in the data editor (plan 008), or a relation's DDL (plan 010). */
export type TabKind = "console" | "table" | "ddl" | "sessions";

export interface Tab {
  readonly id: string;
  readonly kind: TabKind;
  readonly title: string;
  /** Pinned tabs lead the strip and survive Close Others, Close All and Close Tabs to the Right. */
  readonly pinned?: boolean;
}

export interface TabStrip {
  readonly tabs: readonly Tab[];
  readonly activeId: string | null;
}

export const EMPTY_STRIP: TabStrip = { tabs: [], activeId: null };

export function opened(strip: TabStrip, tab: Tab): TabStrip {
  return { tabs: [...strip.tabs, tab], activeId: tab.id };
}

function pinnedCount(tabs: readonly Tab[]): number {
  return tabs.filter((tab) => tab.pinned === true).length;
}

/** Opens `tab` right after `anchorId`, though never among the pinned tabs; at the end when the anchor is gone. */
export function openedAfter(strip: TabStrip, anchorId: string, tab: Tab): TabStrip {
  const anchor = strip.tabs.findIndex((open) => open.id === anchorId);
  if (anchor === -1) return opened(strip, tab);
  const index = Math.max(anchor + 1, pinnedCount(strip.tabs));
  return { tabs: [...strip.tabs.slice(0, index), tab, ...strip.tabs.slice(index)], activeId: tab.id };
}

/** Pins a tab at the end of the pinned group, or unpins it to the start of the unpinned ones. */
export function pinToggled(strip: TabStrip, id: string): TabStrip {
  const tab = strip.tabs.find((open) => open.id === id);
  if (tab === undefined) return strip;
  const rest = strip.tabs.filter((open) => open.id !== id);
  const { pinned: _pinned, ...unpinned } = tab;
  const moved: Tab = tab.pinned === true ? unpinned : { ...tab, pinned: true };
  const index = pinnedCount(rest);
  return { ...strip, tabs: [...rest.slice(0, index), moved, ...rest.slice(index)] };
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

/** Closes the tabs among `ids`; the active one, when closed, hands over to `fallback` or its nearest neighbour. */
function closedAll(strip: TabStrip, ids: ReadonlySet<string>, fallback: string | null): TabStrip {
  const tabs = strip.tabs.filter((tab) => !ids.has(tab.id));
  if (strip.activeId === null || !ids.has(strip.activeId)) return { tabs, activeId: strip.activeId };
  if (fallback !== null && tabs.some((tab) => tab.id === fallback)) return { tabs, activeId: fallback };
  return { tabs, activeId: tabs.at(-1)?.id ?? null };
}

/** The unpinned tabs other than `id`: what Close Other Tabs closes. */
export function otherTabIds(strip: Pick<TabStrip, "tabs">, id: string): readonly string[] {
  if (!strip.tabs.some((tab) => tab.id === id)) return [];
  return strip.tabs.filter((tab) => tab.id !== id && tab.pinned !== true).map((tab) => tab.id);
}

/** The unpinned tabs right of `id`: what Close Tabs to the Right closes. */
export function rightTabIds(strip: Pick<TabStrip, "tabs">, id: string): readonly string[] {
  const index = strip.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return [];
  return strip.tabs
    .slice(index + 1)
    .filter((tab) => tab.pinned !== true)
    .map((tab) => tab.id);
}

/** The unpinned tabs: what Close All Tabs closes. */
export function unpinnedTabIds(strip: Pick<TabStrip, "tabs">): readonly string[] {
  return strip.tabs.filter((tab) => tab.pinned !== true).map((tab) => tab.id);
}

export function closedOthers(strip: TabStrip, id: string): TabStrip {
  if (!strip.tabs.some((tab) => tab.id === id)) return strip;
  return { tabs: closedAll(strip, new Set(otherTabIds(strip, id)), id).tabs, activeId: id };
}

export function closedRight(strip: TabStrip, id: string): TabStrip {
  const right = rightTabIds(strip, id);
  return right.length === 0 ? strip : closedAll(strip, new Set(right), id);
}

export function closedUnpinned(strip: TabStrip): TabStrip {
  return closedAll(strip, new Set(unpinnedTabIds(strip)), null);
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

/** A closed console tab as Reopen Closed Tab brings it back: its file, or its datasource's scratch console. */
export interface ClosedConsole {
  readonly datasourceId: string;
  readonly name: string;
  /** The text at closing, for when its scratch file is gone or its name is taken. */
  readonly sql: string;
  readonly path?: string;
  readonly pinned?: boolean;
}

/** How many closed tabs Reopen Closed Tab remembers; the oldest drop off. */
export const CLOSED_TABS_LIMIT = 20;

export interface TabsState extends TabStrip {
  /** Open tab ids, most recently active first. */
  readonly recent: readonly string[];
  /** Closed console tabs, most recently closed last. */
  readonly closedConsoles: readonly ClosedConsole[];
  readonly open: (tab: Tab) => void;
  readonly openAfter: (anchorId: string, tab: Tab) => void;
  readonly togglePin: (id: string) => void;
  readonly activate: (id: string) => void;
  /** Each returns the tabs it removed, so their owners can be released. */
  readonly close: (id: string) => readonly Tab[];
  readonly closeOthers: (id: string) => readonly Tab[];
  /** Close Others, Close All and Close to the Right leave pinned tabs open. */
  readonly closeAll: () => readonly Tab[];
  readonly closeRight: (id: string) => readonly Tab[];
  readonly rememberClosed: (closed: ClosedConsole) => void;
  /** Removes and answers the most recently closed console, if any. */
  readonly takeClosed: () => ClosedConsole | undefined;
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
      closedConsoles: [],
      open: (tab) => void apply(opened(get(), tab)),
      openAfter: (anchorId, tab) => void apply(openedAfter(get(), anchorId, tab)),
      togglePin: (id) => void apply(pinToggled(get(), id)),
      activate: (id) => void apply(activated(get(), id)),
      close: (id) => apply(closed(get(), id)),
      closeOthers: (id) => apply(closedOthers(get(), id)),
      closeAll: () => apply(closedUnpinned(get())),
      closeRight: (id) => apply(closedRight(get(), id)),
      rememberClosed: (closed) => set({ closedConsoles: [...get().closedConsoles, closed].slice(-CLOSED_TABS_LIMIT) }),
      takeClosed: () => {
        const last = get().closedConsoles.at(-1);
        if (last !== undefined) set({ closedConsoles: get().closedConsoles.slice(0, -1) });
        return last;
      },
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
