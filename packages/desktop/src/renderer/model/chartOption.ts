import type { EChartsOption, SeriesOption, XAXisComponentOption } from "echarts";
import type { ChartData, ChartKind, ChartSpec, TypeClass } from "@table-craft/desktop/engine/protocol.js";
import type { ChartPalette } from "@table-craft/desktop/renderer/chart/palette.js";
import { groupDigits } from "@table-craft/desktop/renderer/grid/format.js";
import { formatCount } from "@table-craft/desktop/renderer/model/format.js";

export interface ChartColumns {
  readonly names: readonly string[];
  readonly classes: readonly TypeClass[];
}

export interface ChartFormats {
  readonly groupDigits: boolean;
}

const KIND_TITLES: Readonly<Record<ChartKind, string>> = {
  bar: "Bar chart",
  line: "Line chart",
  area: "Area chart",
  pie: "Pie chart",
  scatter: "Scatter chart",
  histogram: "Histogram",
  stock: "Stock chart",
};

const KIND_MARKS: Readonly<Record<ChartKind, readonly [string, string]>> = {
  bar: ["bar", "bars"],
  line: ["point", "points"],
  area: ["point", "points"],
  pie: ["slice", "slices"],
  scatter: ["point", "points"],
  histogram: ["bin", "bins"],
  stock: ["candle", "candles"],
};

/** Significant digits a tooltip shows of a double; past this the digits are noise of the conversion. */
const TOOLTIP_PRECISION = 12;
const APPROXIMATE_MARK = "≈ ";
const APPROXIMATE_CLASSES: ReadonlySet<TypeClass> = new Set(["decimal"]);
const DEFAULT_FONT_PX = 12;
/** Light enough that gridlines and a second series still read through the fill. */
const AREA_OPACITY = 0.12;
const PIE_RADIUS = ["46%", "72%"];
/** Lowered so the ring clears the legend above it. */
const PIE_CENTER = ["50%", "55%"];
const PIE_TOTAL_SCALE = 1.6;
/** Each line of the hole's text is this many times its font size: rich text sets lines by the label's size otherwise. */
const PIE_LINE_HEIGHT = 1.4;
const HISTOGRAM_GAP = "4%";
const SCATTER_SYMBOL_PX = 7;
/** Above this many points a line samples and a scatter draws in large mode. */
const DENSE_POINTS = 300;
const LARGE_SCATTER_POINTS = 2_000;
/** Below this many points the plot zooms by wheel and drag only: a slider over a handful of points is clutter. */
const ZOOM_SLIDER_POINTS = 60;
const LEGEND_TOP_PX = 4;
const LEGEND_MARK_PX = 8;
const GRID_TOP_LEGEND_PX = 36;
const GRID_TOP_PX = 16;
const GRID_SIDE_PX = 16;
const GRID_BOTTOM_PX = 8;
const ZOOM_HEIGHT_PX = 18;
const ZOOM_BOTTOM_PX = 6;
const ZOOM_GAP_PX = 8;
/** The axis name sits this many lines of text below the axis, under the tick labels. */
const AXIS_NAME_LINES = 2;
const Y_NAME_GAP_PX = 8;
/** Four or five gridlines: enough to read a value off, few enough to stay behind the data. */
const Y_SPLITS = 4;
const SPLIT_LINE_TYPE = "dashed" as const;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const SECOND_MS = 1_000;
const DATE_LENGTH = 10;
const MINUTE_LENGTH = 16;
const SECOND_LENGTH = 19;
const CLOCK_START = 11;
const PERCENT_DIGITS = 1;

function columnName(columns: ChartColumns, index: number | null): string {
  return index === null ? "" : (columns.names[index] ?? "");
}

/** How a plotted number reads in a tooltip, grouped as the grid groups and marked when it was rounded. */
export function chartNumberText(value: unknown, formats: ChartFormats, approximate: boolean): string {
  if (typeof value === "string") return value;
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const text = String(Number(value.toPrecision(TOOLTIP_PRECISION)));
  const grouped = formats.groupDigits ? groupDigits(text) : text;
  return (approximate || Math.abs(value) > Number.MAX_SAFE_INTEGER ? APPROXIMATE_MARK : "") + grouped;
}

/** Whether the plotted values went through a double on their way here, so a tooltip should say so. */
function approximates(spec: ChartSpec, columns: ChartColumns): boolean {
  if (spec.aggregate === "count" && spec.kind !== "histogram" && spec.kind !== "stock") return false;
  return spec.y.some((index) => APPROXIMATE_CLASSES.has(columns.classes[index] ?? "text"));
}

/** Whether the values are counts of rows, so the value axis ticks whole numbers only. */
function counts(spec: ChartSpec): boolean {
  return spec.kind === "histogram" || (spec.aggregate === "count" && spec.kind === "bar");
}

function pointCount(data: ChartData): number {
  if (data.categories !== null) return data.categories.length;
  return data.series.reduce((total, series) => total + (series.points?.length ?? 0), 0);
}

/** The chart's accessible name, which the end-to-end suites also read: `Bar chart of total by country, 12 bars`. */
export function chartLabel(data: ChartData, spec: ChartSpec, columns: ChartColumns): string {
  const values = spec.y.map((index) => columnName(columns, index)).join(", ");
  const counted =
    spec.aggregate === "count" && (spec.kind === "bar" || spec.kind === "pie") ? `count of ${values}` : values;
  const by = spec.x === null ? "" : ` by ${columnName(columns, spec.x)}`;
  const count = pointCount(data);
  const [one, many] = KIND_MARKS[spec.kind];
  return `${KIND_TITLES[spec.kind]} of ${counted}${by}, ${formatCount(count)} ${count === 1 ? one : many}`;
}

/** The status line under the chart: what was read, what was left out and why. */
export function chartStatusParts(data: ChartData, more: boolean): readonly string[] {
  const parts = [`Plotting ${formatCount(data.rows)} ${data.rows === 1 ? "row" : "rows"}`];
  if (more) parts.push("more on the server; Fetch All to plot every row");
  for (const cut of data.truncated) {
    const shown = formatCount(cut.shown);
    const total = formatCount(cut.total);
    if (cut.what === "slices") parts.push(`the largest ${shown} of ${total} slices, the rest as Other`);
    else parts.push(`the first ${shown} of ${total} ${cut.what}`);
  }
  if (data.skipped > 0) {
    parts.push(`${formatCount(data.skipped)} ${data.skipped === 1 ? "row" : "rows"} skipped: NULL or not a number`);
  }
  return parts;
}

/** Whether the plot has a zoom window: along a time or value axis, and along a stock chart's days. */
export function chartZooms(data: ChartData, spec: ChartSpec): boolean {
  return spec.kind !== "pie" && (data.axis !== "category" || spec.kind === "stock");
}

/** How finely a time axis labels its ticks: as finely as the data's own times go, in one format. */
interface TimeGrain {
  readonly unit: number;
  readonly from: number;
  readonly to: number;
}

function timeGrain(data: ChartData): TimeGrain {
  const times = data.series.flatMap((series) => (series.points ?? []).map((point) => point[0] ?? 0));
  const unit = times.every((time) => time % DAY_MS === 0)
    ? DAY_MS
    : times.every((time) => time % MINUTE_MS === 0)
      ? MINUTE_MS
      : SECOND_MS;
  return { unit, from: Math.floor(Math.min(...times) / DAY_MS), to: Math.floor(Math.max(...times) / DAY_MS) };
}

/** `2024-03-01`, `2024-03-01 09:30`, or `09:30` when every point falls on one day. */
export function timeText(value: number, grain: TimeGrain): string {
  const iso = new Date(value).toISOString().replace("T", " ");
  if (grain.unit === DAY_MS) return iso.slice(0, DATE_LENGTH);
  const end = grain.unit === MINUTE_MS ? MINUTE_LENGTH : SECOND_LENGTH;
  return iso.slice(grain.from === grain.to ? CLOCK_START : 0, end);
}

function percentText(share: number): string {
  return `${String(Number((share * 100).toFixed(PERCENT_DIGITS)))}%`;
}

function seriesOf(data: ChartData, spec: ChartSpec, palette: ChartPalette): SeriesOption[] {
  const categories = data.categories ?? [];
  const dense = pointCount(data) > DENSE_POINTS;
  return data.series.map((series): SeriesOption => {
    const values = series.values ?? [];
    const points = series.points ?? [];
    const plotted = data.categories === null ? points.map((point) => [...point]) : [...values];
    switch (spec.kind) {
      case "pie":
        return {
          type: "pie",
          name: series.name,
          radius: PIE_RADIUS,
          center: PIE_CENTER,
          data: categories.map((name, index) => ({ name, value: values[index] ?? 0 })),
          label: { show: false },
          labelLine: { show: false },
          itemStyle: { borderColor: palette.canvas, borderWidth: 1 },
        };
      case "stock":
        return {
          type: "candlestick",
          name: series.name,
          data: points.map((point) => [...point]),
          itemStyle: {
            color: palette.success,
            color0: palette.danger,
            borderColor: palette.success,
            borderColor0: palette.danger,
          },
        };
      case "scatter":
        return {
          type: "scatter",
          name: series.name,
          data: plotted,
          symbolSize: SCATTER_SYMBOL_PX,
          large: pointCount(data) > LARGE_SCATTER_POINTS,
        };
      case "line":
      case "area":
        return {
          type: "line",
          name: series.name,
          data: plotted,
          showSymbol: false,
          sampling: dense ? "lttb" : undefined,
          connectNulls: false,
          ...(spec.kind === "area" ? { areaStyle: { opacity: AREA_OPACITY } } : {}),
        };
      case "histogram":
        return { type: "bar", name: series.name, data: plotted, barCategoryGap: HISTOGRAM_GAP };
      case "bar":
        return { type: "bar", name: series.name, data: plotted };
    }
  });
}

/**
 * The ECharts option for one chart (plan 155): pure, so a test reads what a theme and a result
 * turn into. Colours come from the theme's variables; the time axis reads wall-clock UTC.
 */
export function chartOption(
  data: ChartData,
  spec: ChartSpec,
  columns: ChartColumns,
  palette: ChartPalette,
  formats: ChartFormats,
): EChartsOption {
  const fontSize = Number.parseFloat(palette.fontUiSize) || DEFAULT_FONT_PX;
  const motionMs = Number.parseFloat(palette.motion) || 0;
  const textStyle = { color: palette.ink, fontFamily: palette.fontUi, fontSize };
  const muted = { color: palette.inkMuted, fontFamily: palette.fontUi, fontSize };
  const approximate = approximates(spec, columns);
  const number = (value: unknown) => chartNumberText(value, formats, approximate);
  const legend = spec.kind === "pie" || data.series.length > 1;
  const zoom = chartZooms(data, spec);
  const slider = zoom && pointCount(data) >= ZOOM_SLIDER_POINTS;
  const tooltip = {
    backgroundColor: palette.raised,
    borderColor: palette.border,
    textStyle,
    confine: true,
    valueFormatter: number,
  };
  const base: EChartsOption = {
    useUTC: true,
    animation: motionMs > 0,
    animationDuration: motionMs,
    animationDurationUpdate: motionMs,
    backgroundColor: "transparent",
    color: [...palette.series],
    textStyle,
    legend: legend
      ? {
          type: "scroll",
          top: LEGEND_TOP_PX,
          icon: "circle",
          itemWidth: LEGEND_MARK_PX,
          itemHeight: LEGEND_MARK_PX,
          textStyle: muted,
          pageTextStyle: muted,
        }
      : { show: false },
    series: seriesOf(data, spec, palette),
  };
  if (spec.kind === "pie") return pieOption(base, data, spec, columns, palette, tooltip, number);
  const axisLine = { lineStyle: { color: palette.border } };
  const splitLine = { lineStyle: { color: palette.border, type: SPLIT_LINE_TYPE } };
  const yName = spec.y.length === 1 && spec.kind !== "histogram" ? columnName(columns, spec.y[0] ?? null) : "";
  const xAxisName = spec.kind === "histogram" ? columnName(columns, spec.y[0] ?? null) : columnName(columns, spec.x);
  const nameGap = fontSize * AXIS_NAME_LINES;
  const zoomBand = slider ? ZOOM_HEIGHT_PX + ZOOM_BOTTOM_PX + ZOOM_GAP_PX : 0;
  const grain = data.axis === "time" ? timeGrain(data) : null;
  const xValue = (value: unknown) =>
    grain !== null && typeof value === "number" ? timeText(value, grain) : number(value);
  return {
    ...base,
    grid: {
      left: GRID_SIDE_PX,
      right: GRID_SIDE_PX,
      top: (legend ? GRID_TOP_LEGEND_PX : GRID_TOP_PX) + (yName === "" ? 0 : fontSize + Y_NAME_GAP_PX),
      bottom: (xAxisName === "" ? 0 : nameGap) + zoomBand + GRID_BOTTOM_PX,
      containLabel: true,
    },
    tooltip: {
      ...tooltip,
      trigger: spec.kind === "scatter" ? "item" : "axis",
      ...(spec.kind === "scatter"
        ? {
            formatter: (params: unknown) => {
              const { seriesName, value } = params as { seriesName?: string; value?: readonly unknown[] };
              return `${escapeHtml(seriesName ?? "")}<br/>${escapeHtml(xAxisName)}: ${escapeHtml(xValue(value?.[0]))}<br/>${escapeHtml(number(value?.[1]))}`;
            },
          }
        : {}),
    },
    xAxis: {
      type: data.axis,
      name: xAxisName,
      nameLocation: "middle",
      nameGap,
      nameTextStyle: muted,
      ...(data.categories === null ? { scale: data.axis === "value" } : { data: [...data.categories] }),
      ...(grain === null
        ? {}
        : {
            minInterval: grain.unit,
            // The tooltip's heading reads the pointer's label, so the hovered time matches the ticks.
            axisPointer: { label: { formatter: ({ value }: { value: unknown }) => xValue(value) } },
          }),
      axisLine,
      axisTick: axisLine,
      axisLabel: {
        ...muted,
        hideOverlap: true,
        ...(grain === null ? {} : { formatter: (value: number) => timeText(value, grain) }),
      },
      splitLine: { show: false },
      // The axis type is only known at run time, which the option's per-type union cannot follow.
    } as XAXisComponentOption,
    yAxis: {
      type: "value",
      name: yName,
      nameGap: Y_NAME_GAP_PX,
      nameTextStyle: { ...muted, align: "left" },
      splitNumber: Y_SPLITS,
      ...(counts(spec) ? { minInterval: 1 } : {}),
      scale: spec.kind === "stock" || spec.kind === "scatter",
      axisLine,
      axisLabel: {
        ...muted,
        formatter: (value: number) => (formats.groupDigits ? groupDigits(String(value)) : String(value)),
      },
      splitLine,
    },
    dataZoom: [
      ...(zoom ? [{ type: "inside" as const, filterMode: "none" as const }] : []),
      ...(slider
        ? [
            {
              type: "slider" as const,
              filterMode: "none" as const,
              height: ZOOM_HEIGHT_PX,
              bottom: ZOOM_BOTTOM_PX,
              borderColor: palette.border,
              ...zoomFill(palette.series[0]),
              textStyle: muted,
              ...(grain === null ? {} : { labelFormatter: (value: number) => timeText(value, grain) }),
            },
          ]
        : []),
    ],
  };
}

/** A ring with the total in its hole and each slice's share in the legend, so no label crowds the slices. */
function pieOption(
  base: EChartsOption,
  data: ChartData,
  spec: ChartSpec,
  columns: ChartColumns,
  palette: ChartPalette,
  tooltip: Record<string, unknown>,
  number: (value: unknown) => string,
): EChartsOption {
  const categories = data.categories ?? [];
  const values = data.series[0]?.values ?? [];
  const total = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const share = (value: number) => (total === 0 ? "" : percentText(value / total));
  const shares = new Map(categories.map((name, at) => [name, share(values[at] ?? 0)]));
  const fontSize = Number.parseFloat(palette.fontUiSize) || DEFAULT_FONT_PX;
  const valueName = spec.y.map((index) => columnName(columns, index)).join(", ");
  const caption = spec.aggregate === "count" ? `count of ${valueName}` : valueName;
  // The hole's text is a label of a silent disc inside the ring: a centred label lays out its own
  // lines, where two titles at one point overlap.
  const hole: SeriesOption = {
    type: "pie",
    name: PIE_HOLE,
    silent: true,
    radius: [0, PIE_RADIUS[0] ?? 0],
    center: PIE_CENTER,
    data: [{ name: PIE_HOLE, value: 1 }],
    itemStyle: { color: TRANSPARENT },
    tooltip: { show: false },
    label: {
      show: true,
      position: "center",
      formatter: `{total|${richText(number(total))}}\n{caption|${richText(caption)}}`,
      rich: {
        total: {
          color: palette.ink,
          fontFamily: palette.fontUi,
          fontSize: fontSize * PIE_TOTAL_SCALE,
          lineHeight: fontSize * PIE_TOTAL_SCALE * PIE_LINE_HEIGHT,
          fontWeight: "bold",
        },
        caption: {
          color: palette.inkMuted,
          fontFamily: palette.fontUi,
          fontSize,
          lineHeight: fontSize * PIE_LINE_HEIGHT,
        },
      },
    },
    emphasis: { disabled: true },
  };
  return {
    ...base,
    legend: {
      ...(base.legend as object),
      data: [...categories],
      formatter: (name: string) => `${name}  ${shares.get(name) ?? ""}`,
    },
    series: [...(base.series as SeriesOption[]), hole],
    tooltip: {
      ...tooltip,
      trigger: "item",
      formatter: (params: unknown) => {
        const { name, value } = params as { name?: string; value?: unknown };
        const text = `${number(value)}${typeof value === "number" ? `  ${share(value)}` : ""}`;
        return `${escapeHtml(name ?? "")}<br/>${escapeHtml(text)}`;
      },
    },
  };
}

const PIE_HOLE = "\u0000hole";
const TRANSPARENT = "transparent";
const RICH_MARKUP = /[{}|]/gu;

/** Cell text inside an ECharts rich-text label, where braces and bars are markup. */
function richText(text: string): string {
  return text.replace(RICH_MARKUP, "");
}

const HEX_COLOR = /^#[\da-f]{6}$/iu;
/** The zoom window's fill as hex alpha: canvas does not take every CSS colour function a theme might use. */
const ZOOM_FILL_ALPHA = "33";

function zoomFill(color: string | undefined): { readonly fillerColor?: string } {
  return color !== undefined && HEX_COLOR.test(color) ? { fillerColor: `${color}${ZOOM_FILL_ALPHA}` } : {};
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** ECharts sets a formatter's answer as HTML; cell text must not become markup. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}
