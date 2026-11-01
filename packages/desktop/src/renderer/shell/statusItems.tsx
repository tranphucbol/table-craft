import { useEffect, useState, type ComponentType } from "react";
import { useConsoleDatasource } from "@table-craft/desktop/renderer/console/useConsoleDatasource.js";
import { pathKey } from "@table-craft/desktop/renderer/model/explorerTree.js";
import { datasourceText, syncFailedText, syncText } from "@table-craft/desktop/renderer/model/format.js";
import { keyspaceStatusText } from "@table-craft/desktop/renderer/model/keyTree.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import { useKeys } from "@table-craft/desktop/renderer/state/keys.js";
import { useServer } from "@table-craft/desktop/renderer/state/server.js";
import { isRunningOn, useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { ExportsChip } from "@table-craft/desktop/renderer/shell/ExportsChip.js";
import { importingText } from "@table-craft/desktop/renderer/model/importText.js";
import { isImporting, useImports } from "@table-craft/desktop/renderer/state/imports.js";
import { scriptsRunningText } from "@table-craft/desktop/renderer/model/scriptText.js";
import { isScriptRunning, useScripts } from "@table-craft/desktop/renderer/state/scripts.js";
import {
  connectionOf,
  datasourceById,
  pluginOf,
  selectedDatasourceId,
  useDatasources,
} from "@table-craft/desktop/renderer/state/datasources.js";

/** The sync label says `2 min ago`, so once a minute is as often as it can change. */
const SYNC_LABEL_TICK_MS = 60_000;
import { activeTab, useTabs } from "@table-craft/desktop/renderer/state/tabs.js";
import { McpStatusChip } from "@table-craft/desktop/renderer/shell/McpChip.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { SpinnerIcon } from "@table-craft/desktop/renderer/ui/icons.js";

/** One slot in the status bar; plan 006 adds the caret position. */
export interface StatusItem {
  readonly id: string;
  readonly side: "left" | "right";
  readonly Component: ComponentType;
}

/** The connection dot the status bar and the datasource widget draw. */
export const DOT_CLASS = {
  disconnected: "border border-ink-muted",
  connecting: "bg-ink-muted",
  connected: "bg-success",
  failed: "bg-danger",
} as const;

/** The connection dot, with a halo while a console runs a statement on the datasource. */
export function ConnectionDot({
  datasourceId,
  status,
}: {
  readonly datasourceId: string | undefined;
  readonly status: keyof typeof DOT_CLASS;
}) {
  const running = useConsoles((state) => status === "connected" && isRunningOn(state.consoles, datasourceId));
  return (
    <span
      aria-hidden
      data-running={running || undefined}
      className={cn("size-2 shrink-0 rounded-full", DOT_CLASS[status], running && "halo")}
    />
  );
}

/** The active console's datasource, or the tree's selection when no console is active. */
export function useActiveDatasourceId(): string | undefined {
  const activeId = useTabs((state) => activeTab(state)?.id ?? null);
  const tabDatasource = useConsoleDatasource(activeId ?? "")?.id;
  return useDatasources((state) => tabDatasource ?? selectedDatasourceId(state.selection) ?? undefined);
}

function DatasourceStatus() {
  const datasourceId = useActiveDatasourceId();
  const datasource = useDatasources((state) => datasourceById(state, datasourceId));
  const connection = useDatasources((state) => connectionOf(state, datasourceId ?? ""));
  const pluginName = useDatasources((state) => pluginOf(state.plugins, datasource?.pluginId ?? "")?.name ?? null);
  const keyspace = useKeys((state) => (datasourceId === undefined ? undefined : state.keyspaces[datasourceId]));
  const nodes = useServer((state) => (datasourceId === undefined ? undefined : state.nodes[datasourceId]));
  if (datasource === undefined) return <span data-testid="status-datasource" />;
  const keys = connection.status === "connected" ? keyspaceStatusText(keyspace, nodes ?? []) : null;
  return (
    <span
      data-testid="status-datasource"
      title={connection.error?.hint}
      className={cn("flex min-w-0 items-center gap-cell", connection.status === "failed" && "text-danger")}
    >
      <ConnectionDot datasourceId={datasourceId} status={connection.status} />
      <span className="truncate">
        {datasourceText(datasource, pluginName, connection)}
        {keys === null ? "" : ` · ${keys}`}
      </span>
    </span>
  );
}

/** Re-renders every `intervalMs`, so a relative time stays true. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * When the active datasource's selected namespace, or else its current one, was last read. The
 * label is rebuilt from the store on every describe, so a Synchronize shows at once.
 */
function SyncStatus() {
  const datasourceId = useActiveDatasourceId();
  const selection = useDatasources((state) => state.selection);
  const catalog = useCatalog((state) => (datasourceId === undefined ? undefined : state.catalogs[datasourceId]));
  const now = useNow(SYNC_LABEL_TICK_MS);
  if (datasourceId === undefined || catalog?.namespaces == null) return null;
  const selected = selection?.kind === "catalog" && selection.id === datasourceId ? selection.path : null;
  const candidates = [selected, catalog.namespaces.find((namespace) => namespace.current)?.path ?? null];
  for (const path of candidates) {
    if (path === null) continue;
    const state = catalog.namespaceStates[pathKey(path)];
    const name = path[path.length - 1] ?? "";
    if (path === selected && state?.error != null) {
      return (
        <span data-testid="status-sync" className="min-w-0 flex-1 basis-0 truncate text-danger">
          {syncFailedText(name, state.error)}
        </span>
      );
    }
    const described = state?.described;
    if (described == null) continue;
    return (
      <span data-testid="status-sync" className="min-w-0 flex-1 basis-0 truncate text-ink-muted">
        {syncText(name, described.introspectedAt, described.elapsedMs, now)}
      </span>
    );
  }
  return null;
}

function RunningIndicator() {
  const running = useConsoles(
    (state) => Object.values(state.consoles).filter((session) => session.status === "running").length,
  );
  if (running === 0) return null;
  return (
    <span data-testid="status-running" className="flex items-center gap-cell">
      <SpinnerIcon aria-hidden className="size-icon animate-spin text-accent" />
      {running === 1 ? "Running 1 statement" : `Running ${running} statements`}
    </span>
  );
}

/** Background imports still writing (plan 021); Services lists each with Cancel. */
function ImportingIndicator() {
  const text = useImports((state) => {
    const running = state.entries.filter(isImporting).map((entry) => entry.task);
    return running.length === 0 ? null : importingText(running);
  });
  if (text === null) return null;
  return (
    <span data-testid="status-importing" className="flex items-center gap-cell">
      <SpinnerIcon aria-hidden className="size-icon animate-spin text-accent" />
      {text}
    </span>
  );
}

/** Run SQL Script tasks still running (decision 081); Services lists each with Cancel. */
function ScriptsIndicator() {
  const text = useScripts((state) => {
    const running = state.entries.filter(isScriptRunning).map((entry) => entry.task);
    return running.length === 0 ? null : scriptsRunningText(running);
  });
  if (text === null) return null;
  return (
    <span data-testid="status-scripts" className="flex items-center gap-cell">
      <SpinnerIcon aria-hidden className="size-icon animate-spin text-accent" />
      {text}
    </span>
  );
}

export const STATUS_ITEMS: readonly StatusItem[] = [
  { id: "datasource", side: "left", Component: DatasourceStatus },
  { id: "sync", side: "left", Component: SyncStatus },
  { id: "running", side: "right", Component: RunningIndicator },
  { id: "exporting", side: "right", Component: ExportsChip },
  { id: "importing", side: "right", Component: ImportingIndicator },
  { id: "scripts", side: "right", Component: ScriptsIndicator },
  { id: "mcp", side: "right", Component: McpStatusChip },
];
