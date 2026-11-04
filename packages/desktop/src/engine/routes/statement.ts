import { assertExecutable } from "@table-craft/desktop/engine/admission.js";
import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";
import { serviceOf } from "@table-craft/desktop/engine/services.js";

export function statementRoutes(connection: ConnectionContext): RoutesFor<"statement"> {
  const { sessionFor, runStatement, explainStatement } = connection;
  return {
    "statement.execute": (request) => {
      assertExecutable(connection.commandLanguage(), request.sql);
      const { sessionId, sql, parameters, pageRows, fetchAllCap, node, repeat } = request;
      return runStatement(sessionId, sql, parameters, { pageRows, fetchAllCap }, request, {
        ...(node === undefined ? {} : { node }),
        ...(repeat === undefined ? {} : { repeat }),
      });
    },
    "statement.cancel": async ({ sessionId }) => {
      const open = sessionFor(sessionId);
      const canceller = serviceOf(open.session, "cancel");
      if (open.waiting.size > 0) {
        for (const stop of open.waiting) stop();
        return null;
      }
      if (open.running > 0) await canceller.cancel();
      return null;
    },
    "statement.explain": async (request) => {
      assertExecutable(connection.commandLanguage(), request.sql);
      return explainStatement(request);
    },
  };
}
