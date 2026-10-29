import type { ExecutionOutcome } from "@table-craft/desktop/renderer/state/executions.js";
import type {
  McpActivityView,
  McpCallOutcome,
  McpConsoleRequest,
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

/** Finished calls kept under one client's datasource in Services, as a console session keeps its executions. */
export const AGENT_CALLS_PER_DATASOURCE = 50;

/** How a finished call reads beside console executions: a refusal, denial or hand-off did not run. */
export const CALL_EXECUTION_OUTCOMES: Readonly<Record<McpCallOutcome, Exclude<ExecutionOutcome, "running">>> = {
  ok: "success",
  capped: "success",
  error: "error",
  denied: "cancelled",
  refused: "cancelled",
  handedOff: "cancelled",
};

const SQL_TOOLS: ReadonlySet<string> = new Set(["run_query", "explain", "check_sql", "open_in_console"]);

/** The console a finished call opens, when it carried a statement for a datasource. */
export function activityConsoleRequest(entry: McpActivityView): McpConsoleRequest | null {
  if (entry.datasourceId === null || entry.target === null || !SQL_TOOLS.has(entry.tool)) return null;
  return { datasourceId: entry.datasourceId, sql: entry.target };
}

export interface AgentDatasourceGroup {
  readonly datasourceId: string;
  readonly runs: readonly McpRunView[];
  /** Newest first. */
  readonly calls: readonly McpActivityView[];
}

export interface AgentClientGroup {
  readonly clientName: string;
  /** False once every session of this client has ended; its calls stay listed. */
  readonly connected: boolean;
  readonly datasources: readonly AgentDatasourceGroup[];
}

interface MutableDatasourceGroup {
  readonly runs: McpRunView[];
  readonly calls: McpActivityView[];
}

/**
 * The Services tree's Agents node: client, then datasource, then its running calls and the finished
 * ones the server still remembers. Clients group by name, so a client that reconnects keeps its calls.
 */
export function agentGroups(status: McpStatus): readonly AgentClientGroup[] {
  const clients = new Map<string, { connected: boolean; byDatasource: Map<string, MutableDatasourceGroup> }>();
  const clientNamed = (name: string) => {
    const client = clients.get(name) ?? { connected: false, byDatasource: new Map<string, MutableDatasourceGroup>() };
    clients.set(name, client);
    return client;
  };
  const datasourceOf = (name: string, datasourceId: string): MutableDatasourceGroup => {
    const { byDatasource } = clientNamed(name);
    const group = byDatasource.get(datasourceId) ?? { runs: [], calls: [] };
    byDatasource.set(datasourceId, group);
    return group;
  };
  for (const client of status.clients) clientNamed(client.name).connected = true;
  for (const run of status.running) datasourceOf(run.clientName, run.datasourceId).runs.push(run);
  for (const entry of status.activity) {
    if (entry.datasourceId === null) continue;
    const { calls } = datasourceOf(entry.clientName, entry.datasourceId);
    if (calls.length < AGENT_CALLS_PER_DATASOURCE) calls.push(entry);
  }
  return [...clients].map(([clientName, client]) => ({
    clientName,
    connected: client.connected,
    datasources: [...client.byDatasource].map(([datasourceId, group]) => ({ datasourceId, ...group })),
  }));
}

const SECOND_MS = 1000;
const MINUTE_S = 60;

/** `0:42`: what an approval has left before it is denied. */
export function countdown(deadline: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((deadline - now) / SECOND_MS));
  return `${String(Math.floor(seconds / MINUTE_S))}:${String(seconds % MINUTE_S).padStart(2, "0")}`;
}
