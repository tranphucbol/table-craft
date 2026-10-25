import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";

export function inspectionRoutes(connection: ConnectionContext): RoutesFor<"inspection"> {
  const { inspect } = connection;
  return {
    "inspection.inspect": ({ text, current, disabled }) => inspect(text, current, disabled),
  };
}
