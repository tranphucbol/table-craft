import { describe, expect, it, vi } from "vitest";
import type {
  ClassifiedStatement,
  ExplainedPlan,
  ExplainedStatement,
  Explainability,
  OpenedSession,
  PlanNode,
  TransactionMode,
} from "@table-craft/desktop/engine/protocol.js";
import type { HistoryEntry } from "@table-craft/desktop/preload/bridge.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { movedInPlan, planNodeAt, planNumber, planRows } from "@table-craft/desktop/renderer/model/planTree.js";
import {
  activePlanOf,
  analyseConfirmation,
  ANALYSE_CONFIRM,
  ANALYSE_TITLE,
  createConsolesStore,
  EXPLAIN_ONE_STATEMENT,
  OUTPUT_TAB,
  type AnalyseRequest,
  type PlanTab,
} from "@table-craft/desktop/renderer/state/consoles.js";
import { createExecutionsStore } from "@table-craft/desktop/renderer/state/executions.js";

const SESSION_ID = "s1";
const REFUSAL = "PostgreSQL cannot explain a CREATE statement. Explain SELECT instead.";

function node(operation: string, change: Partial<PlanNode> = {}): PlanNode {
  return {
    operation,
    target: null,
    detail: null,
    estimatedRows: null,
    estimatedCost: null,
    actualRows: null,
    actualTimeMs: null,
    loops: null,
    properties: [],
    children: [],
    ...change,
  };
}

function split(text: string): ClassifiedStatement[] {
  const statements: ClassifiedStatement[] = [];
  let start = 0;
  for (const piece of text.split(";")) {
    const lead = piece.length - piece.trimStart().length;
    const sql = piece.trim();
    if (sql !== "") {
      const from = start + lead;
      const verb = sql.split(/\s+/)[0]?.toUpperCase() ?? "";
      const kind = verb === "SELECT" ? "read" : verb === "CREATE" ? "ddl" : "write";
      const destructive = verb === "DELETE" && !/\bWHERE\b/i.test(sql) ? "DELETE without WHERE" : null;
      statements.push({ from, to: from + sql.length, sql, kind, destructive, parameters: [] });
    }
    start += piece.length + 1;
  }
  return statements;
}

/** Explains anything but CREATE; a write analysed in manual mode leaves the transaction open. */
function fakeEngine() {
  const explained: { sql: string; analyze: boolean }[] = [];
  let mode: TransactionMode = "auto";
  const call = vi.fn((type: string, params: Record<string, unknown>): Promise<unknown> => {
    switch (type) {
      case "session.open": {
        const opened: OpenedSession = {
          sessionId: SESSION_ID,
          pluginName: "fake",
          capabilities: ["sql", "transactions", "explain", "explainAnalyze"],
          serverVersion: "1",
          namespace: null,
        };
        return Promise.resolve(opened);
      }
      case "script.split":
        return Promise.resolve(split(String(params.text)));
      case "sql.explainable": {
        const sql = String(params.sql);
        const verdict: Explainability = sql.startsWith("CREATE")
          ? { ok: false, reason: REFUSAL }
          : { ok: true, writes: !sql.startsWith("SELECT") };
        return Promise.resolve(verdict);
      }
      case "statement.explain": {
        const sql = String(params.sql);
        const analyze = params.analyze === true;
        explained.push({ sql, analyze });
        const plan: ExplainedPlan = {
          statement: `EXPLAIN (${analyze ? "ANALYZE, " : ""}FORMAT JSON) ${sql}`,
          analyzed: analyze,
          roots: [node("Seq Scan", { target: "orders", estimatedCost: 10 })],
          summary: [],
          raw: "[]",
        };
        const result: ExplainedStatement = { plan, transactionOpen: analyze && mode === "manual" };
        return Promise.resolve(result);
      }
      case "transaction.setMode":
        mode = params.mode as TransactionMode;
        return Promise.resolve({ mode, transactionOpen: false });
      default:
        return Promise.resolve(null);
    }
  });
  return { client: { call } as unknown as EngineClient, call, explained };
}

async function opened(sql: string, options: { confirm?: boolean; mode?: TransactionMode } = {}) {
  const engine = fakeEngine();
  const confirmAnalyse = vi.fn((_request: AnalyseRequest) => Promise.resolve(options.confirm ?? true));
  const recorded: HistoryEntry[] = [];
  const executions = createExecutionsStore();
  let now = 0;
  const store = createConsolesStore({
    connect: () => Promise.resolve(engine.client),
    now: () => (now += 5),
    clock: () => 0,
    confirmAnalyse,
    executions: executions.getState(),
    record: (entry) => recorded.push(entry),
  });
  await store.getState().open("c1", "pg", { sql });
  if (options.mode !== undefined) await store.getState().setTransactionMode("c1", options.mode);
  const session = () => {
    const current = store.getState().consoles.c1;
    if (current === undefined) throw new Error("console c1 is gone");
    return current;
  };
  const plan = (): PlanTab => {
    const shown = activePlanOf(session());
    if (shown === null) throw new Error("no plan tab shown");
    return shown;
  };
  const output = () => session().output.map((entry) => [entry.message, entry.tone]);
  return { ...engine, store, confirmAnalyse, recorded, executions, session, plan, output };
}

describe("explain in the console", () => {
  it("givenSelect_whenExplained_thenPlanTabWithoutAskingAndOutputLine", async () => {
    const { store, confirmAnalyse, plan, output, explained } = await opened("SELECT * FROM orders");

    await store.getState().explain("c1", false);

    expect(confirmAnalyse).not.toHaveBeenCalled();
    expect(explained).toEqual([{ sql: "SELECT * FROM orders", analyze: false }]);
    expect(plan()).toMatchObject({ title: "Plan", analyzed: false, effect: "none", selected: "0" });
    expect(output()).toEqual([["Explained in 5 ms", "success"]]);
  });

  it("givenAnalyseOfWrite_whenRun_thenAsksWithTransactionWording", async () => {
    const sql = "UPDATE orders SET total = total WHERE id = 1";
    const auto = await opened(sql);
    const manual = await opened(sql, { mode: "manual" });

    await auto.store.getState().explain("c1", true);
    await manual.store.getState().explain("c1", true);

    const [autoRequest] = auto.confirmAnalyse.mock.calls[0] ?? [];
    const [manualRequest] = manual.confirmAnalyse.mock.calls[0] ?? [];
    expect(autoRequest?.mode).toBe("auto");
    expect(manualRequest?.mode).toBe("manual");
    if (autoRequest === undefined || manualRequest === undefined) throw new Error("not asked");
    expect(analyseConfirmation(autoRequest)).toEqual({
      kind: "confirm",
      title: ANALYSE_TITLE,
      message: "Its changes will be committed.",
      items: [{ label: sql, detail: "" }],
      confirm: ANALYSE_CONFIRM,
      destructive: true,
    });
    expect(analyseConfirmation(manualRequest)).toMatchObject({
      message: "Its changes stay in the open transaction until you commit or roll back.",
    });
    expect(auto.plan()).toMatchObject({ title: "Plan (analysed)", effect: "committed" });
    expect(manual.plan()).toMatchObject({ effect: "inTransaction" });
    expect(manual.session().transactionOpen).toBe(true);
    expect(auto.output()).toEqual([["Analysed in 5 ms", "success"]]);
  });

  it("givenDestructiveWrite_whenAnalyseAsks_thenTheReasonIsListed", () => {
    const [statement] = split("DELETE FROM orders");
    if (statement === undefined) throw new Error("no statement");

    expect(analyseConfirmation({ statement, mode: "auto" })).toMatchObject({
      items: [{ label: "DELETE FROM orders", detail: "DELETE without WHERE" }],
    });
  });

  it("givenAnalyseConfirmOpen_whenStatusRead_thenWaitingForConfirmation", async () => {
    const { store, confirmAnalyse, session } = await opened("DELETE FROM orders");
    const asked: string[] = [];
    confirmAnalyse.mockImplementation(() => {
      asked.push(session().status);
      return Promise.resolve(false);
    });

    await store.getState().explain("c1", true);

    expect(asked).toEqual(["confirming"]);
    expect(session().status).toBe("ready");
  });

  it("givenAnalyseOfWriteDeclined_whenRun_thenNothingRunsOrIsRecorded", async () => {
    const { store, explained, recorded, executions, output, session } = await opened("DELETE FROM orders", {
      confirm: false,
    });

    await store.getState().explain("c1", true);

    expect(explained).toEqual([]);
    expect(recorded).toEqual([]);
    expect(executions.getState().byTab.c1 ?? []).toEqual([]);
    expect(output()).toEqual([["Cancelled; nothing ran.", "warning"]]);
    expect(session().activeResult).toBe(OUTPUT_TAB);
  });

  it("givenAnalyseOfRead_whenRun_thenNeverAsks", async () => {
    const { store, confirmAnalyse, plan } = await opened("SELECT 1");

    await store.getState().explain("c1", true);

    expect(confirmAnalyse).not.toHaveBeenCalled();
    expect(plan()).toMatchObject({ analyzed: true, effect: "none" });
  });

  it("givenRefusedStatement_whenExplained_thenOutputWarningAndNothingRuns", async () => {
    const { store, explained, recorded, output, session } = await opened("CREATE TABLE t (id int)");

    await store.getState().explain("c1", false);

    expect(explained).toEqual([]);
    expect(recorded).toEqual([]);
    expect(output()).toEqual([[REFUSAL, "warning"]]);
    expect(session().results).toEqual([]);
  });

  it("givenSeveralStatementsSelected_whenExplained_thenRefused", async () => {
    const { store, explained, output } = await opened("SELECT 1;\nSELECT 2;");
    store.getState().setSelection("c1", { from: 0, to: 18 });

    await store.getState().explain("c1", false);

    expect(explained).toEqual([]);
    expect(output()).toEqual([[EXPLAIN_ONE_STATEMENT, "warning"]]);
  });

  it("givenSelectionLeakingPastStatement_whenExplain_thenSelectedTextExplained", async () => {
    const sql = "SELECT 1;\nSELECT * FROM orders WHERE id = 1;";
    const { store, explained } = await opened(sql);
    const from = sql.indexOf(";") + 1;
    store.getState().setSelection("c1", { from, to: sql.indexOf(" WHERE") });

    await store.getState().explain("c1", false);

    expect(explained).toEqual([{ sql: "SELECT * FROM orders", analyze: false }]);
  });

  it("givenCaretInSecondStatement_whenExplained_thenOnlyItIsExplained", async () => {
    const { store, explained } = await opened("SELECT 1;\nSELECT 2;");
    store.getState().setSelection("c1", { from: 12, to: 12 });

    await store.getState().explain("c1", false);

    expect(explained).toEqual([{ sql: "SELECT 2", analyze: false }]);
  });

  it("givenPlanTab_whenRerun_thenSameMode", async () => {
    const { store, plan, explained, confirmAnalyse, session } = await opened(
      "UPDATE orders SET total = 1 WHERE id = 1",
    );
    await store.getState().explain("c1", true);
    const first = plan();
    store.getState().togglePin("c1", first.id);
    store.getState().updatePlan("c1", first.id, { view: "raw" });

    await store.getState().rerun("c1", first.id);

    expect(explained).toEqual([
      { sql: "UPDATE orders SET total = 1 WHERE id = 1", analyze: true },
      { sql: "UPDATE orders SET total = 1 WHERE id = 1", analyze: true },
    ]);
    expect(confirmAnalyse).toHaveBeenCalledTimes(2);
    expect(session().results).toHaveLength(1);
    expect(plan()).toMatchObject({ id: first.id, title: "Plan (analysed)", pinned: true, view: "raw" });
  });

  it("givenPlanTabUnpinned_whenExplainedAgain_thenReplacedLikeAResultTab", async () => {
    const { store, session, plan } = await opened("SELECT 1");
    await store.getState().explain("c1", false);
    const first = plan().id;

    await store.getState().explain("c1", false);

    expect(session().results).toHaveLength(1);
    expect(plan().id).not.toBe(first);
  });

  it("givenExplain_whenRecorded_thenHistoryHasTheExplainTextAndServicesTheLabel", async () => {
    const { store, recorded, executions } = await opened("SELECT * FROM orders");

    await store.getState().explain("c1", false);
    await store.getState().explain("c1", true);

    expect(recorded.map((entry) => [entry.sql, entry.outcome, entry.source])).toEqual([
      ["EXPLAIN (FORMAT JSON) SELECT * FROM orders", "success", "console"],
      ["EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM orders", "success", "console"],
    ]);
    expect(executions.getState().byTab.c1?.map((execution) => execution.label)).toEqual([
      "Explain Analyse: SELECT * FROM orders",
      "Explain: SELECT * FROM orders",
    ]);
  });
});

describe("plan tree", () => {
  const plan = {
    analyzed: false,
    roots: [
      node("Nested Loop", {
        estimatedCost: 20,
        children: [
          node("Seq Scan", { estimatedCost: 5, children: [node("Filter")] }),
          node("Index Scan", { estimatedCost: 15 }),
        ],
      }),
    ],
  };

  it("givenPlanRows_whenBuildingTree_thenBarShareOfRoot", () => {
    const rows = planRows(plan, new Set());

    expect(rows.map((row) => [row.key, row.depth, row.node.operation, row.share])).toEqual([
      ["0", 0, "Nested Loop", 1],
      ["0.0", 1, "Seq Scan", 0.25],
      ["0.0.0", 2, "Filter", null],
      ["0.1", 1, "Index Scan", 0.75],
    ]);
  });

  it("givenAnalysedPlan_whenBuildingTree_thenShareOfRootTime", () => {
    const analysed = {
      analyzed: true,
      roots: [node("Sort", { estimatedCost: 100, actualTimeMs: 2, children: [node("Scan", { actualTimeMs: 0.5 })] })],
    };

    expect(planRows(analysed, new Set()).map((row) => row.share)).toEqual([1, 0.25]);
  });

  it("givenCollapsedNode_whenBuildingTree_thenItsChildrenHidden", () => {
    expect(planRows(plan, new Set(["0.0"])).map((row) => row.key)).toEqual(["0", "0.0", "0.1"]);
    expect(planNodeAt(plan, "0.0.0")?.operation).toBe("Filter");
    expect(planNodeAt(plan, "3")).toBeNull();
  });

  it("givenSelectedNode_whenArrowKeys_thenTreeKeyboardModel", () => {
    const rows = planRows(plan, new Set());

    expect(movedInPlan(rows, "0", [], "ArrowDown")).toEqual({ selected: "0.0", collapsed: [] });
    expect(movedInPlan(rows, "0.0", [], "ArrowLeft")).toEqual({ selected: "0.0", collapsed: ["0.0"] });
    expect(movedInPlan(rows, "0.0", ["0.0"], "ArrowRight")).toEqual({ selected: "0.0", collapsed: [] });
    expect(movedInPlan(rows, "0.1", [], "ArrowLeft")).toEqual({ selected: "0", collapsed: [] });
    expect(movedInPlan(rows, "0", [], "End")).toEqual({ selected: "0.1", collapsed: [] });
    expect(movedInPlan(rows, "0", [], "x")).toBeNull();
  });

  it("givenNumbers_whenFormatted_thenGroupedAndEmptyForNull", () => {
    expect([planNumber(1204), planNumber(17.39), planNumber(0.0364), planNumber(null)]).toEqual([
      "1,204",
      "17.39",
      "0.036",
      "",
    ]);
  });
});
