import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  gotoLine,
  openSearchPanel,
  replaceAll,
  replaceNext,
  searchPanelOpen,
  SearchQuery,
  selectMatches,
  selectNextOccurrence,
  selectSelectionMatches,
  setSearchQuery,
} from "@codemirror/search";
import type { EditorState, StateEffect } from "@codemirror/state";
import type { EditorView, KeyBinding } from "@codemirror/view";
import { useFindHistory } from "@table-craft/desktop/renderer/console/find/findHistory.js";
import { findBarHasFocus, requestFindFocus } from "@table-craft/desktop/renderer/console/find/findPanel.js";
import {
  excludeRange,
  findScope,
  patchFindScope,
  scopeTest,
  type FindScope,
} from "@table-craft/desktop/renderer/console/find/findState.js";
import { openingQuery } from "@table-craft/desktop/renderer/console/find/prefill.js";
import { recase } from "@table-craft/desktop/renderer/console/find/preserveCase.js";

export type FindOption = "caseSensitive" | "wholeWord" | "regexp";

interface QuerySpec {
  readonly search: string;
  readonly replace: string;
  readonly caseSensitive: boolean;
  readonly regexp: boolean;
  readonly wholeWord: boolean;
}

/** What a closed console keeps of its find bar, so switching tabs and back restores it (decision 15). */
export interface SavedFind {
  readonly open: boolean;
  readonly query: QuerySpec;
  readonly scope: FindScope;
}

/**
 * Every console query is literal (decision 3: `\n` means backslash-n until `.*` is on) and carries
 * `scopeTest`, so In Selection and Exclude apply to finding, counting and Replace All alike.
 */
export function consoleQuery(state: EditorState, patch: Partial<QuerySpec> = {}): SearchQuery {
  const last = getSearchQuery(state);
  return new SearchQuery({
    search: last.search,
    replace: last.replace,
    caseSensitive: last.caseSensitive,
    regexp: last.regexp,
    wholeWord: last.wholeWord,
    ...patch,
    literal: true,
    test: scopeTest,
  });
}

/** Re-arms CodeMirror's match highlighting after the scope changed under an unchanged query. */
function rehighlight(state: EditorState): StateEffect<SearchQuery> {
  return setSearchQuery.of(getSearchQuery(state));
}

function remember(state: EditorState, replaced: boolean): void {
  const query = getSearchQuery(state);
  const history = useFindHistory.getState();
  history.record("queries", query.search);
  if (replaced) history.record("replacements", query.replace);
}

/** Whether `from`-`to` is exactly a match of the current query. */
function isMatch(state: EditorState, from: number, to: number): boolean {
  const query = getSearchQuery(state);
  if (!query.valid || from === to) return false;
  const step = query.getCursor(state, from, to).next();
  return !step.done && step.value.from === from && step.value.to === to;
}

export function onMatch(state: EditorState): boolean {
  const { from, to } = state.selection.main;
  return isMatch(state, from, to);
}

export function findOpen(state: EditorState): boolean {
  return searchPanelOpen(state);
}

export function queryValid(state: EditorState): boolean {
  return getSearchQuery(state).valid;
}

/**
 * Find (`replace` false) or Replace (true), as DataGrip's ⌘F and ⌘R (decisions 10, 11): opening
 * prefills from the selection; from inside the bar it only refocuses the field and shows or hides
 * the replace row.
 */
export function openFind(view: EditorView, options: { readonly replace: boolean }): void {
  const open = searchPanelOpen(view.state);
  const last = getSearchQuery(view.state);
  const effects: StateEffect<unknown>[] = [patchFindScope.of({ replaceOpen: options.replace })];
  if (!(open && findBarHasFocus(view))) {
    const opening = openingQuery(view.state, last);
    effects.push(
      patchFindScope.of({ inSelection: opening.inSelection, excluded: [] }),
      setSearchQuery.of(consoleQuery(view.state, { search: opening.search, replace: last.replace })),
    );
  }
  if (!open) openSearchPanel(view);
  view.dispatch({ effects });
  requestFindFocus(view);
}

export function closeFind(view: EditorView): boolean {
  if (!searchPanelOpen(view.state)) return false;
  remember(view.state, findScope(view.state).replaceOpen);
  view.dispatch({ effects: [patchFindScope.of({ inSelection: null, excluded: [] }), rehighlight(view.state)] });
  closeSearchPanel(view);
  view.focus();
  return true;
}

/** The first match at or after `from`, wrapping to the top as DataGrip's incremental search does. */
function matchFrom(state: EditorState, query: SearchQuery, from: number): { from: number; to: number } | null {
  if (query.search === "" || !query.valid) return null;
  const after = query.getCursor(state, from).next();
  if (!after.done) return after.value;
  const before = query.getCursor(state, 0, from).next();
  return before.done ? null : before.value;
}

/** Typing a query selects the nearest match from the caret on, so the counter and the view follow it. */
export function setFindText(view: EditorView, field: "search" | "replace", text: string): void {
  const query = consoleQuery(view.state, { [field]: text });
  const match = field === "search" ? matchFrom(view.state, query, view.state.selection.main.from) : null;
  view.dispatch({
    effects: setSearchQuery.of(query),
    ...(match === null
      ? {}
      : { selection: { anchor: match.from, head: match.to }, scrollIntoView: true, userEvent: "select.search" }),
  });
}

export function toggleOption(view: EditorView, option: FindOption): void {
  const last = getSearchQuery(view.state);
  view.dispatch({ effects: setSearchQuery.of(consoleQuery(view.state, { [option]: !last[option] })) });
}

export function togglePreserveCase(view: EditorView): void {
  view.dispatch({ effects: patchFindScope.of({ preserveCase: !findScope(view.state).preserveCase }) });
}

/** In Selection takes the editor's selection when turned on; the action is off while there is none. */
export function toggleInSelection(view: EditorView): void {
  const { state } = view;
  const ranges = state.selection.ranges.filter((range) => !range.empty);
  const inSelection =
    findScope(state).inSelection !== null ? null : ranges.map((range) => ({ from: range.from, to: range.to }));
  view.dispatch({ effects: [patchFindScope.of({ inSelection }), rehighlight(state)] });
}

export function canScopeToSelection(state: EditorState): boolean {
  return findScope(state).inSelection !== null || state.selection.ranges.some((range) => !range.empty);
}

export function findNextMatch(view: EditorView): boolean {
  remember(view.state, false);
  return findNext(view);
}

export function findPreviousMatch(view: EditorView): boolean {
  remember(view.state, false);
  return findPrevious(view);
}

/** Preserve case has no meaning for a regex replacement, whose `$1` CodeMirror expands itself (decision 13). */
function recasing(state: EditorState): boolean {
  return findScope(state).preserveCase && !getSearchQuery(state).regexp;
}

export function replaceCurrent(view: EditorView): boolean {
  remember(view.state, true);
  if (!recasing(view.state)) return replaceNext(view);
  const { state } = view;
  const { from, to } = state.selection.main;
  if (!isMatch(state, from, to)) return findNext(view);
  const insert = recase(state.sliceDoc(from, to), getSearchQuery(state).replace);
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    userEvent: "input.replace",
  });
  findNext(view);
  return true;
}

export function replaceEvery(view: EditorView): boolean {
  remember(view.state, true);
  if (!recasing(view.state)) return replaceAll(view);
  const { state } = view;
  const query = getSearchQuery(state);
  if (!query.valid || state.readOnly) return false;
  const changes: { from: number; to: number; insert: string }[] = [];
  const cursor = query.getCursor(state);
  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    const { from, to } = step.value;
    changes.push({ from, to, insert: recase(state.sliceDoc(from, to), query.replace) });
  }
  if (changes.length === 0) return false;
  view.dispatch({ changes, userEvent: "input.replace.all" });
  return true;
}

/** Leaves the current match out of Replace All and moves on, as DataGrip's Exclude. */
export function excludeCurrent(view: EditorView): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  if (!isMatch(state, from, to)) return false;
  view.dispatch({ effects: [excludeRange.of({ from, to }), rehighlight(state)] });
  findNext(view);
  return true;
}

/**
 * One cursor per match, leaving the bar for the editor as DataGrip does; with the bar closed, the
 * selection's text (or the word at the caret) is what is matched.
 */
export function selectAllOccurrences(view: EditorView): boolean {
  if (searchPanelOpen(view.state) && getSearchQuery(view.state).valid) {
    if (!selectMatches(view)) return false;
    closeFind(view);
    return true;
  }
  const main = view.state.selection.main;
  if (main.empty) {
    const word = view.state.wordAt(main.head);
    if (word === null) return false;
    view.dispatch({ selection: { anchor: word.from, head: word.to } });
  }
  return selectSelectionMatches(view);
}

export function savedFindOf(state: EditorState): SavedFind {
  const query = getSearchQuery(state);
  return {
    open: searchPanelOpen(state),
    query: {
      search: query.search,
      replace: query.replace,
      caseSensitive: query.caseSensitive,
      regexp: query.regexp,
      wholeWord: query.wholeWord,
    },
    scope: findScope(state),
  };
}

export function restoreFind(view: EditorView, saved: SavedFind): void {
  if (saved.open) openSearchPanel(view);
  view.dispatch({
    effects: [
      setSearchQuery.of(new SearchQuery({ ...saved.query, literal: true, test: scopeTest })),
      patchFindScope.of(saved.scope),
    ],
  });
}

/**
 * CodeMirror's `searchKeymap` without the keys the registry now owns (`Mod-f`, `Mod-g`, and
 * `Mod-Shift-l`, which New Console shadows): F3 and Escape go through the commands above, so they
 * record history and clear the scope, in the editor and in the bar alike.
 */
export const FIND_KEYMAP: readonly KeyBinding[] = [
  { key: "F3", run: findNextMatch, shift: findPreviousMatch, scope: "editor search-panel", preventDefault: true },
  { key: "Escape", run: closeFind, scope: "editor search-panel" },
  { key: "Mod-Alt-g", run: gotoLine },
  { key: "Mod-d", run: selectNextOccurrence, preventDefault: true },
];
