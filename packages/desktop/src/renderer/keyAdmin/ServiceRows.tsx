import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useWatch } from "@table-craft/desktop/renderer/watch/store.js";
import { WATCH_ACTION_IDS } from "@table-craft/desktop/renderer/watch/actions.js";
import { rangeLabel } from "./AccessView.js";
import { TaskRows } from "./TaskRows.js";
import { BUTTON } from "./controls.js";
import { useKeyAdmin } from "./store.js";

export function AdvancedServiceRows() {
  const data = useKeyAdmin((state) => state.data);
  const watches = useWatch((state) => state.entries);
  const sources = useDatasources((state) => state.datasources);
  const ids = new Set([
    ...Object.keys(data).filter((id) => (data[id]?.tasks.length ?? 0) > 0),
    ...Object.values(watches).map((watch) => watch.datasourceId),
  ]);
  return (
    <div aria-label="Independent background key services">
      {[...ids].map((source) => (
        <section key={source} className="border-b border-line">
          <h3 className="bg-panel px-gap py-cell font-semibold">
            {sources.find((item) => item.id === source)?.name ?? source}
          </h3>
          <ul>
            {Object.values(watches)
              .filter((watch) => watch.datasourceId === source)
              .map((watch) => (
                <li key={watch.summary.watchId} className="flex flex-wrap items-center gap-gap px-gap py-cell">
                  <button
                    type="button"
                    className="min-w-0 truncate text-left hover:text-accent"
                    onClick={() => invoke(WATCH_ACTION_IDS.command, { id: watch.summary.watchId, kind: "select" })}
                  >
                    Watch · {rangeLabel(watch.summary.request.range)}
                  </button>
                  <span className="text-ink-muted">
                    {watch.summary.state} · rev {watch.summary.completedRevision ?? "Unknown"}
                    {watch.paused ? " · presentation paused" : ""}
                  </span>
                  {watch.summary.state === "stopped" ? null : (
                    <button
                      type="button"
                      className={BUTTON}
                      onClick={() => invoke(WATCH_ACTION_IDS.command, { id: watch.summary.watchId, kind: "stop" })}
                    >
                      Stop
                    </button>
                  )}
                </li>
              ))}
          </ul>
          {data[source] === undefined ? null : <TaskRows source={source} data={data[source]} />}
        </section>
      ))}
    </div>
  );
}
