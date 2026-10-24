import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";

export function namespaceRoutes(connection: ConnectionContext): RoutesFor<"namespace"> {
  const { switchTargets, switchStatement } = connection;
  return {
    "namespace.targets": ({ refresh }) => switchTargets(refresh),
    "namespace.switchStatement": ({ path }) => Promise.resolve(switchStatement(path)),
  };
}
