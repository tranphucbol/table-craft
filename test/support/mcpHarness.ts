import type { PluginLoadResult } from "@table-craft/core";
import sqlite from "@table-craft/plugin-sqlite";
import { createEngine, type EngineConnection } from "@table-craft/desktop/engine/engine.js";
import { createRuns, type Runs } from "@table-craft/desktop/mcp/activity.js";
import { createApprovals, type Approvals } from "@table-craft/desktop/mcp/approvals.js";
import { createAgentEngines, type EnginePort } from "@table-craft/desktop/mcp/engines.js";
import type { AgentDatasource, AgentHistoryEntry } from "@table-craft/desktop/mcp/messages.js";
import { createTools, type Tools } from "@table-craft/desktop/mcp/tools.js";
import type { ToolContext, ToolResult } from "@table-craft/desktop/mcp/toolKit.js";
import type { McpActiveConsole, McpConsoleRequest } from "@table-craft/desktop/settings/mcp.js";
import { SQLITE_MANIFEST } from "./manifests.js";
import { seededSqliteFile } from "./sqliteFixture.js";

const LOADED_SQLITE: PluginLoadResult = {
  status: "loaded",
  directory: "plugins/sqlite",
  manifest: SQLITE_MANIFEST,
  plugin: sqlite,
};

export const AGENT_CALLER = { sessionId: "mcp-1", clientName: "Claude Code" };

/** An engine port in the same process: what a `MessagePortMain` carries, without Electron. */
export function inProcessPort(connection: EngineConnection): EnginePort & { readonly closed: () => boolean } {
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
  /** What open_in_console handed to the window. */
  readonly opened: McpConsoleRequest[];
  setActiveConsole(active: McpActiveConsole | null): void;
  setWindows(open: boolean): void;
  setDatasources(next: readonly AgentDatasource[]): void;
  setRowCap(rowCap: number): void;
  call(name: Parameters<Tools["call"]>[0], args: unknown): Promise<ToolResult>;
}

/** The MCP tools over one seeded SQLite file per datasource id, with approvals the test answers. */
export function agentHarness(
  datasources: readonly AgentDatasource[],
  options: { readOnly?: boolean } = {},
): AgentHarness {
  const path = seededSqliteFile();
  const history: AgentHistoryEntry[] = [];
  let exposed = datasources;
  let rowCap = 3;
  let clock = 0;
  let windows = true;
  let activeConsole: McpActiveConsole | null = null;
  const opened: McpConsoleRequest[] = [];
  const runs = createRuns(
    () => undefined,
    () => clock,
  );
  const approvals = createApprovals({ onChange: () => undefined, now: () => clock });
  approvals.setWindows(true);
  const engines = createAgentEngines((datasourceId) => {
    const engine = createEngine({
      datasource: {
        id: datasourceId,
        pluginId: "sqlite",
        config: { path },
        readOnly: options.readOnly ?? false,
        keepAliveSeconds: 0,
      },
      plugins: [LOADED_SQLITE],
    });
    return Promise.resolve(inProcessPort(engine.connect()));
  });
  const context: ToolContext = {
    datasources: () => exposed,
    engines,
    approvals,
    record: (entry) => history.push(entry),
    rowCap: () => rowCap,
    now: () => (clock += 1),
    runs,
    consoles: {
      open(request) {
        if (!windows) return false;
        opened.push(request);
        return true;
      },
      active: () => Promise.resolve(activeConsole),
    },
  };
  const tools = createTools(context);
  return {
    tools,
    context,
    approvals,
    history,
    path,
    runs,
    opened,
    setActiveConsole: (active) => (activeConsole = active),
    setWindows: (open) => {
      windows = open;
      approvals.setWindows(open);
    },
    setDatasources: (next) => (exposed = next),
    setRowCap: (next) => (rowCap = next),
    call: async (name, args) => (await tools.call(name, args, AGENT_CALLER)).result,
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
