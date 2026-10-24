import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";

export function routineRoutes(connection: ConnectionContext): RoutesFor<"routine"> {
  const { routineCall } = connection;
  return {
    "routine.call": ({ path, name, kind, signature, args }) => routineCall(path, { name, kind, signature }, args),
  };
}
