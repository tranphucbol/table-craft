import type { Chord } from "@table-craft/desktop/renderer/actions/chords.js";

/**
 * The chords the SQL editor keeps while it has focus (plan 006 decision 21): the registry lets them
 * through to CodeMirror. `test/renderer/keymap.test.ts` fails when an action that can fire in the
 * editor declares one. Run, Run All and Commit (`Mod+Enter` and its siblings) stay with the registry,
 * and so do Find and Replace (plan 139). `Ctrl+Space` is CodeMirror's Basic Completion (plan 009
 * decision 17); `F3` and `Shift+F3` step through matches and `Escape` closes the find bar.
 */
export const EDITOR_CHORDS: readonly Chord[] = [
  "Mod+Z",
  "Mod+Shift+Z",
  "Mod+A",
  "Mod+/",
  "Mod+D",
  "Escape",
  "Ctrl+Space",
  "F3",
  "Shift+F3",
];

/**
 * The chords a plain text field keeps (plan 008): the table editor's cell editor and the value
 * panel's text field edit with them, so the grid's Copy or Delete Rows never steals them.
 */
export const FIELD_CHORDS: readonly Chord[] = [
  "Mod+Z",
  "Mod+Shift+Z",
  "Mod+A",
  "Mod+C",
  "Mod+X",
  "Mod+V",
  "Mod+Backspace",
];

/**
 * The chords the console find bar's fields keep (plan 139): a text field's, plus the bar's own
 * `Escape`, `F3` and `Shift+F3`, which CodeMirror's `search-panel` keymap runs.
 */
export const FIND_FIELD_CHORDS: readonly Chord[] = [...FIELD_CHORDS, "Escape", "F3", "Shift+F3"];

const CODE_EDITOR_SELECTOR = ".cm-editor";
const EDITOR_PANELS_SELECTOR = ".cm-panels";
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set(["text", "search", "number", "url", "email", "password"]);

function isTextField(element: Element): boolean {
  if (element instanceof HTMLTextAreaElement) return true;
  return element instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(element.type);
}

/** What the focused control keeps: a field's in an input (one in an editor's panel too), the editor's inside CodeMirror, else none. */
export function editorReservedChords(): readonly Chord[] {
  const active = document.activeElement;
  if (active === null) return [];
  if (active.closest(EDITOR_PANELS_SELECTOR) !== null) return isTextField(active) ? FIND_FIELD_CHORDS : [];
  if (active.closest(CODE_EDITOR_SELECTOR) !== null) return EDITOR_CHORDS;
  return isTextField(active) ? FIELD_CHORDS : [];
}
