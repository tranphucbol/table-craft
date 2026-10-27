import type { RowRange, SelectionAggregates } from "@table-craft/desktop/engine/protocol.js";
import { formatCell, type CellFormats } from "@table-craft/desktop/renderer/grid/format.js";
import { visibleColumns } from "@table-craft/desktop/renderer/model/columnLayout.js";
import { cellCount, selectedRanges } from "@table-craft/desktop/renderer/model/gridSelection.js";
import { shownRowCount, type ResultTab } from "@table-craft/desktop/renderer/state/resultTab.js";
import { AGGREGATE_NAMES, type AggregateName } from "@table-craft/desktop/settings/settings.js";

/** Fewer selected cells than this show the row count alone, as DataGrip does. */
export const MIN_AGGREGATE_CELLS = 2;

export const AGGREGATE_LABELS: Readonly<Record<AggregateName, string>> = {
  count: "Count",
  distinct: "Distinct",
  sum: "Sum",
  avg: "Avg",
  min: "Min",
  max: "Max",
};

const PART_SEPARATOR = ", ";

export interface AggregatePart {
  readonly name: AggregateName;
  readonly label: string;
  readonly text: string;
}

/**
 * The engine request for the selection's aggregates: the held rows it covers and its result
 * columns. Null below two cells, on a stale result, or when the selection holds only rows the table
 * editor added, which are not in the engine yet.
 */
export function aggregateRequest(
  result: ResultTab,
): { readonly rows: readonly RowRange[]; readonly columns: readonly number[] } | null {
  const { selection } = result;
  if (selection === null || result.stale || cellCount(selection) < MIN_AGGREGATE_CELLS) return null;
  const { rows, columns } = selectedRanges(selection, visibleColumns(result.layout));
  const shown = shownRowCount(result);
  const held = rows.flatMap((range) =>
    range.from >= shown ? [] : [{ from: range.from, to: Math.min(range.to, shown) }],
  );
  return held.length === 0 || columns.length === 0 ? null : { rows: held, columns };
}

/** The chosen aggregates that apply to the selection, as the status line reads them. */
export function aggregateParts(
  aggregates: SelectionAggregates,
  chosen: readonly AggregateName[],
  formats: CellFormats,
): AggregatePart[] {
  const valueClass = aggregates.kind === "numeric" ? "decimal" : "temporal";
  const texts: Readonly<Record<AggregateName, string | null>> = {
    count: formatCell(aggregates.cells, "integer", formats),
    distinct: formatCell(aggregates.distinct, "integer", formats),
    sum: aggregates.sum === null ? null : formatCell(aggregates.sum, "decimal", formats),
    avg: aggregates.avg === null ? null : formatCell(aggregates.avg, "decimal", formats),
    min: aggregates.min === null ? null : formatCell(aggregates.min, valueClass, formats),
    max: aggregates.max === null ? null : formatCell(aggregates.max, valueClass, formats),
  };
  return AGGREGATE_NAMES.flatMap((name) => {
    const text = texts[name];
    return chosen.includes(name) && text !== null ? [{ name, label: AGGREGATE_LABELS[name], text }] : [];
  });
}

/** The line as the clipboard takes it. */
export function aggregateText(parts: readonly AggregatePart[]): string {
  return parts.map((part) => `${part.label}: ${part.text}`).join(PART_SEPARATOR);
}

/** `chosen` with `name` turned on or off, in the order the line shows them. */
export function toggledAggregate(chosen: readonly AggregateName[], name: AggregateName): AggregateName[] {
  const on = chosen.includes(name);
  return AGGREGATE_NAMES.filter((each) => (each === name ? !on : chosen.includes(each)));
}
