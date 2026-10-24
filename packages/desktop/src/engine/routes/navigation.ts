import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";

export function navigationRoutes(connection: ConnectionContext): RoutesFor<"navigation"> {
  const { resolve } = connection;
  return {
    "navigation.resolve": ({ text, offset, current }) => resolve({ text, offset }, current),
  };
}
