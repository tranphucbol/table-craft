import type { McpApprovalView, McpStatus } from "@table-craft/desktop/settings/mcp.js";

/** What a system notification says while an agent waits for the user (decision 143). */
export interface McpNotice {
  readonly title: string;
  readonly body: string;
  /** What a click opens: the approval dialog, or the chip's popover for a waiting client. */
  readonly opens: "approvals" | "clients";
  /** The waiting keys this notice announces, as `waitingKeys` names them. */
  readonly keys: readonly string[];
}

/** The renderer actions a click on the notice runs, by what it `opens`; both open without toggling. */
export const MCP_NOTICE_ACTIONS: Readonly<Record<McpNotice["opens"], string>> = {
  approvals: "mcp.approvals",
  clients: "mcp.decideClient",
};

const APPROVAL_KEY_PREFIX = "approval:";
const CLIENT_KEY_PREFIX = "client:";
const SECOND_MS = 1_000;
const APP_NAME = "TableCraft";

/** Every approval and waiting client, prefixed so an approval id and a client name never collide. */
export function waitingKeys(status: McpStatus): readonly string[] {
  return [
    ...status.approvals.map((approval) => `${APPROVAL_KEY_PREFIX}${approval.id}`),
    ...status.pendingClients.map((client) => `${CLIENT_KEY_PREFIX}${client.name}`),
  ];
}

/** What waits in `next` that did not wait in `previous`; empty when nothing new arrived. */
export function newlyWaiting(previous: McpStatus, next: McpStatus): readonly string[] {
  const before = new Set(waitingKeys(previous));
  return waitingKeys(next).filter((key) => !before.has(key));
}

/** The number on the dock icon: approvals plus clients waiting to be allowed. */
export function waitingCount(status: McpStatus): number {
  return status.approvals.length + status.pendingClients.length;
}

/**
 * The notice for everything waiting in `status`; null when nothing waits. It never carries the
 * statement, the key nor the agent's reason: Notification Center keeps notices and shows them on
 * the lock screen.
 */
export function noticeFor(status: McpStatus, now: number): McpNotice | null {
  const keys = waitingKeys(status);
  const [first, ...rest] = status.approvals;
  if (first !== undefined) {
    const deadline = Math.min(first.deadline, ...rest.map((approval) => approval.deadline));
    const answer = `Answer in ${APP_NAME} within ${secondsLeft(deadline, now)}.`;
    const clients = status.pendingClients.map((client) => client.name);
    const also =
      clients.length === 0 ? "" : ` ${joinNames(clients)} also ${clients.length === 1 ? "wants" : "want"} to connect.`;
    if (rest.length === 0) {
      return { title: approvalTitle(first), body: `On ${target(first)}. ${answer}${also}`, opens: "approvals", keys };
    }
    const from = joinNames(unique(status.approvals.map((approval) => approval.clientName)));
    return {
      title: `${String(status.approvals.length)} agent requests are waiting`,
      body: `From ${from}. ${answer}${also}`,
      opens: "approvals",
      keys,
    };
  }
  const [client, ...others] = status.pendingClients;
  if (client === undefined) return null;
  const deadline = Math.min(client.deadline, ...others.map((other) => other.deadline));
  const names = joinNames(status.pendingClients.map((pending) => pending.name));
  return {
    title: `${names} ${others.length === 0 ? "wants" : "want"} to connect`,
    body: `Allow or block ${others.length === 0 ? "it" : "them"} in ${APP_NAME} within ${secondsLeft(deadline, now)}.`,
    opens: "clients",
    keys,
  };
}

function approvalTitle(approval: McpApprovalView): string {
  if (approval.subject === "key") return `${approval.clientName} wants to read a key`;
  if (approval.kind === "read") return `${approval.clientName} wants to read data`;
  return `${approval.clientName} wants to change data`;
}

function target(approval: McpApprovalView): string {
  if (approval.subject === "key" && approval.database !== null) {
    return `${approval.datasourceName} (db ${String(approval.database)})`;
  }
  return approval.datasourceName;
}

function secondsLeft(deadline: number, now: number): string {
  return `${String(Math.max(0, Math.ceil((deadline - now) / SECOND_MS)))} s`;
}

function unique(names: readonly string[]): readonly string[] {
  return [...new Set(names)];
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`;
}
