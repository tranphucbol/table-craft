import type { Column, ExecuteResult, Row, ServerMessage } from "@table-craft/plugin-api";
import { CoreError } from "@table-craft/core/errors.js";
import { compareValues, inferredTypeClass, typeClass, type TypeClass } from "@table-craft/core/results/compare.js";
import {
  computeView,
  matchesIn,
  nextMatch,
  viewActive,
  viewState,
  type CellPosition,
  type ComputedView,
  type FoundMatch,
  type ViewSpec,
  type ViewState,
} from "@table-craft/core/results/view.js";

/** Rows per window the grid requests; desktop's protocol pins the same value (decision 009). */
export const RESULT_WINDOW_ROWS = 500;
/** Rows read when a statement runs and on each Fetch Next Page (decision 025). */
export const RESULT_PAGE_ROWS = 500;
/** Rows a result may hold; Fetch All stops here and closes the cursor (decision 025). */
export const RESULT_FETCH_ALL_CAP = 100_000;

export type ResultHandle = string;

/** How far a result has been read, and whether more can be. */
export interface ResultState {
  readonly rowCount: number;
  /** Every row the statement produced is held. */
  readonly complete: boolean;
  /** Fetch Next Page and Fetch All can still read more. */
  readonly cursorOpen: boolean;
  /** What the server said running the statement (decision 066); present once complete, when it said anything. */
  readonly messages?: readonly ServerMessage[];
}

export interface ResultSummary extends ResultState {
  readonly handle: ResultHandle;
  readonly columns: readonly Column[];
  /** Each column's class, so the grid draws its glyph without a classifier of its own. */
  readonly typeClasses: readonly TypeClass[];
  readonly rowsAffected: number | null;
}

export interface ResultWindow {
  readonly offset: number;
  readonly rows: readonly Row[];
  /** With a find query set: the matched cells in these rows as flat `row, column` pairs (decision 050). */
  readonly matches?: readonly number[];
}

export type SortDirection = "asc" | "desc";

export interface SortKey {
  /** Index into the result's columns. */
  readonly column: number;
  readonly direction: SortDirection;
}

export interface ResultLimits {
  readonly pageRows: number;
  readonly fetchAllCap: number;
}

/** Limits given with a call win over the store's own (decision 032: paging travels with each request). */
export interface FetchOptions extends Partial<ResultLimits> {
  /** Read to the end, or to the Fetch All cap, instead of one page. */
  readonly all: boolean;
}

const DEFAULT_LIMITS: ResultLimits = { pageRows: RESULT_PAGE_ROWS, fetchAllCap: RESULT_FETCH_ALL_CAP };

interface StoredResult {
  readonly columns: readonly Column[];
  /** The plugin's own array, filled once its rows run out. */
  readonly messages: readonly ServerMessage[];
  classes: readonly TypeClass[];
  readonly rows: Row[];
  /** Open until the rows run out, the cap is reached, or the session moves on. */
  iterator: AsyncIterator<Row> | null;
  /** Read past the last held row, so `complete` is known without another round trip. */
  lookahead: { readonly row: Row } | null;
  complete: boolean;
  keys: readonly SortKey[];
  /** Positions in `rows` in sorted order; null when unsorted or stale after a fetch. */
  order: number[] | null;
  /** The find query and local filters the grid set; null shows every held row. */
  spec: ViewSpec | null;
  /** `spec` applied to the rows; null when there is none or it is stale after a fetch or sort. */
  view: ComputedView | null;
  /** The fetch in flight, so fetches on one handle run one after another. */
  fetching: Promise<unknown>;
  /** Raised by `stopFetch` and `closeCursor`; the running fetch checks it between rows. */
  stopRequested: boolean;
}

const HANDLE_PREFIX = "result-";

function definedLimits(options: Partial<ResultLimits>): Partial<ResultLimits> {
  return {
    ...(options.pageRows === undefined ? {} : { pageRows: options.pageRows }),
    ...(options.fetchAllCap === undefined ? {} : { fetchAllCap: options.fetchAllCap }),
  };
}

function unknownHandle(handle: ResultHandle): CoreError {
  return new CoreError(
    "unknownHandle",
    `No result with handle "${handle}"; it was released or never existed.`,
    "Run the statement again.",
  );
}

function stateOf(stored: StoredResult): ResultState {
  const state = { rowCount: stored.rows.length, complete: stored.complete, cursorOpen: stored.iterator !== null };
  return stored.complete && stored.messages.length > 0 ? { ...state, messages: stored.messages } : state;
}

/**
 * Holds result rows by handle so only windows of them ever leave the process. A result keeps its
 * cursor open after the first page until the rows run out or the caller closes it (decision 025).
 */
export class ResultStore {
  readonly #results = new Map<ResultHandle, StoredResult>();
  readonly #limits: ResultLimits;
  #nextHandle = 1;

  constructor(limits: Partial<ResultLimits> = {}) {
    this.#limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /** Reads the first page from `result.rows` and keeps the iterator for the next. */
  async put(result: ExecuteResult, limits: Partial<ResultLimits> = {}): Promise<ResultSummary> {
    const { pageRows, fetchAllCap } = { ...this.#limits, ...definedLimits(limits) };
    const stored: StoredResult = {
      columns: result.columns,
      messages: result.messages ?? [],
      classes: [],
      rows: [],
      iterator: result.rows[Symbol.asyncIterator](),
      lookahead: null,
      complete: false,
      keys: [],
      order: null,
      spec: null,
      view: null,
      fetching: Promise.resolve(),
      stopRequested: false,
    };
    try {
      await this.#read(stored, Math.min(pageRows, fetchAllCap), fetchAllCap);
    } catch (cause) {
      await this.#close(stored);
      throw cause;
    }
    stored.classes = result.columns.map((column, index) =>
      column.type === null ? inferredTypeClass(stored.rows.map((row) => row[index] ?? null)) : typeClass(column.type),
    );
    const handle = `${HANDLE_PREFIX}${this.#nextHandle++}`;
    this.#results.set(handle, stored);
    return {
      handle,
      columns: result.columns,
      typeClasses: stored.classes,
      rowsAffected: result.rowsAffected,
      ...stateOf(stored),
    };
  }

  /** Appends a page, or everything up to the cap; a sorted result re-sorts with the new rows. */
  fetchMore(handle: ResultHandle, options: FetchOptions): Promise<ResultState> {
    const stored = this.#stored(handle);
    const fetch = stored.fetching.then(async () => {
      if (stored.iterator === null) return stateOf(stored);
      const { pageRows, fetchAllCap } = { ...this.#limits, ...definedLimits(options) };
      const target = options.all ? fetchAllCap : stored.rows.length + pageRows;
      try {
        await this.#read(stored, Math.min(target, fetchAllCap), fetchAllCap);
      } catch (cause) {
        await this.#close(stored);
        throw cause;
      }
      return stateOf(stored);
    });
    stored.fetching = fetch.catch(() => undefined);
    return fetch;
  }

  /**
   * Ends a running fetch, and any queued before this call, after its current row; the rows read
   * so far stay and the cursor stays open.
   */
  async stopFetch(handle: ResultHandle): Promise<ResultState> {
    const stored = this.#stored(handle);
    stored.stopRequested = true;
    await stored.fetching;
    stored.stopRequested = false;
    return stateOf(stored);
  }

  /** Stops reading for good; the rows already held stay. A no-op once the cursor is closed. */
  async closeCursor(handle: ResultHandle): Promise<ResultState> {
    const stored = this.#stored(handle);
    stored.stopRequested = true;
    await stored.fetching;
    await this.#close(stored);
    return stateOf(stored);
  }

  /** Sorts the held rows locally; an empty `keys` restores the order the statement returned. */
  sort(handle: ResultHandle, keys: readonly SortKey[]): ResultState {
    const stored = this.#stored(handle);
    for (const key of keys) {
      if (!Number.isInteger(key.column) || key.column < 0 || key.column >= stored.columns.length) {
        throw new CoreError(
          "invalidRequest",
          `Sort column ${String(key.column)} is outside this result's ${String(stored.columns.length)} columns.`,
          "Sort by a column the result has.",
        );
      }
    }
    stored.keys = keys;
    stored.order = null;
    stored.view = null;
    return stateOf(stored);
  }

  /**
   * Sets the find query and local filters every later window, copy and visible-only export sees
   * (decision 050); null clears them. Recomputed after each fetch and sort.
   */
  setView(handle: ResultHandle, spec: ViewSpec | null): ViewState {
    const stored = this.#stored(handle);
    const columns = stored.columns.length;
    const outside = [...(spec?.columns ?? []), ...(spec?.filters ?? []).map((chip) => chip.column)].find(
      (column) => !Number.isInteger(column) || column < 0 || column >= columns,
    );
    if (outside !== undefined) {
      throw new CoreError(
        "invalidRequest",
        `Column ${String(outside)} is outside this result's ${String(columns)} columns.`,
        "Search and filter the columns the result has.",
      );
    }
    stored.spec = viewActive(spec) ? spec : null;
    stored.view = null;
    return this.viewState(handle);
  }

  /** What the current view shows; every held row when no view is set. */
  viewState(handle: ResultHandle): ViewState {
    const stored = this.#stored(handle);
    const view = this.#view(stored);
    if (view === null) return { shown: stored.rows.length, filtered: false, sources: null, matches: 0, error: null };
    return viewState(view, stored.rows.length);
  }

  /** The match after (or before) `from` in the current view, wrapping; null when nothing matches. */
  findMatch(handle: ResultHandle, from: CellPosition | null, backward: boolean): FoundMatch | null {
    const view = this.#view(this.#stored(handle));
    return view === null ? null : nextMatch(view, from, backward);
  }

  /** At most `RESULT_WINDOW_ROWS` rows from `offset` in the current sort order and view. */
  window(handle: ResultHandle, offset: number, limit: number = RESULT_WINDOW_ROWS): ResultWindow {
    const stored = this.#stored(handle);
    const start = Math.max(0, offset);
    const count = Math.max(0, Math.min(limit, RESULT_WINDOW_ROWS));
    const view = this.#view(stored);
    const positions = view?.sources ?? (stored.keys.length === 0 ? null : this.#order(stored));
    const rows =
      positions === null
        ? stored.rows.slice(start, start + count)
        : positions.slice(start, start + count).map((index) => stored.rows[index] as Row);
    if (view === null || stored.spec === null || stored.spec.find === null) return { offset: start, rows };
    return { offset: start, rows, matches: matchesIn(view, start, rows.length) };
  }

  /** Every held row in the current sort order, for edits, conditions and a whole-result export. */
  rows(handle: ResultHandle): readonly Row[] {
    return this.#ordered(this.#stored(handle));
  }

  /**
   * Every held row by the index a window names it with: by arrival while a filtered view stands,
   * whose sources index the rows as they arrived, else in the current sort order. What edits read.
   */
  heldRows(handle: ResultHandle): readonly Row[] {
    const stored = this.#stored(handle);
    return (this.#view(stored)?.sources ?? null) === null ? this.#ordered(stored) : stored.rows;
  }

  /** The rows the current view shows, in its order: what copy and a visible-only export read. */
  shownRows(handle: ResultHandle): readonly Row[] {
    const stored = this.#stored(handle);
    const sources = this.#view(stored)?.sources ?? null;
    if (sources === null) return this.#ordered(stored);
    return sources.map((index) => stored.rows[index] as Row);
  }

  columns(handle: ResultHandle): readonly Column[] {
    return this.#stored(handle).columns;
  }

  state(handle: ResultHandle): ResultState {
    return stateOf(this.#stored(handle));
  }

  /**
   * Hands the open cursor to `use` and forgets it, for an export that drains it past the cap.
   * Yields the lookahead row first. The result is complete when `use` resolves.
   */
  async drain<T>(handle: ResultHandle, use: (rows: AsyncIterable<Row>) => Promise<T>): Promise<T> {
    const stored = this.#stored(handle);
    await stored.fetching;
    const { iterator, lookahead } = stored;
    stored.iterator = null;
    stored.lookahead = null;
    if (iterator === null) return use(EMPTY_ROWS);
    async function* rest(): AsyncGenerator<Row, void, undefined> {
      if (lookahead !== null) yield lookahead.row;
      for (;;) {
        const next = await (iterator as AsyncIterator<Row>).next();
        if (next.done === true) return;
        yield next.value;
      }
    }
    const rows = rest();
    try {
      return await use(rows);
    } finally {
      await rows.return(undefined);
      await iterator.return?.();
    }
  }

  /** Closes the cursor and drops the rows. Releasing an unknown handle is a no-op, so a renderer may release twice. */
  async release(handle: ResultHandle): Promise<void> {
    const stored = this.#results.get(handle);
    if (stored === undefined) return;
    this.#results.delete(handle);
    stored.stopRequested = true;
    await stored.fetching;
    await this.#close(stored);
  }

  get size(): number {
    return this.#results.size;
  }

  #stored(handle: ResultHandle): StoredResult {
    const stored = this.#results.get(handle);
    if (stored === undefined) throw unknownHandle(handle);
    return stored;
  }

  #order(stored: StoredResult): readonly number[] {
    stored.order ??= sortedOrder(stored);
    return stored.order;
  }

  #view(stored: StoredResult): ComputedView | null {
    if (stored.spec === null) return null;
    stored.view ??= computeView(
      stored.rows,
      stored.keys.length === 0 ? null : this.#order(stored),
      stored.classes,
      stored.spec,
    );
    return stored.view;
  }

  #ordered(stored: StoredResult): readonly Row[] {
    if (stored.keys.length === 0) return stored.rows;
    return this.#order(stored).map((index) => stored.rows[index] as Row);
  }

  /** Reads until `target` rows are held, the rows run out, or a stop is requested. */
  async #read(stored: StoredResult, target: number, fetchAllCap: number): Promise<void> {
    const { rows } = stored;
    while (rows.length < target && stored.iterator !== null && !stored.stopRequested) {
      if (stored.lookahead !== null) {
        rows.push(stored.lookahead.row);
        stored.lookahead = null;
        continue;
      }
      const next = await stored.iterator.next();
      if (next.done === true) {
        stored.complete = true;
        stored.iterator = null;
        break;
      }
      rows.push(next.value);
    }
    stored.order = null;
    stored.view = null;
    if (stored.iterator === null || stored.lookahead !== null || stored.stopRequested) return;
    const next = await stored.iterator.next();
    if (next.done === true) {
      stored.complete = true;
      stored.iterator = null;
      return;
    }
    stored.lookahead = { row: next.value };
    if (rows.length >= fetchAllCap) await this.#close(stored);
  }

  async #close(stored: StoredResult): Promise<void> {
    const { iterator } = stored;
    stored.iterator = null;
    stored.lookahead = null;
    await iterator?.return?.();
  }
}

const EMPTY_ROWS: AsyncIterable<Row> = {
  [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }),
};

function sortedOrder(stored: StoredResult): number[] {
  const order = stored.rows.map((_, index) => index);
  const { rows, keys, classes } = stored;
  order.sort((left, right) => {
    for (const key of keys) {
      const a = rows[left]?.[key.column] ?? null;
      const b = rows[right]?.[key.column] ?? null;
      const compared = compareValues(a, b, classes[key.column] ?? "text");
      if (compared !== 0) return key.direction === "asc" ? compared : -compared;
    }
    return left - right;
  });
  return order;
}
