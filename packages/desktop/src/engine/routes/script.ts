import { assertScriptable } from "@table-craft/desktop/engine/admission.js";
import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import { EngineFailure } from "@table-craft/desktop/engine/failures.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";

export function scriptRoutes(connection: ConnectionContext): RoutesFor<"script"> {
  const { splitScript, scripts, runScript, scriptTaskOf } = connection;
  return {
    "script.split": ({ text }) => Promise.resolve(splitScript(text)),
    "script.run": async (request) => {
      assertScriptable(connection.commandLanguage());
      return runScript(request);
    },
    "script.cancel": ({ taskId }) => {
      scriptTaskOf(taskId);
      scripts.cancel(taskId);
      return Promise.resolve(null);
    },
    "script.answer": ({ taskId, answer }) => {
      scriptTaskOf(taskId);
      if (!scripts.answer(taskId, answer)) {
        throw new EngineFailure({
          code: "invalidRequest",
          message: `Script task "${taskId}" is not waiting for an answer.`,
          hint: "It went on or stopped already; see its line in Services.",
        });
      }
      return Promise.resolve(null);
    },
    "script.list": () => Promise.resolve(scripts.list()),
  };
}
