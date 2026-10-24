import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";

export function sessionsRoutes(connection: ConnectionContext): RoutesFor<"sessions"> {
  const { stopServerSession, listedSessions } = connection;
  return {
    "sessions.list": () => listedSessions(),
    "sessions.cancel": ({ target }) => stopServerSession(target, "cancel"),
    "sessions.terminate": ({ target }) => stopServerSession(target, "terminate"),
  };
}
