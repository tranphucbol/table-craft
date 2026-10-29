/** What an agent may do on one datasource over MCP (plan 117); absent in `datasources.json` is `off`. */
export const AGENT_ACCESS_LEVELS = ["off", "read", "ask"] as const;
export type AgentAccess = (typeof AGENT_ACCESS_LEVELS)[number];

export const AGENT_ACCESS_LABELS: Readonly<Record<AgentAccess, string>> = {
  off: "Off",
  read: "Read only",
  ask: "Ask before writes",
};

/**
 * The colour that marks production (decision 127): Settings › MCP Server never raises such a
 * datasource past Read only; only its own Data Sources page can.
 */
export const PRODUCTION_COLOR = "red";

/** A datasource's own limits for agents; null in a field clears it to the default (decision 127). */
export interface AgentPolicy {
  /** Top-level namespaces agents see; null: the ones the Database pane shows. */
  readonly schemas: readonly string[] | null;
  /** Rows per answer; null: Settings › MCP Server's row limit. */
  readonly rowCap: number | null;
  /** Seconds a statement may run; null: Settings › MCP Server's statement timeout. */
  readonly timeoutSeconds: number | null;
}

/** The server binds the loopback address only; another machine never reaches it. */
export const MCP_HOST = "127.0.0.1";
export const MCP_PATH = "/mcp";
/** The name the client configs give the server. */
export const MCP_SERVER_NAME = "tablecraft";
/** What a drawn snippet shows instead of the token; Copy puts the real one in. */
export const MCP_TOKEN_PLACEHOLDER = "${TABLECRAFT_TOKEN}";

export const MCP_CLIENTS = ["claudeCode", "openCode", "cursor"] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

export const MCP_CLIENT_LABELS: Readonly<Record<McpClient, string>> = {
  claudeCode: "Claude Code",
  openCode: "OpenCode",
  cursor: "Cursor",
};

/** Where each client keeps the snippet, said under it. */
export const MCP_CLIENT_HINTS: Readonly<Record<McpClient, string>> = {
  claudeCode: "Run in a terminal.",
  openCode: "Merge into opencode.json.",
  cursor: "Merge into ~/.cursor/mcp.json.",
};

const JSON_INDENT = 2;

export function mcpEndpoint(port: number): string {
  return `http://${MCP_HOST}:${String(port)}${MCP_PATH}`;
}

/** A datasource marked read-only never takes writes, whatever its agent access says. */
export function effectiveAccess(datasource: {
  readonly agentAccess?: AgentAccess | undefined;
  readonly readOnly: boolean;
}): AgentAccess {
  const access = datasource.agentAccess ?? "off";
  return access === "ask" && datasource.readOnly ? "read" : access;
}

/** The config a client needs, with `token` in the header; the placeholder unless Copy asked for the real one. */
export function mcpClientConfig(client: McpClient, port: number, token: string = MCP_TOKEN_PLACEHOLDER): string {
  const url = mcpEndpoint(port);
  const headers = { Authorization: `Bearer ${token}` };
  switch (client) {
    case "claudeCode":
      return `claude mcp add --transport http ${MCP_SERVER_NAME} ${url} --header "Authorization: Bearer ${token}"`;
    case "openCode":
      return JSON.stringify({ mcp: { [MCP_SERVER_NAME]: { type: "remote", url, headers } } }, null, JSON_INDENT);
    case "cursor":
      return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { url, headers } } }, null, JSON_INDENT);
  }
}

export type McpServerState = "stopped" | "running" | "failed";

/** `capped`: rows came back with more left to fetch; `handedOff`: the user took the statement into a console. */
export type McpCallOutcome = "ok" | "capped" | "error" | "denied" | "refused" | "handedOff";

export interface McpCallView {
  readonly tool: string;
  readonly datasourceId: string | null;
  /** Epoch milliseconds. */
  readonly at: number;
  readonly durationMs: number;
  readonly outcome: McpCallOutcome;
}

/** One tool call as Agent Activity lists it. */
export interface McpActivityView extends McpCallView {
  readonly id: number;
  /** The MCP session id of the client that called. */
  readonly clientId: string;
  readonly clientName: string;
  /** What the call was about: the statement, `schema.table`, a key or a schema. */
  readonly target: string | null;
  readonly rowCount: number | null;
  /** Why it failed, was refused or denied. */
  readonly message: string | null;
}

/** An agent statement in flight, which the Services tree can cancel. */
export interface McpRunView {
  readonly id: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly datasourceId: string;
  readonly tool: string;
  readonly sql: string;
  readonly startedAt: number;
  /** False when the datasource's plugin cannot cancel, so the tree offers no Cancel. */
  readonly cancellable: boolean;
}

export interface McpClientView {
  /** The MCP session id. */
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly connectedAt: number;
  readonly lastCall: McpCallView | null;
}

/** A client name the user allowed or blocked (decision 127); kept in `settings.mcp.clients`. */
export interface McpKnownClient {
  readonly name: string;
  readonly allowed: boolean;
}

/** A client whose calls wait until the user allows or blocks its name. */
export interface McpPendingClient {
  readonly name: string;
  readonly version: string;
  /** Epoch milliseconds; unanswered by `deadline`, its calls are refused. */
  readonly since: number;
  readonly deadline: number;
}

/** The statement kinds that can wait for approval; reads never do and transactions are refused. */
export type ApprovalKind = "write" | "ddl" | "other";

export interface McpApprovalView {
  readonly id: string;
  readonly clientName: string;
  readonly datasourceId: string;
  readonly datasourceName: string;
  readonly sql: string;
  readonly kind: ApprovalKind;
  /** Why the console would ask before running it, such as `DELETE without WHERE`. */
  readonly destructive: string | null;
  /** What the agent said it is for; null when it said nothing. */
  readonly reason: string | null;
  /** Epoch milliseconds; unanswered by then, it is denied. */
  readonly deadline: number;
  /** Whether "allow this kind for the rest of the session" is offered: never for DDL or a destructive statement. */
  readonly allowable: boolean;
}

/** `handOff`: the user opens the statement in a console to run it themselves; the agent is told so. */
export const APPROVAL_ANSWERS = ["allowOnce", "allowKind", "deny", "handOff"] as const;
export type ApprovalAnswer = (typeof APPROVAL_ANSWERS)[number];

/** What a window may tell the MCP host. */
export type McpUserControl =
  | { readonly action: "answer"; readonly approvalId: string; readonly answer: ApprovalAnswer }
  | { readonly action: "pause"; readonly paused: boolean }
  | { readonly action: "disconnect"; readonly clientId: string }
  | { readonly action: "cancel"; readonly runId: string };

/** The focused console as `get_active_context` reads it; the host drops it unless its datasource is exposed. */
export interface McpActiveConsole {
  readonly datasourceId: string;
  readonly sql: string;
  readonly selectionFrom: number;
  readonly selectionTo: number;
  readonly namespace: readonly string[] | null;
}

/** What `open_in_console` asks a window to do: a new console with the text, not run. */
export interface McpConsoleRequest {
  readonly datasourceId: string;
  readonly sql: string;
}

/** Main asks the focused window for its console; it answers through `mcp.context-reply`. */
export interface McpContextRequest {
  readonly requestId: number;
}

/** Agent Activity keeps this many calls, newest first. */
export const MCP_ACTIVITY_LIMIT = 200;

export interface McpStatus {
  readonly state: McpServerState;
  readonly port: number;
  /** Why the server is not running, for `failed`. */
  readonly message: string | null;
  readonly paused: boolean;
  readonly clients: readonly McpClientView[];
  readonly approvals: readonly McpApprovalView[];
  readonly pendingClients: readonly McpPendingClient[];
  readonly running: readonly McpRunView[];
  /** Newest first, at most `MCP_ACTIVITY_LIMIT`. */
  readonly activity: readonly McpActivityView[];
  /** The token's last characters, so a user can tell which one a client holds; main adds it (decision 020). */
  readonly tokenHint: string | null;
}

export function stoppedStatus(port: number): McpStatus {
  return {
    state: "stopped",
    port,
    message: null,
    paused: false,
    clients: [],
    approvals: [],
    pendingClients: [],
    running: [],
    activity: [],
    tokenHint: null,
  };
}

const TOKEN_HINT_CHARS = 4;
const TOKEN_MASK = "••••";

/** `tc_••••3f9a`: enough to match a client's config, too little to use. */
export function tokenHint(token: string): string {
  const prefix = token.slice(0, token.indexOf("_") + 1);
  return `${prefix}${TOKEN_MASK}${token.slice(-TOKEN_HINT_CHARS)}`;
}
