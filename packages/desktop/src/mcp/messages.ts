import type { ServerSeen } from "@table-craft/desktop/engine/protocol.js";
import type { LogRecord } from "@table-craft/desktop/log/record.js";
import type {
  AgentAccess,
  McpActiveConsole,
  McpConsoleRequest,
  McpKnownClient,
  McpStatus,
  McpUserControl,
} from "@table-craft/desktop/settings/mcp.js";

/** Main → MCP host, first: what to serve and with which token. */
export const MCP_BOOT_MESSAGE = "mcp.boot";
/** Main → MCP host: the datasources and their effective access, after any change. */
export const MCP_DATASOURCES_MESSAGE = "mcp.datasources";
/** Main → MCP host: a setting the host reads changed. */
export const MCP_CONFIG_MESSAGE = "mcp.config";
/** MCP host → main: open an engine port for a datasource. */
export const MCP_ENGINE_REQUEST_MESSAGE = "mcp.engineRequest";
/** Main → MCP host: the port, transferred with this message. */
export const MCP_ENGINE_PORT_MESSAGE = "mcp.enginePort";
/** Main → MCP host: how the request ended; a connected one's port arrived just before. */
export const MCP_ENGINE_ANSWER_MESSAGE = "mcp.engineAnswer";
/** MCP host → main: the status windows draw. */
export const MCP_STATUS_MESSAGE = "mcp.status";
/** Main → MCP host: the user's control: an approval answer, pause, a disconnect, whether a window is open. */
export const MCP_CONTROL_MESSAGE = "mcp.control";
/** MCP host → main: one agent statement for the query history. */
export const MCP_HISTORY_MESSAGE = "mcp.history";
/** MCP host → main: open a console with this text in the focused window (`open_in_console`). */
export const MCP_OPEN_CONSOLE_MESSAGE = "mcp.openConsole";
/** MCP host → main: ask the focused window for its console (`get_active_context`). */
export const MCP_CONTEXT_REQUEST_MESSAGE = "mcp.contextRequest";
/** Main → MCP host: the window's answer, null when no console is focused or no window is open. */
export const MCP_CONTEXT_ANSWER_MESSAGE = "mcp.contextAnswer";
/** MCP host → main: what a server said of itself when an agent session opened (decision 131). */
export const MCP_SERVER_SEEN_MESSAGE = "mcp.server-seen";
export const MCP_LOG_MESSAGE = "mcp.log";
export const MCP_SHUTDOWN_MESSAGE = "mcp.shutdown";

/** A datasource as the MCP host sees it: no config, no secrets (decision 020). */
export interface AgentDatasource {
  readonly id: string;
  readonly name: string;
  readonly pluginId: string;
  readonly comment: string | null;
  /** Already capped by the datasource's read-only flag. */
  readonly access: AgentAccess;
  /**
   * The top-level namespaces the catalog tools show: the datasource's agent schemas, else what
   * Manage Shown Schemas keeps (decision 117); absent when every one is shown.
   */
  readonly schemas?: readonly string[];
  /** This datasource's row limit; absent, `McpConfig.rowCap`. */
  readonly rowCap?: number;
  /** This datasource's statement timeout in seconds; absent, `McpConfig.timeoutSeconds`. */
  readonly timeoutSeconds?: number;
}

export interface McpConfig {
  readonly rowCap: number;
  readonly timeoutSeconds: number;
  readonly clients: readonly McpKnownClient[];
}

export interface McpBoot extends McpConfig {
  readonly kind: typeof MCP_BOOT_MESSAGE;
  readonly port: number;
  readonly token: string;
  readonly serverVersion: string;
  readonly datasources: readonly AgentDatasource[];
  readonly windows: boolean;
}

export type McpControl = McpUserControl | { readonly action: "windows"; readonly open: boolean };

/** One agent statement as the history keeps it; main adds `source: "agent"`. */
export interface AgentHistoryEntry {
  readonly datasourceId: string;
  readonly sql: string;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly outcome: "success" | "error" | "cancelled";
  readonly rowCount: number | null;
  readonly message: string | null;
  /** The name the agent's client gave at `initialize`. */
  readonly client: string;
}

export type EngineAnswer =
  | { readonly status: "connected" }
  | { readonly status: "failed"; readonly message: string; readonly hint: string | null };

export type MainToMcp =
  | McpBoot
  | { readonly kind: typeof MCP_DATASOURCES_MESSAGE; readonly datasources: readonly AgentDatasource[] }
  | ({ readonly kind: typeof MCP_CONFIG_MESSAGE } & McpConfig)
  | { readonly kind: typeof MCP_ENGINE_PORT_MESSAGE; readonly requestId: number }
  | { readonly kind: typeof MCP_ENGINE_ANSWER_MESSAGE; readonly requestId: number; readonly answer: EngineAnswer }
  | ({ readonly kind: typeof MCP_CONTROL_MESSAGE } & McpControl)
  | {
      readonly kind: typeof MCP_CONTEXT_ANSWER_MESSAGE;
      readonly requestId: number;
      readonly context: McpActiveConsole | null;
    }
  | { readonly kind: typeof MCP_SHUTDOWN_MESSAGE };

export type McpToMain =
  | { readonly kind: typeof MCP_ENGINE_REQUEST_MESSAGE; readonly requestId: number; readonly datasourceId: string }
  | { readonly kind: typeof MCP_STATUS_MESSAGE; readonly status: McpStatus }
  | { readonly kind: typeof MCP_HISTORY_MESSAGE; readonly entry: AgentHistoryEntry }
  | ({ readonly kind: typeof MCP_SERVER_SEEN_MESSAGE; readonly datasourceId: string } & ServerSeen)
  | ({ readonly kind: typeof MCP_OPEN_CONSOLE_MESSAGE } & McpConsoleRequest)
  | { readonly kind: typeof MCP_CONTEXT_REQUEST_MESSAGE; readonly requestId: number }
  | { readonly kind: typeof MCP_LOG_MESSAGE; readonly record: LogRecord };
