import { getSearchQuery, setSearchQuery, type SearchQuery } from "@codemirror/search";
import { StateEffect, StateField, type ChangeDesc, type EditorState, type Transaction } from "@codemirror/state";

export interface FindRange {
  readonly from: number;
  readonly to: number;
}

/** What the console's find bar keeps beside CodeMirror's own search query (plan 139). */
export interface FindScope {
  readonly replaceOpen: boolean;
  readonly preserveCase: boolean;
  /** Matches count only inside these ranges; null searches the whole document. */
  readonly inSelection: readonly FindRange[] | null;
  /** Matches the user excluded; Replace All skips them. */
  readonly excluded: readonly FindRange[];
}

const NO_RANGES: readonly FindRange[] = [];

export const EMPTY_FIND_SCOPE: FindScope = {
  replaceOpen: false,
  preserveCase: false,
  inSelection: null,
  excluded: NO_RANGES,
};

/** Replaces the named parts of the scope. */
export const patchFindScope = StateEffect.define<Partial<FindScope>>();
/** Adds one match to the excluded set. */
export const excludeRange = StateEffect.define<FindRange>();

/** In Selection grows with text typed at its edges, so a Replace All inside it stays inside it. */
function mapScopeRanges(ranges: readonly FindRange[], changes: ChangeDesc): readonly FindRange[] {
  return ranges
    .map((range) => ({ from: changes.mapPos(range.from, -1), to: changes.mapPos(range.to, 1) }))
    .filter((range) => range.from < range.to);
}

/** An excluded match drops out once its text is edited away. */
function mapExcluded(ranges: readonly FindRange[], changes: ChangeDesc): readonly FindRange[] {
  return ranges
    .map((range) => ({ from: changes.mapPos(range.from, 1), to: changes.mapPos(range.to, -1) }))
    .filter((range) => range.from < range.to);
}

function sameSearch(a: SearchQuery, b: SearchQuery): boolean {
  return (
    a.search === b.search && a.caseSensitive === b.caseSensitive && a.regexp === b.regexp && a.wholeWord === b.wholeWord
  );
}

function queryChanged(transaction: Transaction): boolean {
  const before = getSearchQuery(transaction.startState);
  return transaction.effects.some((effect) => effect.is(setSearchQuery) && !sameSearch(effect.value, before));
}

function clamp(ranges: readonly FindRange[], length: number): readonly FindRange[] {
  return ranges
    .map((range) => ({ from: Math.min(range.from, length), to: Math.min(range.to, length) }))
    .filter((range) => range.from < range.to);
}

export const findScopeField = StateField.define<FindScope>({
  create: () => EMPTY_FIND_SCOPE,
  update(value, transaction) {
    let next = value;
    if (transaction.docChanged && (next.inSelection !== null || next.excluded.length > 0)) {
      next = {
        ...next,
        inSelection: next.inSelection === null ? null : mapScopeRanges(next.inSelection, transaction.changes),
        excluded: mapExcluded(next.excluded, transaction.changes),
      };
    }
    if (next.excluded.length > 0 && queryChanged(transaction)) next = { ...next, excluded: NO_RANGES };
    const length = transaction.state.doc.length;
    for (const effect of transaction.effects) {
      if (effect.is(patchFindScope)) {
        const patch = effect.value;
        next = {
          ...next,
          ...patch,
          inSelection:
            patch.inSelection === undefined ? next.inSelection : patch.inSelection && clamp(patch.inSelection, length),
          excluded: patch.excluded === undefined ? next.excluded : clamp(patch.excluded, length),
        };
      } else if (effect.is(excludeRange)) {
        next = { ...next, excluded: [...next.excluded, effect.value] };
      }
    }
    return next;
  },
});

export function findScope(state: EditorState): FindScope {
  return state.field(findScopeField, false) ?? EMPTY_FIND_SCOPE;
}

/**
 * The `SearchQuery.test` every console query carries: one function, so `SearchQuery.eq` holds while
 * the scope changes, reading In Selection and Exclude from the state it is handed.
 */
export function scopeTest(_match: string, state: EditorState, from: number, to: number): boolean {
  const scope = findScope(state);
  if (scope.inSelection !== null && !scope.inSelection.some((range) => from >= range.from && to <= range.to)) {
    return false;
  }
  return !scope.excluded.some((range) => range.from === from && range.to === to);
}
