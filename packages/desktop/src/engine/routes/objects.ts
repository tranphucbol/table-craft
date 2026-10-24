import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";

export function objectsRoutes(connection: ConnectionContext): RoutesFor<"objects"> {
  const { objectEditor, objectDesign, objectScript, applyObjectChange } = connection;
  return {
    "objects.features": () => Promise.resolve(objectEditor().features),
    "objects.design": ({ path, relation }) => objectDesign(path, relation),
    "objects.script": ({ change }) => objectScript(change),
    "objects.apply": ({ change, statements: previewed }) => applyObjectChange(change, previewed),
  };
}
