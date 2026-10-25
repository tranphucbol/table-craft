import {
  RESULT_FETCH_ALL_CAP,
  RESULT_PAGE_ROWS,
  RESULT_WINDOW_ROWS,
  ResultStore,
  type CoreError,
} from "@table-craft/core";
import type { Column, ExecuteResult, Row, WireValue } from "@table-craft/plugin-api";
import { describe, expect, it } from "vitest";

const ROW_COUNT = 1_200;
const WINDOW_OFFSET = 1_000;
const HUGE_ROW_COUNT = 200_000;
const SMALL_PAGE = 2;
const PER_CALL_PAGE = 10;
const PER_CALL_CAP = 25;
const INTEGER_COLUMN: readonly Column[] = [{ name: "n", type: "INTEGER" }];

function resultOf(count: number, onReturn?: () => void): ExecuteResult {
  async function* rows(): AsyncGenerator<Row> {
    try {
      for (let index = 0; index < count; index++) yield await Promise.resolve([index]);
    } finally {
      onReturn?.();
    }
  }
  return { columns: INTEGER_COLUMN, rows: rows(), rowsAffected: null };
}

function resultFrom(columns: readonly Column[], values: readonly Row[]): ExecuteResult {
  async function* rows(): AsyncGenerator<Row> {
    for (const row of values) yield await Promise.resolve(row);
  }
  return { columns, rows: rows(), rowsAffected: null };
}

function column(store: ResultStore, handle: string, index = 0): WireValue[] {
  return store.window(handle, 0).rows.map((row) => row[index] ?? null);
}

describe("ResultStore", () => {
  it("givenResultOf1200Rows_whenFetchedAndWindowRequestedAt1000_thenReturns200Rows", async () => {
    const store = new ResultStore();
    const { handle } = await store.put(resultOf(ROW_COUNT));
    const { rowCount } = await store.fetchMore(handle, { all: true });

    const window = store.window(handle, WINDOW_OFFSET);

    expect(rowCount).toBe(ROW_COUNT);
    expect(window.rows).toHaveLength(ROW_COUNT - WINDOW_OFFSET);
    expect(window.rows[0]).toEqual([WINDOW_OFFSET]);
  });

  it("givenReleasedHandle_whenWindowRequested_thenUnknownHandleError", async () => {
    const store = new ResultStore();
    const { handle } = await store.put(resultOf(1));
    await store.release(handle);

    expect(() => store.window(handle, 0)).toThrow(expect.objectContaining({ code: "unknownHandle" }) as CoreError);
  });

  it("givenLimitAboveWindowSize_whenWindowRequested_thenClampedToWindowSize", async () => {
    const store = new ResultStore();
    const { handle } = await store.put(resultOf(ROW_COUNT));

    expect(store.window(handle, 0, ROW_COUNT).rows).toHaveLength(RESULT_WINDOW_ROWS);
  });

  it("givenLargeResult_whenExecuted_thenFirstPageOnlyAndCursorOpen", async () => {
    let returned = false;
    const store = new ResultStore();

    const summary = await store.put(
      resultOf(ROW_COUNT, () => {
        returned = true;
      }),
    );

    expect(summary).toMatchObject({ rowCount: RESULT_PAGE_ROWS, complete: false, cursorOpen: true });
    expect(returned).toBe(false);
  });

  it("givenExactlyOnePage_whenExecuted_thenCompleteAndCursorClosed", async () => {
    const store = new ResultStore();

    const summary = await store.put(resultOf(RESULT_PAGE_ROWS));

    expect(summary).toMatchObject({ rowCount: RESULT_PAGE_ROWS, complete: true, cursorOpen: false });
  });

  it("givenOpenCursor_whenFetchMore_thenNextPageAppended", async () => {
    let returned = false;
    const store = new ResultStore();
    const { handle } = await store.put(
      resultOf(ROW_COUNT, () => {
        returned = true;
      }),
    );

    const second = await store.fetchMore(handle, { all: false });
    const third = await store.fetchMore(handle, { all: false });

    expect(second).toEqual({ rowCount: 2 * RESULT_PAGE_ROWS, complete: false, cursorOpen: true });
    expect(third).toEqual({ rowCount: ROW_COUNT, complete: true, cursorOpen: false });
    expect(returned).toBe(true);
    expect(store.window(handle, WINDOW_OFFSET).rows[0]).toEqual([WINDOW_OFFSET]);
  });

  it("givenOpenCursor_whenFetchAll_thenStopsAtCapWithCursorClosed", async () => {
    let returned = false;
    const store = new ResultStore();
    const { handle } = await store.put(
      resultOf(HUGE_ROW_COUNT, () => {
        returned = true;
      }),
    );

    const state = await store.fetchMore(handle, { all: true });

    expect(state).toEqual({ rowCount: RESULT_FETCH_ALL_CAP, complete: false, cursorOpen: false });
    expect(returned).toBe(true);
    expect(await store.fetchMore(handle, { all: true })).toEqual(state);
  });

  it("givenOpenCursor_whenSessionRunsAnotherStatement_thenCursorClosedRowsKept", async () => {
    let returned = false;
    const store = new ResultStore();
    const { handle } = await store.put(
      resultOf(ROW_COUNT, () => {
        returned = true;
      }),
    );

    const state = await store.closeCursor(handle);

    expect(state).toEqual({ rowCount: RESULT_PAGE_ROWS, complete: false, cursorOpen: false });
    expect(returned).toBe(true);
    expect(store.window(handle, 0).rows).toHaveLength(RESULT_PAGE_ROWS);
  });

  it("givenOpenCursor_whenReleased_thenIteratorReturned", async () => {
    let returned = false;
    const store = new ResultStore();
    const { handle } = await store.put(
      resultOf(ROW_COUNT, () => {
        returned = true;
      }),
    );

    await store.release(handle);

    expect(returned).toBe(true);
    expect(store.size).toBe(0);
  });

  it("givenRunningFetchAll_whenStopped_thenRowsKeptAndCursorStillOpen", async () => {
    const store = new ResultStore();
    const { handle } = await store.put(resultOf(HUGE_ROW_COUNT));

    const fetching = store.fetchMore(handle, { all: true });
    const stopped = await store.stopFetch(handle);
    await fetching;

    expect(stopped.cursorOpen).toBe(true);
    expect(stopped.rowCount).toBeLessThan(RESULT_FETCH_ALL_CAP);
    expect((await store.fetchMore(handle, { all: false })).rowCount).toBe(stopped.rowCount + RESULT_PAGE_ROWS);
  });

  it("givenLimitsWithEachCall_whenPutAndFetched_thenPageAndCapAreTheCallers", async () => {
    const store = new ResultStore();
    const limits = { pageRows: PER_CALL_PAGE, fetchAllCap: PER_CALL_CAP };
    const { handle, rowCount } = await store.put(resultOf(ROW_COUNT), limits);

    const nextPage = await store.fetchMore(handle, { all: false, ...limits });
    const all = await store.fetchMore(handle, { all: true, ...limits });

    expect(rowCount).toBe(PER_CALL_PAGE);
    expect(nextPage.rowCount).toBe(2 * PER_CALL_PAGE);
    expect(all).toEqual({ rowCount: PER_CALL_CAP, complete: false, cursorOpen: false });
  });

  it("givenFailingCursor_whenFetchMore_thenRejectsAndCursorClosed", async () => {
    const store = new ResultStore({ pageRows: SMALL_PAGE });
    async function* rows(): AsyncGenerator<Row> {
      yield await Promise.resolve([1]);
      yield [2];
      yield [3];
      throw new Error("division by zero");
    }
    const { handle } = await store.put({ columns: INTEGER_COLUMN, rows: rows(), rowsAffected: null });

    await expect(store.fetchMore(handle, { all: true })).rejects.toThrow("division by zero");

    expect(store.state(handle)).toEqual({ rowCount: 3, complete: false, cursorOpen: false });
  });

  it("givenDecimalTextColumn_whenSortedAscending_thenNumericOrderNullsLast", async () => {
    const store = new ResultStore();
    const { handle } = await store.put(
      resultFrom([{ name: "total", type: "numeric" }], [["9.5"], ["10.25"], [null], ["-3"]]),
    );

    store.sort(handle, [{ column: 0, direction: "asc" }]);
    const ascending = column(store, handle);
    store.sort(handle, [{ column: 0, direction: "desc" }]);
    const descending = column(store, handle);
    store.sort(handle, []);

    expect(ascending).toEqual(["-3", "9.5", "10.25", null]);
    expect(descending).toEqual([null, "10.25", "9.5", "-3"]);
    expect(column(store, handle)).toEqual(["9.5", "10.25", null, "-3"]);
  });

  it("givenSortedResult_whenFetchMore_thenNewRowsTakeSortedPositions", async () => {
    const store = new ResultStore({ pageRows: SMALL_PAGE });
    const { handle } = await store.put(resultFrom(INTEGER_COLUMN, [[5], [1], [4], [2], [3]]));
    store.sort(handle, [{ column: 0, direction: "asc" }]);

    await store.fetchMore(handle, { all: false });

    expect(column(store, handle)).toEqual([1, 2, 4, 5]);
  });

  it("givenTwoSortKeys_whenSorted_thenSecondaryBreaksTies", async () => {
    const store = new ResultStore();
    const columns: Column[] = [
      { name: "id", type: "int4" },
      { name: "customer_id", type: "int4" },
    ];
    const { handle } = await store.put(
      resultFrom(columns, [
        [4, 2],
        [1, 2],
        [3, 1],
        [2, 1],
      ]),
    );

    store.sort(handle, [
      { column: 1, direction: "asc" },
      { column: 0, direction: "desc" },
    ]);

    expect(column(store, handle)).toEqual([3, 2, 4, 1]);
  });

  it("givenSortKeyOutsideColumns_whenSorted_thenInvalidRequest", async () => {
    const store = new ResultStore();
    const { handle } = await store.put(resultOf(1));

    expect(() => store.sort(handle, [{ column: 1, direction: "asc" }])).toThrow(
      expect.objectContaining({ code: "invalidRequest" }) as CoreError,
    );
  });

  it("givenOpenCursor_whenDrained_thenLookaheadAndRestYieldedOnce", async () => {
    const store = new ResultStore({ pageRows: SMALL_PAGE });
    const { handle } = await store.put(resultOf(5));

    const rest = await store.drain(handle, async (rows) => {
      const seen: Row[] = [];
      for await (const row of rows) seen.push(row);
      return seen;
    });

    expect(rest).toEqual([[2], [3], [4]]);
    expect(store.state(handle)).toEqual({ rowCount: SMALL_PAGE, complete: false, cursorOpen: false });
  });

  it("givenColumnWithoutType_whenPut_thenClassInferredFromFirstPage", async () => {
    const store = new ResultStore();
    const columns: readonly Column[] = [
      { name: "n", type: null },
      { name: "label", type: "TEXT" },
    ];

    const summary = await store.put(
      resultFrom(columns, [
        [null, "a"],
        [2, "b"],
      ]),
    );

    expect(summary.typeClasses).toEqual(["integer", "text"]);
  });

  it("givenPluginNamedTypeClass_whenPut_thenItWinsOverNameAndValues", async () => {
    const store = new ResultStore();
    const columns: readonly Column[] = [
      { name: "flag", type: "BIT", typeClass: "boolean" },
      { name: "n", type: null, typeClass: "decimal" },
    ];

    const summary = await store.put(resultFrom(columns, [[true, 2]]));

    expect(summary.typeClasses).toEqual(["boolean", "decimal"]);
  });
});
