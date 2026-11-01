import {
  RESULT_WINDOW_ROWS,
  type Column,
  type ExecutedStatement,
  type ExplainedPlan,
  type ExportTaskState,
  type FilterChip,
  type FindQuery,
  type FoundMatch,
  type KeySource,
  type ResultPaging,
  type ResultState,
  type Row,
  type SortKey,
  type TypeClass,
  type ViewSpec,
  type ViewState,
} from "@table-craft/desktop/engine/protocol.js";
import type { CellFormats } from "@table-craft/desktop/renderer/grid/format.js";
import { columnChars } from "@table-craft/desktop/renderer/grid/widths.js";
import { initialLayout, visibleColumns, type ColumnLayout } from "@table-craft/desktop/renderer/model/columnLayout.js";
import type { HeldRows } from "@table-craft/desktop/renderer/model/editBuffer.js";
import { formatCount } from "@table-craft/desktop/renderer/model/format.js";
import type { GridSelection } from "@table-craft/desktop/renderer/model/gridSelection.js";
import type { ValueFormat } from "@table-craft/desktop/renderer/model/valueFormats.js";

/** What the grid is fetching for a result: a page, everything to the cap, or the rest into a file. */
export type ResultFetch = "page" | "all" | "export";

/** The find bar and the local filter chips of one result (plan 023, decision 050). */
export interface ResultSearch {
  /** The find bar shows; its query marks cells only while it does. */
  readonly open: boolean;
  readonly query: FindQuery;
  /** "Filter rows": hide the rows the query does not match. */
  readonly rowsOnly: boolean;
  readonly filters: readonly FilterChip[];
  /** The match the find bar is on, or null before Enter or after the view changed. */
  readonly current: FoundMatch | null;
  /** Bumped by Find so the bar takes focus again while already open. */
  readonly focusRequest: number;
}

export const EMPTY_QUERY: FindQuery = { text: "", caseSensitive: false, regex: false, wholeCell: false };

export const NO_SEARCH: ResultSearch = {
  open: false,
  query: EMPTY_QUERY,
  rowsOnly: false,
  filters: [],
  current: null,
  focusRequest: 0,
};

/**
 * A result tab: one row-returning statement's rows, held in the engine behind `handle`. Its
 * layout, sort and selection live here and die with the tab (plan 007 decision 8).
 */
export interface ResultTab extends ResultState {
  readonly kind: "rows";
  readonly id: string;
  /** `Result 1`, `Result 2`…, the first number no pinned tab holds. */
  readonly title: string;
  readonly sql: string;
  readonly handle: string;
  readonly columns: readonly Column[];
  readonly typeClasses: readonly TypeClass[];
  readonly rowsAffected: number | null;
  /** Loaded windows keyed by their offset, a multiple of `RESULT_WINDOW_ROWS`; at most `MAX_LOADED_WINDOWS`. */
  readonly windows: Readonly<Record<number, readonly Row[]>>;
  /** Each column's width in characters from the first page, so scrolling and eviction never reflow it. */
  readonly autoChars: readonly number[];
  readonly sort: readonly SortKey[];
  readonly layout: ColumnLayout;
  readonly selection: GridSelection | null;
  readonly fetching: ResultFetch | null;
  /** How the export that drained its cursor ended, so the row count says why fetching stopped. */
  readonly exportEnded?: ExportTaskState;
  /** Its engine went away: the rows shown are all there will be until a rerun (plan 007 decision 18). */
  readonly stale: boolean;
  /** A pinned tab survives the next run; the others are replaced and their handles released. */
  readonly pinned: boolean;
  /** The page size and cap it ran with; a settings change applies to the next statement (decision 032). */
  readonly paging: ResultPaging;
  readonly search: ResultSearch;
  /** The engine's view of the rows while a find query or a chip is set; null shows every held row. */
  readonly view: ViewState | null;
  /**
   * The matched cells of each loaded window, by its offset, as flat `row, column` pairs (result
   * columns); a window without an entry is fetched again while the find bar marks cells.
   */
  readonly matches: Readonly<Record<number, readonly number[]>>;
  /** The one key a command result read (decision 119); its value format is remembered by the key's pattern. */
  readonly source?: KeySource;
  /** The value panel's format for a command result with no source key; it lasts as long as the tab. */
  readonly valueFormat?: ValueFormat;
}

/** Whether a find query is live, so windows carry the cells it matches. */
export function findsCells(result: ResultTab): boolean {
  return result.search.open && result.search.query.text !== "";
}

/** What the engine should show and mark for `result`, or null when nothing narrows or marks it. */
export function viewSpecOf(result: ResultTab, formats: CellFormats): ViewSpec | null {
  const find = findsCells(result) ? result.search.query : null;
  if (find === null && result.search.filters.length === 0) return null;
  return {
    find,
    rowsOnly: result.search.rowsOnly,
    filters: result.search.filters,
    columns: visibleColumns(result.layout),
    formats: { groupDigits: formats.groupDigits },
  };
}

/** Whether the columns a find searches, the drawn ones in their order, differ between two layouts. */
export function searchedColumnsChanged(before: ColumnLayout, after: ColumnLayout): boolean {
  const was = visibleColumns(before);
  const now = visibleColumns(after);
  return was.length !== now.length || was.some((column, index) => column !== now[index]);
}

/** Rows the grid shows from the result: the view's when it hides some, else all held rows. */
export function shownRowCount(result: ResultTab): number {
  return result.view?.filtered === true ? result.view.shown : result.rowCount;
}

/** The held rows the grid draws, with the held index of each while a local filter hides some. */
export function shownHeld(result: ResultTab): HeldRows {
  const sources = result.view?.filtered === true ? result.view.sources : null;
  return sources === null ? result.rowCount : { count: sources.length, sources };
}

/** What an analysed statement did to the data, for the plan's banner (plan 012 decision 12). */
export type AnalysedEffect = "none" | "committed" | "inTransaction";

export type PlanView = "tree" | "raw";

/**
 * A plan tab (plan 012 decision 10): one explained statement's plan, held whole in the renderer
 * because a plan is a few dozen nodes, not rows behind a handle.
 */
export interface PlanTab {
  readonly kind: "plan";
  readonly id: string;
  /** `Plan` or `Plan (analysed)`. */
  readonly title: string;
  /** The statement explained, without the EXPLAIN the plugin wrapped it in. */
  readonly sql: string;
  readonly analyzed: boolean;
  readonly effect: AnalysedEffect;
  readonly plan: ExplainedPlan;
  readonly view: PlanView;
  /** The selected node's path key (`0.1.2`), or null. */
  readonly selected: string | null;
  readonly collapsed: readonly string[];
  readonly pinned: boolean;
}

/** A console's result tabs hold rows or a plan. */
export type ConsoleTab = ResultTab | PlanTab;

export const PLAN_TITLE = "Plan";
export const ANALYSED_PLAN_TITLE = "Plan (analysed)";

export function planTabOf(id: string, sql: string, plan: ExplainedPlan, effect: AnalysedEffect): PlanTab {
  return {
    kind: "plan",
    id,
    title: plan.analyzed ? ANALYSED_PLAN_TITLE : PLAN_TITLE,
    sql,
    analyzed: plan.analyzed,
    effect,
    plan,
    view: "tree",
    selected: plan.roots.length > 0 ? "0" : null,
    collapsed: [],
    pinned: false,
  };
}

/** The window offset that holds row `index`. */
export function windowOffsetOf(index: number): number {
  return Math.floor(index / RESULT_WINDOW_ROWS) * RESULT_WINDOW_ROWS;
}

export function rowAt(windows: ResultTab["windows"], index: number): Row | undefined {
  const offset = windowOffsetOf(index);
  return windows[offset]?.[index - offset];
}

/** Windows a result tab keeps loaded (plan 007 decision 17); scrolling back refetches the rest. */
export const MAX_LOADED_WINDOWS = 20;

/** `windows` with `rows` at `offset`, dropping the windows furthest from it past `max`. */
export function withWindow(
  windows: ResultTab["windows"],
  offset: number,
  rows: readonly Row[],
  max: number = MAX_LOADED_WINDOWS,
): ResultTab["windows"] {
  const next: Record<number, readonly Row[]> = { ...windows, [offset]: rows };
  const offsets = Object.keys(next).map(Number);
  if (offsets.length <= max) return next;
  const furthest = offsets.sort((a, b) => Math.abs(b - offset) - Math.abs(a - offset)).slice(0, offsets.length - max);
  for (const evicted of furthest) delete next[evicted];
  return next;
}

/** A tab for `executed`, the statement `sql` returned. */
export function resultTabOf(
  executed: Omit<ExecutedStatement, "transactionOpen">,
  ids: { readonly id: string; readonly title: string },
  sql: string,
  paging: ResultPaging,
  formats: CellFormats,
): ResultTab {
  const { firstWindow, ...summary } = executed;
  return {
    ...summary,
    kind: "rows",
    ...ids,
    sql,
    paging,
    windows: { [firstWindow.offset]: firstWindow.rows },
    autoChars: columnChars(summary.columns, firstWindow.rows, summary.typeClasses, formats),
    sort: [],
    layout: initialLayout(summary.columns.length),
    selection: null,
    fetching: null,
    stale: false,
    pinned: false,
    search: NO_SEARCH,
    view: null,
    matches: {},
  };
}

/** `matches` with `pairs` at `offset`, keeping only windows still loaded. */
export function withMatches(
  matches: ResultTab["matches"],
  windows: ResultTab["windows"],
  offset: number,
  pairs: readonly number[],
): ResultTab["matches"] {
  const kept: Record<number, readonly number[]> = {};
  for (const [key, value] of Object.entries(matches)) if (key in windows) kept[Number(key)] = value;
  return { ...kept, [offset]: pairs };
}

/** What the find bar says of its query: `3 of 1,284`, `1,284 matches`, `No matches` or the regex error. */
export function findStatusText(result: ResultTab): string | null {
  const { view, search } = result;
  if (search.query.text === "" || view === null) return null;
  if (view.error !== null) return `Invalid regular expression: ${view.error}`;
  if (view.matches === 0) return "No matches";
  if (search.current !== null) return `${formatCount(search.current.index + 1)} of ${formatCount(view.matches)}`;
  return view.matches === 1 ? "1 match" : `${formatCount(view.matches)} matches`;
}

/** Why the search may not cover the whole result: only fetched rows are searched (decision 050). */
export function searchedScopeText(result: ResultTab): string | null {
  if (result.complete) return null;
  const count = formatCount(result.rowCount);
  if (!result.cursorOpen && result.rowCount >= result.paging.fetchAllCap) {
    return `Searched the first ${count} rows; the fetch cap is reached`;
  }
  return `Searched ${count} fetched rows`;
}
