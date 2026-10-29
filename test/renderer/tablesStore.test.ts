import { describe, expect, it, vi } from "vitest";
import type {
  EditableIdentity,
  ExecutedStatement,
  OpenedSession,
  TableQuery,
} from "@table-craft/desktop/engine/protocol.js";
import { EngineRequestError, type EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { selectCell } from "@table-craft/desktop/renderer/model/gridSelection.js";
import { createExecutionsStore } from "@table-craft/desktop/renderer/state/executions.js";
import {
  createTablesStore,
  pendingOf,
  refusedBars,
  submittedScript,
} from "@table-craft/desktop/renderer/state/tables.js";
import type { HistoryEntry } from "@table-craft/desktop/preload/bridge.js";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import { DEFAULT_SETTINGS } from "@table-craft/desktop/settings/settings.js";

const TARGET = { datasourceId: "pg", path: ["public"], relation: "edit_probe" };
const IDENTITY: EditableIdentity = { identity: ["id"] };

interface EngineOptions {
  readonly editable?: EditableIdentity;
  readonly submitFails?: boolean;
  readonly previewFails?: boolean;
  /** The first page leaves the cursor open; Fetch All then reads `FETCHED_ALL` rows. */
  readonly cursorOpen?: boolean;
}

const FETCHED_ALL = 5;

/** An engine holding two rows of `edit_probe (id, label)`; WHERE `bad` is refused like a database would. */
function tableEngine(options: EngineOptions = {}) {
  let handles = 0;
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
      case "table.query": {
        if (params.where === "bad") {
          return Promise.reject(
            new EngineRequestError({ code: "statementFailed", message: "column bad does not exist", hint: "Fix it." }),
          );
        }
        const statement: ExecutedStatement = {
          handle: `h${String(++handles)}`,
          columns: [
            { name: "id", type: "int4" },
            { name: "label", type: "text" },
          ],
          typeClasses: ["integer", "text"],
          rowCount: 2,
          complete: options.cursorOpen !== true,
          cursorOpen: options.cursorOpen === true,
          rowsAffected: null,
          firstWindow: {
            offset: 0,
            rows: [
              [1, "first"],
              [2, "second"],
            ],
          },
          transactionOpen: false,
        };
        const answer: TableQuery = {
          statement,
          sql: `SELECT * FROM "public"."edit_probe"`,
          editable: options.editable ?? IDENTITY,
          columns: [],
          foreignKeys: [],
          referencing: [],
        };
        return Promise.resolve(answer);
      }
      case "table.orderBy":
        return Promise.resolve(`"label" DESC`);
      case "edits.submit":
        if (options.submitFails === true) {
          return Promise.reject(
            new EngineRequestError({
              code: "editRejected",
              message: "Statement 1 affected 0 rows instead of exactly one.",
              hint: "Reload.",
            }),
          );
        }
        return Promise.resolve({
          statements: [
            `UPDATE "public"."edit_probe" SET "label" = 'renamed' WHERE "id" = 1`,
            `DELETE FROM "public"."edit_probe" WHERE "id" = 2`,
          ],
          rowsAffected: 2,
        });
      case "edits.preview":
        if (options.previewFails === true) return Promise.reject(new Error("The engine exited."));
        return Promise.resolve([`UPDATE "public"."edit_probe" SET "label" = 'renamed' WHERE "id" = 1`]);
      case "table.count":
        return Promise.resolve(12_345);
      case "result.view":
        return Promise.resolve(
          params.spec === null
            ? { shown: 2, filtered: false, sources: null, matches: 0, error: null }
            : { shown: 1, filtered: true, sources: [1], matches: 0, error: null },
        );
      case "result.window":
        return Promise.resolve({ offset: 0, rows: [[2, "second"]] });
      case "result.fetchMore":
        return Promise.resolve({ rowCount: FETCHED_ALL, complete: true, cursorOpen: false });
      default:
        return Promise.resolve(null);
    }
  });
  return { client: { call } as unknown as EngineClient, call };
}

async function openedTable(options: EngineOptions = {}) {
  const engine = tableEngine(options);
  const executions = createExecutionsStore();
  const recorded: HistoryEntry[] = [];
  let now = 0;
  const store = createTablesStore({
    connect: () => Promise.resolve(engine.client),
    now: () => (now += 7),
    clock: () => 1_000,
    executions: executions.getState(),
    record: (entry) => recorded.push(entry),
  });
  await store.getState().open("t1", TARGET);
  const session = () => {
    const found = store.getState().tables.t1;
    if (found === undefined) throw new Error("no table tab");
    return found;
  };
  const calls = (type: string) => engine.call.mock.calls.filter(([name]) => name === type).map(([, params]) => params);
  const executionsOf = () => executions.getState().byTab.t1 ?? [];
  return { store, session, calls, recorded, executionsOf };
}

describe("tables store", () => {
  it("givenTable_whenOpened_thenRowsReadWithEmptyClauses", async () => {
    const { session, calls } = await openedTable();

    expect(calls("table.query")).toEqual([
      {
        sessionId: "s1",
        path: ["public"],
        relation: "edit_probe",
        where: "",
        orderBy: "",
        pageRows: DEFAULT_SETTINGS.data.pageRows,
        fetchAllCap: DEFAULT_SETTINGS.data.fetchAllCap,
      },
    ]);
    expect(session().status).toBe("ready");
    expect(session().result?.rowCount).toBe(2);
    expect(session().editable).toEqual(IDENTITY);
  });

  it("givenOpenCursor_whenFetchAll_thenServicesLoadRowShowsAllRows", async () => {
    const { store, session, executionsOf } = await openedTable({ cursorOpen: true });
    const resultId = session().result?.id ?? "";

    await store.getState().fetchMore("t1", resultId, true);

    expect(executionsOf().map((execution) => execution.rowCount)).toEqual([FETCHED_ALL]);
  });

  it("givenPageSizeSetting_whenTableOpened_thenQueryCarriesIt", async () => {
    const before = useSettings.getState().settings;
    useSettings.setState({ settings: { ...before, data: { ...before.data, pageRows: 100, fetchAllCap: 2_000 } } });
    try {
      const { calls } = await openedTable();

      expect(calls("table.query")).toEqual([expect.objectContaining({ pageRows: 100, fetchAllCap: 2_000 })]);
    } finally {
      useSettings.setState({ settings: before });
    }
  });

  it("givenRefusedWhere_whenApplied_thenErrorUnderBarsAndRowsKept", async () => {
    const { store, session } = await openedTable();
    const shown = session().result;

    store.getState().setDraft("t1", { where: "bad" });
    expect(await store.getState().query("t1")).toBe(false);

    expect(session().queryError?.message).toBe("column bad does not exist");
    expect(session().result).toBe(shown);
    expect(session().applied.where).toBe("");
    expect(session().draft.where).toBe("bad");
    expect(refusedBars(session())).toEqual({ where: true, orderBy: false });

    store.getState().revertDraft("t1");
    expect(session().draft.where).toBe("");
    expect(session().queryError).toBeNull();
  });

  it("givenCellEdited_whenSubmitted_thenUpdateSentAndRowsReadAgain", async () => {
    const { store, session, calls } = await openedTable();

    store.getState().beginEdit("t1", { row: 0, column: 1 });
    expect(session().editing?.text).toBe("first");
    store.getState().changeEdit("t1", "renamed");
    store.getState().commitEdit("t1");
    expect(pendingOf(session())).toBe(1);

    expect(await store.getState().submit("t1")).toBe(true);

    expect(calls("edits.submit")).toEqual([
      {
        sessionId: "s1",
        handle: "h1",
        edits: [{ kind: "update", row: 0, values: [{ column: 1, value: { kind: "text", text: "renamed" } }] }],
      },
    ]);
    expect(calls("table.query")).toHaveLength(2);
    expect(pendingOf(session())).toBe(0);
    expect(session().notice).toBe("Submitted 2 statements");
  });

  it("givenLocalFilter_whenShownRowEdited_thenEditNamesTheHeldRow", async () => {
    const { store, session, calls } = await openedTable();
    const resultId = session().result?.id ?? "";
    await store.getState().search("t1", resultId, (search) => ({
      ...search,
      filters: [{ column: 1, op: "notEquals", text: "first" }],
    }));
    store.getState().ensureWindow("t1", resultId, 0);
    await Promise.resolve();
    await Promise.resolve();

    store.getState().beginEdit("t1", { row: 0, column: 1 });
    expect(session().editing?.text).toBe("second");
    store.getState().changeEdit("t1", "renamed");
    store.getState().commitEdit("t1");
    expect(await store.getState().submit("t1")).toBe(true);

    expect(calls("edits.submit")[0]).toMatchObject({
      edits: [{ kind: "update", row: 1, values: [{ column: 1, value: { kind: "text", text: "renamed" } }] }],
    });
  });

  it("givenUnchangedEdit_whenCommitted_thenNothingPending", async () => {
    const { store, session } = await openedTable();

    store.getState().beginEdit("t1", { row: 0, column: 1 });
    store.getState().commitEdit("t1");

    expect(pendingOf(session())).toBe(0);
  });

  it("givenRejectedSubmit_whenSubmitted_thenBufferKeptAndErrorShown", async () => {
    const { store, session } = await openedTable({ submitFails: true });
    store.getState().deleteRows("t1", [1]);

    expect(await store.getState().submit("t1")).toBe(false);

    expect(pendingOf(session())).toBe(1);
    expect(session().error?.code).toBe("editRejected");
    expect(session().status).toBe("ready");
  });

  it("givenReadOnlyTable_whenEditBegun_thenNothingOpens", async () => {
    const { store, session } = await openedTable({ editable: { readOnly: "No primary key." } });

    store.getState().beginEdit("t1", { row: 0, column: 1 });
    store.getState().addRow("t1");

    expect(session().editing).toBeNull();
    expect(pendingOf(session())).toBe(1);
  });

  it("givenHeaderSort_whenSorted_thenOrderByRewrittenAndRowsReadAgain", async () => {
    const { store, session, calls } = await openedTable();

    await store.getState().sortBy("t1", [{ column: 1, direction: "desc" }]);

    expect(calls("table.orderBy")).toEqual([{ terms: [{ name: "label", direction: "desc" }] }]);
    expect(calls("table.query").at(-1)).toMatchObject({ orderBy: `"label" DESC` });
    expect(session().applied.orderBy).toBe(`"label" DESC`);
    expect(session().result?.sort).toEqual([{ column: 1, direction: "desc" }]);
  });

  it("givenPendingChanges_whenDetached_thenDiscardedWithNotice", async () => {
    const { store, session } = await openedTable();
    store.getState().addRow("t1");
    store.getState().select("t1", session().result?.id ?? "", selectCell({ row: 2, column: 0 }));

    store.getState().detach("pg", null);

    expect(session().status).toBe("disconnected");
    expect(session().result?.stale).toBe(true);
    expect(pendingOf(session())).toBe(0);
    expect(session().notice).toBe("The connection closed; 1 pending change was discarded.");
  });

  it("givenWhere_whenRowsCounted_thenCountForAppliedWhere", async () => {
    const { store, session, calls } = await openedTable();

    await store.getState().countRows("t1");

    expect(calls("table.count")).toEqual([{ path: ["public"], relation: "edit_probe", where: "" }]);
    expect(session().count).toBe(12_345);
  });

  it("givenTableSubmit_whenRecorded_thenOneEntryWithTheScript", async () => {
    const { store, recorded, executionsOf } = await openedTable();
    store.getState().beginEdit("t1", { row: 0, column: 1 });
    store.getState().changeEdit("t1", "renamed");
    store.getState().commitEdit("t1");

    await store.getState().submit("t1");

    const script = [
      `UPDATE "public"."edit_probe" SET "label" = 'renamed' WHERE "id" = 1;`,
      `DELETE FROM "public"."edit_probe" WHERE "id" = 2;`,
    ].join("\n");
    expect(recorded).toEqual([
      {
        datasourceId: "pg",
        sql: script,
        startedAt: 1_000,
        durationMs: 7,
        outcome: "success",
        rowCount: 2,
        message: null,
        source: "table",
      },
    ]);
    expect(executionsOf().map((execution) => [execution.label, execution.sql])).toEqual([
      ["Load rows", `SELECT * FROM "public"."edit_probe"`],
      ["Submit 2 statements", script],
      ["Load rows", `SELECT * FROM "public"."edit_probe"`],
    ]);
  });

  it("givenTableSubmitFails_whenRecorded_thenErrorEntryWithScript", async () => {
    const { store, recorded, executionsOf } = await openedTable({ submitFails: true });
    store.getState().beginEdit("t1", { row: 0, column: 1 });
    store.getState().changeEdit("t1", "renamed");
    store.getState().commitEdit("t1");

    await store.getState().submit("t1");

    const script = `UPDATE "public"."edit_probe" SET "label" = 'renamed' WHERE "id" = 1;`;
    const message = "Statement 1 affected 0 rows instead of exactly one.";
    expect(recorded).toEqual([
      {
        datasourceId: "pg",
        sql: script,
        startedAt: 1_000,
        durationMs: 7,
        outcome: "error",
        rowCount: null,
        message,
        source: "table",
      },
    ]);
    expect(executionsOf()[0]).toMatchObject({ label: "Submit 1 statement", sql: script, outcome: "error", message });
  });

  it("givenSubmitAndPreviewFail_whenSubmitted_thenErrorExecutionAndNoHistory", async () => {
    const { store, recorded, executionsOf } = await openedTable({ submitFails: true, previewFails: true });
    store.getState().beginEdit("t1", { row: 0, column: 1 });
    store.getState().changeEdit("t1", "renamed");
    store.getState().commitEdit("t1");

    await store.getState().submit("t1");

    expect(recorded).toEqual([]);
    expect(executionsOf()[0]).toMatchObject({
      label: "Submit changes",
      outcome: "error",
      message: "Statement 1 affected 0 rows instead of exactly one.",
    });
  });

  it("givenTableLoad_whenRun_thenExecutionWithSqlAndNoHistory", async () => {
    const { recorded, executionsOf } = await openedTable();

    expect(recorded).toEqual([]);
    expect(executionsOf()).toEqual([
      {
        id: expect.any(Number) as number,
        startedAt: 1_000,
        durationMs: 7,
        outcome: "success",
        label: "Load rows",
        sql: `SELECT * FROM "public"."edit_probe"`,
        rowCount: 2,
        message: null,
        messages: [],
      },
    ]);
  });

  it("givenRowsCounted_whenReported_thenCountExecutionWithTheCount", async () => {
    const { store, executionsOf } = await openedTable();

    await store.getState().countRows("t1");

    expect(executionsOf()[0]).toMatchObject({ label: "Count rows", outcome: "success", rowCount: 12_345 });
  });

  it("givenStatements_whenScripted_thenEachEndsWithSemicolonOnItsOwnLine", () => {
    expect(submittedScript(["UPDATE t SET a = 1 ", "DELETE FROM t WHERE id = 2;"])).toBe(
      "UPDATE t SET a = 1;\nDELETE FROM t WHERE id = 2;",
    );
  });
});
