import { forgetLayouts } from "@table-craft/desktop/renderer/diagram/elkWorker.js";
import {
  diagramTabId,
  useDiagrams,
  type DiagramsStore,
  type DiagramTarget,
} from "@table-craft/desktop/renderer/state/diagrams.js";
import { useTabs, type TabsStore } from "@table-craft/desktop/renderer/state/tabs.js";

/** Opens the namespace's diagram, or focuses the tab already showing it (plan 152 decision 1). */
export async function openDiagramIn(
  stores: { readonly tabs: TabsStore; readonly diagrams: DiagramsStore },
  target: DiagramTarget,
): Promise<void> {
  const id = diagramTabId(target.datasourceId, target.path);
  if (stores.diagrams.getState().tabs[id] !== undefined) {
    stores.tabs.getState().activate(id);
    return;
  }
  stores.tabs.getState().open({ id, kind: "diagram", title: target.namespace });
  await stores.diagrams.getState().open(id, target);
}

export function openDiagram(target: DiagramTarget): Promise<void> {
  return openDiagramIn({ tabs: useTabs, diagrams: useDiagrams }, target);
}

/** Forgets a closed diagram tab, and any layout of it still in the worker. */
export function closeDiagram(id: string): void {
  forgetLayouts(id);
  useDiagrams.getState().close(id);
}
