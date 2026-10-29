import { ResultStore, displayText } from "@table-craft/core";
import type { Column, ExecuteResult, Row as CoreRow } from "@table-craft/plugin-api";
import { describe, expect, it, vi } from "vitest";
import type {
  ClassifiedStatement,
  ExportTask,
  ExecutedStatement,
  OpenedSession,
  TypeClass,
} from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { formatCell } from "@table-craft/desktop/renderer/grid/format.js";
import { hiddenColumn } from "@table-craft/desktop/renderer/model/columnLayout.js";
import { bufferRowAt, gridRowCount } from "@table-craft/desktop/renderer/model/editBuffer.js";
import { resultStateText } from "@table-craft/desktop/renderer/model/format.js";
import { selectCell } from "@table-craft/desktop/renderer/model/gridSelection.js";
import { createConsolesStore, type ResultTab } from "@table-craft/desktop/renderer/state/consoles.js";
import { createExecutionsStore } from "@table-craft/desktop/renderer/state/executions.js";
import type { ExportStarter } from "@table-craft/desktop/renderer/state/exports.js";
import {
  findStatusText,
  searchedScopeText,
  shownHeld,
  shownRowCount,
  viewSpecOf,
} from "@table-craft/desktop/renderer/state/resultTab.js";

const COLUMNS: readonly Column[] = [
  { name: "id", type: "int4" },
  { name: "name", type: "text" },
  { name: "note", type: "text" },
];
const TOTAL_ROWS = 1_200;
const PAGE_ROWS = 500;
const RAW = { nullText: "<null>", groupDigits: false };

/** Row `i` is named `alpha` every tenth row, `beta` otherwise; every seventh note is NULL. */
function rowOf(index: number): CoreRow {
  return [index + 1, index % 10 === 0 ? "alpha" : "beta", index % 7 === 0 ? null : `note ${String(index)}`];
}

function resultOf(total: number): ExecuteResult {
  async function* rows(): AsyncGenerator<CoreRow> {
    for (let index = 0; index < total; index++) yield await Promise.resolve(rowOf(index));
  }
  return { columns: COLUMNS, rows: rows(), rowsAffected: null };
}

/** An engine over a real `ResultStore`, so the view the renderer asks for is the one core computes. */
function storeEngine(total = TOTAL_ROWS) {
  const results = new ResultStore({ pageRows: PAGE_ROWS });
  const call = vi.fn(async (type: string, params: Record<string, unknown>): Promise<unknown> => {
    const handle = String(params.handle);
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
        return opened;
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
        return [statement];
      }
      case "statement.execute": {
        const summary = await results.put(resultOf(total));
        const executed: ExecutedStatement = {
          handle: summary.handle,
          columns: COLUMNS,
          typeClasses: summary.typeClasses,
          rowCount: summary.rowCount,
          complete: summary.complete,
          cursorOpen: summary.cursorOpen,
          rowsAffected: null,
          firstWindow: results.window(summary.handle, 0),
          transactionOpen: false,
        };
        return executed;
      }
      case "result.window":
        return results.window(handle, Number(params.offset), Number(params.limit));
      case "result.fetchMore":
        return results.fetchMore(handle, { all: params.all === true });
      case "result.sort":
        return results.sort(handle, params.keys as never);
      case "result.view":
        return results.setView(handle, params.spec as never);
      case "result.viewState":
        return results.viewState(handle);
      case "result.findMatch":
        return results.findMatch(handle, params.from as never, params.backward === true);
      default:
        return null;
    }
  });
  return { client: { call } as unknown as EngineClient, call };
}

async function settled(): Promise<void> {
  for (let tick = 0; tick < 5; tick++) await Promise.resolve();
}

async function ranQuery(total = TOTAL_ROWS) {
  const engine = storeEngine(total);
  const started: unknown[] = [];
  const exports: ExportStarter = {
    start: (_datasourceId, request) => {
      started.push(request);
      return Promise.resolve({ taskId: "x1", origin: "memory" } as ExportTask);
    },
    finished: () => new Promise(() => undefined),
  };
  const store = createConsolesStore({
    exports,
    connect: () => Promise.resolve(engine.client),
    now: () => 0,
    clock: () => 0,
    executions: createExecutionsStore().getState(),
  });
  await store.getState().open("c1", "pg", { sql: "SELECT * FROM big" });
  await store.getState().run("c1", "all");
  const result = (): ResultTab => {
    const found = store.getState().consoles.c1?.results[0];
    if (found?.kind !== "rows") throw new Error("no result tab");
    return found;
  };
  const find = (text: string, options: Partial<ResultTab["search"]["query"]> = {}) =>
    store.getState().search("c1", result().id, (search) => ({
      ...search,
      open: true,
      query: { ...search.query, text, ...options },
    }));
  const load = async (offset = 0) => {
    store.getState().ensureWindow("c1", result().id, offset);
    await settled();
  };
  const calls = (type: string) => engine.call.mock.calls.filter(([name]) => name === type).map(([, params]) => params);
  return { store, result, find, load, calls, started };
}

describe("result search state", () => {
  it("givenFindAlpha_whenTyped_thenCountAndFirstMatchSelected", async () => {
    const { result, find, load } = await ranQuery();

    await find("alpha");
    await load();

    expect(result().view).toMatchObject({ shown: 500, filtered: false, matches: 50 });
    expect(result().search.current).toEqual({ index: 0, row: 0, column: 1 });
    expect(result().selection?.focus).toEqual({ row: 0, column: 1 });
    expect(result().matches[0]?.slice(0, 4)).toEqual([0, 1, 10, 1]);
    expect(findStatusText(result())).toBe("1 of 50");
    expect(searchedScopeText(result())).toBe("Searched 500 fetched rows");
  });

  it("givenWindowLoadedBeforeTyping_whenFound_thenItsMatchesLoadWithoutTheGridAsking", async () => {
    const { result, find, load } = await ranQuery();
    await load();

    await find("alpha");
    await settled();

    expect(result().matches[0]?.slice(0, 4)).toEqual([0, 1, 10, 1]);
  });

  it("givenMatches_whenFindNextAndPrevious_thenStepsFromTheFocusedCellAndWraps", async () => {
    const { store, result, find } = await ranQuery();
    await find("alpha");

    await store.getState().findNext("c1", result().id, false);
    expect(result().search.current).toEqual({ index: 1, row: 10, column: 1 });
    store.getState().select("c1", result().id, selectCell({ row: 0, column: 0 }));
    await store.getState().findNext("c1", result().id, true);

    expect(result().search.current).toEqual({ index: 49, row: 490, column: 1 });
    expect(findStatusText(result())).toBe("50 of 50");
  });

  it("givenFilterRows_whenToggled_thenOnlyMatchingRowsShownAndCounted", async () => {
    const { store, result, find, load } = await ranQuery();
    await find("alpha");

    await store.getState().search("c1", result().id, (search) => ({ ...search, rowsOnly: true }));
    await load();

    expect(shownRowCount(result())).toBe(50);
    expect(result().windows[0]?.slice(0, 2)).toEqual([
      [1, "alpha", null],
      [11, "alpha", "note 10"],
    ]);
    expect(resultStateText({ ...result(), sorted: false, fetchAllCap: result().paging.fetchAllCap, shown: 50 })).toBe(
      "50 of 500+ rows · filtered locally",
    );
  });

  it("givenChips_whenAdded_thenRowsHiddenEvenWithFindClosed", async () => {
    const { store, result, load } = await ranQuery();

    await store.getState().search("c1", result().id, (search) => ({
      ...search,
      filters: [
        { column: 1, op: "equals", text: "alpha" },
        { column: 2, op: "isNotNull" },
      ],
    }));
    await load();

    expect(result().search.open).toBe(false);
    expect(shownRowCount(result())).toBe(42);
    expect(result().windows[0]?.[0]).toEqual([11, "alpha", "note 10"]);
  });

  it("givenChips_whenAllRemoved_thenViewDroppedAndEveryRowShown", async () => {
    const { store, result, load, calls } = await ranQuery();
    const chip = { column: 1, op: "equals", text: "alpha" } as const;
    await store.getState().search("c1", result().id, (search) => ({ ...search, filters: [chip] }));

    await store.getState().search("c1", result().id, (search) => ({ ...search, filters: [] }));
    await load();

    expect(calls("result.view").at(-1)).toEqual({ handle: "result-1", spec: null });
    expect(result().view).toBeNull();
    expect(shownRowCount(result())).toBe(500);
  });

  it("givenFilterSet_whenSearchAllFetchesTheRest_thenViewCoversNewRows", async () => {
    const { store, result } = await ranQuery();
    await store.getState().search("c1", result().id, (search) => ({
      ...search,
      filters: [{ column: 1, op: "equals", text: "alpha" }],
    }));

    await store.getState().fetchMore("c1", result().id, true);

    expect(result()).toMatchObject({ rowCount: TOTAL_ROWS, complete: true });
    expect(result().view).toMatchObject({ shown: 120, filtered: true });
    expect(searchedScopeText(result())).toBeNull();
  });

  it("givenFilterSet_whenSorted_thenViewRecomputedInTheSortedOrder", async () => {
    const { store, result, load } = await ranQuery();
    await store.getState().search("c1", result().id, (search) => ({
      ...search,
      filters: [{ column: 1, op: "equals", text: "alpha" }],
    }));

    await store.getState().sort("c1", result().id, [{ column: 0, direction: "desc" }]);
    await load();

    expect(result().windows[0]?.[0]?.[0]).toBe(491);
    expect(shownRowCount(result())).toBe(50);
  });

  it("givenFindTyped_whenSearchedColumnHidden_thenItsMatchesDrop", async () => {
    const { store, result, find } = await ranQuery();
    await find("note 1");
    const before = result().view?.matches;

    store.getState().setLayout("c1", result().id, hiddenColumn(result().layout, 2));
    await settled();

    expect(before).toBeGreaterThan(0);
    expect(result().view?.matches).toBe(0);
    expect(findStatusText(result())).toBe("No matches");
  });

  it("givenInvalidRegex_whenTyped_thenStatusSaysWhyAndNothingHidden", async () => {
    const { store, result, find } = await ranQuery();
    await store.getState().search("c1", result().id, (search) => ({ ...search, rowsOnly: true }));

    await find("(", { regex: true });

    expect(findStatusText(result())).toMatch(/^Invalid regular expression: /);
    expect(shownRowCount(result())).toBe(500);
  });

  it("givenFilteredResult_whenRerun_thenFilterReappliedOnTheNewHandle", async () => {
    const { store, result, calls } = await ranQuery();
    await store.getState().search("c1", result().id, (search) => ({
      ...search,
      filters: [{ column: 1, op: "notEquals", text: "alpha" }],
    }));

    await store.getState().rerun("c1", result().id);

    expect(calls("result.view").at(-1)).toMatchObject({ handle: "result-2", spec: { filters: [{ op: "notEquals" }] } });
    expect(result().view).toMatchObject({ shown: 450, filtered: true });
  });

  it("givenFilteredResult_whenExported_thenShownOnlyRidesOnTheSource", async () => {
    const { store, result, started } = await ranQuery();

    await store.getState().exportTo("c1", result().id, "csv", "/tmp/out.csv", [0, 1], true);

    expect(started).toMatchObject([
      {
        source: { kind: "result", handle: "result-1", columns: [0, 1], shownOnly: true },
      },
    ]);
  });

  it("givenGroupedDigits_whenSpecBuilt_thenFormatsFollowTheSetting", async () => {
    const { result } = await ranQuery();
    const tab = {
      ...result(),
      search: { ...result().search, open: true, query: { ...result().search.query, text: "1" } },
    };

    expect(viewSpecOf(tab, { nullText: "<null>", groupDigits: true })?.formats).toEqual({ groupDigits: true });
    expect(viewSpecOf(result(), RAW)).toBeNull();
  });
});

describe("filtered rows and the edit buffer", () => {
  it("givenSources_whenGridRowMapped_thenHeldRowOfTheSourceAndInsertsAfter", () => {
    const buffer = { updates: new Map(), inserts: [{ id: 1, values: [] }], deletes: new Set<number>(), nextId: 2 };
    const held = { count: 2, sources: [4, 9] };

    expect(bufferRowAt(buffer, held, 1)).toEqual({ kind: "held", row: 9 });
    expect(bufferRowAt(buffer, held, 2)).toMatchObject({ kind: "inserted" });
    expect(gridRowCount(buffer, held)).toBe(3);
  });

  it("givenUnfilteredTab_whenHeldRowsAsked_thenPlainRowCount", async () => {
    const { result } = await ranQuery();

    expect(shownHeld(result())).toBe(500);
  });
});

describe("display text", () => {
  it("givenGridFormatter_whenComparedWithCore_thenSameTextForEveryClass", () => {
    const cases: readonly [unknown, TypeClass][] = [
      [1234567, "integer"],
      [-1234.5, "float"],
      ["98765.4321", "decimal"],
      [{ kind: "bigint", value: "12345678901234567890" }, "integer"],
      [true, "boolean"],
      ["plain text 1234", "text"],
    ];
    for (const grouped of [false, true]) {
      for (const [value, typeClass] of cases) {
        expect(formatCell(value as never, typeClass, { nullText: "<null>", groupDigits: grouped })).toBe(
          displayText(value as never, typeClass, { groupDigits: grouped }),
        );
      }
    }
  });
});
