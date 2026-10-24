import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";

export function catalogRoutes(connection: ConnectionContext): RoutesFor<"catalog"> {
  const { introspect, definitionOf } = connection;
  return {
    "catalog.namespaces": ({ refresh }) => introspect(({ cache }) => cache.namespaces(refresh)),
    "catalog.describe": ({ path, refresh }) => introspect(({ cache }) => cache.describe(path, refresh)),
    "catalog.qualifiedName": ({ path, name }) =>
      introspect(({ session }) => session.introspector?.qualifiedName(path, name) ?? name),
    "catalog.definition": ({ path, name }) => definitionOf(path, name),
  };
}
