/**
 * The MCP host's supervisor (decision 126). Main starts and stops the fourth process, hands it the
 * token, the datasources and engine ports, and relays its status to the windows; it never reads a
 * tool call, so main stays out of the request path (decision 002).
 */
import { randomBytes } from "node:crypto";
import type { QueryHistory } from "@table-craft/core";
import type { SecretStore } from "@table-craft/desktop/main/secrets.js";
import {
  MCP_BOOT_MESSAGE,
  MCP_CONFIG_MESSAGE,
  MCP_CONTEXT_ANSWER_MESSAGE,
  MCP_CONTEXT_REQUEST_MESSAGE,
  MCP_CONTROL_MESSAGE,
  MCP_DATASOURCES_MESSAGE,
  MCP_ENGINE_ANSWER_MESSAGE,
  MCP_ENGINE_PORT_MESSAGE,
  MCP_ENGINE_REQUEST_MESSAGE,
  MCP_HISTORY_MESSAGE,
  MCP_LOG_MESSAGE,
  MCP_OPEN_CONSOLE_MESSAGE,
  MCP_SHUTDOWN_MESSAGE,
  MCP_STATUS_MESSAGE,
  type AgentDatasource,
  type EngineAnswer,
  type MainToMcp,
  type McpToMain,
} from "@table-craft/desktop/mcp/messages.js";
import type { ConnectResult, DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import {
  effectiveAccess,
  mcpClientConfig,
  stoppedStatus,
  tokenHint,
  type McpActiveConsole,
  type McpClient,
  type McpConsoleRequest,
  type McpStatus,
  type McpUserControl,
} from "@table-craft/desktop/settings/mcp.js";
import type { McpSettings } from "@table-craft/desktop/settings/settings.js";
import type { Logger } from "@table-craft/desktop/log/record.js";

/** The secret store's owner for the token: no datasource id can be this (they are UUIDs). */
export const MCP_SECRET_OWNER = "table-craft.mcp";
export const MCP_TOKEN_KEY = "token";
export const MCP_LOG_PROCESS = "mcp";
const TOKEN_PREFIX = "tc_";
const TOKEN_BYTES = 32;
/** How long the host may take to close its listener and ports before it is killed. */
export const MCP_SHUTDOWN_GRACE_MS = 3_000;

/** Handed to the host registry as a port's target, so the engine port goes to the MCP host. */
export interface McpEngineTarget {
  readonly mcpRequest: number;
}

/** A bearer token: 256 random bits, prefixed so a leaked one is recognisable in a scanner. */
export function newMcpToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
}

export function isMcpEngineTarget(target: unknown): target is McpEngineTarget {
  return typeof (target as { mcpRequest?: unknown } | null)?.mcpRequest === "number";
}

/** The slice of Electron's `UtilityProcess` the supervisor uses. */
export interface McpProcess {
  postMessage(message: MainToMcp, transfer?: unknown[]): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
  kill(): boolean;
}

export interface McpSupervisorOptions {
  readonly fork: () => McpProcess;
  readonly settings: () => McpSettings;
  readonly datasources: () => readonly DatasourceView[];
  readonly secrets: SecretStore;
  readonly connect: (datasourceId: string, target: McpEngineTarget) => Promise<ConnectResult>;
  readonly history: Pick<QueryHistory, "record">;
  readonly onStatus: (status: McpStatus) => void;
  /** A record the host posted. */
  readonly forward: (record: unknown, process: string) => void;
  readonly windowsOpen: () => boolean;
  readonly writeClipboard: (text: string) => void;
  /** Shows the text in a new console of the focused window; false when no window is open. */
  readonly openConsole: (request: McpConsoleRequest) => boolean;
  /** Asks the focused window for its console; false when no window is open. */
  readonly askContext: (requestId: number) => boolean;
  readonly newToken: () => string;
  readonly serverVersion: string;
  readonly log: Logger;
  readonly setTimeout?: (run: () => void, ms: number) => unknown;
  readonly clearTimeout?: (timer: unknown) => void;
}

export interface McpSupervisor {
  /** Starts the host when the settings say so; called once at launch. */
  start(): Promise<void>;
  settingsChanged(next: McpSettings): Promise<void>;
  datasourcesChanged(): void;
  windowsChanged(): void;
  /** The other end of a port the host registry opened for `target`. */
  sendPort(target: McpEngineTarget, port: { close(): void }): void;
  status(): McpStatus;
  control(control: McpUserControl): void;
  copyClientConfig(client: McpClient): Promise<void>;
  copyToken(): Promise<void>;
  /** A window's answer to `askContext`. */
  contextReply(requestId: number, context: McpActiveConsole | null): void;
  regenerateToken(): Promise<void>;
  stop(): Promise<void>;
}

interface Running {
  readonly process: McpProcess;
  readonly exited: Promise<void>;
  stopping: boolean;
}

const NEEDS_SECRETS_HINT = "Connect to it once in TableCraft so its password is kept until restart, then ask again.";

/** What agents see of a datasource's namespaces: its own list, else the explorer's (decision 117). */
function schemasOf(datasource: DatasourceView): { readonly schemas?: readonly string[] } {
  const schemas = datasource.agentSchemas ?? datasource.shownNamespaces;
  return schemas === undefined ? {} : { schemas };
}

function isMessage(message: unknown): message is McpToMain {
  return typeof (message as { kind?: unknown } | null)?.kind === "string";
}

export function createMcpSupervisor(options: McpSupervisorOptions): McpSupervisor {
  const setTimer = options.setTimeout ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let running: Running | null = null;
  let applied = options.settings();
  let status = stoppedStatus(applied.port);
  let hint: string | null = null;
  /** Starts and stops run one after another, so a quick off-on never leaves two hosts. */
  let transition: Promise<void> = Promise.resolve();

  function publish(next: McpStatus): void {
    status = { ...next, tokenHint: hint };
    options.onStatus(status);
  }

  function agentDatasources(): AgentDatasource[] {
    return options.datasources().flatMap((datasource) => {
      const access = effectiveAccess(datasource);
      if (datasource.ephemeral || access === "off") return [];
      return [
        {
          id: datasource.id,
          name: datasource.name,
          pluginId: datasource.pluginId,
          comment: datasource.comment === "" ? null : datasource.comment,
          access,
          ...schemasOf(datasource),
          ...(datasource.agentRowCap === undefined ? {} : { rowCap: datasource.agentRowCap }),
          ...(datasource.agentTimeoutSeconds === undefined ? {} : { timeoutSeconds: datasource.agentTimeoutSeconds }),
        },
      ];
    });
  }

  function storedToken(): string | undefined {
    const stored =
      options.secrets.get(MCP_SECRET_OWNER, MCP_TOKEN_KEY, "forever") ??
      options.secrets.get(MCP_SECRET_OWNER, MCP_TOKEN_KEY, "untilRestart");
    hint = stored === undefined ? null : tokenHint(stored);
    return stored;
  }

  async function setToken(token: string): Promise<void> {
    const mode = options.secrets.encryption().available ? "forever" : "untilRestart";
    await options.secrets.clear(MCP_SECRET_OWNER, MCP_TOKEN_KEY);
    await options.secrets.set(MCP_SECRET_OWNER, MCP_TOKEN_KEY, mode, token);
    hint = tokenHint(token);
    publish(status);
  }

  async function token(): Promise<string> {
    const stored = storedToken();
    if (stored !== undefined) return stored;
    const created = options.newToken();
    await setToken(created);
    return created;
  }

  async function answerEngine(process: McpProcess, requestId: number, datasourceId: string): Promise<void> {
    const allowed = agentDatasources().some((datasource) => datasource.id === datasourceId);
    let answer: EngineAnswer;
    if (!allowed) {
      answer = { status: "failed", message: "This datasource is not exposed to agents.", hint: null };
    } else {
      try {
        const result = await options.connect(datasourceId, { mcpRequest: requestId });
        if (result.status === "connected") answer = { status: "connected" };
        else if (result.status === "needsSecrets")
          answer = { status: "failed", message: "TableCraft has no stored password for it.", hint: NEEDS_SECRETS_HINT };
        else answer = { status: "failed", message: result.message, hint: result.hint };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        answer = { status: "failed", message, hint: null };
      }
    }
    if (running?.process === process) process.postMessage({ kind: MCP_ENGINE_ANSWER_MESSAGE, requestId, answer });
  }

  function received(process: McpProcess, message: unknown): void {
    if (!isMessage(message)) return;
    switch (message.kind) {
      case MCP_STATUS_MESSAGE:
        if (running?.process === process && !running.stopping) publish(message.status);
        return;
      case MCP_ENGINE_REQUEST_MESSAGE:
        void answerEngine(process, message.requestId, message.datasourceId);
        return;
      case MCP_HISTORY_MESSAGE:
        try {
          options.history.record({ ...message.entry, source: "agent" });
        } catch (cause) {
          options.log.warn("agent history not recorded", { err: cause });
        }
        return;
      case MCP_LOG_MESSAGE:
        options.forward(message.record, MCP_LOG_PROCESS);
        return;
      case MCP_OPEN_CONSOLE_MESSAGE:
        options.openConsole({ datasourceId: message.datasourceId, sql: message.sql });
        return;
      case MCP_CONTEXT_REQUEST_MESSAGE:
        if (!options.askContext(message.requestId))
          process.postMessage({ kind: MCP_CONTEXT_ANSWER_MESSAGE, requestId: message.requestId, context: null });
        return;
    }
  }

  async function launch(settings: McpSettings): Promise<void> {
    const secret = await token();
    const process = options.fork();
    const exited = new Promise<void>((resolve) => {
      process.once("exit", (code) => {
        const current = running;
        if (current?.process === process) {
          running = null;
          if (current.stopping) publish(stoppedStatus(settings.port));
          else {
            options.log.warn("mcp host exited unexpectedly", { code });
            publish({
              ...stoppedStatus(settings.port),
              state: "failed",
              message: `The MCP server stopped (exit code ${String(code)}). Turn it off and on again in Settings › MCP Server.`,
            });
          }
        }
        resolve();
      });
    });
    running = { process, exited, stopping: false };
    process.on("message", (message) => received(process, message));
    process.postMessage({
      kind: MCP_BOOT_MESSAGE,
      port: settings.port,
      token: secret,
      serverVersion: options.serverVersion,
      datasources: agentDatasources(),
      windows: options.windowsOpen(),
      rowCap: settings.rowCap,
      timeoutSeconds: settings.statementTimeoutSeconds,
      clients: settings.clients,
    });
    options.log.info("mcp host started", { port: settings.port });
  }

  async function halt(): Promise<void> {
    const current = running;
    if (current === null) return;
    current.stopping = true;
    current.process.postMessage({ kind: MCP_SHUTDOWN_MESSAGE });
    const timer = setTimer(() => current.process.kill(), MCP_SHUTDOWN_GRACE_MS);
    await current.exited;
    clearTimer(timer);
  }

  function queue(step: () => Promise<void>): Promise<void> {
    const next = transition.then(step);
    transition = next.catch((cause: unknown) => options.log.error("mcp host transition failed", { err: cause }));
    return next;
  }

  async function restart(settings: McpSettings): Promise<void> {
    await halt();
    if (settings.enabled) await launch(settings);
    else publish(stoppedStatus(settings.port));
  }

  return {
    start() {
      storedToken();
      return queue(() => restart(applied));
    },
    settingsChanged(next) {
      const previous = applied;
      applied = next;
      if (previous.enabled !== next.enabled || previous.port !== next.port) return queue(() => restart(next));
      if (
        previous.rowCap !== next.rowCap ||
        previous.statementTimeoutSeconds !== next.statementTimeoutSeconds ||
        previous.clients !== next.clients
      )
        running?.process.postMessage({
          kind: MCP_CONFIG_MESSAGE,
          rowCap: next.rowCap,
          timeoutSeconds: next.statementTimeoutSeconds,
          clients: next.clients,
        });
      return Promise.resolve();
    },
    datasourcesChanged() {
      running?.process.postMessage({ kind: MCP_DATASOURCES_MESSAGE, datasources: agentDatasources() });
    },
    windowsChanged() {
      running?.process.postMessage({ kind: MCP_CONTROL_MESSAGE, action: "windows", open: options.windowsOpen() });
    },
    sendPort(target, port) {
      if (running === null || running.stopping) {
        port.close();
        return;
      }
      running.process.postMessage({ kind: MCP_ENGINE_PORT_MESSAGE, requestId: target.mcpRequest }, [port]);
    },
    status: () => status,
    control(control) {
      running?.process.postMessage({ kind: MCP_CONTROL_MESSAGE, ...control });
    },
    async copyClientConfig(client) {
      options.writeClipboard(mcpClientConfig(client, applied.port, await token()));
    },
    async copyToken() {
      options.writeClipboard(await token());
    },
    contextReply(requestId, context) {
      running?.process.postMessage({ kind: MCP_CONTEXT_ANSWER_MESSAGE, requestId, context });
    },
    regenerateToken: () =>
      queue(async () => {
        await setToken(options.newToken());
        options.log.info("mcp token regenerated");
        if (running !== null) await restart(applied);
      }),
    stop: () => queue(halt),
  };
}
