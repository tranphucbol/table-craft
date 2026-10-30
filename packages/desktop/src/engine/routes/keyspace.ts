import type { KeyApplyOptions, Keyspace, Session } from "@table-craft/plugin-api";
import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import { BUG_HINT, EngineFailure, helperRequestFailed } from "@table-craft/desktop/engine/failures.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";
import type { KeyAdvancedCalls } from "@table-craft/desktop/engine/protocol.js";

const NO_KEYSPACE = "This datasource's plugin does not declare the keyValue capability.";

function requireRevisionGuard(keyspace: Keyspace, options: KeyApplyOptions): void {
  if (options.lease !== undefined && keyspace.features?.leaseAssignment !== true) {
    throw new EngineFailure({
      code: "invalidRequest",
      message: "This datasource does not support lease assignment.",
      hint: "Reload the key and use its supported expiry controls.",
    });
  }
  if (options.revisionGuard !== undefined && keyspace.features?.revisionGuard !== true) {
    throw new EngineFailure({
      code: "invalidRequest",
      message: "This datasource does not support revision-guarded key changes.",
      hint: "Reload the key and use the datasource's supported edit workflow instead.",
    });
  }
}

function keyspaceOf(session: Session): Keyspace {
  if (session.keyspace === undefined) {
    throw new EngineFailure({ code: "invalidRequest", message: NO_KEYSPACE, hint: BUG_HINT });
  }
  return session.keyspace;
}

/** The key tree and key actions of a `keyValue` datasource (decision 113), on the engine's helper session. */
export function keyspaceRoutes(connection: ConnectionContext): Omit<RoutesFor<"keyspace">, keyof KeyAdvancedCalls> {
  const { onHelper, openKey } = connection;
  const on = <T>(work: (keyspace: Keyspace) => Promise<T>): Promise<T> =>
    onHelper((session) => work(keyspaceOf(session))).catch((cause: unknown) => {
      throw helperRequestFailed(cause);
    });
  const write = <T>(work: (keyspace: Keyspace) => Promise<T>): Promise<T> =>
    connection.keyOperations.scope
      .run("keyValue", true, (session) => work(keyspaceOf(session)))
      .catch((cause: unknown) => {
        throw helperRequestFailed(cause);
      });
  return {
    "keyspace.databases": () =>
      on(async (keyspace) => ({
        delimiter: keyspace.delimiter,
        databases: await keyspace.databases(),
        features: { ...keyspace.features, history: typeof keyspace.history === "function" },
      })),
    "keyspace.history": ({ database, key, cursor, count, maxBytes, timeoutMs }) =>
      on((keyspace) => {
        if (keyspace.history === undefined) {
          throw new EngineFailure({
            code: "invalidRequest",
            message: "This datasource does not support key history.",
            hint: "Use a datasource whose plugin provides key history, or update its plugin if available.",
          });
        }
        return keyspace.history({ database, key, cursor, count, maxBytes, timeoutMs });
      }),
    "keyspace.scan": ({ database, cursor, match, keyType }) =>
      on((keyspace) => keyspace.scan({ database, cursor, match, type: keyType })),
    "keyspace.describe": ({ database, keys }) => on((keyspace) => keyspace.describe(database, keys)),
    "keyspace.open": (request) => openKey(request),
    "keyspace.preview": ({ key, changes, options }) =>
      on((keyspace) => {
        requireRevisionGuard(keyspace, options);
        return Promise.resolve(keyspace.preview(key, changes, options));
      }),
    "keyspace.apply": ({ database, key, changes, options }) =>
      write((keyspace) => {
        requireRevisionGuard(keyspace, options);
        return keyspace.apply(database, key, changes, options);
      }),
    "keyspace.rename": ({ database, key, to, overwrite }) =>
      write(async (keyspace) => {
        await keyspace.rename(database, key, to, overwrite);
        return null;
      }),
    "keyspace.expire": ({ database, key, expiry }) =>
      write(async (keyspace) => {
        await keyspace.expire(database, key, expiry);
        return null;
      }),
    "keyspace.remove": ({ database, keys }) => write((keyspace) => keyspace.remove(database, keys)),
  };
}
