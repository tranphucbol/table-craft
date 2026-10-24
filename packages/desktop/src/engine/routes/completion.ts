import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";

export function completionRoutes(connection: ConnectionContext): RoutesFor<"completion"> {
  const { complete, signatureAt } = connection;
  return {
    "completion.complete": ({ text, offset, scope, current }) =>
      complete(scope === undefined ? { text, offset } : { text, offset, scope }, current),
    "completion.signature": ({ text, offset, scope }) =>
      signatureAt(scope === undefined ? { text, offset } : { text, offset, scope }),
  };
}
