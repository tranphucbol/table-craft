import { useConsoleDatasource } from "@table-craft/desktop/renderer/console/useConsoleDatasource.js";
import { useTabs } from "@table-craft/desktop/renderer/state/tabs.js";
import { selectedDatasourceId, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { ADMIN_ACTION_IDS } from "./actions.js";
import { useKeyAdmin } from "./store.js";

export function ClusterStatus() {
  const activeId = useTabs((state) => state.activeId);
  const tabSource = useConsoleDatasource(activeId ?? "");
  const selected = useDatasources((state) => selectedDatasourceId(state.selection));
  const source = tabSource?.id ?? selected;
  const data = useKeyAdmin((state) => (source === null ? undefined : state.data[source]));
  const status = data?.statuses[0];
  if (source === null || status === undefined || data === undefined) return null;
  const leader = data.members.find((member) => member.id === status.leaderId);
  return (
    <button
      type="button"
      className="flex min-w-0 items-center gap-cell truncate text-left hover:text-ink"
      onClick={() => invoke(ADMIN_ACTION_IDS.cluster, { datasourceId: source })}
    >
      <span className="truncate">
        rev {status.revision} · {data.members.length} members · leader {leader?.name ?? "Unknown"}
      </span>
      {data.alarms.map((alarm) => (
        <span key={`${alarm.kind}-${alarm.memberId}`} className="rounded bg-edit-deleted px-cell text-danger">
          ⚠ {alarm.kind}
        </span>
      ))}
    </button>
  );
}
