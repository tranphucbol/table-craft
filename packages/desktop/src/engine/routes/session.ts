import { loadedPlugin } from "@table-craft/core";
import { connectDatasource } from "@table-craft/desktop/engine/connect.js";
import type { ConnectionContext, OpenSession } from "@table-craft/desktop/engine/connection.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";

export function sessionRoutes(connection: ConnectionContext): RoutesFor<"session"> {
  const { options, now, connector, nextSessionId, sessions, releaseHandlesOf, sessionFor, namespaceOf } = connection;
  return {
    "session.open": async (params) => {
      const readOnly = options.datasource.readOnly || params.readOnly === true;
      const session = await connectDatasource(options, connector, readOnly);
      const { manifest, plugin } = loadedPlugin(options.plugins, options.datasource.pluginId);
      const sessionId = nextSessionId();
      const opening = await namespaceOf({ session, capabilities: plugin.capabilities });
      const open: OpenSession = {
        session,
        capabilities: plugin.capabilities,
        readOnly,
        running: 0,
        opening,
        moved: false,
        switchedBy: null,
        lastUsed: now(),
        lost: null,
        closing: null,
        waiting: new Set(),
        exporting: 0,
      };
      const namespace = opening ?? null;
      sessions.set(sessionId, open);
      return {
        sessionId,
        pluginName: manifest.name,
        capabilities: plugin.capabilities,
        serverVersion: session.serverVersion,
        serverBrand: session.serverBrand ?? null,
        namespace,
      };
    },
    "session.close": async ({ sessionId }) => {
      const open = sessionFor(sessionId);
      sessions.delete(sessionId);
      await releaseHandlesOf(sessionId);
      await open.session.close();
      return null;
    },
  };
}
