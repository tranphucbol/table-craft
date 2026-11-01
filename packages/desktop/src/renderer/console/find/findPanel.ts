import { runScopeHandlers, type EditorView, type Panel } from "@codemirror/view";

/** The DOM CodeMirror shows as its search panel, which React fills (plan 139 decision 1). */
export interface FindHost {
  readonly dom: HTMLElement;
  readonly view: EditorView;
  /** Called after every update of the view while the panel is shown. */
  readonly subscribe: (listener: () => void) => () => void;
}

export const FIND_PANEL_CLASS = "tc-find-panel";

const focusWanted = new WeakSet<EditorView>();
const focusHandlers = new WeakMap<EditorView, () => void>();

/** Moves focus to the find field, now if the bar is drawn, else as soon as it is. */
export function requestFindFocus(view: EditorView): void {
  const handler = focusHandlers.get(view);
  if (handler === undefined) focusWanted.add(view);
  else handler();
}

/** The bar's field registers how to take focus; a request made before it was drawn runs now. */
export function onFindFocus(view: EditorView, handler: () => void): () => void {
  focusHandlers.set(view, handler);
  if (focusWanted.delete(view)) handler();
  return () => {
    if (focusHandlers.get(view) === handler) focusHandlers.delete(view);
  };
}

/** Whether focus is in `view`'s find bar. */
export function findBarHasFocus(view: EditorView): boolean {
  const active = view.root.activeElement;
  return active !== null && view.dom.querySelector(`.${FIND_PANEL_CLASS}`)?.contains(active) === true;
}

/**
 * CodeMirror's `createPanel` for the console: an empty host handed to `onHost` while shown. Keys
 * the registry leaves alone in the bar (Escape, F3) run CodeMirror's `search-panel` bindings, as
 * its own panel does.
 */
export function findPanel(onHost: (host: FindHost | null) => void): (view: EditorView) => Panel {
  return (view) => {
    const dom = document.createElement("div");
    dom.className = FIND_PANEL_CLASS;
    const listeners = new Set<() => void>();
    const host: FindHost = {
      dom,
      view,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    dom.addEventListener("keydown", (event) => {
      if (runScopeHandlers(view, event, "search-panel")) event.preventDefault();
    });
    return {
      dom,
      top: true,
      mount: () => onHost(host),
      update: () => {
        for (const listener of listeners) listener();
      },
      destroy: () => {
        focusWanted.delete(view);
        onHost(null);
      },
    };
  };
}
