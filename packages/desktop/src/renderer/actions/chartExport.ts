import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import type { ChartInstance } from "@table-craft/desktop/renderer/chart/instances.js";
import { CHART_PALETTE_VARIABLES } from "@table-craft/desktop/renderer/chart/palette.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";

/** Twice the screen's pixels, so the PNG stays sharp in a document or a slide. */
export const CHART_PNG_PIXEL_RATIO = 2;
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const UNSAFE_FILE_CHARACTERS = /[\\/:*?"<>|\s]+/gu;
const DEFAULT_CHART_NAME = "chart";

/** The plot is transparent on screen; the PNG takes the canvas colour it sits on, so it reads the same in a file. */
function background(element: HTMLElement): string {
  return getComputedStyle(element).getPropertyValue(CHART_PALETTE_VARIABLES.canvas).trim();
}

export function chartFileName(title: string): string {
  const stem = title.replace(UNSAFE_FILE_CHARACTERS, "-").replace(/^-+|-+$/gu, "");
  return `${stem === "" ? "" : `${stem}-`}${DEFAULT_CHART_NAME}.png`;
}

export function pngBytes(dataUrl: string): Uint8Array {
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) throw new Error("The chart did not draw as a PNG.");
  const text = atob(dataUrl.slice(PNG_DATA_URL_PREFIX.length));
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}

async function notice(message: string, hint: string): Promise<void> {
  await useModal.getState().ask({ kind: "notice", title: "Could not export the chart", message, hint });
}

/** Draws the chart as it shows now and hands the PNG to main's save dialog. */
export async function exportChart(chart: ChartInstance, title: string): Promise<void> {
  try {
    const dataUrl = chart.getDataURL({
      type: "png",
      pixelRatio: CHART_PNG_PIXEL_RATIO,
      backgroundColor: background(chart.getDom()),
      excludeComponents: ["dataZoom"],
    });
    const saved = await bridge().exportChartImage({ data: pngBytes(dataUrl), defaultName: chartFileName(title) });
    if (!saved.ok) await notice(saved.error.message, saved.error.hint);
  } catch (cause) {
    const error = toError(cause);
    await notice(error.message, error.hint);
  }
}
