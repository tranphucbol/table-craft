import { describe, expect, it } from "vitest";
import type { EngineMethod, ExportTask, ResultOf } from "@table-craft/desktop/engine/protocol.js";
import { withExtension } from "@table-craft/desktop/renderer/actions/exportActions.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import {
  ETA_MIN_ELAPSED_MS,
  EXPORT_DONE_FLASH_MS,
  exportChip,
  exportDetailText,
  exportFlashEndsAt,
  exportNotes,
  exportPercent,
  exportPopoverEntries,
  exportProgressText,
  exportRate,
  exportTimeLeft,
  fileNameOf,
  type ExportChipState,
} from "@table-craft/desktop/renderer/model/exportText.js";
import { EXPORTS_ROW_KEY, movedInTree, serviceRows } from "@table-craft/desktop/renderer/model/servicesTree.js";
import { createExportsStore, type ExportEntry } from "@table-craft/desktop/renderer/state/exports.js";

const DATASOURCE = "pg";
const STARTED_AT = 1_000_000;

function taskOf(overrides: Partial<ExportTask> = {}): ExportTask {
  return {
    taskId: "export-1",
    path: "/tmp/out/orders.csv",
    format: "csv",
    origin: "rerun",
    state: "running",
    rows: 0,
    bytes: 0,
    elapsedMs: 0,
    startedAt: STARTED_AT,
    estimate: null,
    sheets: 0,
    truncatedCells: 0,
    clippedBytes: 0,
    warning: null,
    error: null,
    retryable: true,
    drains: null,
    ...overrides,
  };
}

interface Call {
  readonly type: string;
  readonly params: unknown;
}

function fakeClient(answer: (type: string) => unknown): { client: EngineClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: EngineClient = {
    call<M extends EngineMethod>(type: M, params: unknown): Promise<ResultOf<M>> {
      calls.push({ type, params });
      return Promise.resolve(answer(type) as ResultOf<M>);
    },
    fail: () => undefined,
    onEvent: () => () => undefined,
  };
  return { client, calls };
}

function store(answer: (type: string) => unknown = () => taskOf()) {
  const { client, calls } = fakeClient(answer);
  const exports = createExportsStore({ client: () => Promise.resolve(client), stallSeconds: () => 90 });
  return { exports, calls };
}

describe("exports store", () => {
  it("givenStart_whenAnswered_thenListedWithTheStallSetting", async () => {
    const { exports, calls } = store();

    await exports.getState().start(DATASOURCE, {
      source: { kind: "result", handle: "r1", columns: [0] },
      format: "csv",
      path: "/tmp/out/orders.csv",
    });

    expect(calls[0]).toMatchObject({ type: "export.start", params: { stallSeconds: 90, format: "csv" } });
    expect(exports.getState().entries).toEqual([{ datasourceId: DATASOURCE, task: taskOf(), finishedAt: null }]);
  });

  it("givenFinalEvent_whenLateProgressArrives_thenFinalStateKept", () => {
    const { exports } = store();
    const done = taskOf({ state: "done", rows: 10 });

    exports.getState().received(DATASOURCE, { id: null, type: "export.done", task: done });
    exports.getState().received(DATASOURCE, { id: null, type: "export.progress", task: taskOf({ rows: 5 }) });

    expect(exports.getState().entries[0]?.task).toEqual(done);
  });

  it("givenRunningTask_whenFinishedEventArrives_thenWaiterResolves", async () => {
    const { exports } = store();
    exports.getState().received(DATASOURCE, { id: null, type: "export.progress", task: taskOf({ rows: 5 }) });
    const finished = exports.getState().finished("export-1");

    exports.getState().received(DATASOURCE, { id: null, type: "export.failed", task: taskOf({ state: "failed" }) });

    await expect(finished).resolves.toMatchObject({ state: "failed" });
  });

  it("givenRunningTask_whenEngineExits_thenFailedSayingNoFileWritten", () => {
    const { exports } = store();
    exports.getState().received(DATASOURCE, { id: null, type: "export.progress", task: taskOf() });

    exports.getState().detached(DATASOURCE, { code: "internal", message: "The engine exited.", hint: "Reconnect." });

    const { task } = exports.getState().entries[0] ?? {};
    expect(task?.state).toBe("failed");
    expect(task?.error?.message).toBe("The engine exited. The export stopped and no file was written.");
  });

  it("givenRunningTask_whenDisconnected_thenCancelled", () => {
    const { exports } = store();
    exports.getState().received(DATASOURCE, { id: null, type: "export.progress", task: taskOf() });

    exports.getState().detached(DATASOURCE, null);

    expect(exports.getState().entries[0]?.task.state).toBe("cancelled");
  });

  it("givenNonRetryableTask_whenRetried_thenNoCall", async () => {
    const { exports, calls } = store();
    exports.getState().received(DATASOURCE, {
      id: null,
      type: "export.failed",
      task: taskOf({ state: "failed", retryable: false }),
    });

    await expect(exports.getState().retry("export-1")).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it("givenRunningTask_whenDismissed_thenKept", () => {
    const { exports } = store();
    exports.getState().received(DATASOURCE, { id: null, type: "export.progress", task: taskOf() });

    exports.getState().dismiss("export-1");

    expect(exports.getState().entries).toHaveLength(1);
  });
});

describe("export text", () => {
  it("givenEstimate_whenRunning_thenRowsOfEstimateAndPercent", () => {
    const task = taskOf({ rows: 12_345, estimate: 50_000, bytes: 4_300_000, elapsedMs: 3_200 });

    expect(exportProgressText(task)).toBe("12,345 of 50,000 rows · 4.1 MB · 3.2 s");
    expect(exportPercent(task)).toBe(24);
  });

  it("givenDoneTask_whenDescribed_thenNotesSayWhatWasCut", () => {
    const task = taskOf({
      state: "done",
      rows: 1,
      sheets: 2,
      truncatedCells: 3,
      clippedBytes: 4,
      warning: "Low disk.",
    });

    expect(exportProgressText(task)).toBe("1 row · 0 bytes · 0 ms");
    expect(exportProgressText({ ...task, state: "cancelled", rows: 90_500 })).toBe(
      "90,500 rows before it stopped · 0 ms",
    );
    expect(exportNotes(task)).toEqual([
      "Low disk.",
      "2 sheets",
      "3 cells cut to the format's limit",
      "4 binary values exported as previews; export the table for full values",
    ]);
    expect(fileNameOf("C:\\exports\\orders.xlsx")).toBe("orders.xlsx");
  });

  it("givenPathWithKnownExtension_whenFormatChanges_thenExtensionSwapped", () => {
    expect(withExtension("/tmp/orders.csv", "xlsx")).toBe("/tmp/orders.xlsx");
    expect(withExtension("/tmp/orders", "json")).toBe("/tmp/orders.json");
  });
});

function entryOf(overrides: Partial<ExportTask> = {}, finishedAt: number | null = null): ExportEntry {
  return { datasourceId: DATASOURCE, task: taskOf(overrides), finishedAt };
}

const NONE: ExportChipState = { cancelling: new Set(), seen: new Set() };
const SECOND = 1000;
const MINUTE = 60 * SECOND;

describe("exports chip", () => {
  it("givenNoExports_whenChip_thenNull", () => {
    expect(exportChip([], NONE, STARTED_AT)).toBeNull();
  });

  it("givenOneRunningWithoutEstimate_whenChip_thenNameRowsAndClockIndeterminate", () => {
    const chip = exportChip([entryOf({ rows: 412_300 })], NONE, STARTED_AT + MINUTE);

    expect(chip).toMatchObject({
      tone: "running",
      label: "orders.csv · 412,300 rows",
      percent: null,
      startedAt: STARTED_AT,
      cancelTaskId: "export-1",
      cancelling: false,
    });
    expect(chip?.tooltip).toContain("/tmp/out/orders.csv");
  });

  it("givenOneRunningWithEstimate_whenChip_thenPercentDeterminate", () => {
    const chip = exportChip([entryOf({ rows: 41, estimate: 100 })], NONE, STARTED_AT);

    expect(chip).toMatchObject({ label: "orders.csv · 41%", percent: 41 });
  });

  it("givenTwoRunningOneWithoutEstimate_whenChip_thenCountAndIndeterminate", () => {
    const chip = exportChip(
      [entryOf({ estimate: 10 }), entryOf({ taskId: "export-2", startedAt: STARTED_AT - MINUTE })],
      NONE,
      STARTED_AT,
    );

    expect(chip).toMatchObject({
      label: "2 exports",
      percent: null,
      startedAt: STARTED_AT - MINUTE,
      cancelTaskId: null,
    });
  });

  it("givenTwoRunningWithEstimates_whenChip_thenCombinedPercent", () => {
    const chip = exportChip(
      [entryOf({ rows: 10, estimate: 100 }), entryOf({ taskId: "export-2", rows: 50, estimate: 100 })],
      NONE,
      STARTED_AT,
    );

    expect(chip).toMatchObject({ label: "2 exports · 30%", percent: 30 });
  });

  it("givenCancelClicked_whenChip_thenCancelling", () => {
    const chip = exportChip([entryOf()], { ...NONE, cancelling: new Set(["export-1"]) }, STARTED_AT);

    expect(chip).toMatchObject({ label: "Cancelling orders.csv…", cancelling: true });
  });

  it("givenDoneWithinFlash_whenChip_thenDoneTone", () => {
    const finishedAt = STARTED_AT + MINUTE;
    const done = entryOf({ state: "done", rows: 790_644, elapsedMs: 230 * SECOND }, finishedAt);

    expect(exportChip([done], NONE, finishedAt + SECOND)).toMatchObject({
      tone: "done",
      label: "orders.csv · 790,644 rows · 230.0 s",
      startedAt: null,
      cancelTaskId: null,
    });
    expect(exportFlashEndsAt([done])).toBe(finishedAt + EXPORT_DONE_FLASH_MS);
  });

  it("givenDoneAfterFlash_whenChip_thenNull", () => {
    const done = entryOf({ state: "done" }, STARTED_AT);

    expect(exportChip([done], NONE, STARTED_AT + EXPORT_DONE_FLASH_MS)).toBeNull();
  });

  it("givenFailedUnseen_whenChip_thenFailedTone", () => {
    const failed = entryOf({ state: "failed" }, STARTED_AT);

    expect(exportChip([failed], NONE, STARTED_AT + MINUTE)).toMatchObject({
      tone: "failed",
      label: "Export failed · orders.csv",
    });
  });

  it("givenFailedSeen_whenChip_thenNull", () => {
    const failed = entryOf({ state: "failed" }, STARTED_AT);

    expect(exportChip([failed], { ...NONE, seen: new Set(["export-1"]) }, STARTED_AT)).toBeNull();
  });

  it("givenCancelled_whenChip_thenNull", () => {
    expect(exportChip([entryOf({ state: "cancelled" }, STARTED_AT)], NONE, STARTED_AT)).toBeNull();
  });

  it("givenRunningAndFinished_whenPopoverEntries_thenRunningFirstThenNewestFinished", () => {
    const entries = [
      entryOf({ taskId: "old", state: "done" }, 1),
      entryOf({ taskId: "run" }),
      entryOf({ taskId: "new", state: "failed" }, 2),
    ];

    expect(exportPopoverEntries(entries).map((entry) => entry.task.taskId)).toEqual(["run", "new", "old"]);
  });
});

describe("export rate and time left", () => {
  it("givenEstimateBeforeThreeSeconds_whenTimeLeft_thenNull", () => {
    const task = taskOf({ rows: 1000, estimate: 10_000 });

    expect(exportTimeLeft(task, STARTED_AT + ETA_MIN_ELAPSED_MS - 1)).toBeNull();
  });

  it("givenEstimateAndRate_whenTimeLeft_thenAboutMinutes", () => {
    const task = taskOf({ rows: 10_000, estimate: 100_000 });

    expect(exportRate(task, STARTED_AT + 10 * SECOND)).toBe(1000);
    expect(exportTimeLeft(task, STARTED_AT + 10 * SECOND)).toBe("about 2 min left");
    expect(exportTimeLeft(taskOf({ rows: 90_000, estimate: 100_000 }), STARTED_AT + 10 * SECOND)).toBe(
      "less than a minute left",
    );
  });

  it("givenNoEstimate_whenTimeLeft_thenNull", () => {
    expect(exportTimeLeft(taskOf({ rows: 10 }), STARTED_AT + MINUTE)).toBeNull();
  });

  it("givenRunningTask_whenDetail_thenRowsSizeRateClockAndTimeLeft", () => {
    const task = taskOf({ rows: 412_300, estimate: 1_000_000, bytes: 118 * 1024 * 1024 });

    expect(exportDetailText(task, STARTED_AT + 102 * SECOND)).toBe(
      "412,300 of 1,000,000 rows · 118.0 MB · 4,042 rows/s · 1:42 · about 2 min left",
    );
  });
});

describe("exports store cancel", () => {
  function storeAt(call: (type: string) => Promise<unknown>, now = () => STARTED_AT) {
    const client: EngineClient = {
      call: <M extends EngineMethod>(type: M) => call(type) as Promise<ResultOf<M>>,
      fail: () => undefined,
      onEvent: () => () => undefined,
    };
    return createExportsStore({ client: () => Promise.resolve(client), stallSeconds: () => 90, now });
  }

  it("givenCancelRejects_whenCancel_thenCancellingCleared", async () => {
    const exports = storeAt(() => Promise.reject(new Error("gone")));
    exports.getState().received(DATASOURCE, { id: null, type: "export.progress", task: taskOf() });

    await expect(exports.getState().cancel("export-1")).rejects.toThrow("gone");

    expect(exports.getState().cancelling.size).toBe(0);
  });

  it("givenFinalEvent_whenCancelling_thenCancellingClearedAndFinishedAtStamped", async () => {
    const exports = storeAt(
      () => Promise.resolve(null),
      () => STARTED_AT + MINUTE,
    );
    exports.getState().received(DATASOURCE, { id: null, type: "export.progress", task: taskOf() });

    await exports.getState().cancel("export-1");
    expect(exports.getState().cancelling.has("export-1")).toBe(true);
    exports
      .getState()
      .received(DATASOURCE, { id: null, type: "export.cancelled", task: taskOf({ state: "cancelled" }) });

    expect(exports.getState().cancelling.size).toBe(0);
    expect(exports.getState().entries[0]?.finishedAt).toBe(STARTED_AT + MINUTE);
  });

  it("givenFailedTask_whenMarkedSeen_thenSeen", () => {
    const exports = storeAt(() => Promise.resolve(null));

    exports.getState().markSeen(["export-1"]);

    expect(exports.getState().seen.has("export-1")).toBe(true);
  });
});

describe("services exports node", () => {
  const entries = [
    { datasourceId: DATASOURCE, task: taskOf({ taskId: "a" }), finishedAt: null },
    { datasourceId: DATASOURCE, task: taskOf({ taskId: "b", state: "done" }), finishedAt: 1 },
  ];

  it("givenExports_whenRowsBuilt_thenNodeAfterDatasourcesNewestFirst", () => {
    const rows = serviceRows([], new Set(), entries);

    expect(rows.map((row) => row.key)).toEqual([EXPORTS_ROW_KEY, "export:b", "export:a"]);
  });

  it("givenCollapsedNode_whenRowsBuilt_thenOnlyTheNode", () => {
    expect(serviceRows([], new Set([EXPORTS_ROW_KEY]), entries)).toHaveLength(1);
  });

  it("givenExportLine_whenArrowLeft_thenParentSelected", () => {
    const rows = serviceRows([], new Set(), entries);

    expect(movedInTree(rows, "export:a", new Set(), "ArrowLeft")?.selected).toBe(EXPORTS_ROW_KEY);
  });
});
