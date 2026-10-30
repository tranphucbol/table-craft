import { history } from "@codemirror/commands";
import type { Compartment, EditorState } from "@codemirror/state";

export function scrubEditorState(state: EditorState, undo: Compartment): EditorState {
  const cleared = state.update({
    changes: { from: 0, to: state.doc.length, insert: "" },
    selection: { anchor: 0 },
    effects: undo.reconfigure([]),
  }).state;
  return cleared.update({ effects: undo.reconfigure(history()) }).state;
}
