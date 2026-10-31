import { describe, expect, it } from "vitest";
import { createLogger, type LogRecord } from "@table-craft/desktop/log/record.js";
import { createMcpNotices } from "@table-craft/desktop/main/mcpNotices.js";
import {
  stoppedStatus,
  type McpApprovalView,
  type McpPendingClient,
  type McpStatus,
} from "@table-craft/desktop/settings/mcp.js";
import type { McpNotice } from "@table-craft/desktop/settings/mcpNotice.js";

const NOW = 1_000_000;
const STOPPED = stoppedStatus(47_820);
const RUNNING: McpStatus = { ...STOPPED, state: "running" };
const WRITE: McpApprovalView = {
  id: "approval-1",
  clientName: "OpenCode",
  datasourceId: "shop",
  datasourceName: "shop-prod",
  sql: "UPDATE orders SET total = 0",
  kind: "write",
  subject: "statement",
  database: null,
  destructive: null,
  reason: null,
  deadline: NOW + 60_000,
  allowable: true,
};
const SECOND = { ...WRITE, id: "approval-2" };
const CURSOR: McpPendingClient = { name: "Cursor", version: "1.0", since: NOW, deadline: NOW + 60_000 };

function waiting(approvals: readonly McpApprovalView[], pendingClients: readonly McpPendingClient[] = []): McpStatus {
  return { ...RUNNING, approvals, pendingClients };
}

interface Shown {
  readonly notice: McpNotice;
  readonly click: () => void;
  closed: boolean;
}

function harness(initial: { enabled?: boolean; focused?: boolean; supported?: boolean } = {}) {
  const state = { enabled: true, focused: false, supported: true, ...initial };
  const shown: Shown[] = [];
  const badges: number[] = [];
  const revealed: McpNotice["opens"][] = [];
  const records: LogRecord[] = [];
  const notices = createMcpNotices({
    enabled: () => state.enabled,
    focused: () => state.focused,
    supported: () => state.supported,
    show(notice, onClick) {
      const entry: Shown = { notice, click: onClick, closed: false };
      shown.push(entry);
      return {
        close: () => {
          entry.closed = true;
        },
      };
    },
    setBadge: (count) => badges.push(count),
    reveal: (opens) => revealed.push(opens),
    now: () => NOW,
    log: createLogger({ process: "main", scope: "test", sink: (record) => records.push(record) }),
  });
  const open = () => shown.filter((entry) => !entry.closed);
  return { state, notices, shown, open, badges, revealed, records };
}

describe("MCP notices", () => {
  it("givenBackgroundAndNewApproval_whenStatusChanged_thenOneNoticeAndBadge", () => {
    const { notices, open, badges } = harness();

    notices.statusChanged(RUNNING);
    notices.statusChanged(waiting([WRITE]));

    expect(open().map((entry) => entry.notice.title)).toEqual(["OpenCode wants to change data"]);
    expect(badges.at(-1)).toBe(1);
  });

  it("givenFocusedWindow_whenNewApproval_thenNoNoticeButBadge", () => {
    const { notices, shown, badges } = harness({ focused: true });

    notices.statusChanged(waiting([WRITE]));

    expect(shown).toEqual([]);
    expect(badges.at(-1)).toBe(1);
  });

  it("givenLiveNotice_whenAnotherApprovalArrives_thenReplacedWithCount", () => {
    const { notices, shown, open } = harness();

    notices.statusChanged(waiting([WRITE]));
    notices.statusChanged(waiting([WRITE, SECOND]));

    expect(shown).toHaveLength(2);
    expect(shown[0]?.closed).toBe(true);
    expect(open().map((entry) => entry.notice.title)).toEqual(["2 agent requests are waiting"]);
  });

  it("givenLiveNotice_whenStatusRepeats_thenNotShownAgain", () => {
    const { notices, shown } = harness();

    notices.statusChanged(waiting([WRITE, SECOND]));
    notices.statusChanged(waiting([WRITE, SECOND]));
    notices.statusChanged(waiting([SECOND]));

    expect(shown).toHaveLength(1);
    expect(shown[0]?.closed).toBe(false);
  });

  it("givenLiveNotice_whenAllAnswered_thenClosedAndBadgeZero", () => {
    const { notices, open, badges } = harness();

    notices.statusChanged(waiting([WRITE]));
    notices.statusChanged(RUNNING);

    expect(open()).toEqual([]);
    expect(badges.at(-1)).toBe(0);
  });

  it("givenLiveNotice_whenWindowFocused_thenClosedButBadgeKept", () => {
    const { notices, open, badges } = harness();

    notices.statusChanged(waiting([WRITE]));
    notices.windowFocused();

    expect(open()).toEqual([]);
    expect(badges.at(-1)).toBe(1);
  });

  it("givenDisabled_whenNewApproval_thenNothingShownAndBadgeZero", () => {
    const { notices, shown, badges } = harness({ enabled: false });

    notices.statusChanged(waiting([WRITE]));

    expect(shown).toEqual([]);
    expect(badges).toEqual([0]);
  });

  it("givenLiveNotice_whenTurnedOff_thenClosedAndBadgeZero", () => {
    const { state, notices, open, badges } = harness();

    notices.statusChanged(waiting([WRITE]));
    state.enabled = false;
    notices.settingsChanged();

    expect(open()).toEqual([]);
    expect(badges.at(-1)).toBe(0);
  });

  it("givenUnsupported_whenNewApproval_thenBadgeOnlyAndLoggedOnce", () => {
    const { notices, shown, badges, records } = harness({ supported: false });

    notices.statusChanged(waiting([WRITE]));
    notices.statusChanged(waiting([WRITE, SECOND]));

    expect(shown).toEqual([]);
    expect(badges.at(-1)).toBe(2);
    expect(records.filter((record) => record.level === "info")).toHaveLength(1);
  });

  it("givenNotice_whenClicked_thenRevealsApprovalsAndCloses", () => {
    const { notices, shown, open, revealed } = harness();

    notices.statusChanged(waiting([WRITE]));
    shown[0]?.click();

    expect(revealed).toEqual(["approvals"]);
    expect(open()).toEqual([]);
  });

  it("givenPendingClientNotice_whenClicked_thenRevealsClients", () => {
    const { notices, shown, revealed } = harness();

    notices.statusChanged(waiting([], [CURSOR]));
    shown[0]?.click();

    expect(revealed).toEqual(["clients"]);
  });

  it("givenReplacedNotice_whenOldOneClicked_thenNewOneStaysOpen", () => {
    const { notices, shown, open } = harness();

    notices.statusChanged(waiting([WRITE]));
    notices.statusChanged(waiting([WRITE, SECOND]));
    shown[0]?.click();

    expect(open()).toHaveLength(1);
  });

  it("givenServerStopped_whenStatusChanged_thenClosedAndBadgeZero", () => {
    const { notices, open, badges } = harness();

    notices.statusChanged(waiting([WRITE], [CURSOR]));
    notices.statusChanged(STOPPED);

    expect(open()).toEqual([]);
    expect(badges.at(-1)).toBe(0);
  });
});
