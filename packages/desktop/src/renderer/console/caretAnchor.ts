import type { EditorView } from "@codemirror/view";
import type { PopoverAnchor } from "@table-craft/desktop/renderer/ui/Popover.js";

/** The mounted console editors, so a popover can hang from a position in one. */
const views = new Map<string, EditorView>();

/** Registers a console's editor while it is mounted; returns the unregistration. */
export function trackEditor(consoleId: string, view: EditorView): () => void {
  views.set(consoleId, view);
  return () => {
    if (views.get(consoleId) === view) views.delete(consoleId);
  };
}

/** The console's editor while it is mounted. */
export function editorOf(consoleId: string): EditorView | null {
  return views.get(consoleId) ?? null;
}

/** Where `offset` sits on screen in the console's editor, or null when it is not mounted or not drawn. */
export function caretAnchor(consoleId: string, offset: number): PopoverAnchor | null {
  const coords = views.get(consoleId)?.coordsAtPos(offset) ?? null;
  if (coords === null) return null;
  const { left, top, right, bottom } = coords;
  return { left, top, right, bottom };
}
