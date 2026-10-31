import { useEffect } from "react";
import type { ServerInfo, ServerNode, SlowCommand } from "@table-craft/desktop/engine/protocol.js";
import { SERVER_ACTION_IDS, type SlowCommandArgs } from "@table-craft/desktop/renderer/actions/serverActions.js";
import { useConsoleDatasource } from "@table-craft/desktop/renderer/console/useConsoleDatasource.js";
import { Select } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { nodeLabel } from "@table-craft/desktop/renderer/model/runOn.js";
import {
  durationText,
  overviewRows,
  REFRESH_INTERVALS,
  serverCards,
  SERVER_VIEWS,
  type RefreshInterval,
  type ServerCard,
  type ServerView,
} from "@table-craft/desktop/renderer/model/serverInfo.js";
import { pluginOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import {
  showsOverview,
  slowCommandKey,
  useServer,
  type ServerTab as Tab,
} from "@table-craft/desktop/renderer/state/server.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { tintFrame } from "@table-craft/desktop/renderer/ui/tint.js";

const MS_PER_SECOND = 1_000;
/** The node picker's value for the Overview, or for a standalone server the server itself. */
const NO_NODE = "";
const VIEW_LABELS: Readonly<Record<ServerView, string>> = { info: "Info", slowLog: "Slow log" };
const NOT_REPORTED = "—";

function intervalLabel(seconds: RefreshInterval): string {
  return seconds === 0 ? "Refresh: Off" : `Refresh: ${String(seconds)} s`;
}

function nodeChoices(nodes: readonly ServerNode[]) {
  return [
    { value: NO_NODE, label: "Overview" },
    ...nodes.map((node) => ({ value: node.id, label: nodeLabel(node, nodes) })),
  ];
}

/**
 * A datasource's server figures (decision 20 of plan 058): `INFO` sections as cards, a cluster's
 * Overview of every node, and the slow log; read again on an interval or by Refresh.
 */
export function ServerTab({ tabId }: { readonly tabId: string }) {
  const tab = useServer((state) => state.tabs[tabId]);
  const nodes = useServer((state) => (tab === undefined ? undefined : state.nodes[tab.datasourceId]));
  const datasource = useConsoleDatasource(tabId);
  const plugin = useDatasources((state) => pluginOf(state.plugins, datasource?.pluginId ?? ""));
  const refreshSeconds = tab?.refreshSeconds ?? 0;

  useEffect(() => {
    if (refreshSeconds === 0) return;
    const timer = setInterval(() => void useServer.getState().refresh(tabId), refreshSeconds * MS_PER_SECOND);
    return () => clearInterval(timer);
  }, [refreshSeconds, tabId]);

  if (tab === undefined) return null;
  const { setNode, setView, setRefresh } = useServer.getState();
  const color = datasource?.color ?? null;
  const cluster = (nodes?.length ?? 0) > 1;

  return (
    <div
      data-testid="server-tab"
      data-color={color ?? undefined}
      className={cn("flex min-h-0 flex-1 flex-col", tintFrame(color))}
    >
      <div className="flex h-tab shrink-0 items-center gap-gap border-b border-line bg-panel px-gap text-ink-muted">
        <ActionButton actionId={SERVER_ACTION_IDS.refresh} compact />
        <div role="group" aria-label="Server view" className="flex">
          {SERVER_VIEWS.map((view) => (
            <button
              key={view}
              type="button"
              aria-pressed={tab.view === view}
              data-testid={`server-view-${view}`}
              className={cn("px-cell", tab.view === view ? "bg-selection text-ink" : "hover:bg-raised")}
              onClick={() => void setView(tabId, view)}
            >
              {VIEW_LABELS[view]}
            </button>
          ))}
        </div>
        {cluster && nodes !== undefined ? (
          <Select
            label="Node"
            testId="server-node"
            value={tab.node ?? NO_NODE}
            options={nodeChoices(nodes)}
            onChange={(value) => void setNode(tabId, value === NO_NODE ? null : value)}
          />
        ) : null}
        <Select
          label="Refresh interval"
          testId="server-refresh"
          value={String(tab.refreshSeconds)}
          options={REFRESH_INTERVALS.map((seconds) => ({ value: String(seconds), label: intervalLabel(seconds) }))}
          onChange={(value) => setRefresh(tabId, Number(value) as RefreshInterval)}
        />
        {tab.loading ? <span className="truncate">Reading…</span> : null}
        {datasource === undefined ? null : (
          <span className="ml-auto shrink-0 truncate">
            {datasource.name}
            {plugin === undefined ? "" : ` · ${plugin.name}`}
          </span>
        )}
      </div>
      {tab.error === null ? null : (
        <div
          role="alert"
          data-testid="server-error"
          className="shrink-0 border-b border-line bg-panel px-gap py-1 break-words text-danger"
        >
          {tab.error.message} <span className="text-ink-muted">{tab.error.hint}</span>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto bg-canvas">
        {tab.view === "slowLog" ? (
          <SlowLog tabId={tabId} tab={tab} cluster={cluster} />
        ) : showsOverview(tab, nodes) && nodes !== undefined ? (
          <Overview nodes={nodes} infos={tab.infos} />
        ) : tab.info === null ? null : (
          <Cards info={tab.info} />
        )}
      </div>
    </div>
  );
}

function Cards({ info }: { readonly info: ServerInfo }) {
  return (
    <div
      data-testid="server-cards"
      className="grid grid-cols-[repeat(auto-fill,minmax(var(--spacing-plan-details),1fr))] gap-gap p-gap"
    >
      {serverCards(info).map((card) => (
        <Card key={card.title} card={card} />
      ))}
    </div>
  );
}

function Card({ card }: { readonly card: ServerCard }) {
  return (
    <section
      aria-label={card.title}
      data-testid="server-card"
      className="min-w-0 rounded border border-line bg-panel p-gap"
    >
      <h3 className="pb-1 font-semibold text-ink">{card.title}</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-gap">
        {card.headline.map((figure) => (
          <div key={figure.name} className="contents">
            <dt className="text-ink-muted">{figure.name}</dt>
            <dd className="truncate text-right font-grid" title={figure.value}>
              {figure.value}
            </dd>
          </div>
        ))}
      </dl>
      {card.rest.length === 0 ? null : (
        <details className="pt-1">
          <summary className="cursor-default text-ink-muted">{`${String(card.rest.length)} more`}</summary>
          <dl className="grid grid-cols-[auto_1fr] gap-x-gap">
            {card.rest.map((figure) => (
              <div key={figure.name} className="contents">
                <dt className="truncate text-ink-muted">{figure.name}</dt>
                <dd className="truncate text-right font-grid" title={figure.value}>
                  {figure.value}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </section>
  );
}

const TH = "px-cell text-left font-normal whitespace-nowrap";
const TD = "px-cell whitespace-nowrap";

function Overview({
  nodes,
  infos,
}: {
  readonly nodes: readonly ServerNode[];
  readonly infos: Readonly<Record<string, ServerInfo>>;
}) {
  return (
    <table data-testid="server-overview" className="w-full border-collapse font-grid text-grid">
      <thead className="sticky top-0 bg-panel text-ink-muted">
        <tr className="h-row">
          <th className={TH}>Node</th>
          <th className={TH}>Role</th>
          <th className={TH}>Slots</th>
          <th className={TH}>Memory</th>
          <th className={TH}>Ops/s</th>
          <th className={cn(TH, "w-full")}>State</th>
        </tr>
      </thead>
      <tbody>
        {overviewRows(nodes, infos).map((row) => (
          <tr key={row.node.id} data-node={row.node.address} className="h-row hover:bg-raised">
            <td className={TD}>{row.node.address}</td>
            <td className={TD}>{row.role}</td>
            <td className={TD}>{row.slots === "" ? NOT_REPORTED : row.slots}</td>
            <td className={cn(TD, "text-right")}>{row.memory ?? NOT_REPORTED}</td>
            <td className={cn(TD, "text-right")}>{row.opsPerSecond ?? NOT_REPORTED}</td>
            <td className={TD}>{row.node.state}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SlowLog({ tabId, tab, cluster }: { readonly tabId: string; readonly tab: Tab; readonly cluster: boolean }) {
  const commands: readonly SlowCommand[] = tab.slowLog ?? [];
  const select = useServer((state) => state.selectSlow);
  return (
    <div data-testid="server-slow-log">
      <table className="w-full border-collapse font-grid text-grid">
        <thead className="sticky top-0 bg-panel text-ink-muted">
          <tr className="h-row">
            <th className={TH}>Time</th>
            <th className={TH}>Duration</th>
            <th className={cn(TH, "w-full")}>Command</th>
            <th className={TH}>Client</th>
            {cluster ? <th className={TH}>Node</th> : null}
            <th className={TH} />
          </tr>
        </thead>
        <tbody>
          {commands.map((command) => {
            const key = slowCommandKey(command);
            const args: SlowCommandArgs = { command: command.command };
            return (
              <tr
                key={key}
                aria-selected={key === tab.selectedSlow}
                className={cn(
                  "h-row cursor-default hover:bg-raised",
                  key === tab.selectedSlow && "bg-grid-selection hover:bg-grid-selection",
                )}
                onMouseDown={() => select(tabId, key)}
              >
                <td className={TD}>{new Date(command.at).toLocaleString()}</td>
                <td className={cn(TD, "text-right")}>{durationText(command.durationMicros)}</td>
                <td className="max-w-0 truncate px-cell" title={command.command}>
                  {command.command}
                </td>
                <td className={TD}>{command.client ?? NOT_REPORTED}</td>
                {cluster ? <td className={TD}>{command.node ?? NOT_REPORTED}</td> : null}
                <td className={TD}>
                  <button
                    type="button"
                    className="text-accent hover:underline"
                    onClick={() => invoke(SERVER_ACTION_IDS.openSlowCommand, args)}
                  >
                    Open in Console
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {tab.slowLog !== null && commands.length === 0 ? (
        <p className="p-gap text-ink-muted">The slow log is empty.</p>
      ) : null}
    </div>
  );
}
