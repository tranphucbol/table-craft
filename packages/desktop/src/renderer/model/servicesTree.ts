import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import { serviceState, type ServiceState } from "@table-craft/desktop/renderer/model/format.js";
import type { AgentClientGroup, AgentDatasourceGroup } from "@table-craft/desktop/renderer/model/mcp.js";
import type { ConsoleSession } from "@table-craft/desktop/renderer/state/consoles.js";
import type { Execution } from "@table-craft/desktop/renderer/state/executions.js";
import type { ExportEntry } from "@table-craft/desktop/renderer/state/exports.js";
import type { ImportEntry } from "@table-craft/desktop/renderer/state/imports.js";
import type { KeyDeleteTask } from "@table-craft/desktop/renderer/state/keyDeletes.js";
import type { ScriptEntry } from "@table-craft/desktop/renderer/state/scripts.js";
import type { TableSession, TableStatus } from "@table-craft/desktop/renderer/state/tables.js";
import type { Tab } from "@table-craft/desktop/renderer/state/tabs.js";
import type { McpRunView } from "@table-craft/desktop/settings/mcp.js";

/** An open console or table tab: one session on its datasource (plan 011 decision 12). */
export interface ServiceSession {
  readonly tabId: string;
  readonly kind: "console" | "table";
  readonly title: string;
  readonly state: ServiceState;
  readonly lastDurationMs: number | null;
  /** Newest first. */
  readonly executions: readonly Execution[];
}

export interface ServiceDatasource {
  readonly datasourceId: string;
  readonly name: string;
  readonly sessions: readonly ServiceSession[];
}

export interface ServicesInput {
  readonly tabs: readonly Tab[];
  readonly consoles: Readonly<Record<string, ConsoleSession>>;
  readonly tables: Readonly<Record<string, TableSession>>;
  readonly executions: Readonly<Record<string, readonly Execution[]>>;
  readonly datasources: readonly DatasourceView[];
}

const TABLE_STATE: Readonly<Record<TableStatus, ServiceState>> = {
  connecting: "connecting",
  ready: "idle",
  loading: "running",
  submitting: "running",
  failed: "failed",
  disconnected: "disconnected",
};

const NONE: readonly Execution[] = [];

function lastFinished(executions: readonly Execution[]): number | null {
  return executions.find((execution) => execution.durationMs !== null)?.durationMs ?? null;
}

function sessionOf(tab: Tab, input: ServicesInput): { datasourceId: string; session: ServiceSession } | null {
  const executions = input.executions[tab.id] ?? NONE;
  if (tab.kind === "console") {
    const console = input.consoles[tab.id];
    if (console === undefined) return null;
    return {
      datasourceId: console.datasourceId,
      session: {
        tabId: tab.id,
        kind: "console",
        title: tab.title,
        state: serviceState(console),
        lastDurationMs: console.lastRun?.durationMs ?? null,
        executions,
      },
    };
  }
  if (tab.kind === "table") {
    const table = input.tables[tab.id];
    if (table === undefined) return null;
    return {
      datasourceId: table.datasourceId,
      session: {
        tabId: tab.id,
        kind: "table",
        title: tab.title,
        state: TABLE_STATE[table.status],
        lastDurationMs: lastFinished(executions),
        executions,
      },
    };
  }
  return null;
}

/** Datasources with an open console or table tab, in tab order, each with its sessions in tab order. */
export function servicesTree(input: ServicesInput): readonly ServiceDatasource[] {
  const groups = new Map<string, ServiceSession[]>();
  for (const tab of input.tabs) {
    const found = sessionOf(tab, input);
    if (found === null) continue;
    const sessions = groups.get(found.datasourceId) ?? [];
    sessions.push(found.session);
    groups.set(found.datasourceId, sessions);
  }
  return [...groups].map(([datasourceId, sessions]) => ({
    datasourceId,
    name: input.datasources.find((view) => view.id === datasourceId)?.name ?? datasourceId,
    sessions,
  }));
}

/** One visible line of the tree; `key` is stable across renders, `parent` the line ← moves to. */
export type ServiceRow =
  | { readonly kind: "datasource"; readonly key: string; readonly depth: 0; readonly node: ServiceDatasource }
  | {
      readonly kind: "session";
      readonly key: string;
      readonly depth: 1;
      readonly parent: string;
      readonly node: ServiceSession;
    }
  | {
      readonly kind: "execution";
      readonly key: string;
      readonly depth: 2;
      readonly parent: string;
      readonly tabId: string;
      readonly node: Execution;
    }
  | { readonly kind: "exports"; readonly key: string; readonly depth: 0; readonly count: number }
  | {
      readonly kind: "export";
      readonly key: string;
      readonly depth: 1;
      readonly parent: string;
      readonly node: ExportEntry;
    }
  | { readonly kind: "imports"; readonly key: string; readonly depth: 0; readonly count: number }
  | {
      readonly kind: "import";
      readonly key: string;
      readonly depth: 1;
      readonly parent: string;
      readonly node: ImportEntry;
    }
  | { readonly kind: "scripts"; readonly key: string; readonly depth: 0; readonly count: number }
  | {
      readonly kind: "script";
      readonly key: string;
      readonly depth: 1;
      readonly parent: string;
      readonly node: ScriptEntry;
    }
  | { readonly kind: "keyDeletes"; readonly key: string; readonly depth: 0; readonly count: number }
  | {
      readonly kind: "keyDelete";
      readonly key: string;
      readonly depth: 1;
      readonly parent: string;
      readonly node: KeyDeleteTask;
    }
  | { readonly kind: "agents"; readonly key: string; readonly depth: 0; readonly count: number }
  | {
      readonly kind: "agentClient";
      readonly key: string;
      readonly depth: 1;
      readonly parent: string;
      readonly node: AgentClientGroup;
    }
  | {
      readonly kind: "agentDatasource";
      readonly key: string;
      readonly depth: 2;
      readonly parent: string;
      readonly node: AgentDatasourceGroup;
    }
  | {
      readonly kind: "agentRun";
      readonly key: string;
      readonly depth: 3;
      readonly parent: string;
      readonly node: McpRunView;
    };

/** The Exports node's key: one node under the datasources, every background export below it (decision 040). */
export const EXPORTS_ROW_KEY = "exports";

/** The Imports node's key, beside the Exports node (plan 021). */
export const IMPORTS_ROW_KEY = "imports";

/** The SQL Scripts node's key, after the Imports node (decision 081). */
export const SCRIPTS_ROW_KEY = "scripts";

/** The Key Deletions node's key, after SQL Scripts (plan 058 decision 17). */
export const KEY_DELETES_ROW_KEY = "keyDeletes";

/** The Agents node's key, last: each MCP client, the datasources it is using, its running calls (plan 117). */
export const AGENTS_ROW_KEY = "agents";

export function datasourceRowKey(datasourceId: string): string {
  return `datasource:${datasourceId}`;
}

export function sessionRowKey(tabId: string): string {
  return `session:${tabId}`;
}

/**
 * The lines shown, every node expanded unless `collapsed` holds its key (the tree starts expanded);
 * the Exports, Imports and SQL Scripts nodes follow the datasources while any task of theirs is
 * listed, newest first.
 */
export function serviceRows(
  tree: readonly ServiceDatasource[],
  collapsed: ReadonlySet<string>,
  exports: readonly ExportEntry[] = [],
  imports: readonly ImportEntry[] = [],
  scripts: readonly ScriptEntry[] = [],
  keyDeletes: readonly KeyDeleteTask[] = [],
  agents: readonly AgentClientGroup[] = [],
): readonly ServiceRow[] {
  const rows: ServiceRow[] = [];
  for (const datasource of tree) {
    const datasourceKey = datasourceRowKey(datasource.datasourceId);
    rows.push({ kind: "datasource", key: datasourceKey, depth: 0, node: datasource });
    if (collapsed.has(datasourceKey)) continue;
    for (const session of datasource.sessions) {
      const sessionKey = sessionRowKey(session.tabId);
      rows.push({ kind: "session", key: sessionKey, depth: 1, parent: datasourceKey, node: session });
      if (collapsed.has(sessionKey)) continue;
      for (const execution of session.executions) {
        rows.push({
          kind: "execution",
          key: `execution:${session.tabId}:${String(execution.id)}`,
          depth: 2,
          parent: sessionKey,
          tabId: session.tabId,
          node: execution,
        });
      }
    }
  }
  if (exports.length > 0) {
    rows.push({ kind: "exports", key: EXPORTS_ROW_KEY, depth: 0, count: exports.length });
    if (!collapsed.has(EXPORTS_ROW_KEY)) {
      for (const entry of [...exports].reverse()) {
        rows.push({
          kind: "export",
          key: `export:${entry.task.taskId}`,
          depth: 1,
          parent: EXPORTS_ROW_KEY,
          node: entry,
        });
      }
    }
  }
  if (imports.length > 0) {
    rows.push({ kind: "imports", key: IMPORTS_ROW_KEY, depth: 0, count: imports.length });
    if (!collapsed.has(IMPORTS_ROW_KEY)) {
      for (const entry of [...imports].reverse()) {
        rows.push({
          kind: "import",
          key: `import:${entry.task.taskId}`,
          depth: 1,
          parent: IMPORTS_ROW_KEY,
          node: entry,
        });
      }
    }
  }
  if (scripts.length > 0) {
    rows.push({ kind: "scripts", key: SCRIPTS_ROW_KEY, depth: 0, count: scripts.length });
    if (!collapsed.has(SCRIPTS_ROW_KEY)) {
      for (const entry of [...scripts].reverse()) {
        rows.push({
          kind: "script",
          key: `script:${entry.task.taskId}`,
          depth: 1,
          parent: SCRIPTS_ROW_KEY,
          node: entry,
        });
      }
    }
  }
  if (keyDeletes.length > 0) {
    rows.push({ kind: "keyDeletes", key: KEY_DELETES_ROW_KEY, depth: 0, count: keyDeletes.length });
    if (!collapsed.has(KEY_DELETES_ROW_KEY)) {
      for (const task of [...keyDeletes].reverse()) {
        rows.push({
          kind: "keyDelete",
          key: `keyDelete:${task.taskId}`,
          depth: 1,
          parent: KEY_DELETES_ROW_KEY,
          node: task,
        });
      }
    }
  }
  if (agents.length > 0) agentRows(rows, agents, collapsed);
  return rows;
}

function agentRows(rows: ServiceRow[], agents: readonly AgentClientGroup[], collapsed: ReadonlySet<string>): void {
  rows.push({ kind: "agents", key: AGENTS_ROW_KEY, depth: 0, count: agents.length });
  if (collapsed.has(AGENTS_ROW_KEY)) return;
  for (const client of agents) {
    const clientKey = `agent:${client.clientId}`;
    rows.push({ kind: "agentClient", key: clientKey, depth: 1, parent: AGENTS_ROW_KEY, node: client });
    if (collapsed.has(clientKey)) continue;
    for (const datasource of client.datasources) {
      const datasourceKey = `${clientKey}:${datasource.datasourceId}`;
      rows.push({ kind: "agentDatasource", key: datasourceKey, depth: 2, parent: clientKey, node: datasource });
      if (collapsed.has(datasourceKey)) continue;
      for (const run of datasource.runs) {
        rows.push({ kind: "agentRun", key: `agentRun:${run.id}`, depth: 3, parent: datasourceKey, node: run });
      }
    }
  }
}

/** Whether a line has children to show or hide. */
export function expandable(row: ServiceRow): boolean {
  if (row.kind === "datasource") return row.node.sessions.length > 0;
  if (
    row.kind === "exports" ||
    row.kind === "imports" ||
    row.kind === "scripts" ||
    row.kind === "keyDeletes" ||
    row.kind === "agents"
  ) {
    return row.count > 0;
  }
  if (row.kind === "agentClient") return row.node.datasources.length > 0;
  if (row.kind === "agentDatasource") return row.node.runs.length > 0;
  return row.kind === "session" && row.node.executions.length > 0;
}

export interface TreeMove {
  readonly selected: string | null;
  readonly collapsed: ReadonlySet<string>;
}

/**
 * The Database pane's arrow keys (WAI-ARIA tree): ↑ ↓ move, → expands then steps in, ← collapses
 * then steps out, Home and End jump. Null for any other key.
 */
export function movedInTree(
  rows: readonly ServiceRow[],
  selected: string | null,
  collapsed: ReadonlySet<string>,
  key: string,
): TreeMove | null {
  if (rows.length === 0) return null;
  const at = rows.findIndex((row) => row.key === selected);
  const row = rows[at];
  const to = (index: number): TreeMove => ({ selected: rows[index]?.key ?? selected, collapsed });
  switch (key) {
    case "ArrowDown":
      return to(Math.min(at + 1, rows.length - 1));
    case "ArrowUp":
      return to(Math.max(at - 1, 0));
    case "Home":
      return to(0);
    case "End":
      return to(rows.length - 1);
    case "ArrowRight": {
      if (row === undefined || !expandable(row)) return { selected, collapsed };
      if (collapsed.has(row.key)) {
        const next = new Set(collapsed);
        next.delete(row.key);
        return { selected, collapsed: next };
      }
      return to(at + 1);
    }
    case "ArrowLeft": {
      if (row === undefined) return { selected, collapsed };
      if (expandable(row) && !collapsed.has(row.key)) return { selected, collapsed: new Set(collapsed).add(row.key) };
      return row.kind === "datasource" ||
        row.kind === "exports" ||
        row.kind === "imports" ||
        row.kind === "scripts" ||
        row.kind === "keyDeletes" ||
        row.kind === "agents"
        ? { selected, collapsed }
        : { selected: row.parent, collapsed };
    }
    default:
      return null;
  }
}
