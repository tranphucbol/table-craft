import type { PluginLoadResult } from "@table-craft/core";
import { PluginError, type DatasourcePlugin } from "@table-craft/plugin-api";
import sqlite from "@table-craft/plugin-sqlite";
import { createEngine, type EngineConnection } from "@table-craft/desktop/engine/engine.js";
import type { OpenedSession } from "@table-craft/desktop/engine/protocol.js";
import { createRuns, type Runs } from "@table-craft/desktop/mcp/activity.js";
import { createApprovals, type Approvals } from "@table-craft/desktop/mcp/approvals.js";
import { createAgentEngines, type EnginePort } from "@table-craft/desktop/mcp/engines.js";
import type { AgentDatasource, AgentHistoryEntry } from "@table-craft/desktop/mcp/messages.js";
import { createTools, type Tools } from "@table-craft/desktop/mcp/tools.js";
import { approvalWait, type Caller, type ToolContext, type ToolResult } from "@table-craft/desktop/mcp/toolKit.js";
import { createConsoleOwners, type ConsoleOwners } from "@table-craft/desktop/mcp/consoleOwners.js";
import type { McpActiveConsole } from "@table-craft/desktop/settings/mcp.js";
import { fakeWindow, type FakeWindow } from "./fakeWindow.js";
import { SQLITE_MANIFEST } from "./manifests.js";
import { seededSqliteFile } from "./sqliteFixture.js";

const LOADED_SQLITE: PluginLoadResult = {
  status: "loaded",
  directory: "plugins/sqlite",
  manifest: SQLITE_MANIFEST,
  plugin: sqlite,
};

/** SQLite that reports `sentOf(sql)` as the text it sent, as a plugin adding a hint does. */
function sendingSqlite(sentOf: (sql: string) => string): PluginLoadResult {
  const base: DatasourcePlugin = sqlite;
  const plugin: DatasourcePlugin = {
    ...base,
    connect: async (config, connectOptions) => {
      const session = await base.connect(config, connectOptions);
      return {
        ...session,
        execute: async (sql, params, options) => {
          const sent = sentOf(sql);
          try {
            return { ...(await session.execute(sql, params, options)), sent };
          } catch (cause) {
            throw new PluginError("statementFailed", cause instanceof Error ? cause.message : String(cause), { sent });
          }
        },
      };
    },
  };
  return { status: "loaded", directory: "plugins/sqlite", manifest: SQLITE_MANIFEST, plugin };
}

/** A caller as the server makes one per `tools/call`, with its own approval wait. */
export function agentCaller(sessionId = "mcp-1"): Caller {
  return { sessionId, clientName: "Claude Code", waits: approvalWait() };
}

/** An engine port in the same process: what a `MessagePortMain` carries, without Electron. */
export function inProcessPort(
  connection: Pick<EngineConnection, "handle" | "close">,
): EnginePort & { readonly closed: () => boolean } {
  const messageListeners: ((data: unknown) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  let closed = false;
  return {
    postMessage(message) {
      void connection.handle(message).then((response) => {
        if (!closed) for (const listener of messageListeners) listener(response);
      });
    },
    onMessage: (listener) => messageListeners.push(listener),
    onClose: (listener) => closeListeners.push(listener),
    close() {
      if (closed) return;
      closed = true;
      void connection.close();
      for (const listener of closeListeners) listener();
    },
    closed: () => closed,
  };
}

export interface AgentHarness {
  readonly tools: Tools;
  /** What the tools see; resources and prompts read through it too. */
  readonly context: ToolContext;
  readonly approvals: Approvals;
  readonly history: AgentHistoryEntry[];
  readonly path: string;
  readonly runs: Runs;
  /** The one window the console tools reach. */
  readonly window: FakeWindow;
  readonly owners: ConsoleOwners;
  setActiveConsole(active: McpActiveConsole | null): void;
  setWindows(open: boolean): void;
  setAllowFocus(allowed: boolean): void;
  setDatasources(next: readonly AgentDatasource[]): void;
  setRowCap(rowCap: number): void;
  setTimeoutSeconds(seconds: number): void;
  /** Moves the fake clock on, as a user taking `ms` to answer would. */
  advance(ms: number): void;
  /** What each agent session said of its server as it opened (decision 131). */
  readonly seen: { readonly datasourceId: string; readonly opened: OpenedSession }[];
  /** Every request the tools sent to an engine, in order. */
  readonly requests: { readonly type: string; readonly timeoutSeconds?: number; readonly serverEnforced?: boolean }[];
  /** Calls as session `mcp-1`, or as `caller` when given. */
  call(name: Parameters<Tools["call"]>[0], args: unknown, caller?: Caller): Promise<ToolResult>;
}

/** The MCP tools over one seeded SQLite file per datasource id, with approvals the test answers. */
export function agentHarness(
  datasources: readonly AgentDatasource[],
  options: { readOnly?: boolean; sentOf?: (sql: string) => string } = {},
): AgentHarness {
  const path = seededSqliteFile();
  const history: AgentHistoryEntry[] = [];
  let exposed = datasources;
  let rowCap = 3;
  let timeoutSeconds = 120;
  const requests: AgentHarness["requests"] = [];
  const seen: AgentHarness["seen"][number][] = [];
  let clock = 0;
  let allowFocus = true;
  const window = fakeWindow();
  const owners = createConsoleOwners();
  const runs = createRuns(
    () => undefined,
    () => clock,
  );
  const approvals = createApprovals({ onChange: () => undefined, now: () => clock });
  approvals.setWindows(true);
  const engines = createAgentEngines(
    (datasourceId) => {
      const engine = createEngine({
        datasource: {
          id: datasourceId,
          pluginId: "sqlite",
          config: { path },
          readOnly: options.readOnly ?? false,
          keepAliveSeconds: 0,
        },
        plugins: [options.sentOf === undefined ? LOADED_SQLITE : sendingSqlite(options.sentOf)],
      });
      const connection = engine.connect();
      return Promise.resolve(
        inProcessPort({
          close: () => connection.close(),
          handle: (request) => {
            requests.push(request as AgentHarness["requests"][number]);
            return connection.handle(request);
          },
        }),
      );
    },
    (datasourceId, opened) => seen.push({ datasourceId, opened }),
  );
  const context: ToolContext = {
    datasources: () => exposed,
    engines,
    approvals,
    record: (entry) => history.push(entry),
    rowCap: () => rowCap,
    timeoutSeconds: () => timeoutSeconds,
    now: () => (clock += 1),
    runs,
    windows: window,
    owners,
    allowFocus: () => allowFocus,
  };
  const tools = createTools(context);
  return {
    tools,
    context,
    approvals,
    history,
    path,
    runs,
    window,
    owners,
    seen,
    setActiveConsole: (active) => (window.active = active),
    setWindows: (open) => {
      window.open = open;
      approvals.setWindows(open);
    },
    setAllowFocus: (allowed) => (allowFocus = allowed),
    setDatasources: (next) => (exposed = next),
    setRowCap: (next) => (rowCap = next),
    setTimeoutSeconds: (next) => (timeoutSeconds = next),
    advance: (ms) => (clock += ms),
    requests,
    call: async (name, args, caller = agentCaller()) => (await tools.call(name, args, caller)).result,
  };
}

export function textOf(result: ToolResult): string {
  return result.content.map((part) => part.text).join("\n");
}

/** Resolves once an approval waits, so the test can answer it. */
export async function waitingApproval(approvals: Approvals): Promise<string> {
  for (;;) {
    const [first] = approvals.pending();
    if (first !== undefined) return first.id;
    await new Promise((resolve) => setImmediate(resolve));
  }
}
