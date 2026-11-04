import type { Session } from "@table-craft/plugin-api";
import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import { helperRequestFailed } from "@table-craft/desktop/engine/failures.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";
import { serviceOf } from "@table-craft/desktop/engine/services.js";

/** What a `nodes` datasource's servers are (decision 114), asked on the engine's helper session. */
export function serverRoutes(connection: ConnectionContext): RoutesFor<"server"> {
  const on = <T>(read: (session: Session) => Promise<T>): Promise<T> =>
    connection.onHelper(read).catch((cause: unknown) => {
      throw helperRequestFailed(cause);
    });
  return {
    "server.nodes": () => on((session) => serviceOf(session, "nodes").list()),
    "server.info": ({ node }) => on((session) => serviceOf(session, "serverInfo").info(node)),
    "server.slowLog": ({ node, limit }) => on((session) => serviceOf(session, "serverInfo").slowLog(node, limit)),
  };
}
