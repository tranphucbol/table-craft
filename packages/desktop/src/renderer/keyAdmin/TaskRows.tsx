import type { AdminData } from "./store.js";
import { CommandButton } from "./controls.js";

export function TaskRows({ source, data }: { readonly source: string; readonly data: AdminData }) {
  return (
    <ul aria-label="Background key tasks">
      {data.tasks.map((task) => (
        <li key={task.taskId} className="border-b border-line p-gap">
          <div className="flex flex-wrap items-center gap-gap">
            <strong className="capitalize">{task.kind}</strong>
            <span className={task.state === "failed" ? "text-danger" : "text-ink-muted"}>
              {task.state} · {task.completed} of {task.total ?? "unknown"}{" "}
              {task.kind === "import" ? "transactions" : "units"}
            </span>
            {task.state === "running" ? (
              <CommandButton source={source} command={{ kind: "taskCancel", taskId: task.taskId }}>
                Cancel
              </CommandButton>
            ) : null}
            {task.resumable && task.outcome === "confirmed" ? (
              <CommandButton source={source} command={{ kind: "taskResume", taskId: task.taskId }}>
                Resume After Confirmed Chunk {task.completed}
              </CommandButton>
            ) : null}
          </div>
          {task.error === null ? null : (
            <p role="alert" className="pt-cell text-danger">
              {task.error}
            </p>
          )}
          {task.outcome === "uncertain" ? (
            <p className="pt-cell text-warning">
              The last operation may have committed. Inspect the affected keys before doing anything else. Automatic
              resume is blocked.
            </p>
          ) : null}
          {task.hashes === undefined ? null : (
            <>
              <p className={new Set(task.hashes.map((hash) => hash.hash)).size === 1 ? "text-success" : "text-danger"}>
                {new Set(task.hashes.map((hash) => hash.hash)).size === 1
                  ? "All measured members match"
                  : "Member hashes differ"}
              </p>
              <ul>
                {task.hashes.map((hash) => (
                  <li className="select-text font-grid" key={hash.endpointId}>
                    {hash.endpointId} · revision {hash.revision} · hash {hash.hash} · compact revision{" "}
                    {hash.compactRevision}
                  </li>
                ))}
              </ul>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
