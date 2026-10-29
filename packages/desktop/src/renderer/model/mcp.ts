import type {
  McpActivityView,
  McpCallOutcome,
  McpRunView,
  McpServerState,
  McpStatus,
} from "@table-craft/desktop/settings/mcp.js";

export const MCP_STATE_DOT: Readonly<Record<McpServerState, string>> = {
  stopped: "border border-ink-muted",
  running: "bg-success",
  failed: "bg-danger",
};

/** `waiting` is the amber a write approval or a new client turns the chip (decision 127); paused shares it. */
export type McpChipTone = "off" | "running" | "waiting" | "failed";

export interface McpChipView {
  readonly tone: McpChipTone;
  readonly label: string;
  readonly tooltip: string;
}

function clients(count: number): string {
  return count === 1 ? "1 client" : `${String(count)} clients`;
}

export function mcpStatusText(status: McpStatus): string {
  switch (status.state) {
    case "stopped":
      return "Off";
    case "failed":
      return "Could not start";
    case "running": {
      const connected =
        status.clients.length === 0 ? "no clients connected" : `${clients(status.clients.length)} connected`;
      return `${status.paused ? "Paused" : "Running"} · ${connected}`;
    }
  }
}

export function mcpChip(status: McpStatus): McpChipView {
  const waiting = status.approvals.length;
  if (status.state === "stopped") return { tone: "off", label: "MCP", tooltip: "MCP server off. Click for options." };
  if (status.state === "failed") {
    return { tone: "failed", label: "MCP", tooltip: status.message ?? "The MCP server could not start." };
  }
  if (waiting > 0) {
    const what = waiting === 1 ? "An agent wants" : `${String(waiting)} agent requests want`;
    return {
      tone: "waiting",
      label: `MCP · ${String(waiting)} waiting`,
      tooltip: `${what} to change data. Click to answer.`,
    };
  }
  const asking = status.pendingClients.length;
  if (asking > 0) {
    const [first] = status.pendingClients;
    const who = asking === 1 && first !== undefined ? first.name : `${String(asking)} clients`;
    return {
      tone: "waiting",
      label: `MCP · ${who} asks`,
      tooltip: `${who} wants to connect. Click to allow or block.`,
    };
  }
  const count = status.clients.length;
  const label = count === 0 ? "MCP" : `MCP ${String(count)}`;
  if (status.paused) return { tone: "waiting", label, tooltip: "Agents are paused: every tool call is refused." };
  return { tone: "running", label, tooltip: `MCP server running on port ${String(status.port)} · ${clients(count)}` };
}

export const CALL_OUTCOME_LABELS: Readonly<Record<McpCallOutcome, string>> = {
  ok: "ok",
  capped: "capped",
  error: "failed",
  denied: "denied",
  refused: "refused",
  handedOff: "handed to you",
};

/** Outcome badges: refusals and denials read as warnings, failures as errors. */
export const CALL_OUTCOME_TONES: Readonly<Record<McpCallOutcome, "success" | "warning" | "danger" | "muted">> = {
  ok: "success",
  capped: "muted",
  error: "danger",
  denied: "warning",
  refused: "warning",
  handedOff: "muted",
};

export interface ActivityFilter {
  /** Null shows every client. */
  readonly client: string | null;
  readonly outcome: McpCallOutcome | null;
}

export const ALL_ACTIVITY: ActivityFilter = { client: null, outcome: null };

export function filteredActivity(
  entries: readonly McpActivityView[],
  filter: ActivityFilter,
): readonly McpActivityView[] {
  return entries.filter(
    (entry) =>
      (filter.client === null || entry.clientName === filter.client) &&
      (filter.outcome === null || entry.outcome === filter.outcome),
  );
}

/** The client names the activity names, in first-seen order: the client filter's options. */
export function activityClients(entries: readonly McpActivityView[]): readonly string[] {
  return [...new Set(entries.map((entry) => entry.clientName))];
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** `just now`, `12 min`, `3 h 5 min`: how long a client has been connected. */
export function connectedFor(since: number, now: number): string {
  const elapsed = Math.max(0, now - since);
  if (elapsed < MINUTE_MS) return "just now";
  const hours = Math.floor(elapsed / HOUR_MS);
  const minutes = Math.floor((elapsed % HOUR_MS) / MINUTE_MS);
  if (hours === 0) return `${String(minutes)} min`;
  return minutes === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(minutes)} min`;
}

export interface AgentDatasourceGroup {
  readonly datasourceId: string;
  readonly runs: readonly McpRunView[];
}

export interface AgentClientGroup {
  readonly clientId: string;
  readonly clientName: string;
  readonly datasources: readonly AgentDatasourceGroup[];
}

/** The Services tree's Agents node: client, then datasource, then each running call. */
export function agentGroups(status: McpStatus): readonly AgentClientGroup[] {
  type Grouped = { readonly name: string; readonly byDatasource: Map<string, McpRunView[]> };
  const grouped = (name: string): Grouped => ({ name, byDatasource: new Map<string, McpRunView[]>() });
  const clients = new Map<string, Grouped>();
  for (const client of status.clients) clients.set(client.id, grouped(client.name));
  for (const run of status.running) {
    const client = clients.get(run.clientId) ?? grouped(run.clientName);
    clients.set(run.clientId, client);
    const runs = client.byDatasource.get(run.datasourceId) ?? [];
    client.byDatasource.set(run.datasourceId, [...runs, run]);
  }
  return [...clients].map(([clientId, client]) => ({
    clientId,
    clientName: client.name,
    datasources: [...client.byDatasource].map(([datasourceId, runs]) => ({ datasourceId, runs })),
  }));
}

const SECOND_MS = 1000;
const MINUTE_S = 60;

/** `0:42`: what an approval has left before it is denied. */
export function countdown(deadline: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((deadline - now) / SECOND_MS));
  return `${String(Math.floor(seconds / MINUTE_S))}:${String(seconds % MINUTE_S).padStart(2, "0")}`;
}
