import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  RpcError,
  idOf,
  parseMessage,
  rpcError,
  rpcResult,
  type JsonObject,
} from "@table-craft/desktop/mcp/jsonrpc.js";
import { TOOL_DEFINITIONS, isToolName, type Tools } from "@table-craft/desktop/mcp/tools.js";
import { APPROVAL_REFUSALS } from "@table-craft/desktop/mcp/approvals.js";
import { approvalWait } from "@table-craft/desktop/mcp/toolKit.js";
import { getPrompt, listPrompts, RESOURCE_TEMPLATES } from "@table-craft/desktop/mcp/resources.js";
import type { McpActivityView, McpCallView, McpClientView } from "@table-craft/desktop/settings/mcp.js";

/** Newest first; an older client gets its own version back when it is listed here. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;
export const SERVER_NAME = "TableCraft";
const UNKNOWN_CLIENT = "Unknown client";

const INSTRUCTIONS = [
  "TableCraft serves the databases its user configured. Start with list_datasources; datasources the user did not expose are not listed.",
  "Explore with list_schemas, list_tables and describe_table before writing SQL, and use the datasource's dialect.",
  "run_query takes one statement. Reads return a capped preview; page with fetch_rows. A write waits for the user to approve it in TableCraft, so say why in `reason`.",
  "For Redis and other key-value datasources use scan_keys and get_key; run_query takes one command there.",
  "To hand a statement to the user instead of running it, use open_in_console.",
].join(" ");

export const HTTP_OK = 200;
export const HTTP_ACCEPTED = 202;
export const HTTP_BAD_REQUEST = 400;
export const HTTP_NOT_FOUND = 404;

export interface McpReply {
  readonly status: number;
  readonly body?: unknown;
  /** Set on the answer to `initialize`, for the `Mcp-Session-Id` header. */
  readonly sessionId?: string;
}

export interface McpServer {
  handle(sessionId: string | null, body: string): Promise<McpReply>;
  /** Ends a session, as a client's DELETE or the user's Disconnect does; false when it was unknown. */
  end(sessionId: string): boolean;
  clients(): readonly McpClientView[];
}

/** The `resources/*` methods, over the same catalog the tools read. */
export interface McpResources {
  list(): unknown;
  read(uri: string): Promise<unknown>;
}

export interface McpServerOptions {
  readonly tools: Tools;
  readonly resources: McpResources;
  /** Null when the client may call; otherwise why not, for the agent to read (decision 127). */
  readonly admit: (name: string, version: string) => Promise<string | null>;
  /** Every finished tool call, for Agent Activity. */
  readonly onCall: (entry: Omit<McpActivityView, "id">) => void;
  readonly serverVersion: string;
  readonly paused: () => boolean;
  readonly now: () => number;
  readonly newSessionId: () => string;
  /** A client connected, called or left; the status changed. */
  readonly onChange: () => void;
  readonly onEnded: (sessionId: string) => void;
}

interface Session {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly connectedAt: number;
  lastCall: McpCallView | null;
}

function text(params: JsonObject, key: string): string | null {
  const value = params[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function negotiatedVersion(requested: string | null): string {
  const supported: readonly string[] = SUPPORTED_PROTOCOL_VERSIONS;
  return requested !== null && supported.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const sessions = new Map<string, Session>();

  function initialize(params: JsonObject): { readonly session: Session; readonly result: unknown } {
    const info = (params.clientInfo ?? {}) as JsonObject;
    const session: Session = {
      id: options.newSessionId(),
      name: text(info, "title") ?? text(info, "name") ?? UNKNOWN_CLIENT,
      version: text(info, "version") ?? "",
      connectedAt: options.now(),
      lastCall: null,
    };
    sessions.set(session.id, session);
    options.onChange();
    const result = {
      protocolVersion: negotiatedVersion(text(params, "protocolVersion")),
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false, subscribe: false },
        prompts: { listChanged: false },
      },
      serverInfo: { name: SERVER_NAME, version: options.serverVersion },
      instructions: INSTRUCTIONS,
    };
    return { session, result };
  }

  function finished(session: Session, entry: Omit<McpActivityView, "id" | "clientId" | "clientName">): void {
    session.lastCall = {
      tool: entry.tool,
      datasourceId: entry.datasourceId,
      at: entry.at,
      durationMs: entry.durationMs,
      approvalWaitMs: entry.approvalWaitMs,
      outcome: entry.outcome,
    };
    options.onCall({ ...entry, clientId: session.id, clientName: session.name });
  }

  function refusal(text: string): unknown {
    return { content: [{ type: "text", text }], isError: true };
  }

  async function callTool(session: Session, params: JsonObject): Promise<unknown> {
    const name = text(params, "name");
    if (name === null || !isToolName(name)) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${name ?? "(none)"}.`);
    const started = options.now();
    const refused = (message: string): unknown => {
      finished(session, {
        tool: name,
        datasourceId: null,
        at: started,
        durationMs: options.now() - started,
        approvalWaitMs: 0,
        outcome: "refused",
        target: null,
        rowCount: null,
        message,
      });
      return refusal(message);
    };
    if (options.paused()) return refused(APPROVAL_REFUSALS.paused);
    const blocked = await options.admit(session.name, session.version);
    if (blocked !== null) return refused(blocked);
    const waits = approvalWait();
    const answer = await options.tools.call(name, params.arguments ?? {}, {
      sessionId: session.id,
      clientName: session.name,
      waits,
    });
    finished(session, {
      tool: name,
      datasourceId: answer.datasourceId,
      at: started,
      durationMs: Math.max(0, options.now() - started - waits.ms()),
      approvalWaitMs: waits.ms(),
      outcome: answer.outcome,
      target: answer.target,
      rowCount: answer.rowCount,
      message: answer.message,
    });
    return answer.result;
  }

  async function readResource(session: Session, params: JsonObject): Promise<unknown> {
    const uri = text(params, "uri");
    if (uri === null) throw new RpcError(INVALID_PARAMS, "resources/read needs a uri.");
    if (options.paused()) throw new RpcError(INVALID_REQUEST, APPROVAL_REFUSALS.paused);
    const blocked = await options.admit(session.name, session.version);
    if (blocked !== null) throw new RpcError(INVALID_REQUEST, blocked);
    return options.resources.read(uri);
  }

  async function dispatch(session: Session, method: string, params: JsonObject): Promise<unknown> {
    switch (method) {
      case "ping":
        return {};
      case "tools/list":
        return { tools: TOOL_DEFINITIONS };
      case "tools/call":
        return callTool(session, params);
      case "resources/list":
        return options.resources.list();
      case "resources/templates/list":
        return { resourceTemplates: RESOURCE_TEMPLATES };
      case "resources/read":
        return readResource(session, params);
      case "prompts/list":
        return listPrompts();
      case "prompts/get":
        return getPrompt(text(params, "name") ?? "", (params.arguments ?? {}) as JsonObject);
      default:
        throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}.`);
    }
  }

  return {
    async handle(sessionId, body) {
      let message;
      try {
        message = parseMessage(body);
      } catch (cause) {
        if (!(cause instanceof RpcError)) throw cause;
        return { status: HTTP_BAD_REQUEST, body: rpcError(idOf(body), cause.code, cause.message) };
      }
      if (message.kind === "request" && message.method === "initialize") {
        const { session, result } = initialize(message.params);
        return { status: HTTP_OK, body: rpcResult(message.id, result), sessionId: session.id };
      }
      const id = message.kind === "request" ? message.id : null;
      if (sessionId === null) {
        return {
          status: HTTP_BAD_REQUEST,
          body: rpcError(id, INVALID_REQUEST, "Missing Mcp-Session-Id; initialize first."),
        };
      }
      const session = sessions.get(sessionId);
      if (session === undefined) {
        return { status: HTTP_NOT_FOUND, body: rpcError(id, INVALID_REQUEST, "Unknown session; initialize again.") };
      }
      if (message.kind !== "request") return { status: HTTP_ACCEPTED };
      try {
        return {
          status: HTTP_OK,
          body: rpcResult(message.id, await dispatch(session, message.method, message.params)),
        };
      } catch (cause) {
        if (cause instanceof RpcError)
          return { status: HTTP_OK, body: rpcError(message.id, cause.code, cause.message) };
        const reason = cause instanceof Error ? cause.message : String(cause);
        return { status: HTTP_OK, body: rpcError(message.id, INTERNAL_ERROR, reason) };
      }
    },
    end(sessionId) {
      if (!sessions.delete(sessionId)) return false;
      options.onEnded(sessionId);
      options.onChange();
      return true;
    },
    clients: () =>
      [...sessions.values()].map((session) => ({
        id: session.id,
        name: session.name,
        version: session.version,
        connectedAt: session.connectedAt,
        lastCall: session.lastCall,
      })),
  };
}
