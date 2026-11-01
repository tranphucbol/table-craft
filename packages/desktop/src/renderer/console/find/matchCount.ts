import type { SearchQuery } from "@codemirror/search";
import type { EditorState, SelectionRange } from "@codemirror/state";
import type { FindRange } from "@table-craft/desktop/renderer/console/find/findState.js";

/** Counting stops here, so a pattern matching every character of a 10 MB paste still answers at once. */
export const MATCH_COUNT_CAP = 10_000;

/** The matches of one query over one document, in order. */
export interface FoundMatches {
  readonly ranges: readonly FindRange[];
  /** More matches exist past `MATCH_COUNT_CAP`. */
  readonly capped: boolean;
}

export interface MatchCount {
  readonly total: number;
  readonly capped: boolean;
  /** 1-based index of the main selection among the matches, or null. */
  readonly current: number | null;
}

/** The matches, `invalid` for a regex that does not compile, null for an empty query. */
export function findMatches(state: EditorState, query: SearchQuery): FoundMatches | "invalid" | null {
  if (query.search === "") return null;
  if (!query.valid) return "invalid";
  const ranges: FindRange[] = [];
  const cursor = query.getCursor(state);
  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    if (ranges.length === MATCH_COUNT_CAP) return { ranges, capped: true };
    ranges.push({ from: step.value.from, to: step.value.to });
  }
  return { ranges, capped: false };
}

/** The 1-based index of the match `selection` covers exactly, or null. */
export function currentMatch(found: FoundMatches, selection: Pick<SelectionRange, "from" | "to">): number | null {
  let low = 0;
  let high = found.ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const range = found.ranges[middle];
    if (range === undefined) return null;
    if (range.from < selection.from) low = middle + 1;
    else if (range.from > selection.from) high = middle - 1;
    else return range.to === selection.to ? middle + 1 : null;
  }
  return null;
}

export function countOf(found: FoundMatches, selection: Pick<SelectionRange, "from" | "to">): MatchCount {
  return { total: found.ranges.length, capped: found.capped, current: currentMatch(found, selection) };
}

export function countMatches(state: EditorState, query: SearchQuery): MatchCount | "invalid" | null {
  const found = findMatches(state, query);
  return found === null || found === "invalid" ? found : countOf(found, state.selection.main);
}

const CAP_TEXT = `${MATCH_COUNT_CAP.toLocaleString("en-US")}+`;

/** Stands for the current match while the caret is on none, as VS Code's "? of 12". */
const NO_CURRENT = "?";

/**
 * The bar's counter, kept short so it sits sized to its text right before the arrows: `3/12`,
 * `?/12` off a match, `0/0`, `1/10,000+`.
 */
export function counterText(count: MatchCount | "invalid" | null): string {
  if (count === null) return "";
  if (count === "invalid") return "Bad pattern";
  const total = count.capped ? CAP_TEXT : String(count.total);
  const current = count.total === 0 ? "0" : count.current === null ? NO_CURRENT : String(count.current);
  return `${current}/${total}`;
}

/** The counter as a screen reader should say it: "2 of 3 matches" where the bar shows "2/3". */
export function counterSpoken(count: MatchCount | "invalid" | null): string {
  if (count === null || count === "invalid") return counterText(count);
  if (count.total === 0) return "No matches";
  const total = count.capped ? `more than ${MATCH_COUNT_CAP.toLocaleString("en-US")}` : String(count.total);
  const noun = !count.capped && count.total === 1 ? "match" : "matches";
  return count.current === null ? `${total} ${noun}` : `${String(count.current)} of ${total} ${noun}`;
}

/** Whether the counter should read as a failure: no match, or a pattern that does not compile. */
export function countFailed(count: MatchCount | "invalid" | null): boolean {
  return count === "invalid" || (count !== null && count.total === 0);
}
