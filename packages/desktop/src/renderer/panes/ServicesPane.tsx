import * as ContextMenu from "@radix-ui/react-context-menu";
import { AdvancedServiceRows } from "@table-craft/desktop/renderer/keyAdmin/ServiceRows.js";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { EXPORT_ACTION_IDS } from "@table-craft/desktop/renderer/actions/exportActions.js";
import { IMPORT_ACTION_IDS } from "@table-craft/desktop/renderer/actions/importActions.js";
import { HISTORY_ACTION_IDS } from "@table-craft/desktop/renderer/actions/historyActions.js";
import { hasFailedStatement, located, SCRIPT_ACTION_IDS } from "@table-craft/desktop/renderer/actions/scriptActions.js";
import { SESSIONS_ACTION_IDS, showableInSessions } from "@table-craft/desktop/renderer/actions/sessionsActions.js";
import type { ExportTaskState } from "@table-craft/desktop/engine/protocol.js";
import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import { invoke, registry } from "@table-craft/desktop/renderer/actions/index.js";
import {
  clockTime,
  connectionText,
  formatCount,
  formatDuration,
  rowsText,
  SERVICE_STATE_TEXT,
  type ServiceState,
} from "@table-craft/desktop/renderer/model/format.js";
import {
  EXPORT_STATE_TEXT,
  exportNotes,
  exportPercent,
  exportProgressText,
  fileNameOf,
} from "@table-craft/desktop/renderer/model/exportText.js";
import {
  datasourceName,
  expandable,
  expandableKeys,
  movedInTree,
  serviceRows,
  servicesTree,
  visibleAncestor,
  type ServiceRow,
} from "@table-craft/desktop/renderer/model/servicesTree.js";
import {
  serverMessagesTooltip,
  warningCount,
  warningsText,
} from "@table-craft/desktop/renderer/model/serverMessages.js";
import { useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { connectionOf, datasourceById, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { DatasourceGlyph, useDatasourceBrand } from "@table-craft/desktop/renderer/ui/brandIcons.js";
import {
  useExecutions,
  type Execution,
  type ExecutionOutcome,
} from "@table-craft/desktop/renderer/state/executions.js";
import { useExports, type ExportEntry } from "@table-craft/desktop/renderer/state/exports.js";
import { useKeyDeletes } from "@table-craft/desktop/renderer/state/keyDeletes.js";
import {
  KeyDeleteLine,
  keyDeleteActionsOf,
  keyDeleteLabel,
  KeyDeletesLine,
} from "@table-craft/desktop/renderer/panes/keyDeleteLines.js";
import {
  agentCallLabel,
  AgentCallLine,
  agentClientLabel,
  AgentClientLine,
  AgentDatasourceLine,
  agentRunLabel,
  AgentRunLine,
  AgentsLine,
} from "@table-craft/desktop/renderer/panes/agentLines.js";
import { MCP_ACTION_IDS } from "@table-craft/desktop/renderer/actions/mcpActions.js";
import { activityConsoleRequest, agentGroups } from "@table-craft/desktop/renderer/model/mcp.js";
import { useMcp } from "@table-craft/desktop/renderer/state/mcp.js";
import { resumeLabel, useImports, type ImportEntry } from "@table-craft/desktop/renderer/state/imports.js";
import {
  IMPORT_STATE_TEXT,
  importNotes,
  importPercent,
  importProgressText,
} from "@table-craft/desktop/renderer/model/importText.js";
import {
  scriptFailure,
  scriptName,
  scriptProgressText,
  scriptStateText,
} from "@table-craft/desktop/renderer/model/scriptText.js";
import { isScriptAsking, useScripts, type ScriptEntry } from "@table-craft/desktop/renderer/state/scripts.js";
import { useServicesTree } from "@table-craft/desktop/renderer/state/servicesTree.js";
import { useTables } from "@table-craft/desktop/renderer/state/tables.js";
import { useTabs } from "@table-craft/desktop/renderer/state/tabs.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { WIDE_MENU_CONTENT } from "@table-craft/desktop/renderer/ui/menu.js";
import {
  CollapsedIcon,
  ConsoleIcon,
  ExpandedIcon,
  ExportIcon,
  ImportIcon,
  ScriptIcon,
  SpinnerIcon,
  TableIcon,
  WarningIcon,
} from "@table-craft/desktop/renderer/ui/icons.js";
import { OutcomeGlyph } from "@table-craft/desktop/renderer/ui/Outcome.js";

const STATE_CLASS: Readonly<Record<ServiceState, string>> = {
  connecting: "text-ink-muted",
  idle: "text-ink-muted",
  running: "text-accent",
  waiting: "text-warning",
  asking: "text-danger",
  failed: "text-danger",
  disconnected: "text-ink-muted",
};
const INDENT_PX = 16;
/** A running execution's elapsed time ticks this often (plan 011 decision 12). */
const TICK_MS = 1000;
const NO_COLLAPSED: ReadonlySet<string> = new Set();

/** `Date.now()`, re-read every second while `ticking`. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, TICK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [ticking]);
  return now;
}

interface MenuEntry {
  readonly actionId: string;
  readonly args: unknown;
}

/** An export's state as the outcome glyph Services draws for an execution. */
const EXPORT_OUTCOME: Readonly<Record<ExportTaskState, ExecutionOutcome>> = {
  running: "running",
  done: "success",
  failed: "error",
  cancelled: "cancelled",
};

/** What an export line offers, in its context menu and as its buttons. */
function exportActionsOf(entry: ExportEntry): readonly string[] {
  const { task } = entry;
  if (task.state === "running") return [EXPORT_ACTION_IDS.cancel];
  const finished = task.state === "done" ? [EXPORT_ACTION_IDS.reveal] : task.retryable ? [EXPORT_ACTION_IDS.retry] : [];
  return [...finished, EXPORT_ACTION_IDS.dismiss];
}

/** What an import line offers: Cancel while it runs; Resume or Retry, the rejected rows and Remove after. */
function importActionsOf(entry: ImportEntry): readonly string[] {
  const { task } = entry;
  if (task.state === "running") return [IMPORT_ACTION_IDS.cancel];
  return [
    ...(resumeLabel(task) === null ? [] : [IMPORT_ACTION_IDS.resume]),
    ...(task.rejectedFile === null ? [] : [IMPORT_ACTION_IDS.revealRejected]),
    IMPORT_ACTION_IDS.dismiss,
  ];
}

const SCRIPT_ANSWERS = [
  SCRIPT_ACTION_IDS.skip,
  SCRIPT_ACTION_IDS.skipAll,
  SCRIPT_ACTION_IDS.stop,
  SCRIPT_ACTION_IDS.retry,
];

/**
 * What a script line offers: Cancel while it runs, the answers while it asks about a failed
 * statement (decision 083); the failing statement and Remove after.
 */
function scriptActionsOf(entry: ScriptEntry): readonly string[] {
  const goTo = hasFailedStatement(entry) ? [SCRIPT_ACTION_IDS.goTo] : [];
  if (isScriptAsking(entry)) return [...SCRIPT_ANSWERS, ...goTo];
  if (entry.task.state === "running") return [SCRIPT_ACTION_IDS.cancel];
  return [...goTo, SCRIPT_ACTION_IDS.dismiss];
}

function menuOf(row: ServiceRow, cancellable: boolean, inSessions: boolean): readonly MenuEntry[] {
  if (row.kind === "session") {
    const args = { tabId: row.node.tabId };
    return [
      ...(cancellable ? [{ actionId: HISTORY_ACTION_IDS.cancel, args }] : []),
      { actionId: HISTORY_ACTION_IDS.clearExecutions, args },
    ];
  }
  if (row.kind === "export") {
    const args = { taskId: row.node.task.taskId };
    return exportActionsOf(row.node).map((actionId) => ({ actionId, args }));
  }
  if (row.kind === "import") {
    const args = { taskId: row.node.task.taskId };
    return importActionsOf(row.node).map((actionId) => ({ actionId, args }));
  }
  if (row.kind === "script") {
    const args = { taskId: row.node.task.taskId };
    return scriptActionsOf(row.node).map((actionId) => ({ actionId, args }));
  }
  if (row.kind === "keyDelete") {
    const args = { taskId: row.node.taskId };
    return keyDeleteActionsOf(row.node).map((actionId) => ({ actionId, args }));
  }
  if (row.kind === "agentRun") {
    return row.node.cancellable ? [{ actionId: MCP_ACTION_IDS.cancel, args: row.node.id }] : [];
  }
  if (row.kind === "agentCall") {
    const request = activityConsoleRequest(row.node);
    return request === null ? [] : [{ actionId: MCP_ACTION_IDS.openInConsole, args: request }];
  }
  if (row.kind === "execution" && row.node.sql !== null) {
    const args = { tabId: row.tabId, executionId: row.node.id };
    return [
      { actionId: HISTORY_ACTION_IDS.copySql, args },
      { actionId: HISTORY_ACTION_IDS.openInConsole, args },
      ...(inSessions ? [{ actionId: SESSIONS_ACTION_IDS.showInSessions, args }] : []),
    ];
  }
  return [];
}

function Menu({ entries }: { readonly entries: readonly MenuEntry[] }) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Content className={WIDE_MENU_CONTENT}>
        {entries.map((entry) => (
          <ContextMenu.Item
            key={entry.actionId}
            className="flex h-row cursor-default items-center rounded px-gap outline-none data-[highlighted]:bg-selection"
            onSelect={() => invoke(entry.actionId, entry.args)}
          >
            {registry.get(entry.actionId)?.title ?? entry.actionId}
          </ContextMenu.Item>
        ))}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  );
}

function DatasourceLine({ row }: { readonly row: Extract<ServiceRow, { kind: "datasource" }> }) {
  const connection = useDatasources((state) => connectionOf(state, row.node.datasourceId));
  const view = useDatasources((state) => datasourceById(state, row.node.datasourceId));
  const brand = useDatasourceBrand({ id: row.node.datasourceId, pluginId: view?.pluginId ?? "", brand: view?.brand });
  return (
    <>
      <DatasourceGlyph
        brand={brand}
        tone={connection.status === "failed" ? "danger" : null}
        className="size-icon shrink-0"
      />
      <span className="truncate">{row.node.name}</span>
      <span className={cn("truncate", connection.status === "failed" ? "text-danger" : "text-ink-muted")}>
        {connectionText(connection)}
      </span>
    </>
  );
}

function SessionLine({ row }: { readonly row: Extract<ServiceRow, { kind: "session" }> }) {
  const { node } = row;
  const Glyph = node.state === "running" ? SpinnerIcon : node.kind === "console" ? ConsoleIcon : TableIcon;
  return (
    <>
      <Glyph
        aria-hidden
        className={cn("size-icon shrink-0", node.state === "running" ? "animate-spin text-accent" : "text-ink-muted")}
      />
      <span className="truncate">{node.title}</span>
      <span className={STATE_CLASS[node.state]}>{SERVICE_STATE_TEXT[node.state]}</span>
      {node.lastDurationMs === null ? null : (
        <span className="ml-auto shrink-0 text-ink-muted tabular-nums">{formatDuration(node.lastDurationMs)}</span>
      )}
    </>
  );
}

function ExecutionLine({ execution, now }: { readonly execution: Execution; readonly now: number }) {
  const duration = execution.durationMs ?? Math.max(0, now - execution.startedAt);
  const warnings = warningCount(execution.messages);
  return (
    <>
      <OutcomeGlyph outcome={execution.outcome} />
      <span className="min-w-0 truncate font-editor text-editor" title={execution.message ?? undefined}>
        {execution.label}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-cell text-ink-muted tabular-nums">
        {warnings === 0 ? null : (
          <span className="flex items-center gap-px text-warning" title={serverMessagesTooltip(execution.messages)}>
            <WarningIcon aria-hidden weight="fill" className="size-icon" />
            {warningsText(warnings)}
          </span>
        )}
        {execution.rowCount === null ? null : <span>{rowsText(execution.rowCount)}</span>}
        <span data-testid="execution-duration">{formatDuration(duration)}</span>
        <span>{clockTime(execution.startedAt)}</span>
      </span>
    </>
  );
}

function ExportsLine({ count }: { readonly count: number }) {
  return (
    <>
      <ExportIcon aria-hidden className="size-icon shrink-0 text-accent" />
      <span className="truncate">Exports</span>
      <span className="text-ink-muted tabular-nums">{count}</span>
    </>
  );
}

const EXPORT_BUTTON_LABEL: Readonly<Record<string, string>> = {
  [EXPORT_ACTION_IDS.cancel]: "Cancel",
  [EXPORT_ACTION_IDS.retry]: "Retry",
  [EXPORT_ACTION_IDS.reveal]: "Reveal",
};

/**
 * One background export: its file, state and progress; a failure's message and hint in the
 * tooltip and under the line's detail. Cancel, Retry and Reveal are buttons as well as menu items.
 */
function ExportLine({ entry }: { readonly entry: ExportEntry }) {
  const { task } = entry;
  const percent = exportPercent(task);
  const detail =
    task.error === null ? [task.path, ...exportNotes(task)].join("\n") : `${task.error.message}\n${task.error.hint}`;
  return (
    <>
      <OutcomeGlyph outcome={EXPORT_OUTCOME[task.state]} />
      <span className="min-w-0 truncate" title={detail}>
        {fileNameOf(task.path)}
      </span>
      <span className={cn("shrink-0", task.state === "failed" ? "text-danger" : "text-ink-muted")}>
        {task.state === "running" && percent !== null
          ? `${EXPORT_STATE_TEXT.running} ${String(percent)}%`
          : EXPORT_STATE_TEXT[task.state]}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-cell text-ink-muted tabular-nums">
        <span data-testid="export-progress">{exportProgressText(task)}</span>
        {exportActionsOf(entry).flatMap((actionId) => {
          const label = EXPORT_BUTTON_LABEL[actionId];
          if (label === undefined) return [];
          return [
            <button
              key={actionId}
              type="button"
              tabIndex={-1}
              data-action={actionId}
              className="rounded px-1 text-accent hover:bg-raised"
              onClick={(event) => {
                event.stopPropagation();
                invoke(actionId, { taskId: task.taskId });
              }}
            >
              {label}
            </button>,
          ];
        })}
      </span>
    </>
  );
}

function TaskButtons({
  actions,
  taskId,
}: {
  readonly actions: readonly (readonly [string, string])[];
  readonly taskId: string;
}) {
  return actions.map(([actionId, label]) => (
    <button
      key={actionId}
      type="button"
      tabIndex={-1}
      data-action={actionId}
      className="rounded px-1 text-accent hover:bg-raised"
      onClick={(event) => {
        event.stopPropagation();
        invoke(actionId, { taskId });
      }}
    >
      {label}
    </button>
  ));
}

function ImportsLine({ count }: { readonly count: number }) {
  return (
    <>
      <ImportIcon aria-hidden className="size-icon shrink-0 text-accent" />
      <span className="truncate">Imports</span>
      <span className="text-ink-muted tabular-nums">{count}</span>
    </>
  );
}

function importButtons(entry: ImportEntry): readonly (readonly [string, string])[] {
  const resume = resumeLabel(entry.task);
  return importActionsOf(entry).flatMap((actionId): (readonly [string, string])[] => {
    if (actionId === IMPORT_ACTION_IDS.cancel) return [[actionId, "Cancel"]];
    if (actionId === IMPORT_ACTION_IDS.resume && resume !== null) return [[actionId, resume]];
    if (actionId === IMPORT_ACTION_IDS.revealRejected) return [[actionId, "Rejected"]];
    return [];
  });
}

/**
 * One background import: its file, table, state and progress; what was kept and the failure's
 * message and hint in the tooltip. Cancel, Resume or Retry and the rejected rows are buttons too.
 */
function ImportLine({ entry }: { readonly entry: ImportEntry }) {
  const { task } = entry;
  const percent = importPercent(task);
  const detail = [
    `${task.file} → ${task.table}`,
    ...importNotes(task),
    ...(task.error === null ? [] : [task.error.message, task.error.hint]),
  ].join("\n");
  return (
    <>
      <OutcomeGlyph outcome={EXPORT_OUTCOME[task.state]} />
      <span className="min-w-0 truncate" title={detail}>
        {fileNameOf(task.file)} → {task.table}
      </span>
      <span className={cn("shrink-0", task.state === "failed" ? "text-danger" : "text-ink-muted")}>
        {task.state === "running" && percent !== null
          ? `${IMPORT_STATE_TEXT.running} ${String(percent)}%`
          : IMPORT_STATE_TEXT[task.state]}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-cell text-ink-muted tabular-nums">
        <span data-testid="import-progress">{importProgressText(task)}</span>
        {task.rejected > 0 ? <span className="text-warning">{`${formatCount(task.rejected)} rejected`}</span> : null}
        <TaskButtons actions={importButtons(entry)} taskId={task.taskId} />
      </span>
    </>
  );
}

function ScriptsLine({ count }: { readonly count: number }) {
  return (
    <>
      <ScriptIcon aria-hidden className="size-icon shrink-0 text-accent" />
      <span className="truncate">SQL Scripts</span>
      <span className="text-ink-muted tabular-nums">{count}</span>
    </>
  );
}

const SCRIPT_BUTTON_LABEL: Readonly<Record<string, string>> = {
  [SCRIPT_ACTION_IDS.cancel]: "Cancel",
  [SCRIPT_ACTION_IDS.goTo]: "Go to statement",
  [SCRIPT_ACTION_IDS.skip]: "Skip",
  [SCRIPT_ACTION_IDS.skipAll]: "Skip All",
  [SCRIPT_ACTION_IDS.stop]: "Stop",
  [SCRIPT_ACTION_IDS.retry]: "Retry",
};

/**
 * One Run SQL Script task: its file, state and progress; the failure it asks about, stopped at or
 * skipped last, with the message and hint in the tooltip. Its actions are buttons too.
 */
function ScriptLine({ entry }: { readonly entry: ScriptEntry }) {
  const { task } = entry;
  const failure = scriptFailure(task);
  const detail = [
    ...task.files,
    ...(failure === null ? [] : [failure.line === null ? "" : located(failure), failure.message, failure.hint]),
  ]
    .filter((line) => line !== "")
    .join("\n");
  const failing = task.state === "failed" || task.question !== null || task.failed > 0;
  return (
    <>
      <OutcomeGlyph outcome={EXPORT_OUTCOME[task.state]} />
      <span className="min-w-0 truncate" title={detail}>
        {scriptName(task)}
      </span>
      <span data-testid="script-state" className={cn("shrink-0", failing ? "text-danger" : "text-ink-muted")}>
        {scriptStateText(task)}
      </span>
      {failure?.line == null ? null : (
        <span className="min-w-0 shrink-first truncate text-danger" data-testid="script-error">
          {`line ${String(failure.line)}: ${failure.message}`}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-cell text-ink-muted tabular-nums">
        <span data-testid="script-progress">{scriptProgressText(task)}</span>
        <TaskButtons
          actions={scriptActionsOf(entry).flatMap((actionId): (readonly [string, string])[] => {
            const label = SCRIPT_BUTTON_LABEL[actionId];
            return label === undefined ? [] : [[actionId, label]];
          })}
          taskId={task.taskId}
        />
      </span>
    </>
  );
}

function rowLabel(row: ServiceRow, datasources: readonly DatasourceView[]): string {
  if (row.kind === "scripts") return `SQL Scripts, ${String(row.count)}`;
  if (row.kind === "keyDeletes") return `Key Deletions, ${String(row.count)}`;
  if (row.kind === "keyDelete") return keyDeleteLabel(row.node);
  if (row.kind === "script") {
    const { task } = row.node;
    return [scriptName(task), scriptStateText(task), scriptProgressText(task)].join(", ");
  }
  if (row.kind === "imports") return `Imports, ${String(row.count)}`;
  if (row.kind === "import") {
    const { task } = row.node;
    return [
      `${fileNameOf(task.file)} into ${task.table}`,
      IMPORT_STATE_TEXT[task.state],
      importProgressText(task),
      ...importNotes(task),
    ].join(", ");
  }
  if (row.kind === "datasource") return row.node.name;
  if (row.kind === "exports") return `Exports, ${String(row.count)}`;
  if (row.kind === "export") {
    const { task } = row.node;
    return `${fileNameOf(task.path)}, ${EXPORT_STATE_TEXT[task.state]}, ${exportProgressText(task)}`;
  }
  if (row.kind === "session") return `${row.node.title}, ${SERVICE_STATE_TEXT[row.node.state]}`;
  if (row.kind === "agents") return `Agents, ${String(row.count)}`;
  if (row.kind === "agentClient") return agentClientLabel(row.node);
  if (row.kind === "agentDatasource") return datasourceName(datasources, row.node.datasourceId);
  if (row.kind === "agentRun") return agentRunLabel(row.node);
  if (row.kind === "agentCall") return agentCallLabel(row.node);
  return `${row.node.label}, ${row.node.outcome}`;
}

/**
 * The Services tree (plan 011 decision 12): each datasource with an open console or table tab, its
 * sessions, and what each sent, newest first. Enter or a click on a session or execution shows its tab.
 * Background exports follow under one Exports node (decision 040), imports under one Imports node,
 * Run SQL Script tasks under one SQL Scripts node (decision 081).
 */
export function ServicesPane() {
  const tabs = useTabs((state) => state.tabs);
  const activeId = useTabs((state) => state.activeId);
  const activate = useTabs((state) => state.activate);
  const consoles = useConsoles((state) => state.consoles);
  const tables = useTables((state) => state.tables);
  const executions = useExecutions((state) => state.byTab);
  const datasources = useDatasources((state) => state.datasources);
  const exports = useExports((state) => state.entries);
  const imports = useImports((state) => state.entries);
  const scripts = useScripts((state) => state.entries);
  const keyDeletes = useKeyDeletes((state) => state.tasks);
  const mcpStatus = useMcp((state) => state.status);
  const agents = useMemo(() => agentGroups(mcpStatus), [mcpStatus]);
  const [selected, setSelected] = useState<string | null>(null);
  const collapsed = useServicesTree((state) => state.collapsed);
  const setCollapsed = useServicesTree((state) => state.setCollapsed);
  const elements = useRef(new Map<string, HTMLLIElement>());

  const tree = useMemo(
    () => servicesTree({ tabs, consoles, tables, executions, datasources }),
    [tabs, consoles, tables, executions, datasources],
  );
  const rows = useMemo(
    () => serviceRows(tree, collapsed, exports, imports, scripts, keyDeletes, agents),
    [tree, collapsed, exports, imports, scripts, keyDeletes, agents],
  );
  const allRows = useMemo(
    () => serviceRows(tree, NO_COLLAPSED, exports, imports, scripts, keyDeletes, agents),
    [tree, exports, imports, scripts, keyDeletes, agents],
  );
  const running =
    mcpStatus.running.length > 0 || rows.some((row) => row.kind === "execution" && row.node.outcome === "running");
  const now = useNow(running);
  const selectedIndex = rows.findIndex((row) => row.key === selected);

  function select(key: string | null): void {
    setSelected(key);
    if (key !== null) elements.current.get(key)?.focus();
  }

  useEffect(() => useServicesTree.getState().setExpandableKeys(expandableKeys(allRows)), [allRows]);

  const shownSelected = visibleAncestor(allRows, rows, selected);
  if (shownSelected !== selected) setSelected(shownSelected);

  useEffect(() => {
    // A line folded away took focus with it; the line selected in its place takes it.
    if (selected !== null && document.activeElement === document.body) elements.current.get(selected)?.focus();
  }, [selected]);

  function open(row: ServiceRow): void {
    if (row.kind === "session") activate(row.node.tabId);
    else if (row.kind === "execution") activate(row.tabId);
  }

  function toggle(row: ServiceRow): void {
    const next = new Set(collapsed);
    if (next.has(row.key)) next.delete(row.key);
    else next.add(row.key);
    setCollapsed(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLUListElement>): void {
    const current = rows[selectedIndex];
    if (event.key === "Enter" && current !== undefined) {
      open(current);
      event.preventDefault();
      return;
    }
    const moved = movedInTree(rows, selected, collapsed, event.key);
    if (moved === null) return;
    event.preventDefault();
    setCollapsed(moved.collapsed);
    select(moved.selected);
  }

  if (rows.length === 0)
    return (
      <>
        <AdvancedServiceRows />
        <p className="p-gap text-ink-muted">No open console sessions.</p>
      </>
    );
  return (
    <>
      <AdvancedServiceRows />
      <ul
        role="tree"
        aria-label="Services"
        tabIndex={selectedIndex === -1 ? 0 : -1}
        className="py-1 outline-none"
        onKeyDown={onKeyDown}
        onFocus={(event) => {
          if (event.target === event.currentTarget && selectedIndex === -1 && rows[0] !== undefined)
            select(rows[0].key);
        }}
      >
        {rows.map((row, index) => {
          const isSelected = index === selectedIndex;
          const active = row.kind === "session" && row.node.tabId === activeId;
          const canExpand = expandable(row);
          const cancellable =
            row.kind === "session" && row.node.kind === "console" && consoles[row.node.tabId]?.status === "running";
          // Reads the console and plugin stores; this pane re-renders on both through `consoles` and `datasources`.
          const inSessions = row.kind === "execution" && showableInSessions(row.tabId);
          const entries = menuOf(row, cancellable, inSessions);
          const line = (
            <li
              key={row.key}
              ref={(element) => {
                if (element === null) elements.current.delete(row.key);
                else elements.current.set(row.key, element);
              }}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-selected={isSelected}
              aria-expanded={canExpand ? !collapsed.has(row.key) : undefined}
              aria-label={rowLabel(row, datasources)}
              tabIndex={isSelected ? 0 : -1}
              data-kind={row.kind}
              data-state={
                row.kind === "session"
                  ? row.node.state
                  : row.kind === "execution"
                    ? row.node.outcome
                    : row.kind === "export" || row.kind === "import" || row.kind === "script"
                      ? row.node.task.state
                      : row.kind === "keyDelete"
                        ? row.node.state
                        : row.kind === "agentCall"
                          ? row.node.outcome
                          : undefined
              }
              style={{ paddingLeft: `calc(var(--spacing-gap) + ${String(row.depth * INDENT_PX)}px)` }}
              className={cn(
                "flex h-row cursor-default items-center gap-cell pr-gap outline-none hover:bg-raised",
                isSelected && "bg-selection hover:bg-selection",
                !isSelected && active && "bg-raised",
              )}
              onMouseDown={() => select(row.key)}
              onContextMenu={() => select(row.key)}
              onClick={() => open(row)}
              onDoubleClick={() => {
                const request = row.kind === "agentCall" ? activityConsoleRequest(row.node) : null;
                if (request !== null) invoke(MCP_ACTION_IDS.openInConsole, request);
              }}
            >
              {canExpand ? (
                <button
                  type="button"
                  tabIndex={-1}
                  aria-hidden
                  className="flex size-icon shrink-0 items-center justify-center text-ink-muted"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggle(row);
                  }}
                >
                  {collapsed.has(row.key) ? <CollapsedIcon /> : <ExpandedIcon />}
                </button>
              ) : (
                <span aria-hidden className="size-icon shrink-0" />
              )}
              {row.kind === "datasource" ? (
                <DatasourceLine row={row} />
              ) : row.kind === "session" ? (
                <SessionLine row={row} />
              ) : row.kind === "exports" ? (
                <ExportsLine count={row.count} />
              ) : row.kind === "export" ? (
                <ExportLine entry={row.node} />
              ) : row.kind === "imports" ? (
                <ImportsLine count={row.count} />
              ) : row.kind === "import" ? (
                <ImportLine entry={row.node} />
              ) : row.kind === "scripts" ? (
                <ScriptsLine count={row.count} />
              ) : row.kind === "script" ? (
                <ScriptLine entry={row.node} />
              ) : row.kind === "keyDeletes" ? (
                <KeyDeletesLine count={row.count} />
              ) : row.kind === "keyDelete" ? (
                <KeyDeleteLine task={row.node} />
              ) : row.kind === "agents" ? (
                <AgentsLine count={row.count} />
              ) : row.kind === "agentClient" ? (
                <AgentClientLine client={row.node} />
              ) : row.kind === "agentDatasource" ? (
                <AgentDatasourceLine group={row.node} />
              ) : row.kind === "agentRun" ? (
                <AgentRunLine run={row.node} now={now} />
              ) : row.kind === "agentCall" ? (
                <AgentCallLine call={row.node} />
              ) : (
                <ExecutionLine execution={row.node} now={now} />
              )}
            </li>
          );
          if (entries.length === 0) return line;
          return (
            <ContextMenu.Root key={row.key}>
              <ContextMenu.Trigger asChild>{line}</ContextMenu.Trigger>
              <Menu entries={entries} />
            </ContextMenu.Root>
          );
        })}
      </ul>
    </>
  );
}
