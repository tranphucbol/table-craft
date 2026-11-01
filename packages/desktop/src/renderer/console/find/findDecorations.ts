import { searchPanelOpen } from "@codemirror/search";
import { Prec, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import {
  FIND_EXCLUDED_CLASS,
  FIND_OPEN_CLASS,
  FIND_SCOPE_CLASS,
} from "@table-craft/desktop/renderer/console/editorTheme.js";
import { findScope, findScopeField, type FindRange } from "@table-craft/desktop/renderer/console/find/findState.js";

const SCOPE_MARK = Decoration.mark({ class: FIND_SCOPE_CLASS });
const EXCLUDED_MARK = Decoration.mark({ class: FIND_EXCLUDED_CLASS });

function marks(ranges: readonly FindRange[], mark: Decoration): DecorationSet {
  return Decoration.set(
    ranges.map((range) => mark.range(range.from, range.to)),
    true,
  );
}

function scopeMarks(state: EditorState): DecorationSet {
  const ranges = findScope(state).inSelection;
  return ranges === null ? Decoration.none : marks(ranges, SCOPE_MARK);
}

function excludedMarks(state: EditorState): DecorationSet {
  return marks(findScope(state).excluded, EXCLUDED_MARK);
}

/**
 * What the find bar shows in the text beside CodeMirror's own match marks: the In Selection range,
 * the excluded matches, and the class that hides the selection's echoes while the bar is open.
 */
export const findDecorations: Extension = [
  // Lowest, so the In Selection band wraps the match marks instead of covering them.
  Prec.lowest(EditorView.decorations.compute([findScopeField], scopeMarks)),
  EditorView.decorations.compute([findScopeField], excludedMarks),
  EditorView.editorAttributes.of((view) => (searchPanelOpen(view.state) ? { class: FIND_OPEN_CLASS } : null)),
];
