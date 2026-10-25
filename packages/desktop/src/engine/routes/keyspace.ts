import type { Keyspace, Session } from "@table-craft/plugin-api";
import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import { BUG_HINT, EngineFailure, helperRequestFailed } from "@table-craft/desktop/engine/failures.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";

const NO_KEYSPACE = "This datasource's plugin does not declare the keyValue capability.";

function keyspaceOf(session: Session): Keyspace {
  if (session.keyspace === undefined) {
    throw new EngineFailure({ code: "invalidRequest", message: NO_KEYSPACE, hint: BUG_HINT });
  }
  return session.keyspace;
}

/** The key tree and key actions of a `keyValue` datasource (decision 113), on the engine's helper session. */
export function keyspaceRoutes(connection: ConnectionContext): RoutesFor<"keyspace"> {
  const { onHelper, openKey } = connection;
  const on = <T>(work: (keyspace: Keyspace) => Promise<T>): Promise<T> =>
    onHelper((session) => work(keyspaceOf(session))).catch((cause: unknown) => {
      throw helperRequestFailed(cause);
    });
  return {
    "keyspace.databases": () =>
      on(async (keyspace) => ({ delimiter: keyspace.delimiter, databases: await keyspace.databases() })),
    "keyspace.scan": ({ database, cursor, match, keyType }) =>
      on((keyspace) => keyspace.scan({ database, cursor, match, type: keyType })),
    "keyspace.describe": ({ database, keys }) => on((keyspace) => keyspace.describe(database, keys)),
    "keyspace.open": (request) => openKey(request),
    "keyspace.preview": ({ key, changes, options }) =>
      on((keyspace) => Promise.resolve(keyspace.preview(key, changes, options))),
    "keyspace.apply": ({ database, key, changes, options }) =>
      on((keyspace) => keyspace.apply(database, key, changes, options)),
    "keyspace.rename": ({ database, key, to, overwrite }) =>
      on(async (keyspace) => {
        await keyspace.rename(database, key, to, overwrite);
        return null;
      }),
    "keyspace.expire": ({ database, key, expiry }) =>
      on(async (keyspace) => {
        await keyspace.expire(database, key, expiry);
        return null;
      }),
    "keyspace.remove": ({ database, keys }) => on((keyspace) => keyspace.remove(database, keys)),
  };
}
