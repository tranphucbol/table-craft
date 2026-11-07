import type { ChartKind, ChartSpec, Column, TypeClass } from "@table-craft/desktop/engine/protocol.js";

/** A result tab's chart (plan 155): whether it replaces the rows, and what it draws; null suggests one. */
export interface ResultChart {
  readonly shown: boolean;
  readonly spec: ChartSpec | null;
}

/** Value columns a suggestion plots at most; more stay a click away. */
export const SUGGESTED_MAX_SERIES = 4;

const NUMERIC_CLASSES: ReadonlySet<TypeClass> = new Set(["integer", "float", "decimal"]);
const KEY_NAME = /^(?:id|.+_id)$|[a-z]Id$/u;
const STOCK_NAMES = ["open", "high", "low", "close"] as const;
const STOCK_VALUES = STOCK_NAMES.length;

export function isNumericClass(typeClass: TypeClass | undefined): boolean {
  return typeClass !== undefined && NUMERIC_CLASSES.has(typeClass);
}

function isKeyName(name: string): boolean {
  return KEY_NAME.test(name) || KEY_NAME.test(name.toLowerCase());
}

function indicesWhere(classes: readonly TypeClass[], test: (typeClass: TypeClass) => boolean): number[] {
  return classes.flatMap((typeClass, index) => (test(typeClass) ? [index] : []));
}

/** Numeric columns, keys last: an `id` is rarely the value one wants plotted. */
export function valueColumns(columns: readonly Column[], classes: readonly TypeClass[]): number[] {
  const numeric = indicesWhere(classes, (typeClass) => NUMERIC_CLASSES.has(typeClass));
  const keyLike = (index: number) => isKeyName(columns[index]?.name ?? "");
  return [...numeric.filter((index) => !keyLike(index)), ...numeric.filter(keyLike)];
}

function plainValues(columns: readonly Column[], classes: readonly TypeClass[]): number[] {
  return valueColumns(columns, classes).filter((index) => !isKeyName(columns[index]?.name ?? ""));
}

function labelColumns(classes: readonly TypeClass[]): number[] {
  return indicesWhere(classes, (typeClass) => !NUMERIC_CLASSES.has(typeClass) && typeClass !== "temporal");
}

function temporalColumns(classes: readonly TypeClass[]): number[] {
  return indicesWhere(classes, (typeClass) => typeClass === "temporal");
}

/** Open, high, low and close by name, when the result has all four as numbers. */
function stockValues(columns: readonly Column[], classes: readonly TypeClass[]): number[] | null {
  const found = STOCK_NAMES.map((name) =>
    columns.findIndex((column, index) => column.name.toLowerCase() === name && isNumericClass(classes[index])),
  );
  return found.every((index) => index >= 0) ? found : null;
}

function specOf(kind: ChartKind, x: number | null, y: readonly number[]): ChartSpec {
  return { kind, x, y, groupBy: null, aggregate: "sum", bins: null };
}

/**
 * The chart a result most likely means (plan 155 decision 6): candles over time, a line over time,
 * bars per label, a scatter of two numbers, a histogram of one; null when nothing is numeric.
 */
export function suggestChart(columns: readonly Column[], classes: readonly TypeClass[]): ChartSpec | null {
  const values = valueColumns(columns, classes);
  if (values.length === 0) return null;
  const plain = plainValues(columns, classes);
  const preferred = (plain.length > 0 ? plain : values).slice(0, SUGGESTED_MAX_SERIES);
  const time = temporalColumns(classes)[0];
  const stock = stockValues(columns, classes);
  if (time !== undefined && stock !== null) return specOf("stock", time, stock);
  if (time !== undefined) return specOf("line", time, preferred);
  const label = labelColumns(classes)[0];
  if (label !== undefined) return specOf("bar", label, preferred);
  if (plain.length >= 2) return specOf("scatter", plain[0] ?? null, plain.slice(1, SUGGESTED_MAX_SERIES + 1));
  if (values.length >= 2) return specOf("scatter", values[0] ?? null, values.slice(1, SUGGESTED_MAX_SERIES + 1));
  return specOf("histogram", null, preferred.slice(0, 1));
}

function firstOther(candidates: readonly number[], taken: readonly number[]): number | undefined {
  return candidates.find((index) => !taken.includes(index));
}

/** The X column a kind draws best when the spec has none or one it cannot use. */
function xFor(kind: ChartKind, spec: ChartSpec, columns: readonly Column[], classes: readonly TypeClass[]) {
  const values = valueColumns(columns, classes);
  const time = temporalColumns(classes);
  const labels = labelColumns(classes);
  const taken = spec.y;
  const keep = spec.x !== null && !taken.includes(spec.x) ? spec.x : undefined;
  switch (kind) {
    case "histogram":
      return null;
    case "pie":
    case "bar":
      return keep ?? firstOther([...labels, ...time, ...values], taken) ?? null;
    case "stock":
      return keep ?? firstOther([...time, ...labels], taken) ?? null;
    case "scatter":
      return keep ?? firstOther([...values, ...time], taken) ?? null;
    case "line":
    case "area":
      return keep ?? firstOther([...time, ...values, ...labels], taken) ?? null;
  }
}

function yFor(kind: ChartKind, spec: ChartSpec, columns: readonly Column[], classes: readonly TypeClass[]) {
  const numeric = spec.y.filter((index) => isNumericClass(classes[index]));
  const values = valueColumns(columns, classes);
  const first = numeric[0] ?? values.find((index) => index !== spec.x);
  switch (kind) {
    case "pie":
    case "histogram":
      return first === undefined ? [] : [first];
    case "stock": {
      if (numeric.length === STOCK_VALUES) return numeric;
      return stockValues(columns, classes) ?? values.filter((index) => index !== spec.x).slice(0, STOCK_VALUES);
    }
    default:
      return numeric.length > 0 ? numeric : first === undefined ? [] : [first];
  }
}

/** Whether `spec` names columns a chart of its kind can draw. */
export function specProblem(spec: ChartSpec): boolean {
  if (spec.kind === "histogram") return spec.y.length !== 1;
  if (spec.x === null) return true;
  if (spec.kind === "pie") return spec.y.length !== 1;
  if (spec.kind === "stock") return spec.y.length !== STOCK_VALUES;
  return spec.y.length === 0;
}

/**
 * `spec` as another kind, keeping the columns that kind can use (plan 155 decision 7); null when
 * the result has nothing that kind can draw, such as a stock chart from fewer than four numbers.
 */
export function withKind(
  spec: ChartSpec,
  kind: ChartKind,
  columns: readonly Column[],
  classes: readonly TypeClass[],
): ChartSpec | null {
  const y = yFor(kind, spec, columns, classes);
  const x = xFor(kind, { ...spec, y }, columns, classes);
  const single = kind === "pie" || kind === "histogram" || kind === "stock";
  const next: ChartSpec = { ...spec, kind, x, y, groupBy: single ? null : spec.groupBy };
  return specProblem(next) ? null : next;
}

/**
 * The chart a rerun keeps (plan 155 decision 15): its columns found again by name, or the chart
 * still shown with a fresh suggestion when one of them is gone.
 */
export function carriedChart(
  chart: ResultChart | undefined,
  before: readonly string[],
  after: readonly string[],
): ResultChart | undefined {
  if (chart?.spec == null) return chart;
  const { spec } = chart;
  const moved = (index: number) => {
    const name = before[index];
    return name === undefined ? -1 : after.indexOf(name);
  };
  const x = spec.x === null ? null : moved(spec.x);
  const y = spec.y.map(moved);
  const groupBy = spec.groupBy === null ? null : moved(spec.groupBy);
  if (x === -1 || groupBy === -1 || y.includes(-1)) return { shown: chart.shown, spec: null };
  return { shown: chart.shown, spec: { ...spec, x, y, groupBy } };
}

/** The spec a chart draws: the chosen one, else the suggestion. */
export function effectiveSpec(
  chart: ResultChart | undefined,
  columns: readonly Column[],
  classes: readonly TypeClass[],
): ChartSpec | null {
  return chart?.spec ?? suggestChart(columns, classes);
}
