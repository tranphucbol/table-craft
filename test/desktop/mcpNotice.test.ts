import { describe, expect, it } from "vitest";
import {
  stoppedStatus,
  type McpApprovalView,
  type McpPendingClient,
  type McpStatus,
} from "@table-craft/desktop/settings/mcp.js";
import { newlyWaiting, noticeFor, waitingCount } from "@table-craft/desktop/settings/mcpNotice.js";

const NOW = 1_000_000;
const RUNNING: McpStatus = { ...stoppedStatus(47_820), state: "running" };
const WRITE: McpApprovalView = {
  id: "approval-1",
  clientName: "OpenCode",
  datasourceId: "shop",
  datasourceName: "shop-prod",
  sql: "UPDATE orders SET total = 0",
  kind: "write",
  subject: "statement",
  database: null,
  destructive: "no WHERE",
  reason: "zero the totals for the audit",
  deadline: NOW + 58_000,
  allowable: false,
};
const CURSOR: McpPendingClient = { name: "Cursor", version: "1.0", since: NOW, deadline: NOW + 60_000 };

function waiting(approvals: readonly McpApprovalView[], pendingClients: readonly McpPendingClient[] = []): McpStatus {
  return { ...RUNNING, approvals, pendingClients };
}

describe("MCP notice text", () => {
  it("givenNoApprovals_whenNoticeFor_thenNull", () => {
    expect(noticeFor(RUNNING, NOW)).toBeNull();
  });

  it("givenOneWriteApproval_whenNoticeFor_thenNamesClientDatasourceAndChange", () => {
    expect(noticeFor(waiting([WRITE]), NOW)).toEqual({
      title: "OpenCode wants to change data",
      body: "On shop-prod. Answer in TableCraft within 58 s.",
      opens: "approvals",
      keys: ["approval:approval-1"],
    });
  });

  it("givenOneReadApproval_whenNoticeFor_thenSaysReadData", () => {
    expect(noticeFor(waiting([{ ...WRITE, kind: "read" }]), NOW)?.title).toBe("OpenCode wants to read data");
  });

  it("givenKeyApproval_whenNoticeFor_thenSaysReadAKeyWithDatabase", () => {
    const key = { ...WRITE, kind: "read", subject: "key", database: 3, datasourceName: "cache" } as const;

    expect(noticeFor(waiting([key]), NOW)).toMatchObject({
      title: "OpenCode wants to read a key",
      body: "On cache (db 3). Answer in TableCraft within 58 s.",
    });
  });

  it("givenSeveralApprovals_whenNoticeFor_thenCountsThemAndUsesSoonestDeadline", () => {
    const second = { ...WRITE, id: "approval-2", deadline: NOW + 41_000 };
    const third = { ...WRITE, id: "approval-3", clientName: "Cursor" };

    expect(noticeFor(waiting([WRITE, second, third]), NOW)).toMatchObject({
      title: "3 agent requests are waiting",
      body: "From OpenCode and Cursor. Answer in TableCraft within 41 s.",
      opens: "approvals",
    });
  });

  it("givenOnlyPendingClient_whenNoticeFor_thenOpensClients", () => {
    expect(noticeFor(waiting([], [CURSOR]), NOW)).toEqual({
      title: "Cursor wants to connect",
      body: "Allow or block it in TableCraft within 60 s.",
      opens: "clients",
      keys: ["client:Cursor"],
    });
  });

  it("givenApprovalAndPendingClient_whenNoticeFor_thenOpensApprovalsAndMentionsClient", () => {
    expect(noticeFor(waiting([WRITE], [CURSOR]), NOW)).toEqual({
      title: "OpenCode wants to change data",
      body: "On shop-prod. Answer in TableCraft within 58 s. Cursor also wants to connect.",
      opens: "approvals",
      keys: ["approval:approval-1", "client:Cursor"],
    });
  });

  it("givenApproval_whenNoticeFor_thenBodyNeverContainsSqlNorReason", () => {
    const notice = noticeFor(waiting([WRITE]), NOW);
    const text = `${notice?.title ?? ""} ${notice?.body ?? ""}`;

    expect(text).not.toContain("UPDATE");
    expect(text).not.toContain("audit");
    expect(text).not.toContain("WHERE");
  });

  it("givenPassedDeadline_whenNoticeFor_thenZeroSecondsLeft", () => {
    expect(noticeFor(waiting([WRITE]), WRITE.deadline + 5_000)?.body).toContain("within 0 s");
  });
});

describe("MCP waiting keys", () => {
  it("givenSameApprovals_whenNewlyWaiting_thenEmpty", () => {
    expect(newlyWaiting(waiting([WRITE]), waiting([WRITE]))).toEqual([]);
  });

  it("givenOneMoreApproval_whenNewlyWaiting_thenOnlyTheNewOne", () => {
    const second = { ...WRITE, id: "approval-2" };

    expect(newlyWaiting(waiting([WRITE]), waiting([WRITE, second]))).toEqual(["approval:approval-2"]);
  });

  it("givenApprovalIdEqualToClientName_whenNewlyWaiting_thenBothCounted", () => {
    const named = { ...WRITE, id: "Cursor" };

    expect(newlyWaiting(waiting([named]), waiting([named], [CURSOR]))).toEqual(["client:Cursor"]);
  });

  it("givenApprovalsAndClients_whenWaitingCount_thenBothCounted", () => {
    expect(waitingCount(waiting([WRITE, { ...WRITE, id: "approval-2" }], [CURSOR]))).toBe(3);
  });
});
