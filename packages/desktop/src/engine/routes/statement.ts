import { assertExecutable } from "@table-craft/desktop/engine/admission.js";
import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import { BUG_HINT, EngineFailure } from "@table-craft/desktop/engine/failures.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";

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
      if (!open.capabilities.includes("cancel") || open.session.cancel === undefined) {
        throw new EngineFailure({
          code: "invalidRequest",
          message: "This datasource's plugin does not declare the cancel capability.",
          hint: BUG_HINT,
        });
      }
      if (open.waiting.size > 0) {
        for (const stop of open.waiting) stop();
        return null;
      }
      if (open.running > 0) await open.session.cancel();
      return null;
    },
    "statement.explain": async (request) => {
      assertExecutable(connection.commandLanguage(), request.sql);
      return explainStatement(request);
    },
  };
}
