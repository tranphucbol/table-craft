import { describe, expect, it } from "vitest";
import { createLogger, type LogRecord } from "@table-craft/desktop/log/record.js";
import { createAgentLog } from "@table-craft/desktop/mcp/agentLog.js";
import { ACTIVITY_TARGET_CHARS } from "@table-craft/desktop/mcp/activity.js";
import type { ApprovalRequest } from "@table-craft/desktop/mcp/approvals.js";
import { AGENT_LOG_SCOPE, type McpActivityView } from "@table-craft/desktop/settings/mcp.js";

const CALL: Omit<McpActivityView, "id"> = {
  tool: "run_query",
  datasourceId: "shop",
  at: 1_000,
  durationMs: 12,
  approvalWaitMs: 0,
  outcome: "ok",
  target: "SELECT * FROM orders",
  rowCount: 3,
  message: null,
  clientId: "mcp-1",
  clientName: "Claude Code",
};

const REQUEST: ApprovalRequest = {
  sessionId: "mcp-1",
  clientName: "Claude Code",
  datasourceId: "shop",
  datasourceName: "Shop",
  sql: "DELETE FROM orders",
  kind: "write",
  subject: "statement",
  database: null,
  destructive: "no WHERE",
  reason: "clean up",
  allowable: false,
};

function captured() {
  const records: LogRecord[] = [];
  const log = createAgentLog(createLogger({ process: "mcp", scope: "mcp", sink: (record) => records.push(record) }));
  return { log, records };
}

describe("agent log", () => {
  it("givenOkCall_whenLogged_thenInfoAgentCallWithFullTarget", () => {
    const { log, records } = captured();

    log.call(CALL);

    expect(records).toEqual([
      expect.objectContaining({
        level: "info",
        process: "mcp",
        scope: AGENT_LOG_SCOPE,
        msg: "agent call",
        clientId: "mcp-1",
        clientName: "Claude Code",
        tool: "run_query",
        datasourceId: "shop",
        outcome: "ok",
        durationMs: 12,
        rowCount: 3,
        target: "SELECT * FROM orders",
      }),
    ]);
  });

  it("givenErrorCall_whenLogged_thenWarnWithMessage", () => {
    const { log, records } = captured();

    log.call({ ...CALL, outcome: "error", rowCount: null, message: "no such table: order" });

    expect(records[0]).toMatchObject({ level: "warn", outcome: "error", message: "no such table: order" });
  });

  it("givenRefusedCall_whenLogged_thenInfoOutcomeRefused", () => {
    const { log, records } = captured();

    log.call({ ...CALL, outcome: "refused", datasourceId: null, target: null, message: "Agents are paused." });

    expect(records[0]).toMatchObject({ level: "info", outcome: "refused", message: "Agents are paused." });
  });

  it("givenStatementLongerThanActivityCut_whenLogged_thenTargetIsWhole", () => {
    const { log, records } = captured();
    const long = `SELECT ${"x, ".repeat(ACTIVITY_TARGET_CHARS)}1`;

    log.call({ ...CALL, target: long });

    expect(records[0]?.target).toBe(long);
  });

  it("givenAbsentValues_whenLogged_thenFieldsOmitted", () => {
    const { log, records } = captured();

    log.call({ ...CALL, datasourceId: null, rowCount: null, target: null });

    for (const key of ["datasourceId", "rowCount", "target", "message", "approvalWaitMs"])
      expect(records[0]).not.toHaveProperty(key);
  });

  it("givenApproval_whenAskedAndAnswered_thenPairSharesTheId", () => {
    const { log, records } = captured();

    log.asked("approval-7", REQUEST);
    log.answered(REQUEST, "denied", 4_000, "approval-7");
    log.answered(REQUEST, "paused", 0, null);

    expect(records).toMatchObject([
      {
        msg: "approval asked",
        approvalId: "approval-7",
        kind: "write",
        target: "DELETE FROM orders",
        destructive: "no WHERE",
        reason: "clean up",
      },
      { msg: "approval answered", approvalId: "approval-7", outcome: "denied", waitedMs: 4_000 },
      { msg: "approval answered", outcome: "paused" },
    ]);
    expect(records[2]).not.toHaveProperty("approvalId");
  });

  it("givenSession_whenConnectedAndDisconnected_thenNamedWithWhoLeft", () => {
    const { log, records } = captured();
    const session = { id: "mcp-1", name: "Claude Code", version: "2.1" };

    log.connected(session);
    log.disconnected(session, "user");

    expect(records).toMatchObject([
      { msg: "agent connected", clientId: "mcp-1", clientName: "Claude Code", clientVersion: "2.1" },
      { msg: "agent disconnected", clientId: "mcp-1", by: "user" },
    ]);
  });
});
