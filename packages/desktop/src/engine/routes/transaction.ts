import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import { OPEN_TRANSACTION_HINT, TRANSACTION_HINT } from "@table-craft/desktop/engine/failures.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";

export function transactionRoutes(connection: ConnectionContext): RoutesFor<"transaction"> {
  const { transact } = connection;
  return {
    "transaction.setMode": ({ sessionId, mode }) =>
      transact(sessionId, (transactions) => transactions.setMode(mode), OPEN_TRANSACTION_HINT),
    "transaction.commit": ({ sessionId }) =>
      transact(sessionId, (transactions) => transactions.commit(), TRANSACTION_HINT),
    "transaction.rollback": ({ sessionId }) =>
      transact(sessionId, (transactions) => transactions.rollback(), TRANSACTION_HINT),
  };
}
