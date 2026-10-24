import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";

export function editsRoutes(connection: ConnectionContext): RoutesFor<"edits"> {
  const { editStatements, submit } = connection;
  return {
    "edits.preview": ({ handle, edits }) => Promise.resolve(editStatements(handle, edits)),
    "edits.submit": (request) => submit(request),
  };
}
