import { isolateHistory } from "@codemirror/commands";
import type { EditorState, TransactionSpec } from "@codemirror/state";
import type { AgentChange, Replacement } from "@table-craft/desktop/renderer/state/consoles.js";

const AGENT_EVENT = "input.agent";

/**
 * Applies a reformat as one undo step (plan 019 decision 2); null when the text it was computed
 * from changed meanwhile, so a late answer never overwrites newer typing.
 */
export function replacementAt(state: EditorState, replacement: Replacement): TransactionSpec | null {
  const { from, to, before, text, selection } = replacement;
  if (to > state.doc.length || state.doc.sliceString(from, to) !== before) return null;
  return {
    changes: { from, to, insert: text },
    selection: { anchor: selection.from, head: selection.to },
    scrollIntoView: true,
    userEvent: "input.format",
    annotations: isolateHistory.of("full"),
  };
}

/**
 * Replaces the main selection with `text`, or inserts it at the caret, leaving the caret after it.
 * Isolated in the undo history so one undo takes back exactly this, even right after typing.
 */
export function insertionAt(state: EditorState, text: string): TransactionSpec {
  const { from, to } = state.selection.main;
  return {
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
    userEvent: "input.paste",
    annotations: isolateHistory.of("full"),
  };
}

/**
 * Applies an agent's edit as one undo step (plan 156), without taking focus; null when the view's
 * text plus the change is not `latest`, as when edits arrived while the editor was unmounted, and
 * the whole-text sync must catch up instead.
 */
export function agentChangeAt(state: EditorState, agentChange: AgentChange, latest: string): TransactionSpec | null {
  const { change, selection } = agentChange;
  const { doc } = state;
  if (change.to > doc.length) return null;
  if (doc.sliceString(0, change.from) + change.insert + doc.sliceString(change.to) !== latest) return null;
  return {
    changes: change,
    selection: { anchor: selection.from, head: selection.to },
    scrollIntoView: true,
    userEvent: AGENT_EVENT,
    annotations: isolateHistory.of("full"),
  };
}
