import { inferForeignKeys, searchCatalog } from "@table-craft/core";
import type { NamespaceCatalog } from "@table-craft/plugin-api";
import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import { messageOf } from "@table-craft/desktop/engine/failures.js";
import type { UnreadNamespace } from "@table-craft/desktop/engine/protocol.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";
import { serviceOf } from "@table-craft/desktop/engine/services.js";

export function catalogRoutes(connection: ConnectionContext): RoutesFor<"catalog"> {
  const { introspect, definitionOf, scriptOf } = connection;
  return {
    "catalog.databases": () => introspect(({ session }) => serviceOf(session, "databases")!.list()),
    "catalog.namespaces": ({ refresh }) => introspect(({ cache }) => cache.namespaces(refresh)),
    "catalog.describe": ({ path, refresh }) => introspect(({ cache }) => cache.describe(path, refresh)),
    "catalog.inferredKeys": ({ path }) =>
      introspect(async ({ cache }) => inferForeignKeys((await cache.describe(path, false)).catalog)),
    "catalog.search": async ({ paths, query, scope, limit }) => {
      const catalogs: NamespaceCatalog[] = [];
      const unread: UnreadNamespace[] = [];
      for (const path of paths) {
        try {
          catalogs.push((await introspect(({ cache }) => cache.describe(path, false))).catalog);
        } catch (cause) {
          // Every path failing is a lost connection or a missing capability, not a schema it may not read.
          if (unread.length === paths.length - 1 && catalogs.length === 0) throw cause;
          unread.push({ path, message: messageOf(cause) });
        }
      }
      const hits = searchCatalog(catalogs, query, scope);
      return { hits: hits.slice(0, limit), total: hits.length, unread };
    },
    "catalog.qualifiedName": ({ path, name }) =>
      introspect(({ session }) => serviceOf(session, "schemaTree").qualifiedName(path, name)),
    "catalog.definition": ({ path, name }) => definitionOf(path, name),
    "catalog.script": ({ path, kinds, title }) => scriptOf({ path, kinds, title }),
  };
}
