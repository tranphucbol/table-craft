import type {
  ApprovalAnswer,
  ApprovalKind,
  ApprovalSubject,
  McpApprovalView,
} from "@table-craft/desktop/settings/mcp.js";

/** How long a request waits for the user before it is denied. */
export const APPROVAL_TIMEOUT_MS = 60_000;

export type ApprovalOutcome = "allowed" | "denied" | "handedOff" | "timedOut" | "noWindow" | "paused";

export const APPROVAL_REFUSALS: Readonly<Record<Exclude<ApprovalOutcome, "allowed">, string>> = {
  denied: "The user denied this statement in TableCraft.",
  handedOff:
    "The user took this statement into a TableCraft console to review and run it themselves; it did not run here.",
  timedOut: "Nobody answered in TableCraft in time, so the statement was denied.",
  noWindow: "TableCraft has no window open to ask the user, so the statement was denied.",
  paused: "Agents are paused in TableCraft.",
};

export interface ApprovalRequest {
  /** The MCP session asking; an "allow this kind" answer lasts as long as it does. */
  readonly sessionId: string;
  readonly clientName: string;
  readonly datasourceId: string;
  readonly datasourceName: string;
  readonly sql: string;
  readonly kind: ApprovalKind;
  readonly subject: ApprovalSubject;
  readonly database: number | null;
  readonly rerunRows?: number;
  readonly destructive: string | null;
  readonly reason: string | null;
  readonly allowable: boolean;
}

type Granted = Pick<ApprovalRequest, "sessionId" | "datasourceId" | "kind" | "subject" | "allowable">;

export interface Approvals {
  /** Resolves once the user answers, the wait runs out, or nobody can answer. */
  request(request: ApprovalRequest): Promise<ApprovalOutcome>;
  /** False when the id is not waiting any more. */
  answer(id: string, answer: ApprovalAnswer): boolean;
  pending(): readonly McpApprovalView[];
  /** Whether an earlier "allow this kind" answer covers the statement. */
  allowedAlready(request: Granted): boolean;
  setWindows(open: boolean): void;
  setPaused(paused: boolean): void;
  forgetSession(sessionId: string): void;
}

export interface ApprovalsOptions {
  readonly onChange: () => void;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
  /** A dialog opened for the request. */
  readonly onAsked?: (id: string, request: ApprovalRequest) => void;
  /** Every request's end, including those refused without asking, whose `id` is null. */
  readonly onSettled?: (
    request: ApprovalRequest,
    outcome: ApprovalOutcome,
    waitedMs: number,
    id: string | null,
  ) => void;
}

interface Waiting {
  readonly view: McpApprovalView;
  readonly request: ApprovalRequest;
  readonly askedAt: number;
  readonly timer: unknown;
  readonly settle: (outcome: ApprovalOutcome) => void;
}

function grantKey(request: Granted): string {
  const scope: ApprovalKind | "rerun" = request.subject === "rerun" ? "rerun" : request.kind;
  return JSON.stringify([request.sessionId, request.datasourceId, scope]);
}

export function createApprovals(options: ApprovalsOptions): Approvals {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? APPROVAL_TIMEOUT_MS;
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const waiting = new Map<string, Waiting>();
  const granted = new Set<string>();
  let windows = false;
  let paused = false;
  let next = 0;

  function settle(id: string, outcome: ApprovalOutcome): void {
    const entry = waiting.get(id);
    if (entry === undefined) return;
    waiting.delete(id);
    clearTimer(entry.timer);
    options.onSettled?.(entry.request, outcome, Math.max(0, now() - entry.askedAt), id);
    entry.settle(outcome);
    options.onChange();
  }

  function refuse(request: ApprovalRequest, outcome: ApprovalOutcome): Promise<ApprovalOutcome> {
    options.onSettled?.(request, outcome, 0, null);
    return Promise.resolve(outcome);
  }

  function settleAll(outcome: ApprovalOutcome): void {
    for (const id of [...waiting.keys()]) settle(id, outcome);
  }

  return {
    request(request) {
      if (paused) return refuse(request, "paused");
      if (!windows) return refuse(request, "noWindow");
      next += 1;
      const id = `approval-${String(next)}`;
      return new Promise<ApprovalOutcome>((resolve) => {
        const askedAt = now();
        const view: McpApprovalView = {
          id,
          clientName: request.clientName,
          datasourceId: request.datasourceId,
          datasourceName: request.datasourceName,
          sql: request.sql,
          kind: request.kind,
          subject: request.subject,
          database: request.database,
          ...(request.rerunRows === undefined ? {} : { rerunRows: request.rerunRows }),
          destructive: request.destructive,
          reason: request.reason,
          deadline: askedAt + timeoutMs,
          allowable: request.allowable,
        };
        const timer = setTimer(() => settle(id, "timedOut"), timeoutMs);
        waiting.set(id, { view, request, askedAt, timer, settle: resolve });
        options.onAsked?.(id, request);
        options.onChange();
      });
    },
    answer(id, answer) {
      const entry = waiting.get(id);
      if (entry === undefined) return false;
      if (answer === "allowKind" && entry.request.allowable) {
        granted.add(grantKey(entry.request));
      }
      settle(id, answer === "deny" ? "denied" : answer === "handOff" ? "handedOff" : "allowed");
      return true;
    },
    pending: () => [...waiting.values()].map((entry) => entry.view),
    allowedAlready: (request) => request.allowable && granted.has(grantKey(request)),
    setWindows(open) {
      windows = open;
      if (!open) settleAll("noWindow");
    },
    setPaused(value) {
      paused = value;
      if (value) settleAll("paused");
    },
    forgetSession(sessionId) {
      for (const key of [...granted]) {
        if ((JSON.parse(key) as string[])[0] === sessionId) granted.delete(key);
      }
      for (const [id, entry] of [...waiting]) if (entry.request.sessionId === sessionId) settle(id, "denied");
    },
  };
}
