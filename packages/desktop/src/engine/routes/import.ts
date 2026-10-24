import { MS_PER_SECOND } from "@table-craft/desktop/engine/connect.js";
import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import { EngineFailure } from "@table-craft/desktop/engine/failures.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";

export function importRoutes(connection: ConnectionContext): RoutesFor<"import"> {
  const { imports, previewImport, newTableDdl, startImport, importTaskOf } = connection;
  return {
    "import.preview": ({ file, format }) => previewImport(file, format),
    "import.ddl": async ({ path, relation, columns }) => (await newTableDdl(path, relation, columns)).ddl,
    "import.start": (request) => startImport(request),
    "import.cancel": ({ taskId }) => {
      importTaskOf(taskId);
      imports.cancel(taskId);
      return Promise.resolve(null);
    },
    "import.resume": ({ taskId, stallSeconds }) => {
      if (importTaskOf(taskId).state === "running") {
        throw new EngineFailure({
          code: "invalidRequest",
          message: "This import is still running.",
          hint: "Wait for it to end, or cancel it first.",
        });
      }
      return Promise.resolve(imports.resume(taskId, stallSeconds * MS_PER_SECOND));
    },
    "import.list": () => Promise.resolve(imports.list()),
  };
}
