import { create } from "zustand";

/**
 * A SQL console, a table open in the data editor (plan 008), a relation's DDL (plan 010), a key or
 * a server's figures (plan 058).
 */
export type TabKind = "console" | "table" | "ddl" | "sessions" | "key" | "server" | "keyAdmin";

export const EDITOR_GROUPS = ["left", "right"] as const;
export type EditorGroupId = (typeof EDITOR_GROUPS)[number];

export interface Tab {
  readonly id: string;
  readonly kind: TabKind;
  readonly title: string;
  readonly groupId?: EditorGroupId;
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
  readonly groupActiveIds: Readonly<Record<EditorGroupId, string | null>>;
  readonly moveToGroup: (id: string, side: EditorGroupId) => void;
  readonly unsplit: () => void;
  readonly focusGroup: (id: EditorGroupId) => void;
  readonly restoreGroups: (
    entries: readonly { readonly id: string; readonly groupId: EditorGroupId; readonly selected: boolean }[],
  ) => void;
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
    function apply(next: TabStrip, collapse = false): readonly Tab[] {
      const before = get();
      const remaining = next.tabs.some((tab) => groupOf(tab) === "left");
      const tabs = remaining || !collapse ? next.tabs : next.tabs.map((tab) => ({ ...tab, groupId: "left" as const }));
      const closingActive = before.activeId !== null && !tabs.some((tab) => tab.id === before.activeId);
      const oldGroup = groupOf(before.tabs.find((tab) => tab.id === before.activeId));
      const groupActiveIds = { ...before.groupActiveIds };
      for (const group of EDITOR_GROUPS) {
        const members = tabs.filter((tab) => groupOf(tab) === group);
        const selected =
          !closingActive || group === oldGroup ? members.find((tab) => tab.id === next.activeId) : undefined;
        const remembered = members.find((tab) => tab.id === before.groupActiveIds[group]);
        groupActiveIds[group] = selected?.id ?? remembered?.id ?? members.at(-1)?.id ?? null;
      }
      const activeId = closingActive ? (groupActiveIds[oldGroup] ?? next.activeId) : next.activeId;
      const active = tabs.find((tab) => tab.id === activeId);
      if (active !== undefined) groupActiveIds[groupOf(active)] = active.id;
      const strip = { tabs, activeId };
      set({ ...strip, groupActiveIds, recent: recency(before.recent, strip) });
      return before.tabs.filter((tab) => !tabs.some((open) => open.id === tab.id));
    }
    function inGroup(id?: string): TabStrip {
      const state = get();
      const anchor = state.tabs.find((tab) => tab.id === (id ?? state.activeId));
      return groupStrip(state, groupOf(anchor));
    }
    function applyGroup(next: TabStrip, id?: string): readonly Tab[] {
      const group = groupOf(get().tabs.find((tab) => tab.id === (id ?? get().activeId)));
      const tabs = get().tabs.filter((tab) => groupOf(tab) !== group);
      const ordered = group === "left" ? [...next.tabs, ...tabs] : [...tabs, ...next.tabs];
      const otherActive = get().groupActiveIds[group === "left" ? "right" : "left"];
      return apply({ tabs: ordered, activeId: next.activeId ?? otherActive }, ordered.length < get().tabs.length);
    }
    return {
      ...EMPTY_STRIP,
      groupActiveIds: { left: null, right: null },
      recent: [],
      closedConsoles: [],
      open: (tab) => {
        const groupId = tab.groupId ?? groupOf(activeTab(get()));
        void apply(opened(get(), groupId === "left" && tab.groupId === undefined ? tab : { ...tab, groupId }), false);
      },
      openAfter: (anchorId, tab) => {
        const groupId = groupOf(get().tabs.find((open) => open.id === anchorId));
        void applyGroup(
          openedAfter(inGroup(anchorId), anchorId, groupId === "left" ? tab : { ...tab, groupId }),
          anchorId,
        );
      },
      togglePin: (id) => void applyGroup(pinToggled(inGroup(id), id), id),
      activate: (id) => void apply(activated(get(), id)),
      close: (id) => {
        const state = get();
        const tab = state.tabs.find((open) => open.id === id);
        if (tab === undefined) return [];
        const group = groupOf(tab);
        const next = closed(inGroup(id), id);
        const otherActive = state.groupActiveIds[group === "left" ? "right" : "left"];
        return apply(
          {
            tabs: state.tabs.filter((open) => open.id !== id),
            activeId: state.activeId === id ? (next.activeId ?? otherActive) : state.activeId,
          },
          true,
        );
      },
      closeOthers: (id) => applyGroup(closedOthers(inGroup(id), id), id),
      closeAll: () => applyGroup(closedUnpinned(inGroup())),
      closeRight: (id) => applyGroup(closedRight(inGroup(id), id), id),
      moveToGroup: (id, side) => {
        const state = get();
        const tab = state.tabs.find((open) => open.id === id);
        if (tab === undefined || state.tabs.length < 2) return;
        const split = EDITOR_GROUPS.every((group) => state.tabs.some((open) => groupOf(open) === group));
        const tabs = state.tabs.map((open) => ({
          ...open,
          groupId:
            open.id === id ? side : split ? groupOf(open) : side === "left" ? ("right" as const) : ("left" as const),
        }));
        const ordered = EDITOR_GROUPS.flatMap((group) => pinnedFirst(tabs.filter((open) => groupOf(open) === group)));
        void apply({ tabs: ordered, activeId: id }, true);
      },
      unsplit: () =>
        void apply({
          tabs: pinnedFirst(get().tabs.map((tab) => ({ ...tab, groupId: "left" }))),
          activeId: get().activeId,
        }),
      focusGroup: (id) => {
        const active = get().groupActiveIds[id];
        if (active !== null) void apply(activated(get(), active));
      },
      restoreGroups: (entries) => {
        const state = get();
        const placements = new Map(entries.map((entry) => [entry.id, entry]));
        void apply({
          tabs: state.tabs.map((tab) => {
            const entry = placements.get(tab.id);
            return entry === undefined ? tab : { ...tab, groupId: entry.groupId };
          }),
          activeId: state.activeId,
        });
        const groupActiveIds = { ...get().groupActiveIds };
        for (const entry of entries) {
          if (entry.selected && get().tabs.some((tab) => tab.id === entry.id)) groupActiveIds[entry.groupId] = entry.id;
        }
        set({ groupActiveIds, activeId: groupActiveIds[groupOf(activeTab(get()))] });
      },
      rememberClosed: (closed) => set({ closedConsoles: [...get().closedConsoles, closed].slice(-CLOSED_TABS_LIMIT) }),
      takeClosed: () => {
        const last = get().closedConsoles.at(-1);
        if (last !== undefined) set({ closedConsoles: get().closedConsoles.slice(0, -1) });
        return last;
      },
      cycle: (delta) => void applyGroup(cycled(inGroup(), delta)),
      retitle: (id, title) => {
        if (!get().tabs.some((tab) => tab.id === id && tab.title !== title)) return;
        set({ tabs: get().tabs.map((tab) => (tab.id === id ? { ...tab, title } : tab)) });
      },
    };
  });
}

export type TabsStore = ReturnType<typeof createTabsStore>;

export const useTabs = createTabsStore();

export function groupOf(tab: Tab | null | undefined): EditorGroupId {
  return tab?.groupId ?? "left";
}

export function groupStrip(state: Pick<TabsState, "tabs" | "groupActiveIds">, groupId: EditorGroupId): TabStrip {
  return { tabs: state.tabs.filter((tab) => groupOf(tab) === groupId), activeId: state.groupActiveIds[groupId] };
}

function pinnedFirst(tabs: readonly Tab[]): readonly Tab[] {
  return [...tabs.filter((tab) => tab.pinned === true), ...tabs.filter((tab) => tab.pinned !== true)];
}

export function activeTab(strip: TabStrip): Tab | null {
  return strip.tabs.find((tab) => tab.id === strip.activeId) ?? null;
}
