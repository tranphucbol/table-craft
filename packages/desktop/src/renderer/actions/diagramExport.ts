import type { DiagramImageFormat } from "@table-craft/desktop/diagrams/state.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import {
  DIAGRAM_PNG_MAX_SIDE_PX,
  DIAGRAM_PNG_SCALE,
  diagramPng,
  diagramSvg,
  readPalette,
  type DiagramImage,
} from "@table-craft/desktop/renderer/diagram/exportDiagram.js";
import { readMetrics } from "@table-craft/desktop/renderer/diagram/metrics.js";
import { shownGraph } from "@table-craft/desktop/renderer/model/diagram.js";
import { tableSizes } from "@table-craft/desktop/renderer/model/diagramLayout.js";
import {
  diagramGraphOf,
  diagramLayoutOf,
  useDiagrams,
  type DiagramTab,
} from "@table-craft/desktop/renderer/state/diagrams.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";

function placedOf(diagram: DiagramTab) {
  const state = useDiagrams.getState();
  const graph = diagramGraphOf(state, diagram);
  const layout = diagramLayoutOf(state, diagram);
  if (graph === null || layout === undefined) return null;
  const shown = shownGraph(graph, layout.hiddenTables);
  return shown.tables.some((table) => table.id in layout.positions) ? { shown, layout } : null;
}

/** Whether the tab has a placed table to export yet. */
export function canExportDiagram(diagram: DiagramTab): boolean {
  return placedOf(diagram) !== null;
}

/** The whole shown diagram as the app is drawing it now, or null while nothing is placed yet. */
export function diagramImageOf(diagram: DiagramTab): DiagramImage | null {
  const placed = placedOf(diagram);
  if (placed === null) return null;
  const { shown, layout } = placed;
  const metrics = readMetrics();
  return diagramSvg({
    graph: shown,
    positions: layout.positions,
    sizes: tableSizes(shown.tables, layout.columns, metrics),
    mode: layout.columns,
    metrics,
    palette: readPalette(),
  });
}

async function notice(title: string, message: string, hint: string): Promise<void> {
  await useModal.getState().ask({ kind: "notice", title, message, hint });
}

/** Draws the diagram in the current theme and hands it to main's save dialog (decision 18). */
export async function exportDiagram(diagram: DiagramTab, format: DiagramImageFormat): Promise<void> {
  try {
    const image = diagramImageOf(diagram);
    if (image === null) return;
    const png = format === "png" ? await diagramPng(image) : null;
    const data = png?.data ?? new TextEncoder().encode(image.svg);
    const saved = await bridge().exportDiagramImage({ format, data, defaultName: `${diagram.namespace}.${format}` });
    if (!saved.ok) {
      await notice("Could not export the diagram", saved.error.message, saved.error.hint);
      return;
    }
    if (saved.value !== null && png?.reduced === true)
      await notice(
        "Exported a smaller PNG",
        `${saved.value} is drawn at ${png.scale.toFixed(2)}× instead of ${String(DIAGRAM_PNG_SCALE)}×, so no side is longer than ${String(DIAGRAM_PNG_MAX_SIDE_PX)} px.`,
        "Export as SVG for a full-size image.",
      );
  } catch (cause) {
    const error = toError(cause);
    await notice("Could not export the diagram", error.message, error.hint);
  }
}
