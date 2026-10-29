import { describe, expect, it, vi } from "vitest";
import {
  RESULT_FETCH_ALL_CAP,
  RESULT_WINDOW_ROWS,
  type ClassifiedStatement,
  type ExecutedStatement,
  type OpenedSession,
  type ResultState,
  type Row,
} from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { bytesNote, hexLines, panelValue } from "@table-craft/desktop/renderer/grid/format.js";
import { hiddenColumn } from "@table-craft/desktop/renderer/model/columnLayout.js";
import { exportedText, resultStateText } from "@table-craft/desktop/renderer/model/format.js";
import { selectCell } from "@table-craft/desktop/renderer/model/gridSelection.js";
import { prettyJson } from "@table-craft/desktop/renderer/model/prettyJson.js";
import {
  createConsolesStore,
  MAX_LOADED_WINDOWS,
  withWindow,
  type ResultTab,
} from "@table-craft/desktop/renderer/state/consoles.js";
import { createExecutionsStore } from "@table-craft/desktop/renderer/state/executions.js";

const TOTAL_ROWS = 50_000;
const FIRST_PAGE = 500;

function rowsAt(offset: number, limit: number, total: number): Row[] {
  return Array.from({ length: Math.max(Math.min(limit, total - offset), 0) }, (_, index) => [offset + index + 1]);
}

/** An engine whose every SELECT returns a first page of `TOTAL_ROWS` with the cursor open. */
function pagingEngine() {
  let fetched = FIRST_PAGE;
  let handles = 0;
  const state = (): ResultState => ({
    rowCount: fetched,
    complete: fetched >= TOTAL_ROWS,
    cursorOpen: fetched < TOTAL_ROWS,
  });
  const call = vi.fn((type: string, params: Record<string, unknown>): Promise<unknown> => {
    switch (type) {
      case "session.open": {
        const opened: OpenedSession = {
          sessionId: "s1",
          pluginName: "fake",
          capabilities: ["sql"],
          serverVersion: "1",
          serverBrand: null,
          namespace: null,
        };
        return Promise.resolve(opened);
      }
      case "script.split": {
        const text = String(params.text).trim();
        const statement: ClassifiedStatement = {
          from: 0,
          to: text.length,
          sql: text,
          kind: "read",
          destructive: null,
          parameters: [],
        };
        return Promise.resolve([statement]);
      }
      case "statement.execute": {
        fetched = FIRST_PAGE;
        const executed: ExecutedStatement = {
          handle: `h${String(++handles)}`,
          columns: [
            { name: "n", type: "int4" },
            { name: "hash", type: "text" },
          ],
          typeClasses: ["integer", "text"],
          ...state(),
          rowsAffected: null,
          firstWindow: { offset: 0, rows: rowsAt(0, RESULT_WINDOW_ROWS, fetched) },
          transactionOpen: false,
        };
        return Promise.resolve(executed);
      }
      case "result.fetchMore":
        fetched = params.all === true ? TOTAL_ROWS : fetched + FIRST_PAGE;
        return Promise.resolve(state());
      case "result.sort":
        return Promise.resolve(state());
      case "result.window": {
        const offset = Number(params.offset);
        return Promise.resolve({ offset, rows: rowsAt(offset, Number(params.limit), fetched) });
      }
      default:
        return Promise.resolve(null);
    }
  });
  return { client: { call } as unknown as EngineClient, call };
}

async function ranQuery() {
  const engine = pagingEngine();
  const executions = createExecutionsStore();
  const store = createConsolesStore({
    connect: () => Promise.resolve(engine.client),
    now: () => 0,
    clock: () => 0,
    executions: executions.getState(),
  });
  await store.getState().open("c1", "pg", { sql: "SELECT n FROM big" });
  await store.getState().run("c1", "all");
  const result = (): ResultTab => {
    const found = store.getState().consoles.c1?.results[0];
    if (found?.kind !== "rows") throw new Error("no result tab");
    return found;
  };
  const calls = (type: string) => engine.call.mock.calls.filter(([name]) => name === type);
  const servicesRowCounts = () => executions.getState().byTab.c1?.map((execution) => execution.rowCount);
  return { ...engine, store, result, calls, servicesRowCounts };
}

describe("result grid state", () => {
  it("givenFirstPage_whenExecuted_thenTabHoldsCursorStateAndOutputSaysPlus", async () => {
    const { store, result } = await ranQuery();

    expect(result()).toMatchObject({ rowCount: 500, complete: false, cursorOpen: true, stale: false });
    expect(store.getState().consoles.c1?.output.at(-1)?.message).toBe("500+ rows retrieved in 0 ms");
  });

  it("givenOpenCursor_whenFetchNextPageThenAll_thenCountsFollowTheEngine", async () => {
    const { store, result } = await ranQuery();

    await store.getState().fetchMore("c1", result().id, false);
    expect(result()).toMatchObject({ rowCount: 1_000, complete: false, cursorOpen: true, fetching: null });
    await store.getState().fetchMore("c1", result().id, true);
    expect(result()).toMatchObject({ rowCount: TOTAL_ROWS, complete: true, cursorOpen: false });
  });

  it("givenFetchAll_whenFinished_thenServicesRowShowsAllRows", async () => {
    const { store, result, servicesRowCounts } = await ranQuery();
    expect(servicesRowCounts()).toEqual([FIRST_PAGE]);

    await store.getState().fetchMore("c1", result().id, true);

    expect(servicesRowCounts()).toEqual([TOTAL_ROWS]);
  });

  it("givenTwentyOneWindows_whenAnotherLoads_thenFurthestEvicted", () => {
    let windows: ResultTab["windows"] = {};
    for (let index = 0; index <= MAX_LOADED_WINDOWS; index++) {
      windows = withWindow(windows, index * RESULT_WINDOW_ROWS, [[index]]);
    }

    const offsets = Object.keys(windows).map(Number);
    expect(offsets).toHaveLength(MAX_LOADED_WINDOWS);
    expect(offsets).not.toContain(0);
    expect(offsets).toContain(MAX_LOADED_WINDOWS * RESULT_WINDOW_ROWS);
  });

  it("givenScrollThroughFetchedRows_whenWindowsLoad_thenAtMostTwentyKept", async () => {
    const { store, result, calls } = await ranQuery();
    await store.getState().fetchMore("c1", result().id, true);

    for (let offset = 0; offset < TOTAL_ROWS; offset += RESULT_WINDOW_ROWS) {
      store.getState().ensureWindow("c1", result().id, offset);
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(Object.keys(result().windows).length).toBeLessThanOrEqual(MAX_LOADED_WINDOWS);
    expect(result().windows[TOTAL_ROWS - RESULT_WINDOW_ROWS]?.[0]).toEqual([TOTAL_ROWS - RESULT_WINDOW_ROWS + 1]);
    expect(calls("result.window").length).toBeGreaterThan(MAX_LOADED_WINDOWS);
  });

  it("givenEngineExited_whenResultShown_thenStaleAndNoFetch", async () => {
    const { store, result, calls } = await ranQuery();

    store.getState().detach("pg", null);
    await store.getState().fetchMore("c1", result().id, false);
    store.getState().ensureWindow("c1", result().id, RESULT_WINDOW_ROWS);

    expect(result()).toMatchObject({ stale: true, cursorOpen: false, rowCount: 500 });
    expect(result().windows[0]).toHaveLength(RESULT_WINDOW_ROWS);
    expect(calls("result.fetchMore")).toHaveLength(0);
    expect(calls("result.window")).toHaveLength(0);
  });

  it("givenStaleResult_whenRerun_thenReconnectsAndKeepsLayout", async () => {
    const { store, result, calls } = await ranQuery();
    store.getState().setLayout("c1", result().id, hiddenColumn(result().layout, 1));
    store.getState().detach("pg", null);

    await store.getState().rerun("c1", result().id);

    expect(calls("session.open")).toHaveLength(2);
    expect(result()).toMatchObject({ stale: false, cursorOpen: true, handle: "h2", title: "Result 1" });
    expect(result().layout.hidden).toEqual([false, true]);
  });

  it("givenSortedResult_whenRerun_thenSortReappliedAndWindowsRefetched", async () => {
    const { store, result, calls } = await ranQuery();
    await store.getState().sort("c1", result().id, [{ column: 0, direction: "desc" }]);
    expect(result().windows).toEqual({});

    await store.getState().rerun("c1", result().id);

    expect(calls("result.sort").map(([, params]) => params)).toEqual([
      { handle: "h1", keys: [{ column: 0, direction: "desc" }] },
      { handle: "h2", keys: [{ column: 0, direction: "desc" }] },
    ]);
    expect(calls("result.release").map(([, params]) => params)).toEqual([{ handle: "h1" }]);
    expect(result().sort).toEqual([{ column: 0, direction: "desc" }]);
  });

  it("givenSelection_whenColumnHidden_thenSelectionCleared", async () => {
    const { store, result } = await ranQuery();
    store.getState().select("c1", result().id, selectCell({ row: 3, column: 1 }));

    store.getState().setLayout("c1", result().id, hiddenColumn(result().layout, 0));

    expect(result().selection).toBeNull();
  });
});

describe("result grid text", () => {
  const base = { complete: false, cursorOpen: true, sorted: false, fetchAllCap: RESULT_FETCH_ALL_CAP };

  it("givenEachFetchState_whenLabelled_thenReadsAsTheFooterSays", () => {
    expect(resultStateText({ ...base, rowCount: 500 })).toBe("500+ rows");
    expect(resultStateText({ ...base, rowCount: 1_000 })).toBe("1,000+ rows");
    expect(resultStateText({ ...base, rowCount: 5_000, complete: true, cursorOpen: false })).toBe("5,000 rows");
    expect(resultStateText({ ...base, rowCount: 500, cursorOpen: false })).toBe("500+ rows · fetching stopped");
    expect(resultStateText({ ...base, rowCount: RESULT_FETCH_ALL_CAP, cursorOpen: false })).toBe(
      "100,000+ rows · fetch cap reached",
    );
    expect(resultStateText({ ...base, rowCount: 500, sorted: true })).toBe("500+ rows · sorted locally");
    expect(resultStateText({ ...base, rowCount: 1, complete: true })).toBe("1 row");
  });

  it("givenExport_whenLogged_thenRowsPathSizeAndTime", () => {
    expect(exportedText({ path: "/tmp/a.csv", rows: 50_000, bytes: 1_468_006, elapsedMs: 1_200 })).toBe(
      "50,000 rows exported to /tmp/a.csv (1.4 MB) in 1.2 s",
    );
  });

  it("givenJsonWithBigNumbers_whenPrettyPrinted_thenDigitsKept", () => {
    expect(prettyJson('{"a": 12345678901234567890, "b": [true, null, {}], "c": "x, {y}"}')).toBe(
      '{\n  "a": 12345678901234567890,\n  "b": [\n    true,\n    null,\n    {}\n  ],\n  "c": "x, {y}"\n}',
    );
  });

  it("givenClippedBytes_whenPanelled_thenHexAndCountOfShown", () => {
    const preview = "ab".repeat(32);

    expect(panelValue({ kind: "bytes", preview, length: 2_048 })).toEqual({
      kind: "bytes",
      hex: hexLines(preview),
      note: "32 of 2,048 bytes shown",
    });
    expect(hexLines(preview).split("\n")).toHaveLength(2);
    expect(bytesNote("deadbeef", 4)).toBe("4 bytes");
    expect(panelValue(null)).toEqual({ kind: "null" });
    expect(panelValue("<null>")).toEqual({ kind: "text", text: "<null>" });
  });
});
