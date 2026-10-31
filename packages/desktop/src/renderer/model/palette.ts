import type { Chord } from "@table-craft/desktop/renderer/actions/chords.js";

/** Find Action lists actions only; Search Everywhere has a tab per provider plus `All`. */
export type PaletteMode = "findAction" | "searchEverywhere";

export const ALL_TAB = "all";

export const RECENT_ACTIONS_LIMIT = 8;
/** Enough to lift a recent item over a slightly better match, not over a much better one. */
const RECENT_BOOST = 4;

export interface SearchItem {
  /** Unique across providers, e.g. `action:console.new`. */
  readonly key: string;
  readonly title: string;
  /** Muted text after the title, such as an action's category. */
  readonly detail?: string;
  readonly shortcut?: Chord;
  /** A disabled item is listed greyed and cannot be run. */
  readonly enabled: boolean;
  /** From `fuzzy.score`; higher is better. */
  readonly score: number;
  /** The id `recent` remembers it by, when it can be recent. */
  readonly recentId?: string;
  readonly run: () => void;
}

/** One source of Search Everywhere results; plan 005 adds tables. */
export interface SearchProvider {
  readonly id: string;
  readonly title: string;
  search(query: string): readonly SearchItem[];
  /** Whether its tab shows; absent, always. The Keys tab shows only beside a key-value datasource. */
  shown?(): boolean;
}

export interface PaletteTab {
  readonly id: string;
  readonly title: string;
}

export function paletteTabs(providers: readonly SearchProvider[]): readonly PaletteTab[] {
  return [
    { id: ALL_TAB, title: "All" },
    ...providers.filter((provider) => provider.shown?.() !== false).map(({ id, title }) => ({ id, title })),
  ];
}

export function recentRank(recent: readonly string[], item: SearchItem): number {
  return item.recentId === undefined ? -1 : recent.indexOf(item.recentId);
}

function rankScore(recent: readonly string[], item: SearchItem): number {
  const rank = recentRank(recent, item);
  return rank === -1 ? item.score : item.score + RECENT_BOOST * (RECENT_ACTIONS_LIMIT - rank);
}

/**
 * The palette's rows for `query`, best first; `tab` narrows Search Everywhere to one provider.
 * Enabled rows come before disabled ones, so the highlighted first row runs whenever anything
 * can (plan 130 decision 12).
 */
export function paletteResults(
  providers: readonly SearchProvider[],
  query: string,
  recent: readonly string[],
  tab: string = ALL_TAB,
): readonly SearchItem[] {
  const shown = tab === ALL_TAB ? providers : providers.filter((provider) => provider.id === tab);
  return shown
    .flatMap((provider) => provider.search(query))
    .map((item, index) => ({ item, index, rank: rankScore(recent, item) }))
    .sort((a, b) => Number(b.item.enabled) - Number(a.item.enabled) || b.rank - a.rank || a.index - b.index)
    .map(({ item }) => item);
}

/** `recent` with `id` moved to the front, at most `RECENT_ACTIONS_LIMIT` long. */
export function pushRecent(recent: readonly string[], id: string): readonly string[] {
  return [id, ...recent.filter((entry) => entry !== id)].slice(0, RECENT_ACTIONS_LIMIT);
}
