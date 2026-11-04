import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";
import { languageServiceOf } from "@table-craft/desktop/engine/services.js";

export function sqlRoutes(connection: ConnectionContext): RoutesFor<"sql"> {
  const { sqlLanguage, formatText, generate } = connection;
  return {
    "sql.format": ({ text, options: format }) => Promise.resolve(formatText(text, format)),
    "sql.explainable": ({ sql, analyze }) =>
      Promise.resolve(languageServiceOf(sqlLanguage(), "explain").explainable(sql, { analyze })),
    "sql.generate": ({ path, name, statement }) => generate(path, name, statement),
  };
}
