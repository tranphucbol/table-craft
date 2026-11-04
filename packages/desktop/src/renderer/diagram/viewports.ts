/** What the diagram actions ask of a mounted canvas, which only React Flow inside the tab can do. */
export interface DiagramViewportControls {
  readonly fit: () => void;
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
}

const controls = new Map<string, DiagramViewportControls>();

/** Called by the tab's canvas while it is mounted; the returned function unregisters it. */
export function registerViewport(tabId: string, control: DiagramViewportControls): () => void {
  controls.set(tabId, control);
  return () => {
    if (controls.get(tabId) === control) controls.delete(tabId);
  };
}

export function viewportOf(tabId: string): DiagramViewportControls | undefined {
  return controls.get(tabId);
}
