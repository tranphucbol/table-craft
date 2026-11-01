import type { SearchQuery } from "@codemirror/search";
import type { EditorState } from "@codemirror/state";
import type { FindScope } from "@table-craft/desktop/renderer/console/find/findState.js";

/** A longer selection is not a query anyone means to type, as CodeMirror's own panel judges. */
export const PREFILL_LIMIT = 100;

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

export function escapeRegExp(text: string): string {
  return text.replace(REGEX_SPECIALS, "\\$&");
}

/**
 * What opening the find bar searches for (plan 139 decision 11): a short single-line selection
 * becomes the query, a multi-line one becomes the In Selection scope, and otherwise the last query
 * stays.
 */
export function openingQuery(
  state: EditorState,
  last: SearchQuery,
): { readonly search: string; readonly inSelection: FindScope["inSelection"] } {
  const main = state.selection.main;
  if (main.empty) return { search: last.search, inSelection: null };
  const text = state.sliceDoc(main.from, main.to);
  if (text.includes("\n")) {
    const ranges = state.selection.ranges.filter((range) => !range.empty);
    return { search: last.search, inSelection: ranges.map((range) => ({ from: range.from, to: range.to })) };
  }
  if (text.length > PREFILL_LIMIT) return { search: last.search, inSelection: null };
  return { search: last.regexp ? escapeRegExp(text) : text, inSelection: null };
}
