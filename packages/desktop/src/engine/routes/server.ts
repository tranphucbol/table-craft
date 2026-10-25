import type { Session } from "@table-craft/plugin-api";
import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import { BUG_HINT, EngineFailure } from "@table-craft/desktop/engine/failures.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";

const NO_NODES = "This datasource's plugin does not declare the nodes capability.";

function nodesOf(session: Session) {
  if (session.nodes === undefined) {
    throw new EngineFailure({ code: "invalidRequest", message: NO_NODES, hint: BUG_HINT });
  }
  return session.nodes();
}

/** What a `nodes` datasource's servers are (decision 114), asked on the engine's helper session. */
export function serverRoutes(connection: ConnectionContext): RoutesFor<"server"> {
  const { onHelper } = connection;
  return {
    "server.nodes": () => onHelper(nodesOf),
  };
}
