import type { Row, TypeClass, WireValue } from "@table-craft/plugin-api";

export const CHART_KINDS = ["bar", "line", "area", "pie", "scatter", "histogram", "stock"] as const;
export type ChartKind = (typeof CHART_KINDS)[number];
export const CHART_AGGREGATES = ["sum", "avg", "count", "min", "max"] as const;
export type ChartAggregate = (typeof CHART_AGGREGATES)[number];

/** Bar, line and area on a category axis draw at most this many categories, the first ones read. */
export const CHART_MAX_CATEGORIES = 1_000;
/** Y columns times group values. */
export const CHART_MAX_SERIES = 20;
/** The largest `PIE_MAX_SLICES - 1` slices, plus one that sums the rest. */
export const PIE_MAX_SLICES = 20;
export const HISTOGRAM_MIN_BINS = 5;
export const HISTOGRAM_MAX_BINS = 100;
export const PIE_OTHER_LABEL = "Other";
/** Open, high, low and close. */
export const STOCK_VALUES = 4;
/** Significant digits of a histogram bin edge in its label. */
const BIN_LABEL_DIGITS = 6;
const SERIES_NAME_SEPARATOR = " · ";

/** What the user asked to draw: result column indices, as the grid numbers them. */
export interface ChartSpec {
  readonly kind: ChartKind;
  /** Result column of the X axis (pie: the labels); null only for a histogram. */
  readonly x: number | null;
  /** Value columns: one series each; one for pie and histogram; open, high, low, close for stock. */
  readonly y: readonly number[];
  /** A column whose distinct values split each Y column into one series each. */
  readonly groupBy: number | null;
  /** Folds repeated categories; time and value axes draw every row. */
  readonly aggregate: ChartAggregate;
  /** Histogram only; null picks Sturges' rule. */
  readonly bins: number | null;
}

export type ChartAxis = "category" | "time" | "value";

export interface ChartSeries {
  readonly name: string;
  /** Category axis: one value per category, null where the series has none. */
  readonly values?: readonly (number | null)[];
  /** Time or value axis: `[x, y]`; stock: `[open, close, low, high]`, one per category. */
  readonly points?: readonly (readonly number[])[];
}

export interface ChartTruncation {
  readonly what: "categories" | "series" | "slices";
  readonly shown: number;
  readonly total: number;
}

export interface ChartData {
  readonly axis: ChartAxis;
  /** Category labels in first-appearance order; histogram bin labels (`10 – 20`). Null on time and value axes. */
  readonly categories: readonly string[] | null;
  readonly series: readonly ChartSeries[];
  /** Rows read: the shown rows of the result at the time of the request. */
  readonly rows: number;
  /** Rows a plotted cell of which was NULL or did not convert. */
  readonly skipped: number;
  readonly truncated: readonly ChartTruncation[];
}

/** Why `spec` cannot be drawn as its kind, or null when it can. */
export function chartSpecProblem(spec: ChartSpec): string | null {
  switch (spec.kind) {
    case "histogram":
      return spec.y.length === 1 ? null : "A histogram takes exactly one value column.";
    case "pie":
      if (spec.x === null) return "A pie chart takes a label column.";
      return spec.y.length === 1 ? null : "A pie chart takes exactly one value column.";
    case "stock":
      if (spec.x === null) return "A stock chart takes an X column.";
      return spec.y.length === STOCK_VALUES ? null : "A stock chart takes four value columns: open, high, low, close.";
    default:
      if (spec.x === null) return `A ${spec.kind} chart takes an X column.`;
      return spec.y.length > 0 ? null : `A ${spec.kind} chart takes at least one value column.`;
  }
}

const NUMERIC_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu;
const NUMERIC_CLASSES: ReadonlySet<TypeClass> = new Set(["integer", "float", "decimal"]);

/** A cell as a double, or null when it holds no finite number. */
export function chartNumber(value: WireValue): number | null {
  if (value === null || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return NUMERIC_TEXT.test(value.trim()) ? Number(value) : null;
  if (value.kind === "bigint") return Number(value.value);
  return null;
}

const DATE_TEXT =
  /^(\d{4,})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?)?$/iu;
const TIME_TEXT = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?)?$/iu;
const MILLIS_DIGITS = 3;

function millisOf(fraction: string | undefined): number {
  return fraction === undefined ? 0 : Number(fraction.slice(0, MILLIS_DIGITS).padEnd(MILLIS_DIGITS, "0"));
}

/**
 * A temporal cell as epoch milliseconds of the wall-clock time it reads, with any offset ignored:
 * the axis is drawn in UTC, so its labels read what the grid cell reads (no zone shift).
 */
export function chartTime(value: WireValue): number | null {
  if (value === null || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = typeof value === "string" ? value.trim() : value.kind === "date" ? value.iso : null;
  if (text === null) return null;
  const date = DATE_TEXT.exec(text);
  if (date !== null) {
    const [, year, month, day, hour, minute, second, fraction] = date;
    const time = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour ?? 0),
      Number(minute ?? 0),
      Number(second ?? 0),
      millisOf(fraction),
    );
    return Number.isFinite(time) ? time : null;
  }
  const clock = TIME_TEXT.exec(text);
  if (clock === null) return null;
  const [, hour, minute, second, fraction] = clock;
  return Date.UTC(1970, 0, 1, Number(hour), Number(minute), Number(second ?? 0), millisOf(fraction));
}

/** A cell as a category label. */
export function chartLabel(value: Exclude<WireValue, null>): string {
  if (typeof value !== "object") return String(value);
  switch (value.kind) {
    case "bigint":
      return value.value;
    case "json":
      return value.text;
    case "date":
      return value.iso;
    case "bytes":
      return `0x${value.preview}`;
  }
}

/** The axis X is drawn on, by the chart's kind and the class of its X column. */
export function chartAxis(kind: ChartKind, xClass: TypeClass | null): ChartAxis {
  // A bar folds its X values into one bar each, so the aggregate holds on dates too.
  if (kind === "pie" || kind === "histogram" || kind === "stock" || kind === "bar") return "category";
  if (xClass === "temporal") return "time";
  if (xClass !== null && NUMERIC_CLASSES.has(xClass)) return "value";
  return "category";
}

interface Fold {
  count: number;
  sum: number;
  min: number;
  max: number;
}

function folded(fold: Fold | undefined, aggregate: ChartAggregate): number | null {
  if (fold === undefined) return null;
  switch (aggregate) {
    case "sum":
      return fold.sum;
    case "avg":
      return fold.count === 0 ? null : fold.sum / fold.count;
    case "count":
      return fold.count;
    case "min":
      return fold.min;
    case "max":
      return fold.max;
  }
}

function addTo(fold: Fold | undefined, value: number): Fold {
  if (fold === undefined) return { count: 1, sum: value, min: value, max: value };
  fold.count += 1;
  fold.sum += value;
  fold.min = Math.min(fold.min, value);
  fold.max = Math.max(fold.max, value);
  return fold;
}

/** One output series: which Y column it plots and which group value it keeps, if any. */
interface SeriesKey {
  readonly y: number;
  readonly group: string | null;
}

/**
 * Hands out series in first-appearance order of group values, Y columns in spec order within a
 * group, and refuses past `CHART_MAX_SERIES`.
 */
class SeriesSlots {
  readonly keys: SeriesKey[] = [];
  readonly #slots = new Map<string, number | null>();
  readonly #groups = new Set<string>();
  readonly spec: ChartSpec;
  readonly names: readonly string[];

  constructor(spec: ChartSpec, names: readonly string[]) {
    this.spec = spec;
    this.names = names;
    if (spec.groupBy === null) {
      for (const y of spec.y) this.keys.push({ y, group: null });
    }
  }

  slot(group: string | null, yAt: number): number | null {
    if (group === null) return yAt < this.keys.length ? yAt : null;
    const key = `${String(yAt)}\u0000${group}`;
    const known = this.#slots.get(key);
    if (known !== undefined) return known;
    if (!this.#groups.has(group)) {
      this.#groups.add(group);
      for (const [at, y] of this.spec.y.entries()) {
        const free = this.keys.length < CHART_MAX_SERIES;
        if (free) this.keys.push({ y, group });
        this.#slots.set(`${String(at)}\u0000${group}`, free ? this.keys.length - 1 : null);
      }
    }
    return this.#slots.get(key) ?? null;
  }

  get total(): number {
    return this.spec.groupBy === null ? this.spec.y.length : this.#groups.size * this.spec.y.length;
  }

  name(index: number): string {
    const key = this.keys[index];
    if (key === undefined) return "";
    const column = this.names[key.y] ?? "";
    if (key.group === null) return column;
    return this.spec.y.length > 1 ? `${key.group}${SERIES_NAME_SEPARATOR}${column}` : key.group;
  }

  truncation(): ChartTruncation[] {
    const total = this.total;
    return total > this.keys.length ? [{ what: "series", shown: this.keys.length, total }] : [];
  }
}

function groupOf(row: Row, spec: ChartSpec): string | null | undefined {
  if (spec.groupBy === null) return null;
  const value = row[spec.groupBy] ?? null;
  return value === null ? undefined : chartLabel(value);
}

function categoryChart(rows: readonly Row[], spec: ChartSpec, names: readonly string[]): ChartData {
  const series = new SeriesSlots(spec, names);
  const categories = new Map<string, number>();
  const folds: Map<number, Fold>[] = [];
  const counting = spec.aggregate === "count";
  let distinct = 0;
  let skipped = 0;
  for (const row of rows) {
    const x = row[spec.x ?? -1] ?? null;
    const group = groupOf(row, spec);
    if (x === null || group === undefined) {
      skipped += 1;
      continue;
    }
    const label = chartLabel(x);
    let at = categories.get(label);
    if (at === undefined) {
      distinct += 1;
      if (categories.size < CHART_MAX_CATEGORIES) {
        at = categories.size;
        categories.set(label, at);
      }
    }
    let dropped = false;
    for (const [yAt, y] of spec.y.entries()) {
      const value = counting ? 0 : chartNumber(row[y] ?? null);
      if (value === null) {
        dropped = true;
        continue;
      }
      const slot = series.slot(group, yAt);
      if (slot === null || at === undefined) continue;
      const perSeries = folds[slot] ?? new Map<number, Fold>();
      folds[slot] = perSeries;
      perSeries.set(at, addTo(perSeries.get(at), value));
    }
    if (dropped) skipped += 1;
  }
  const truncated = series.truncation();
  if (distinct > categories.size) truncated.unshift({ what: "categories", shown: categories.size, total: distinct });
  return {
    axis: "category",
    categories: [...categories.keys()],
    series: series.keys.map((_, index) => ({
      name: series.name(index),
      values: [...categories.values()].map((at) => folded(folds[index]?.get(at), spec.aggregate)),
    })),
    rows: rows.length,
    skipped,
    truncated,
  };
}

function pointChart(
  rows: readonly Row[],
  spec: ChartSpec,
  names: readonly string[],
  axis: "time" | "value",
): ChartData {
  const series = new SeriesSlots(spec, names);
  const points: number[][][] = [];
  let skipped = 0;
  for (const row of rows) {
    const cell = row[spec.x ?? -1] ?? null;
    const x = axis === "time" ? chartTime(cell) : chartNumber(cell);
    const group = groupOf(row, spec);
    if (x === null || group === undefined) {
      skipped += 1;
      continue;
    }
    let dropped = false;
    for (const [yAt, y] of spec.y.entries()) {
      const value = chartNumber(row[y] ?? null);
      if (value === null) {
        dropped = true;
        continue;
      }
      const slot = series.slot(group, yAt);
      if (slot === null) continue;
      (points[slot] ??= []).push([x, value]);
    }
    if (dropped) skipped += 1;
  }
  const ordered = spec.kind === "line" || spec.kind === "area";
  return {
    axis,
    categories: null,
    series: series.keys.map((_, index) => {
      const own = points[index] ?? [];
      return { name: series.name(index), points: ordered ? own.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0)) : own };
    }),
    rows: rows.length,
    skipped,
    truncated: series.truncation(),
  };
}

function pieChart(rows: readonly Row[], spec: ChartSpec, names: readonly string[]): ChartData {
  const slices = new Map<string, Fold>();
  const counting = spec.aggregate === "count";
  const [y = -1] = spec.y;
  let skipped = 0;
  for (const row of rows) {
    const label = row[spec.x ?? -1] ?? null;
    const value = counting ? 0 : chartNumber(row[y] ?? null);
    if (label === null || value === null) {
      skipped += 1;
      continue;
    }
    const key = chartLabel(label);
    slices.set(key, addTo(slices.get(key), value));
  }
  let entries = [...slices].map(([label, fold]) => [label, folded(fold, spec.aggregate) ?? 0] as const);
  const truncated: ChartTruncation[] = [];
  if (entries.length > PIE_MAX_SLICES) {
    const largest = [...entries].sort((a, b) => b[1] - a[1]);
    const kept = largest.slice(0, PIE_MAX_SLICES - 1);
    const rest = largest.slice(PIE_MAX_SLICES - 1).reduce((sum, [, value]) => sum + value, 0);
    truncated.push({ what: "slices", shown: kept.length, total: entries.length });
    entries = [...kept, [PIE_OTHER_LABEL, rest] as const];
  }
  return {
    axis: "category",
    categories: entries.map(([label]) => label),
    series: [{ name: names[y] ?? "", values: entries.map(([, value]) => value) }],
    rows: rows.length,
    skipped,
    truncated,
  };
}

/** Sturges' rule, `ceil(log2 n) + 1`, within the histogram bounds. */
export function defaultBins(count: number): number {
  const sturges = Math.ceil(Math.log2(Math.max(count, 1))) + 1;
  return Math.min(HISTOGRAM_MAX_BINS, Math.max(HISTOGRAM_MIN_BINS, sturges));
}

function edgeText(value: number): string {
  return String(Number(value.toPrecision(BIN_LABEL_DIGITS)));
}

/** Bin widths a reader takes in at a glance: 1, 2, 2.5 or 5 times a power of ten. */
const NICE_STEPS = [1, 2, 2.5, 5, 10] as const;
/** Rounds away the binary noise of `(value - start) / step`, so a value on an edge lands in the bin it opens. */
const BIN_INDEX_DIGITS = 12;

interface BinEdges {
  readonly start: number;
  readonly step: number;
  readonly bins: number;
}

function edgesOf(min: number, max: number, step: number): BinEdges {
  const start = Math.floor(min / step) * step;
  const bins = Math.max(1, Math.ceil(Number(((max - start) / step).toPrecision(BIN_INDEX_DIGITS))));
  return { start, step, bins };
}

/**
 * Round bin edges over `[min, max]`: of the nice widths around an even split into `wanted` bins,
 * the one whose bin count comes nearest `wanted` (the wider on a tie), the first edge a multiple
 * of it at or below `min`. The count is therefore near `wanted`, not always equal to it.
 */
export function binEdges(min: number, max: number, wanted: number): BinEdges {
  const power = 10 ** Math.floor(Math.log10((max - min) / wanted));
  const candidates = [power / 10, power, power * 10]
    .flatMap((scale) => NICE_STEPS.map((step) => edgesOf(min, max, step * scale)))
    .filter((edges) => edges.bins <= HISTOGRAM_MAX_BINS);
  let best = candidates[0] ?? edgesOf(min, max, power * 10);
  for (const edges of candidates) {
    const nearer = Math.abs(edges.bins - wanted) - Math.abs(best.bins - wanted);
    if (nearer < 0 || (nearer === 0 && edges.step > best.step)) best = edges;
  }
  return best;
}

function histogramChart(rows: readonly Row[], spec: ChartSpec, names: readonly string[]): ChartData {
  const [y = -1] = spec.y;
  const values: number[] = [];
  for (const row of rows) {
    const value = chartNumber(row[y] ?? null);
    if (value !== null) values.push(value);
  }
  const skipped = rows.length - values.length;
  const name = names[y] ?? "";
  if (values.length === 0)
    return { axis: "category", categories: [], series: [], rows: rows.length, skipped, truncated: [] };
  const min = values.reduce((low, value) => Math.min(low, value));
  const max = values.reduce((high, value) => Math.max(high, value));
  if (min === max) {
    return {
      axis: "category",
      categories: [edgeText(min)],
      series: [{ name, values: [values.length] }],
      rows: rows.length,
      skipped,
      truncated: [],
    };
  }
  const { start, step, bins } = binEdges(min, max, spec.bins ?? defaultBins(values.length));
  const counts = new Array<number>(bins).fill(0);
  for (const value of values) {
    const at = Math.min(bins - 1, Math.floor(Number(((value - start) / step).toPrecision(BIN_INDEX_DIGITS))));
    counts[at] = (counts[at] ?? 0) + 1;
  }
  return {
    axis: "category",
    categories: counts.map((_, at) => `${edgeText(start + at * step)} – ${edgeText(start + (at + 1) * step)}`),
    series: [{ name, values: counts }],
    rows: rows.length,
    skipped,
    truncated: [],
  };
}

function stockChart(rows: readonly Row[], spec: ChartSpec, names: readonly string[]): ChartData {
  const categories: string[] = [];
  const candles: number[][] = [];
  let skipped = 0;
  for (const row of rows) {
    const x = row[spec.x ?? -1] ?? null;
    const [open, high, low, close] = spec.y.map((column) => chartNumber(row[column] ?? null));
    if (x === null || open == null || high == null || low == null || close == null) {
      skipped += 1;
      continue;
    }
    categories.push(chartLabel(x));
    candles.push([open, close, low, high]);
  }
  return {
    axis: "category",
    categories,
    series: [{ name: names[spec.x ?? -1] ?? "", points: candles }],
    rows: rows.length,
    skipped,
    truncated: [],
  };
}

/**
 * The series to draw `rows` as `spec` says, where `classes` and `names` describe every column of
 * the result. Numbers become doubles: the chart is for shape, the grid keeps the exact value.
 * A row a plotted cell of which is NULL or does not convert is skipped and counted, never drawn as 0.
 */
export function chartData(
  rows: readonly Row[],
  classes: readonly TypeClass[],
  names: readonly string[],
  spec: ChartSpec,
): ChartData {
  switch (spec.kind) {
    case "pie":
      return pieChart(rows, spec, names);
    case "histogram":
      return histogramChart(rows, spec, names);
    case "stock":
      return stockChart(rows, spec, names);
    default: {
      const axis = chartAxis(spec.kind, spec.x === null ? null : (classes[spec.x] ?? "text"));
      return axis === "category" ? categoryChart(rows, spec, names) : pointChart(rows, spec, names, axis);
    }
  }
}
