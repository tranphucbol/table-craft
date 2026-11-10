import { useEffect, useMemo, useRef, useState } from "react";
import type { ChartData, ChartSpec, EngineError } from "@table-craft/desktop/engine/protocol.js";
import { ChartBar } from "@table-craft/desktop/renderer/chart/ChartBar.js";
import { chartKey } from "@table-craft/desktop/renderer/chart/instances.js";
import { readChartPalette } from "@table-craft/desktop/renderer/chart/palette.js";
import { useAppearanceVersion, useEChart } from "@table-craft/desktop/renderer/chart/useEChart.js";
import type { GridHost } from "@table-craft/desktop/renderer/grid/GridCells.js";
import {
  chartLabel,
  chartOption,
  chartStatusParts,
  chartZooms,
} from "@table-craft/desktop/renderer/model/chartOption.js";
import { effectiveSpec } from "@table-craft/desktop/renderer/model/chartSpec.js";
import type { ResultTab } from "@table-craft/desktop/renderer/state/resultTab.js";
import { useCellFormats } from "@table-craft/desktop/renderer/state/settings.js";

/** A burst of changes, such as rows arriving page by page, asks the engine once (plan 155 decision 21). */
const CHART_REFRESH_MS = 250;
const NOTHING_TO_PLOT = "Nothing to plot: the result has no numeric column.";
const LOADING_TEXT = "Drawing…";
const STATUS_SEPARATOR = " · ";

type Shaped =
  | { readonly state: "waiting" }
  | { readonly state: "drawn"; readonly data: ChartData; readonly spec: ChartSpec }
  | { readonly state: "failed"; readonly error: EngineError };

const WAITING: Shaped = { state: "waiting" };

function Message({ children, tone = "muted" }: { readonly children: string; readonly tone?: "muted" | "danger" }) {
  return (
    <div
      role="status"
      className={tone === "danger" ? "m-auto max-w-prose p-gap text-danger" : "m-auto max-w-prose p-gap text-ink-muted"}
    >
      {children}
    </div>
  );
}

/**
 * The chart that replaces a result's rows (plan 155): the engine shapes the series from the rows
 * the grid shows, and ECharts draws them in the theme's colours.
 */
export function ChartView({
  ownerId,
  result,
  host,
}: {
  readonly ownerId: string;
  readonly result: ResultTab;
  readonly host: () => GridHost;
}) {
  const { columns, typeClasses, chart } = result;
  const spec = useMemo(() => effectiveSpec(chart, columns, typeClasses), [chart, columns, typeClasses]);
  const [shaped, setShaped] = useState<Shaped>(WAITING);
  const asked = useRef(0);
  const specKey = JSON.stringify(spec);
  const resultId = result.id;
  const { handle, rowCount, sort, view, stale } = result;

  useEffect(() => {
    if (spec === null || stale) return;
    const request = ++asked.current;
    const timer = setTimeout(
      () => {
        void host()
          .chart(ownerId, resultId, spec)
          .then((answer) => {
            if (answer === null || request !== asked.current) return;
            setShaped(
              "data" in answer ? { state: "drawn", data: answer.data, spec } : { state: "failed", error: answer.error },
            );
          });
      },
      shaped.state === "waiting" ? 0 : CHART_REFRESH_MS,
    );
    return () => clearTimeout(timer);
    // `shaped` only picks the delay; a new answer must not ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, ownerId, resultId, handle, specKey, rowCount, sort, view, stale]);

  const appearance = useAppearanceVersion();
  const formats = useCellFormats();
  const names = useMemo(() => columns.map((column) => column.name), [columns]);
  const drawn = shaped.state === "drawn" ? shaped : null;
  const option = useMemo(
    () =>
      drawn === null
        ? null
        : chartOption(drawn.data, drawn.spec, { names, classes: typeClasses }, readChartPalette(), formats),
    // `appearance` re-reads the theme's variables after a theme or density switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drawn, names, typeClasses, formats, appearance],
  );
  const { ref, failed, zoomed } = useEChart(chartKey(ownerId, resultId), option);

  if (spec === null) return <Message>{NOTHING_TO_PLOT}</Message>;
  const label = drawn === null ? null : chartLabel(drawn.data, drawn.spec, { names, classes: typeClasses });
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="chart-view">
      <ChartBar
        spec={spec}
        columns={columns}
        classes={typeClasses}
        zoomed={zoomed && drawn !== null && chartZooms(drawn.data, drawn.spec)}
      />
      <div className="relative flex min-h-0 flex-1 bg-canvas">
        <div
          ref={ref}
          role="img"
          aria-label={label ?? LOADING_TEXT}
          data-chart-kind={drawn?.spec.kind}
          data-chart-series={drawn?.data.series.length}
          data-chart-points={drawn === null ? undefined : pointsOf(drawn.data)}
          data-chart-rows={drawn?.data.rows}
          className="tc-chart absolute inset-0"
        />
        {failed !== null ? (
          <div className="absolute inset-0 flex bg-canvas">
            <Message tone="danger">{`The chart library did not load: ${failed}`}</Message>
          </div>
        ) : shaped.state === "failed" ? (
          <div className="absolute inset-0 flex bg-canvas">
            <Message tone="danger">{`${shaped.error.message} ${shaped.error.hint}`}</Message>
          </div>
        ) : null}
      </div>
      {drawn === null ? null : (
        <div
          role="status"
          data-testid="chart-status"
          className="h-row shrink-0 truncate border-t border-line bg-panel px-gap leading-(--spacing-row) text-ink-muted"
        >
          {chartStatusParts(drawn.data, result.cursorOpen || result.refetch === true).join(STATUS_SEPARATOR)}
        </div>
      )}
    </div>
  );
}

function pointsOf(data: ChartData): number {
  if (data.categories !== null) return data.categories.length;
  return data.series.reduce((total, series) => total + (series.points?.length ?? 0), 0);
}
