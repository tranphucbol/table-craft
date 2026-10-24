import { MS_PER_SECOND } from "@table-craft/desktop/engine/connect.js";
import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import { EngineFailure } from "@table-craft/desktop/engine/failures.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";

export function exportRoutes(connection: ConnectionContext): RoutesFor<"export"> {
  const { qualifiedOf, tasks, tableJob, taskOf, absolutePath, exportTables, resultJob } = connection;
  return {
    "export.start": async ({ source, format, path, stallSeconds }) => {
      absolutePath(path);
      const stallMs = stallSeconds * MS_PER_SECOND;
      if (source.kind === "table") {
        const job = await tableJob(source, format, path);
        const task = tasks.start(job, stallMs);
        exportTables.set(task.taskId, await qualifiedOf(source.path, source.relation));
        return task;
      }
      return tasks.start(resultJob(source, format, path), stallMs);
    },
    "export.cancel": ({ taskId }) => {
      taskOf(taskId);
      tasks.cancel(taskId);
      return Promise.resolve(null);
    },
    "export.retry": ({ taskId, stallSeconds }) => {
      if (!taskOf(taskId).retryable) {
        throw new EngineFailure({
          code: "invalidRequest",
          message: "This export wrote rows the grid held, and they cannot be read again.",
          hint: "Run the statement again, then export its result.",
        });
      }
      const task = tasks.retry(taskId, stallSeconds * MS_PER_SECOND);
      const table = exportTables.get(taskId);
      if (table !== undefined) exportTables.set(task.taskId, table);
      return Promise.resolve(task);
    },
    "export.list": () => Promise.resolve(tasks.list()),
  };
}
