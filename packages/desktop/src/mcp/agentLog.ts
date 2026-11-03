import type { LogFields, Logger } from "@table-craft/desktop/log/record.js";
import type { ApprovalOutcome, ApprovalRequest } from "@table-craft/desktop/mcp/approvals.js";
import { AGENT_LOG_SCOPE, type McpActivityView } from "@table-craft/desktop/settings/mcp.js";

export const AGENT_CONNECTED = "agent connected";
export const AGENT_CALL = "agent call";
export const APPROVAL_ASKED = "approval asked";
export const APPROVAL_ANSWERED = "approval answered";
export const AGENT_DISCONNECTED = "agent disconnected";

/** Who ended a session: the client's DELETE, or the user's Disconnect. */
export type AgentLeave = "client" | "user";

export interface AgentSession {
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

export interface AgentLog {
  connected(session: AgentSession): void;
  call(entry: Omit<McpActivityView, "id">): void;
  asked(id: string, request: ApprovalRequest): void;
  /** `id` is null when the request was refused without asking, as when agents are paused. */
  answered(request: ApprovalRequest, outcome: ApprovalOutcome, waitedMs: number, id: string | null): void;
  disconnected(session: AgentSession, by: AgentLeave): void;
}

/** Leaves out null, undefined and empty values so a row reads short. */
function present(fields: Readonly<Record<string, unknown>>): LogFields {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== null && value !== undefined && value !== ""),
  );
}

function client(id: string, name: string): LogFields {
  return { clientId: id, clientName: name };
}

export function createAgentLog(log: Logger): AgentLog {
  const agent = log.child(AGENT_LOG_SCOPE);
  return {
    connected(session) {
      agent.info(AGENT_CONNECTED, present({ ...client(session.id, session.name), clientVersion: session.version }));
    },
    call(entry) {
      const fields = present({
        ...client(entry.clientId, entry.clientName),
        tool: entry.tool,
        datasourceId: entry.datasourceId,
        outcome: entry.outcome,
        durationMs: entry.durationMs,
        approvalWaitMs: entry.approvalWaitMs === 0 ? null : entry.approvalWaitMs,
        rowCount: entry.rowCount,
        target: entry.target,
        message: entry.message,
      });
      if (entry.outcome === "error") agent.warn(AGENT_CALL, fields);
      else agent.info(AGENT_CALL, fields);
    },
    asked(id, request) {
      agent.info(
        APPROVAL_ASKED,
        present({
          approvalId: id,
          ...client(request.sessionId, request.clientName),
          datasourceId: request.datasourceId,
          kind: request.kind,
          subject: request.subject,
          database: request.database,
          destructive: request.destructive,
          target: request.sql,
          reason: request.reason,
        }),
      );
    },
    answered(request, outcome, waitedMs, id) {
      agent.info(
        APPROVAL_ANSWERED,
        present({
          approvalId: id,
          ...client(request.sessionId, request.clientName),
          datasourceId: request.datasourceId,
          outcome,
          waitedMs,
        }),
      );
    },
    disconnected(session, by) {
      agent.info(AGENT_DISCONNECTED, { ...client(session.id, session.name), by });
    },
  };
}
