import type { Row, ServerMessage, WireValue } from "./wire.js";

/** Mirrors `ResultWindow` in core; `matches` are flat `row, column` pairs while a find is set. */
export interface ResultWindow {
  readonly offset: number;
  readonly rows: readonly Row[];
  readonly matches?: readonly number[];
}

/** Mirrors `ResultState` in core: how far a result has been read, and whether more can be. */
export interface ResultState {
  readonly rowCount: number;
  readonly complete: boolean;
  readonly cursorOpen: boolean;
  /** What the server said running the statement; present once the result is complete and it said anything. */
  readonly messages?: readonly ServerMessage[];
}

/** Mirrors `SortDirection` in core. */
export type SortDirection = "asc" | "desc";

/** Mirrors `SortKey` in core: a column index and its direction. */
export interface SortKey {
  readonly column: number;
  readonly direction: SortDirection;
}

/** Mirrors `FindQuery` in core: what the grid's find bar looks for (decision 050). */
export interface FindQuery {
  readonly text: string;
  readonly caseSensitive: boolean;
  readonly regex: boolean;
  readonly wholeCell: boolean;
}

/** Mirrors `FilterChip` in core: a local quick filter; `text` is the value's database text. */
export type FilterChip =
  | { readonly column: number; readonly op: "equals" | "notEquals"; readonly text: string }
  | { readonly column: number; readonly op: "isNull" | "isNotNull" };

export type FilterOp = FilterChip["op"];

/** Mirrors `DisplayFormats` in core. */
export interface DisplayFormats {
  readonly groupDigits: boolean;
}

/** Mirrors `ViewSpec` in core: the find query and filters, over the columns the grid draws. */
export interface ViewSpec {
  readonly find: FindQuery | null;
  readonly rowsOnly: boolean;
  readonly filters: readonly FilterChip[];
  readonly columns: readonly number[];
  readonly formats: DisplayFormats;
}

/** Mirrors `ViewState` in core: rows shown, held positions when filtered, and the match count. */
export interface ViewState {
  readonly shown: number;
  readonly filtered: boolean;
  readonly sources: readonly number[] | null;
  readonly matches: number;
  readonly error: string | null;
}

/** Mirrors `FoundMatch` in core. */
export interface FoundMatch {
  readonly index: number;
  readonly row: number;
  readonly column: number;
}

/** Mirrors `SelectionAggregates` in core: what the selected cells add up to (plan 043). */
export interface SelectionAggregates {
  readonly cells: number;
  readonly distinct: number;
  readonly kind: "numeric" | "temporal" | "other";
  readonly sum: string | null;
  readonly avg: string | null;
  readonly min: WireValue;
  readonly max: WireValue;
}

/** Mirrors `CHART_KINDS` in core. */
export const CHART_KINDS = ["bar", "line", "area", "pie", "scatter", "histogram", "stock"] as const;
export type ChartKind = (typeof CHART_KINDS)[number];
/** Mirrors `CHART_AGGREGATES` in core. */
export const CHART_AGGREGATES = ["sum", "avg", "count", "min", "max"] as const;
export type ChartAggregate = (typeof CHART_AGGREGATES)[number];
/** Mirrors `HISTOGRAM_MIN_BINS` and `HISTOGRAM_MAX_BINS` in core. */
export const HISTOGRAM_MIN_BINS = 5;
export const HISTOGRAM_MAX_BINS = 100;

/** Mirrors `ChartSpec` in core: what to draw, as result column indices (plan 155). */
export interface ChartSpec {
  readonly kind: ChartKind;
  readonly x: number | null;
  readonly y: readonly number[];
  readonly groupBy: number | null;
  readonly aggregate: ChartAggregate;
  readonly bins: number | null;
}

export type ChartAxis = "category" | "time" | "value";

/** Mirrors `ChartSeries` in core. */
export interface ChartSeries {
  readonly name: string;
  readonly values?: readonly (number | null)[];
  readonly points?: readonly (readonly number[])[];
}

/** Mirrors `ChartTruncation` in core. */
export interface ChartTruncation {
  readonly what: "categories" | "series" | "slices";
  readonly shown: number;
  readonly total: number;
}

/** Mirrors `ChartData` in core: the series the engine shaped from the shown rows. */
export interface ChartData {
  readonly axis: ChartAxis;
  readonly categories: readonly string[] | null;
  readonly series: readonly ChartSeries[];
  readonly rows: number;
  readonly skipped: number;
  readonly truncated: readonly ChartTruncation[];
}

/** A cell's bytes, every one of them, as lower-case hex (plan 043). */
export interface CellBytes {
  readonly kind: "bytes";
  readonly preview: string;
  readonly length: number;
}

/** A file's bytes the engine read and holds for an edit; the renderer sees only their first bytes. */
export interface StagedBytes {
  readonly id: string;
  readonly length: number;
  readonly preview: string;
}
