import { useEffect, useState } from "react";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { SERVER_ACTION_IDS } from "@table-craft/desktop/renderer/actions/serverActions.js";
import { pluginOf } from "@table-craft/desktop/renderer/state/datasources.js";
import { ADMIN_ACTION_IDS } from "./actions.js";
import { EMPTY_ADMIN, useKeyAdmin } from "./store.js";
import { CommandButton } from "./controls.js";
import { LeasesView } from "./LeasesView.js";
import { AccessView } from "./AccessView.js";
import { ClusterView } from "./ClusterView.js";
import { CoordinationView } from "./CoordinationView.js";

const AUTO_REFRESH_MS = 5_000;
export function AdminView({ tabId }: { readonly tabId: string }) {
  const tab = useKeyAdmin((state) => state.tabs[tabId]);
  const data = useKeyAdmin((state) => state.data[tab?.datasourceId ?? ""] ?? EMPTY_ADMIN);
  const readOnly = useDatasources(
    (state) => state.datasources.find((source) => source.id === tab?.datasourceId)?.readOnly === true,
  );
  const [auto, setAuto] = useState(false);
  const hasServerInfo = useDatasources((state) => {
    const source = state.datasources.find((item) => item.id === tab?.datasourceId);
    return pluginOf(state.plugins, source?.pluginId ?? "")?.capabilities.includes("serverInfo") === true;
  });
  useEffect(() => {
    if (!auto || tab === undefined) return;
    const timer = setInterval(
      () =>
        invoke(ADMIN_ACTION_IDS.command, {
          datasourceId: tab.datasourceId,
          command: { kind: "refresh", view: tab.view },
        }),
      AUTO_REFRESH_MS,
    );
    return () => clearInterval(timer);
  }, [auto, tab]);
  if (tab === undefined) return <p className="p-gap text-ink-muted">This view is closed.</p>;
  const reason = readOnly ? "Read-only data source" : null;
  const cluster = ["members", "alarms", "maintenance"].includes(tab.view);
  return (
    <section aria-label={cluster ? "Cluster" : tab.view} className="flex min-h-0 flex-1 flex-col text-ui">
      <div
        role="toolbar"
        aria-label="Service controls"
        className="flex shrink-0 flex-wrap items-center gap-cell border-b border-line bg-panel p-cell"
      >
        <CommandButton
          source={tab.datasourceId}
          command={{ kind: "refresh", view: tab.view }}
          reason={data.loading ? "Refreshing…" : null}
        >
          Refresh
        </CommandButton>
        <label className="flex items-center gap-cell">
          <input type="checkbox" checked={auto} onChange={(event) => setAuto(event.target.checked)} />
          Auto-refresh
        </label>
        {cluster ? (
          <div role="tablist" aria-label="Cluster views" className="ml-auto flex gap-cell">
            {(["members", "alarms", "maintenance"] as const).map((view) => (
              <CommandButton
                key={view}
                source={tab.datasourceId}
                pressed={tab.view === view}
                command={{ kind: "view", tabId, view }}
              >
                {view === "members" ? "Members" : view === "alarms" ? "Alarms" : "Maintenance"}
              </CommandButton>
            ))}
          </div>
        ) : null}
        {cluster && hasServerInfo ? (
          <button
            type="button"
            className="h-row rounded border border-line px-cell hover:bg-raised"
            title="Version, storage and connection information"
            onClick={() => invoke(SERVER_ACTION_IDS.details, { datasourceId: tab.datasourceId })}
          >
            Server Details
          </button>
        ) : null}
        <span className="ml-auto text-ink-muted">
          {data.loading ? "Refreshing…" : readOnly ? "Read-only" : "Cluster-global administration"}
        </span>
      </div>
      {data.error === null ? null : (
        <div role="alert" className="border-b border-line p-gap text-danger">
          {data.error}
          <p className="text-ink-muted">
            Check the connection and permissions, then refresh. Do not retry an uncertain write without checking its
            outcome.
          </p>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {tab.view === "leases" ? (
          <LeasesView
            key={`${tab.leaseId ?? "leases"}:${tab.leaseFocus ?? 0}`}
            initialLease={tab.leaseId}
            source={tab.datasourceId}
            data={data}
            reason={reason}
          />
        ) : tab.view === "access" ? (
          <AccessView source={tab.datasourceId} data={data} reason={reason} />
        ) : tab.view === "coordination" ? (
          <CoordinationView source={tab.datasourceId} data={data} reason={reason} />
        ) : (
          <ClusterView source={tab.datasourceId} data={data} view={tab.view} reason={reason} />
        )}
      </div>
    </section>
  );
}
