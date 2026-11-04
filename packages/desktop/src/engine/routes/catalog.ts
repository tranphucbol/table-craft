import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";
import { serviceOf } from "@table-craft/desktop/engine/services.js";

export function catalogRoutes(connection: ConnectionContext): RoutesFor<"catalog"> {
  const { introspect, definitionOf, scriptOf } = connection;
  return {
    "catalog.namespaces": ({ refresh }) => introspect(({ cache }) => cache.namespaces(refresh)),
    "catalog.describe": ({ path, refresh }) => introspect(({ cache }) => cache.describe(path, refresh)),
    "catalog.qualifiedName": ({ path, name }) =>
      introspect(({ session }) => serviceOf(session, "schemaTree").qualifiedName(path, name)),
    "catalog.definition": ({ path, name }) => definitionOf(path, name),
    "catalog.script": ({ path, kinds, title }) => scriptOf({ path, kinds, title }),
  };
}
