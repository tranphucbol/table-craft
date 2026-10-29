import { describe, expect, it } from "vitest";
import type { ExplainedPlan } from "@table-craft/desktop/engine/protocol.js";
import { EngineRequestError, type EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { planWarnings } from "@table-craft/desktop/renderer/model/planTree.js";
import {
  APPROVAL_PLAN_TIMEOUT_SECONDS,
  createApprovalPlansStore,
} from "@table-craft/desktop/renderer/state/approvalPlans.js";

const UPDATE = "UPDATE order_events SET state = 'gone'";
const REQUEST = { id: "approval-1", datasourceId: "tidb", sql: UPDATE };
const FULL_SCAN = "Full table scan: reads every row of order_events.";

function scan(partition: string) {
  return {
    operation: "TableFullScan_9",
    target: `table:order_events, partition:${partition}`,
    detail: "keep order:false",
    estimatedRows: 10000,
    estimatedCost: null,
    actualRows: null,
    actualTimeMs: null,
    loops: null,
    properties: [],
    children: [],
    warnings: [FULL_SCAN],
  };
}

const PLAN: ExplainedPlan = {
  statement: `EXPLAIN ${UPDATE}`,
  analyzed: false,
  roots: [
    {
      operation: "Update_4",
      target: null,
      detail: null,
      estimatedRows: null,
      estimatedCost: null,
      actualRows: null,
      actualTimeMs: null,
      loops: null,
      properties: [],
      children: [scan("p202601"), scan("p202602")],
    },
  ],
  summary: [],
  raw: "",
};

interface Call {
  readonly type: string;
  readonly params: Record<string, unknown>;
}

/**
 * An engine that plans `UPDATE` and records every call, fails the explain with `explainError`, or
 * holds it until `explainHeld` settles, like a server that cannot cancel.
 */
function engine(
  options: {
    explainable?: boolean;
    writes?: boolean;
    explainError?: EngineRequestError;
    explainHeld?: Promise<void>;
  } = {},
) {
  const calls: Call[] = [];
  const client = {
    call(type: string, params: Record<string, unknown>): Promise<unknown> {
      calls.push({ type, params });
      if (type === "sql.explainable") {
        return Promise.resolve(
          options.explainable === false
            ? { ok: false, reason: "TiDB cannot explain this." }
            : { ok: true, writes: options.writes ?? true },
        );
      }
      if (type === "session.open") return Promise.resolve({ sessionId: "explain-1" });
      if (type === "statement.explain") {
        if (options.explainError !== undefined) return Promise.reject(options.explainError);
        const held = options.explainHeld ?? Promise.resolve();
        return held.then(() => ({ plan: PLAN, transactionOpen: false }));
      }
      return Promise.resolve(null);
    },
    fail: () => undefined,
    onEvent: () => () => undefined,
  };
  return { client: client as EngineClient, calls };
}

function store(client: EngineClient, waiting: () => readonly string[] = () => [REQUEST.id]) {
  return createApprovalPlansStore({ connect: () => Promise.resolve(client), waiting });
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("approval plans", () => {
  it("givenWaitingUpdate_whenExplained_thenPlannedOnItsOwnSessionNeverAnalysed", async () => {
    const { client, calls } = engine();
    const plans = store(client);

    await plans.getState().explain(REQUEST);
    await settled();

    expect(plans.getState().plans[REQUEST.id]).toEqual({ state: "explained", plan: PLAN });
    expect(calls.map((call) => call.type)).toEqual([
      "sql.explainable",
      "session.open",
      "statement.explain",
      "session.close",
    ]);
    expect(calls[0]?.params).toEqual({ sql: UPDATE, analyze: false });
    expect(calls[1]?.params).toEqual({ readOnly: false });
    expect(calls[2]?.params).toEqual({
      sessionId: "explain-1",
      sql: UPDATE,
      analyze: false,
      timeoutSeconds: APPROVAL_PLAN_TIMEOUT_SECONDS,
      serverEnforced: true,
    });
    expect(calls.filter((call) => call.params.analyze === true)).toEqual([]);
    expect(calls[3]?.params).toEqual({ sessionId: "explain-1" });
  });

  it("givenWaitingSelect_whenExplained_thenPlannedOnAReadOnlySession", async () => {
    const { client, calls } = engine({ writes: false });
    const plans = store(client);

    await plans.getState().explain({ ...REQUEST, sql: "SELECT * FROM order_events" });

    expect(calls.find((call) => call.type === "session.open")?.params).toEqual({ readOnly: true });
  });

  it("givenExplained_whenExplainedAgain_thenTheDatabaseIsNotAskedTwice", async () => {
    const { client, calls } = engine();
    const plans = store(client);

    await plans.getState().explain(REQUEST);
    await plans.getState().explain(REQUEST);

    expect(calls.filter((call) => call.type === "statement.explain")).toHaveLength(1);
  });

  it("givenSlowPlan_whenTimedOut_thenAbandonedAndSessionClosed", async () => {
    const timedOut = new EngineRequestError({
      code: "statementTimedOut",
      message: "The statement timed out after 10 s and was cancelled.",
      hint: "",
    });
    const { client, calls } = engine({ explainError: timedOut });
    const plans = store(client);

    await plans.getState().explain(REQUEST);
    await settled();

    expect(plans.getState().plans[REQUEST.id]).toEqual({
      state: "failed",
      message: `The plan took longer than ${String(APPROVAL_PLAN_TIMEOUT_SECONDS)} s, so it was abandoned; the request is still waiting.`,
    });
    expect(calls.at(-1)).toEqual({ type: "session.close", params: { sessionId: "explain-1" } });
  });

  it("givenUnexplainableStatement_whenExplained_thenReasonShownAndNoSessionOpened", async () => {
    const { client, calls } = engine({ explainable: false });
    const plans = store(client);

    await plans.getState().explain(REQUEST);

    expect(plans.getState().plans[REQUEST.id]).toEqual({ state: "failed", message: "TiDB cannot explain this." });
    expect(calls.map((call) => call.type)).toEqual(["sql.explainable"]);
  });

  it("givenRequestAnsweredWhileExplaining_whenPlanArrives_thenDropped", async () => {
    const { client } = engine();
    let waiting: readonly string[] = [REQUEST.id];
    const plans = store(client, () => waiting);

    const explaining = plans.getState().explain(REQUEST);
    waiting = [];
    await explaining;

    expect(plans.getState().plans).toEqual({});
  });

  it("givenEngineThatCannotCancel_whenPlanOverrunsTheLimit_thenAbandonedAndSessionClosedWhenItEnds", async () => {
    let finish = (): void => undefined;
    const { client, calls } = engine({ explainHeld: new Promise<void>((resolve) => (finish = resolve)) });
    const plans = createApprovalPlansStore({
      connect: () => Promise.resolve(client),
      waiting: () => [REQUEST.id],
      limitMs: 1,
    });

    await plans.getState().explain(REQUEST);

    expect(plans.getState().plans[REQUEST.id]).toEqual({
      state: "failed",
      message: `The plan took longer than ${String(APPROVAL_PLAN_TIMEOUT_SECONDS)} s, so it was abandoned; the request is still waiting.`,
    });
    expect(calls.map((call) => call.type)).not.toContain("session.close");
    finish();
    await settled();
    expect(calls.at(-1)).toEqual({ type: "session.close", params: { sessionId: "explain-1" } });
  });

  it("givenPartitionsScannedInFull_whenWarningsListed_thenOnce", () => {
    expect(planWarnings(PLAN)).toEqual([FULL_SCAN]);
  });
});
