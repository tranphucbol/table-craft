import { serverSeenOf } from "@table-craft/desktop/engine/protocol.js";
import type { Logger } from "@table-craft/desktop/log/record.js";
import { createAgentLog } from "@table-craft/desktop/mcp/agentLog.js";
import { createApprovals } from "@table-craft/desktop/mcp/approvals.js";
import { createActivity, createRuns } from "@table-craft/desktop/mcp/activity.js";
import { ADMISSION_REFUSALS, createClientGate } from "@table-craft/desktop/mcp/clients.js";
import { listResources, readResource } from "@table-craft/desktop/mcp/resources.js";
import { createAgentEngines, type EnginePort } from "@table-craft/desktop/mcp/engines.js";
import { listen, type HttpListener } from "@table-craft/desktop/mcp/http.js";
import {
  MCP_BOOT_MESSAGE,
  MCP_CONFIG_MESSAGE,
  MCP_CONTROL_MESSAGE,
  MCP_DATASOURCES_MESSAGE,
  MCP_ENGINE_ANSWER_MESSAGE,
  MCP_ENGINE_PORT_MESSAGE,
  MCP_ENGINE_REQUEST_MESSAGE,
  MCP_HISTORY_MESSAGE,
  MCP_SERVER_SEEN_MESSAGE,
  MCP_SHUTDOWN_MESSAGE,
  MCP_STATUS_MESSAGE,
  MCP_UI_ANSWER_MESSAGE,
  MCP_UI_REQUEST_MESSAGE,
  type AgentDatasource,
  type EngineAnswer,
  type McpBoot,
  type McpControl,
  type MainToMcp,
  type McpToMain,
} from "@table-craft/desktop/mcp/messages.js";
import { createMcpServer, type McpServer } from "@table-craft/desktop/mcp/server.js";
import { createConsoleOwners } from "@table-craft/desktop/mcp/consoleOwners.js";
import { releaseConsoles } from "@table-craft/desktop/mcp/consoleTools.js";
import { ToolFailure, type ToolContext, type UiReply } from "@table-craft/desktop/mcp/toolKit.js";
import { createTools } from "@table-craft/desktop/mcp/tools.js";
import type { McpServerState, McpUiAnswer } from "@table-craft/desktop/settings/mcp.js";

/** How long a window tool waits for the window to answer (decision 161). */
export const UI_TIMEOUT_MS = 5_000;

export interface McpHostOptions {
  readonly send: (message: McpToMain) => void;
  readonly log: Logger;
  readonly newSessionId: () => string;
  readonly now?: () => number;
  /** Tests pass a short wait; the app waits a minute. */
  readonly approvalTimeoutMs?: number;
  readonly clientTimeoutMs?: number;
}

export interface McpHost {
  /** `port` is the engine port transferred with an `MCP_ENGINE_PORT_MESSAGE`. */
  handle(message: MainToMcp, port?: EnginePort): void;
  /** Resolves once the listener is up or has failed; for tests and the shutdown path. */
  ready(): Promise<void>;
  close(): Promise<void>;
}

interface EngineRequest {
  port: EnginePort | null;
  readonly resolve: (port: EnginePort) => void;
  readonly reject: (cause: unknown) => void;
}

export function createMcpHost(options: McpHostOptions): McpHost {
  const now = options.now ?? Date.now;
  let datasources: readonly AgentDatasource[] = [];
  let rowCap = 0;
  let timeoutSeconds = 0;
  let paused = false;
  let state: McpServerState = "stopped";
  let failure: string | null = null;
  let port = 0;
  let listener: HttpListener | null = null;
  let started: Promise<void> = Promise.resolve();
  let nextRequest = 0;
  const requests = new Map<number, EngineRequest>();
  let windows = false;
  let allowFocus = true;
  let nextUiRequest = 0;
  const uiRequests = new Map<number, (window: number | null, answer: McpUiAnswer | null) => void>();
  const owners = createConsoleOwners();

  const agentLog = createAgentLog(options.log);
  const approvals = createApprovals({
    onChange: () => publish(),
    onAsked: (id, request) => agentLog.asked(id, request),
    onSettled: (request, outcome, waitedMs, id) => agentLog.answered(request, outcome, waitedMs, id),
    now,
    ...(options.approvalTimeoutMs === undefined ? {} : { timeoutMs: options.approvalTimeoutMs }),
  });
  const gate = createClientGate({
    onChange: () => publish(),
    now,
    ...(options.clientTimeoutMs === undefined ? {} : { timeoutMs: options.clientTimeoutMs }),
  });
  const activity = createActivity(() => publish());
  const runs = createRuns(() => publish(), now);
  const engines = createAgentEngines(
    (datasourceId) =>
      new Promise<EnginePort>((resolve, reject) => {
        nextRequest += 1;
        requests.set(nextRequest, { port: null, resolve, reject });
        options.send({ kind: MCP_ENGINE_REQUEST_MESSAGE, requestId: nextRequest, datasourceId });
      }),
    (datasourceId, opened) =>
      options.send({ kind: MCP_SERVER_SEEN_MESSAGE, datasourceId, ...serverSeenOf(opened, now()) }),
  );
  const context: ToolContext = {
    datasources: () => datasources,
    engines,
    approvals,
    runs,
    windows: {
      ask(target, request) {
        if (!windows) return Promise.resolve<UiReply>({ status: "gone" });
        nextUiRequest += 1;
        const requestId = nextUiRequest;
        return new Promise<UiReply>((resolve) => {
          const timer = setTimeout(() => {
            uiRequests.delete(requestId);
            resolve({ status: "silent" });
          }, UI_TIMEOUT_MS);
          uiRequests.set(requestId, (window, answer) => {
            clearTimeout(timer);
            uiRequests.delete(requestId);
            resolve(window === null || answer === null ? { status: "gone" } : { status: "answered", window, answer });
          });
          options.send({ kind: MCP_UI_REQUEST_MESSAGE, requestId, target, request });
        });
      },
    },
    owners,
    allowFocus: () => allowFocus,
    record: (entry) => options.send({ kind: MCP_HISTORY_MESSAGE, entry }),
    rowCap: () => rowCap,
    timeoutSeconds: () => timeoutSeconds,
    now,
  };
  const tools = createTools(context);
  let server: McpServer | null = null;

  function publish(): void {
    options.send({
      kind: MCP_STATUS_MESSAGE,
      status: {
        state,
        port,
        message: failure,
        paused,
        clients: server?.clients() ?? [],
        approvals: approvals.pending(),
        pendingClients: gate.pending(),
        running: runs.list(),
        activity: activity.list(),
        tokenHint: null,
      },
    });
  }

  function answered(requestId: number, answer: EngineAnswer): void {
    const request = requests.get(requestId);
    if (request === undefined) return;
    requests.delete(requestId);
    if (answer.status === "connected" && request.port !== null) {
      request.resolve(request.port);
      return;
    }
    request.port?.close();
    const reason =
      answer.status === "failed" ? `${answer.message}${answer.hint === null ? "" : ` ${answer.hint}`}` : "";
    request.reject(new ToolFailure(`TableCraft could not connect to the datasource. ${reason}`.trim()));
  }

  function setDatasources(next: readonly AgentDatasource[]): void {
    const access = new Map(next.map((datasource) => [datasource.id, datasource.access]));
    for (const previous of datasources) {
      if ((access.get(previous.id) ?? "off") === "off") engines.drop(previous.id);
    }
    datasources = next;
  }

  function control(message: McpControl): void {
    switch (message.action) {
      case "answer":
        approvals.answer(message.approvalId, message.answer);
        return;
      case "pause":
        paused = message.paused;
        approvals.setPaused(message.paused);
        publish();
        return;
      case "disconnect":
        server?.end(message.clientId, "user");
        return;
      case "cancel":
        void runs.cancel(message.runId).catch((cause: unknown) => options.log.warn("cancel failed", { err: cause }));
        return;
      case "open": {
        const call = activity.list().find((entry) => entry.id === message.callId);
        const sql = activity.fullTarget(message.callId);
        const datasourceId = call?.datasourceId ?? null;
        if (datasourceId !== null && sql !== null)
          void context.windows.ask("focused", {
            kind: "open",
            handle: null,
            client: null,
            datasourceId,
            sql,
            schema: null,
            title: null,
            focus: false,
          });
        return;
      }
      case "windows":
        windows = message.open;
        approvals.setWindows(message.open);
        gate.setWindows(message.open);
        return;
    }
  }

  async function boot(message: McpBoot): Promise<void> {
    rowCap = message.rowCap;
    timeoutSeconds = message.timeoutSeconds;
    allowFocus = message.allowFocus;
    port = message.port;
    setDatasources(message.datasources);
    windows = message.windows;
    approvals.setWindows(message.windows);
    gate.setWindows(message.windows);
    gate.setKnown(message.clients);
    const mcp = createMcpServer({
      tools,
      resources: { list: () => listResources(context), read: (uri) => readResource(context, uri) },
      admit: async (name, version) => {
        const admission = await gate.admit(name, version);
        return admission === "allowed" ? null : ADMISSION_REFUSALS[admission](name);
      },
      onCall: (entry) => {
        activity.add(entry);
        agentLog.call(entry);
      },
      onStarted: (session) => agentLog.connected(session),
      serverVersion: message.serverVersion,
      paused: () => paused,
      now,
      newSessionId: options.newSessionId,
      onChange: () => publish(),
      onEnded: (session, by) => {
        approvals.forgetSession(session.id);
        releaseConsoles(context, owners.endSession(session.id));
        agentLog.disconnected(session, by);
      },
    });
    server = mcp;
    try {
      listener = await listen({
        port: message.port,
        token: message.token,
        server: mcp,
        onError: (cause) => options.log.error("request failed", { err: cause }),
      });
      port = listener.port;
      state = "running";
      options.log.info("listening", { port });
    } catch (cause) {
      state = "failed";
      failure = cause instanceof Error ? cause.message : String(cause);
      options.log.warn("not listening", { port: message.port, err: cause });
    }
    publish();
  }

  return {
    handle(message, enginePort) {
      switch (message.kind) {
        case MCP_BOOT_MESSAGE:
          started = boot(message);
          return;
        case MCP_DATASOURCES_MESSAGE:
          setDatasources(message.datasources);
          return;
        case MCP_CONFIG_MESSAGE:
          rowCap = message.rowCap;
          timeoutSeconds = message.timeoutSeconds;
          allowFocus = message.allowFocus;
          gate.setKnown(message.clients);
          return;
        case MCP_UI_ANSWER_MESSAGE:
          uiRequests.get(message.requestId)?.(message.window, message.answer);
          return;
        case MCP_ENGINE_PORT_MESSAGE: {
          const request = requests.get(message.requestId);
          if (request === undefined || enginePort === undefined) enginePort?.close();
          else request.port = enginePort;
          return;
        }
        case MCP_ENGINE_ANSWER_MESSAGE:
          answered(message.requestId, message.answer);
          return;
        case MCP_CONTROL_MESSAGE:
          control(message);
          return;
        case MCP_SHUTDOWN_MESSAGE:
          void this.close();
          return;
      }
    },
    ready: () => started,
    async close() {
      await started;
      approvals.setWindows(false);
      gate.setWindows(false);
      releaseConsoles(context, owners.clear());
      for (const answer of [...uiRequests.values()]) answer(null, null);
      engines.closeAll();
      await listener?.close();
      listener = null;
    },
  };
}
