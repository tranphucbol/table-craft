import { describe, expect, it } from "vitest";
import type { ClassifiedStatement } from "@table-craft/desktop/engine/protocol.js";
import {
  accessVerdict,
  ASK_READS_REASON,
  NOT_EXPOSED_REASON,
  READ_ONLY_REASON,
  TRANSACTION_REASON,
} from "@table-craft/desktop/mcp/access.js";
import { createApprovals, type ApprovalRequest } from "@table-craft/desktop/mcp/approvals.js";

const REQUEST: ApprovalRequest = {
  sessionId: "mcp-1",
  clientName: "Cursor",
  datasourceId: "shop",
  datasourceName: "Shop",
  sql: "DELETE FROM orders WHERE id = 1",
  kind: "write",
  subject: "statement",
  database: null,
  destructive: null,
  reason: null,
  allowable: true,
};

const READ_REQUEST: ApprovalRequest = { ...REQUEST, sql: "SELECT * FROM orders", kind: "read" };

function statement(kind: ClassifiedStatement["kind"], destructive: string | null = null): ClassifiedStatement {
  return { kind, destructive, sql: "x" } as ClassifiedStatement;
}

function manualTimers() {
  const timers: (() => void)[] = [];
  return {
    setTimer: (run: () => void) => timers.push(run),
    clearTimer: () => undefined,
    fire: () => timers.splice(0).forEach((run) => run()),
  };
}

describe("MCP access", () => {
  it("givenEachAccessLevel_whenStatementsJudged_thenOnlyAskLetsWritesWait", () => {
    expect(accessVerdict("off", statement("read"))).toEqual({ kind: "refuse", reason: NOT_EXPOSED_REASON });
    expect(accessVerdict("read", statement("read"))).toEqual({ kind: "read" });
    expect(accessVerdict("read", statement("write"))).toEqual({ kind: "refuse", reason: READ_ONLY_REASON });
    expect(accessVerdict("ask", statement("transaction"))).toEqual({ kind: "refuse", reason: TRANSACTION_REASON });
    expect(accessVerdict("ask", statement("write"))).toEqual({ kind: "approve", approval: "write", allowable: true });
    expect(accessVerdict("ask", statement("write", "no WHERE"))).toMatchObject({ allowable: false });
    expect(accessVerdict("ask", statement("ddl"))).toEqual({ kind: "approve", approval: "ddl", allowable: false });
  });

  it("givenAskReads_whenStatementsJudged_thenReadsWaitAndChangesAreRefused", () => {
    expect(accessVerdict("askReads", statement("read"))).toEqual({
      kind: "approve",
      approval: "read",
      allowable: true,
    });
    for (const kind of ["write", "ddl", "other"] as const)
      expect(accessVerdict("askReads", statement(kind))).toEqual({ kind: "refuse", reason: ASK_READS_REASON });
    expect(accessVerdict("askReads", statement("transaction"))).toEqual({
      kind: "refuse",
      reason: TRANSACTION_REASON,
    });
  });
});

describe("MCP approvals", () => {
  it("givenWaitingRequest_whenTimeRunsOut_thenTimedOut", async () => {
    const timers = manualTimers();
    const approvals = createApprovals({ onChange: () => undefined, ...timers });
    approvals.setWindows(true);

    const outcome = approvals.request(REQUEST);
    timers.fire();

    await expect(outcome).resolves.toBe("timedOut");
    expect(approvals.pending()).toEqual([]);
  });

  it("givenWaitingRequest_whenPausedOrWindowsClose_thenSettledAtOnce", async () => {
    const approvals = createApprovals({ onChange: () => undefined, ...manualTimers() });
    approvals.setWindows(true);

    const beforePause = approvals.request(REQUEST);
    approvals.setPaused(true);
    const whilePaused = approvals.request(REQUEST);
    approvals.setPaused(false);
    const beforeClose = approvals.request(REQUEST);
    approvals.setWindows(false);

    await expect(beforePause).resolves.toBe("paused");
    await expect(whilePaused).resolves.toBe("paused");
    await expect(beforeClose).resolves.toBe("noWindow");
  });

  it("givenAllowKind_whenSessionEnds_thenTheGrantGoesWithIt", async () => {
    const approvals = createApprovals({ onChange: () => undefined, ...manualTimers() });
    approvals.setWindows(true);

    const outcome = approvals.request(REQUEST);
    const [view] = approvals.pending();
    approvals.answer(view?.id ?? "", "allowKind");
    await outcome;

    expect(approvals.allowedAlready(REQUEST)).toBe(true);
    expect(approvals.allowedAlready({ ...REQUEST, sessionId: "mcp-2" })).toBe(false);
    approvals.forgetSession("mcp-1");
    expect(approvals.allowedAlready(REQUEST)).toBe(false);
  });

  it("givenReadGrant_whenSameSessionReadsAgain_thenNotAsked", async () => {
    const approvals = createApprovals({ onChange: () => undefined, ...manualTimers() });
    approvals.setWindows(true);

    const outcome = approvals.request(READ_REQUEST);
    const [view] = approvals.pending();
    expect(view).toMatchObject({ kind: "read", subject: "statement", database: null });
    approvals.answer(view?.id ?? "", "allowKind");
    await outcome;

    const another: ApprovalRequest = { ...READ_REQUEST, sql: "SELECT 1" };
    const key: ApprovalRequest = { ...READ_REQUEST, sql: "user:1", subject: "key", database: 0 };
    expect(approvals.allowedAlready(another)).toBe(true);
    expect(approvals.allowedAlready(key)).toBe(true);
    expect(approvals.allowedAlready(REQUEST)).toBe(false);
    expect(approvals.allowedAlready({ ...READ_REQUEST, datasourceId: "crm" })).toBe(false);
  });

  it("givenUnallowableRequest_whenAnsweredAllowKind_thenOnlyThatOneRuns", async () => {
    const approvals = createApprovals({ onChange: () => undefined, ...manualTimers() });
    approvals.setWindows(true);
    const ddl = { ...REQUEST, kind: "ddl" as const, allowable: false };

    const outcome = approvals.request(ddl);
    approvals.answer(approvals.pending()[0]?.id ?? "", "allowKind");

    await expect(outcome).resolves.toBe("allowed");
    expect(approvals.allowedAlready(ddl)).toBe(false);
  });

  it("givenAnsweredId_whenAnsweredAgain_thenFalse", async () => {
    const changes: number[] = [];
    const approvals = createApprovals({ onChange: () => changes.push(1), now: () => 1_000, ...manualTimers() });
    approvals.setWindows(true);

    const outcome = approvals.request(REQUEST);
    const [view] = approvals.pending();

    expect(view?.deadline).toBe(61_000);
    expect(approvals.answer(view?.id ?? "", "deny")).toBe(true);
    expect(approvals.answer(view?.id ?? "", "deny")).toBe(false);
    await expect(outcome).resolves.toBe("denied");
    expect(changes).toHaveLength(2);
  });
});
