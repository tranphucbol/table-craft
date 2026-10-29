import { create } from "zustand";
import type { ExplainedPlan } from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useMcp } from "@table-craft/desktop/renderer/state/mcp.js";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";

/**
 * How long the approval dialog waits for a plan. The engine times nothing out where it cannot
 * cancel (TiDB before 6.1, decision 088), so the dialog also gives up on its own and closes the
 * session once the statement ends (decision 130).
 */
export const APPROVAL_PLAN_TIMEOUT_SECONDS = 10;

const TIMED_OUT_CODE = "statementTimedOut";
const MS_PER_SECOND = 1000;

export type ApprovalPlan =
  | { readonly state: "explaining" }
  | { readonly state: "explained"; readonly plan: ExplainedPlan }
  | { readonly state: "failed"; readonly message: string };

/** The waiting request whose statement is explained. */
export interface ApprovalPlanRequest {
  readonly id: string;
  readonly datasourceId: string;
  readonly sql: string;
}

export interface ApprovalPlansState {
  /** By approval id; only requests still waiting. */
  readonly plans: Readonly<Record<string, ApprovalPlan>>;
  /**
   * Plans the statement once, never analysed, on a session of its own that closes after,
   * read-only for a read: the agent's sessions are never touched, and nothing is answered or
   * recorded.
   */
  readonly explain: (request: ApprovalPlanRequest) => Promise<void>;
}

export interface ApprovalPlansDependencies {
  readonly connect: (datasourceId: string) => Promise<EngineClient>;
  /** The ids of the requests still waiting; a plan for any other is dropped. */
  readonly waiting: () => readonly string[];
  /** Defaults to {@link APPROVAL_PLAN_TIMEOUT_SECONDS}; tests shorten it. */
  readonly limitMs?: number;
}

class PlanTookTooLong extends Error {}

export function failureText(cause: unknown): string {
  if (cause instanceof PlanTookTooLong || toError(cause).code === TIMED_OUT_CODE) {
    return `The plan took longer than ${String(APPROVAL_PLAN_TIMEOUT_SECONDS)} s, so it was abandoned; the request is still waiting.`;
  }
  return toError(cause).message;
}

function withinLimit<T>(work: Promise<T>, limitMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PlanTookTooLong()), limitMs);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

export function createApprovalPlansStore(dependencies: ApprovalPlansDependencies) {
  const limitMs = dependencies.limitMs ?? APPROVAL_PLAN_TIMEOUT_SECONDS * MS_PER_SECOND;
  return create<ApprovalPlansState>()((set, get) => {
    function waitingPlans(): Record<string, ApprovalPlan> {
      const waiting = new Set(dependencies.waiting());
      return Object.fromEntries(Object.entries(get().plans).filter(([id]) => waiting.has(id)));
    }

    function settle(id: string, plan: ApprovalPlan): void {
      const plans = waitingPlans();
      set({ plans: plans[id] === undefined ? plans : { ...plans, [id]: plan } });
    }

    async function plan(request: ApprovalPlanRequest): Promise<ApprovalPlan> {
      const client = await dependencies.connect(request.datasourceId);
      const explainable = await client.call("sql.explainable", { sql: request.sql, analyze: false });
      if (!explainable.ok) return { state: "failed", message: explainable.reason };
      // MySQL refuses even a plain EXPLAIN of a write inside a READ ONLY transaction. The write
      // stays safe: `explainable` has refused a second statement, a nested EXPLAIN and analysing.
      const { sessionId } = await client.call("session.open", { readOnly: !explainable.writes });
      const explaining = client.call("statement.explain", {
        sessionId,
        sql: request.sql,
        analyze: false,
        timeoutSeconds: APPROVAL_PLAN_TIMEOUT_SECONDS,
        serverEnforced: true,
      });
      void explaining
        .catch(() => undefined)
        .finally(() => void client.call("session.close", { sessionId }).catch(() => undefined));
      const explained = await withinLimit(explaining, limitMs);
      return { state: "explained", plan: explained.plan };
    }

    return {
      plans: {},

      async explain(request) {
        const current = get().plans[request.id];
        if (current !== undefined && current.state !== "failed") return;
        set({ plans: { ...waitingPlans(), [request.id]: { state: "explaining" } } });
        try {
          settle(request.id, await plan(request));
        } catch (cause) {
          settle(request.id, { state: "failed", message: failureText(cause) });
        }
      },
    };
  });
}

export type ApprovalPlansStore = ReturnType<typeof createApprovalPlansStore>;

export const useApprovalPlans = createApprovalPlansStore({
  connect: (id) => useDatasources.getState().connect(id),
  waiting: () => useMcp.getState().status.approvals.map((approval) => approval.id),
});
