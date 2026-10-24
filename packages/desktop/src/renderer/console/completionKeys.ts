import { acceptCompletion } from "@codemirror/autocomplete";
import { CharCategory, EditorState, Prec, type Extension } from "@codemirror/state";
import { keymap, type Command } from "@codemirror/view";

const COMPLETE_EVENT = "input.complete";

let replacingRest = false;

/** Where the identifier the caret is in ends, at or after `pos`. */
export function restOfWordEnd(state: EditorState, pos: number): number {
  const isWord = state.charCategorizer(pos);
  const line = state.doc.lineAt(pos);
  let end = pos;
  while (end < line.to && isWord(state.sliceDoc(end, end + 1)) === CharCategory.Word) end += 1;
  return end;
}

/** Runs `apply` so that the completion it applies also overwrites the rest of the identifier. */
export function replacingRestOfWord<T>(apply: () => T): T {
  replacingRest = true;
  try {
    return apply();
  } finally {
    replacingRest = false;
  }
}

/**
 * Extends the completion transaction rather than following it with a delete, so that a Tab
 * accept stays one change and one undo step.
 */
export const restOfWordFilter = EditorState.transactionFilter.of((transaction) => {
  if (!replacingRest || !transaction.isUserEvent(COMPLETE_EVENT)) return transaction;
  const before = transaction.startState;
  const head = before.selection.main.head;
  const length = restOfWordEnd(before, head) - head;
  if (length === 0) return transaction;
  // The end of the inserted text, not the new caret: a function's caret lands inside its `()`.
  const at = transaction.changes.mapPos(head, 1);
  return [transaction, { changes: { from: at, to: at + length }, sequential: true }];
});

/**
 * Tab accepts the selected completion and replaces the identifier the caret is in, as DataGrip
 * does; Enter keeps CodeMirror's insert (decision 059). Without an open popup it returns false
 * and Tab falls through to snippet fields, indenting or focus.
 */
export const acceptCompletionReplacing: Command = (view) => replacingRestOfWord(() => acceptCompletion(view));

/** Highest precedence, beside CodeMirror's own completion keymap, so it runs before `indentWithTab`. */
export const tabAcceptsCompletion: Extension = [
  restOfWordFilter,
  Prec.highest(keymap.of([{ key: "Tab", run: acceptCompletionReplacing }])),
];
