import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { live, shown, type ShownResult } from "@table-craft/desktop/renderer/actions/gridActions.js";
import { writeClipboard } from "@table-craft/desktop/renderer/state/clipboard.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import {
  editableSurfaceOf,
  editSurfaceOf,
  type EditSurface,
} from "@table-craft/desktop/renderer/actions/resultEditing.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { exportChart } from "@table-craft/desktop/renderer/actions/chartExport.js";
import { chartInstance } from "@table-craft/desktop/renderer/chart/instances.js";
import type { ChartSpec } from "@table-craft/desktop/engine/protocol.js";
import {
  blobLimitBytes,
  focusedBinaryCell,
  suggestedFileName,
  type BinaryCell,
} from "@table-craft/desktop/renderer/model/binaryCells.js";
import { visibleColumns } from "@table-craft/desktop/renderer/model/columnLayout.js";
import type { BufferCell } from "@table-craft/desktop/renderer/model/editBuffer.js";
import { canWriteCell } from "@table-craft/desktop/renderer/model/resultEdits.js";
import {
  aggregateParts,
  aggregateRequest,
  aggregateText,
  toggledAggregate,
} from "@table-craft/desktop/renderer/model/aggregates.js";
import { currentFormats, useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import { AGGREGATE_NAMES, type AggregateName } from "@table-craft/desktop/settings/settings.js";

export const GRID_HELPER_ACTION_IDS = {
  copyAggregates: "grid.copyAggregates",
  toggleAggregate: "grid.toggleAggregate",
  transpose: "grid.transpose",
  toggleChart: "grid.toggleChart",
  setChart: "grid.setChart",
  resetChartZoom: "grid.resetChartZoom",
  exportChart: "grid.exportChart",
  saveBytes: "grid.saveBytes",
  loadBytes: "grid.loadBytes",
} as const;

const SAVE_TITLE = "Save Value to File";
const LOAD_TITLE = "Load File into Cell";

function blobLimit(): number {
  return blobLimitBytes(useSettings.getState().settings.data.blobLimitMb);
}

/** The focused binary cell of the shown result, whose bytes Save to File writes. */
function savable(context: ActionContext): { readonly target: ShownResult; readonly cell: BinaryCell } | null {
  const target = shown(context);
  if (target === null || target.result.stale) return null;
  const cell = focusedBinaryCell(target.result, editSurfaceOf(context)?.target.buffer);
  return cell === null ? null : { target, cell };
}

/** The focused cell of a binary column an editable table or console result can write a file into. */
function loadable(
  context: ActionContext,
): { readonly target: ShownResult; readonly surface: EditSurface; readonly cell: BufferCell } | null {
  const target = shown(context);
  const surface = editableSurfaceOf(context);
  if (target === null || surface === null || context.keyTab !== null || surface.editing !== null) return null;
  const focus = target.result.selection?.focus;
  const column = focus === undefined ? undefined : visibleColumns(target.result.layout)[focus.column];
  if (focus === undefined || column === undefined || target.result.typeClasses[column] !== "bytes") return null;
  const cell = { row: focus.row, column };
  return canWriteCell(surface.target, cell) ? { target, surface, cell } : null;
}

/** The shown result while its chart replaces the rows. */
function charted(context: ActionContext): ShownResult | null {
  const target = shown(context);
  return target?.result.chart?.shown === true ? target : null;
}

/** Whether the shown result draws its rows, which Transpose and the value panel work on. */
export function showsRows(context: ActionContext): boolean {
  return shown(context) !== null && charted(context) === null;
}

export interface ChartArgs {
  readonly spec: ChartSpec;
}

export interface AggregateArgs {
  readonly name: AggregateName;
}

function isAggregateName(value: unknown): value is AggregateName {
  return (AGGREGATE_NAMES as readonly unknown[]).includes(value);
}

export const GRID_HELPER_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: GRID_HELPER_ACTION_IDS.copyAggregates,
    title: "Copy Selection Aggregates",
    category: "Result Grid",
    icon: "copy",
    when: (context) => {
      const target = live(context);
      return target !== null && aggregateRequest(target.result) !== null;
    },
    run: async (context) => {
      const target = live(context);
      const request = target === null ? null : aggregateRequest(target.result);
      if (target === null || request === null) return;
      const aggregates = await target.host.aggregate(target.ownerId, target.result.id, request.rows, request.columns);
      if (aggregates === null) return;
      const parts = aggregateParts(aggregates, useSettings.getState().settings.data.aggregates, currentFormats());
      if (parts.length > 0) await writeClipboard(aggregateText(parts));
    },
  }),
  defineAction<AggregateArgs | undefined>({
    id: GRID_HELPER_ACTION_IDS.toggleAggregate,
    title: "Show or Hide a Selection Aggregate",
    category: "Result Grid",
    run: async (_context, args) => {
      const name = args?.name;
      if (!isAggregateName(name)) return;
      await useSettings.getState().update((settings) => ({
        ...settings,
        data: { ...settings.data, aggregates: toggledAggregate(settings.data.aggregates, name) },
      }));
    },
  }),
  defineAction({
    id: GRID_HELPER_ACTION_IDS.transpose,
    title: "Transpose",
    category: "Result Grid",
    icon: "transpose",
    shortcut: "Mod+Alt+T",
    shortcutRegion: "grid",
    when: showsRows,
    run: (context) => {
      const target = shown(context);
      if (target === null) return;
      const { layout } = target.result;
      target.host.setLayout(target.ownerId, target.result.id, { ...layout, transposed: layout.transposed !== true });
    },
  }),
  defineAction({
    id: GRID_HELPER_ACTION_IDS.toggleChart,
    title: "Show Chart",
    category: "Result Grid",
    icon: "chart",
    shortcut: "Mod+Alt+C",
    shortcutRegion: "grid",
    when: (context) => shown(context) !== null,
    run: (context) => {
      const target = shown(context);
      if (target === null) return;
      const { chart } = target.result;
      target.host.setChart(target.ownerId, target.result.id, {
        shown: chart?.shown !== true,
        spec: chart?.spec ?? null,
      });
    },
  }),
  defineAction<ChartArgs | undefined>({
    id: GRID_HELPER_ACTION_IDS.setChart,
    title: "Change Chart",
    category: "Result Grid",
    inPalette: false,
    when: (context) => charted(context) !== null,
    run: (context, args) => {
      const target = charted(context);
      if (target === null || args === undefined) return;
      target.host.setChart(target.ownerId, target.result.id, { shown: true, spec: args.spec });
    },
  }),
  defineAction({
    id: GRID_HELPER_ACTION_IDS.resetChartZoom,
    title: "Reset Chart Zoom",
    category: "Result Grid",
    icon: "fit",
    when: (context) => charted(context) !== null,
    run: (context) => {
      const target = charted(context);
      if (target === null) return;
      chartInstance(target.ownerId, target.result.id)?.dispatchAction({ type: "dataZoom", start: 0, end: 100 });
    },
  }),
  defineAction({
    id: GRID_HELPER_ACTION_IDS.exportChart,
    title: "Export Chart as PNG…",
    category: "Result Grid",
    icon: "exportPng",
    when: (context) => charted(context) !== null,
    run: async (context) => {
      const target = charted(context);
      const chart = target === null ? undefined : chartInstance(target.ownerId, target.result.id);
      if (chart === undefined) return;
      await exportChart(chart, context.activeTab?.title ?? "");
    },
  }),
  defineAction({
    id: GRID_HELPER_ACTION_IDS.saveBytes,
    title: "Save Value to File…",
    category: "Result Grid",
    icon: "saveFile",
    when: (context) => savable(context) !== null,
    run: async (context) => {
      const found = savable(context);
      if (found === null) return;
      const { target, cell } = found;
      const name = target.result.columns[cell.column]?.name ?? "";
      const chosen = await bridge().saveFile(SAVE_TITLE, suggestedFileName(name, cell.value.preview));
      if (!chosen.ok || chosen.value === null) return;
      const at = { row: cell.held, column: cell.column };
      await target.host.saveBytes(target.ownerId, target.result.id, at, chosen.value, blobLimit());
    },
  }),
  defineAction({
    id: GRID_HELPER_ACTION_IDS.loadBytes,
    title: "Load File into Cell…",
    category: "Result Grid",
    icon: "loadFile",
    when: (context) => loadable(context) !== null,
    run: async (context) => {
      const found = loadable(context);
      if (found === null) return;
      const chosen = await bridge().openAnyFile(LOAD_TITLE);
      if (!chosen.ok || chosen.value === null) return;
      const { target, surface, cell } = found;
      const staged = await target.host.loadBytes(target.ownerId, target.result.id, chosen.value, blobLimit());
      if (staged !== null) surface.setCells([cell], { kind: "bytes", ...staged });
    },
  }),
];
