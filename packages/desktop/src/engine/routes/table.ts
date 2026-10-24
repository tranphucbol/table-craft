import { orderClause } from "@table-craft/core";
import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";

export function tableRoutes(connection: ConnectionContext): RoutesFor<"table"> {
  const { sqlLanguage, countRows, queryTable, condition } = connection;
  return {
    "table.query": (request) => queryTable(request),
    "table.count": ({ path, relation, where }) => countRows(path, relation, where),
    "table.condition": ({ handle, rows, columns }) => Promise.resolve(condition(handle, rows, columns)),
    "table.orderBy": ({ terms }) => Promise.resolve(orderClause(sqlLanguage(), terms)),
  };
}
