import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import type { Routes } from "@table-craft/desktop/engine/routes/types.js";
import { sessionRoutes } from "@table-craft/desktop/engine/routes/session.js";
import { statementRoutes } from "@table-craft/desktop/engine/routes/statement.js";
import { scriptRoutes } from "@table-craft/desktop/engine/routes/script.js";
import { sqlRoutes } from "@table-craft/desktop/engine/routes/sql.js";
import { transactionRoutes } from "@table-craft/desktop/engine/routes/transaction.js";
import { resultRoutes } from "@table-craft/desktop/engine/routes/result.js";
import { exportRoutes } from "@table-craft/desktop/engine/routes/export.js";
import { importRoutes } from "@table-craft/desktop/engine/routes/import.js";
import { objectsRoutes } from "@table-craft/desktop/engine/routes/objects.js";
import { catalogRoutes } from "@table-craft/desktop/engine/routes/catalog.js";
import { namespaceRoutes } from "@table-craft/desktop/engine/routes/namespace.js";
import { routineRoutes } from "@table-craft/desktop/engine/routes/routine.js";
import { completionRoutes } from "@table-craft/desktop/engine/routes/completion.js";
import { inspectionRoutes } from "@table-craft/desktop/engine/routes/inspection.js";
import { navigationRoutes } from "@table-craft/desktop/engine/routes/navigation.js";
import { tableRoutes } from "@table-craft/desktop/engine/routes/table.js";
import { editsRoutes } from "@table-craft/desktop/engine/routes/edits.js";
import { sessionsRoutes } from "@table-craft/desktop/engine/routes/sessions.js";
import { keyspaceRoutes } from "@table-craft/desktop/engine/routes/keyspace.js";
import { serverRoutes } from "@table-craft/desktop/engine/routes/server.js";
import { keyAdvancedRoutes } from "@table-craft/desktop/engine/routes/keyAdvanced.js";

/** One function per method prefix; each builds its prefix's handlers over a connection. */
export const ROUTE_GROUPS = [
  sessionRoutes,
  statementRoutes,
  scriptRoutes,
  sqlRoutes,
  transactionRoutes,
  resultRoutes,
  exportRoutes,
  importRoutes,
  objectsRoutes,
  catalogRoutes,
  namespaceRoutes,
  routineRoutes,
  completionRoutes,
  inspectionRoutes,
  navigationRoutes,
  tableRoutes,
  editsRoutes,
  sessionsRoutes,
  serverRoutes,
  keyspaceRoutes,
  keyAdvancedRoutes,
] as const;

export function routesOf(connection: ConnectionContext): Routes {
  return {
    ...sessionRoutes(connection),
    ...statementRoutes(connection),
    ...scriptRoutes(connection),
    ...sqlRoutes(connection),
    ...transactionRoutes(connection),
    ...resultRoutes(connection),
    ...exportRoutes(connection),
    ...importRoutes(connection),
    ...objectsRoutes(connection),
    ...catalogRoutes(connection),
    ...namespaceRoutes(connection),
    ...routineRoutes(connection),
    ...completionRoutes(connection),
    ...inspectionRoutes(connection),
    ...navigationRoutes(connection),
    ...tableRoutes(connection),
    ...editsRoutes(connection),
    ...sessionsRoutes(connection),
    ...serverRoutes(connection),
    ...keyspaceRoutes(connection),
    ...keyAdvancedRoutes(connection),
  };
}
