import type { Row, ServerMessage } from "./wire.js";

/** Mirrors `ResultWindow` in core; `matches` are flat `row, column` pairs while a find is set. */
export interface ResultWindow {
  readonly offset: number;
  readonly rows: readonly Row[];
  readonly matches?: readonly number[];
}

/** Mirrors `TypeClass` in core: what a column holds, for its header glyph. */
export type TypeClass = "integer" | "float" | "decimal" | "boolean" | "temporal" | "json" | "bytes" | "text";

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
