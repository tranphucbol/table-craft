import { CoreError, EditRejectedError, TunnelError } from "@table-craft/core";
import {
  errorPositionOf,
  isPluginError,
  isTlsSettingsError,
  offsetOfPosition,
  type SqlLanguage,
} from "@table-craft/plugin-api";
import {
  STATEMENT_CANCELLED_MESSAGE,
  type EngineError,
  type Explainability,
} from "@table-craft/desktop/engine/protocol.js";
import type { SessionLost } from "@table-craft/desktop/engine/watch.js";

export const BUG_HINT = "This is a TableCraft bug; restart the app and report it.";

export class EngineFailure extends Error {
  constructor(
    readonly error: EngineError,
    cause?: unknown,
  ) {
    super(error.message, cause === undefined ? undefined : { cause });
  }
}

export function toEngineError(cause: unknown): EngineError {
  if (cause instanceof EngineFailure) return cause.error;
  if (cause instanceof EditRejectedError) {
    return { code: cause.code, message: cause.message, hint: cause.hint, statementIndex: cause.statementIndex };
  }
  if (cause instanceof CoreError) return { code: cause.code, message: cause.message, hint: cause.hint };
  const message = cause instanceof Error ? cause.message : String(cause);
  return { code: "internal", message, hint: BUG_HINT };
}

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export const CONNECTION_HINT =
  "Check that the database is running and that the host, port, user and password are right.";
export const TLS_SETTINGS_HINT = "Fix the SSL settings under SSH/SSL in the data source's properties.";

export function connectionFailed(cause: unknown): unknown {
  if (!isPluginError(cause) || cause.code !== "connectionFailed") return cause;
  return new EngineFailure(
    {
      code: "connectionFailed",
      message: `Could not connect: ${cause.message}`,
      hint: isTlsSettingsError(cause) ? TLS_SETTINGS_HINT : CONNECTION_HINT,
    },
    cause,
  );
}

export const STATEMENT_HINT = "Fix the statement and run it again.";
export const FORMAT_HINT = "The text is unchanged; fix what the reason points at and reformat again.";
export const READ_ONLY_STATEMENT_HINT =
  "This data source is read-only, so writes are refused; clear Read-only in its properties to write.";

export const SERVER_TIMEOUT_HINT =
  "Narrow it with LIMIT or WHERE and run it again, or raise the statement timeout; rows already read stay readable.";
export const RECONNECT_HINT = "Run it again; the console reconnects first.";
export const UNKNOWN_OUTCOME_HINT = "Run it again to reconnect, but check first whether it took effect.";

export function positionIn(sent: string, cause: unknown): number | undefined {
  const position = errorPositionOf(cause);
  return position === undefined ? undefined : offsetOfPosition(sent, position);
}

/**
 * `sent` is the text the plugin ran, when it is also the request's own `sql`: only then does the
 * plugin's error position point into the user's text (decision 082).
 */
export function statementFailed(cause: unknown, readOnly: boolean, sent?: string): EngineFailure {
  if (cause instanceof EngineFailure) return cause;
  if (isPluginError(cause) && cause.code === "connectionLost") {
    return new EngineFailure({ code: "connectionLost", message: cause.message, hint: RECONNECT_HINT }, cause);
  }
  if (isPluginError(cause) && cause.code === "cancelled") {
    return new EngineFailure({ code: "cancelled", message: cause.message, hint: "Run it again when ready." });
  }
  if (isPluginError(cause) && cause.code === "sessionBusy") return sessionBusy();
  if (isPluginError(cause) && cause.code === "timedOut") {
    return new EngineFailure({ code: "statementTimedOut", message: cause.message, hint: SERVER_TIMEOUT_HINT }, cause);
  }
  if (cause instanceof TunnelError) {
    return new EngineFailure({ code: cause.code, message: cause.message, hint: cause.hint }, cause);
  }
  const position = sent === undefined ? undefined : positionIn(sent, cause);
  return new EngineFailure(
    {
      code: "statementFailed",
      message: messageOf(cause),
      hint: readOnly ? READ_ONLY_STATEMENT_HINT : STATEMENT_HINT,
      ...(position === undefined ? {} : { position }),
    },
    cause,
  );
}

export const CONFLICT_HINT = "Reload to see the other change, or overwrite it with yours.";

/**
 * A plugin's refusal of a request on the helper session, keyspace or server figures: a typed
 * failure, while a non-plugin error stays the bug it is.
 */
export function helperRequestFailed(cause: unknown): unknown {
  if (!isPluginError(cause)) return cause;
  if (cause.code === "conflict") {
    return new EngineFailure({ code: "conflict", message: cause.message, hint: CONFLICT_HINT }, cause);
  }
  return statementFailed(cause, false);
}

export function explainFailed(cause: unknown, readOnly: boolean): EngineFailure {
  if (isPluginError(cause) && cause.code === "explainUnsupported") {
    return new EngineFailure({
      code: "explainUnsupported",
      message: cause.message,
      hint: "Put the caret in a statement this database can explain.",
    });
  }
  return statementFailed(cause, readOnly);
}

export function explainabilityOf(language: SqlLanguage, sql: string, analyze: boolean): Explainability {
  if (language.explainable === undefined) {
    throw new EngineFailure({
      code: "invalidRequest",
      message: "This datasource's plugin does not declare the explain capability.",
      hint: BUG_HINT,
    });
  }
  return language.explainable(sql, { analyze });
}

export const INTROSPECTION_HINT =
  "Check that this user may read the schema, then choose Synchronize (⌥⌘Y) to try again.";

export const DEFINITION_HINT = "Choose Synchronize (⌥⌘Y) to see what the namespace holds now.";

export function introspectionFailed(cause: unknown): unknown {
  if (!isPluginError(cause)) return cause;
  if (cause.code === "definitionNotFound") {
    return new EngineFailure({ code: "definitionNotFound", message: cause.message, hint: DEFINITION_HINT });
  }
  if (cause.code !== "introspectionFailed") return cause;
  return new EngineFailure({ code: "introspectionFailed", message: cause.message, hint: INTROSPECTION_HINT });
}

export const TRANSACTION_HINT = "Check the connection, then try again; the transaction may already have ended.";

export function transactionLost(): EngineFailure {
  return new EngineFailure({
    code: "connectionLost",
    message: "The connection was lost with a transaction open; its uncommitted changes are gone.",
    hint: "Run again to reconnect, then repeat the transaction's statements.",
  });
}

export function lostInFlight(cause: SessionLost, timeoutSeconds: number): EngineFailure {
  const message =
    cause.reason === "cancelUnanswered"
      ? `The statement timed out after ${String(timeoutSeconds)} s and the server did not answer the cancel, so the connection was dropped.`
      : "The connection was lost while the statement ran; it may have completed on the server.";
  return new EngineFailure({ code: "connectionLost", message, hint: UNKNOWN_OUTCOME_HINT }, cause);
}

export function timedOut(seconds: number): EngineFailure {
  return new EngineFailure({
    code: "statementTimedOut",
    message: `The statement timed out after ${String(seconds)} s and was cancelled.`,
    hint: "Raise the statement timeout in the data source's Advanced settings, or in Settings → Editor → Running.",
  });
}

export const BUSY_HINT = "Run it again; the console reconnects first.";

export function sessionBusy(): EngineFailure {
  return new EngineFailure({
    code: "sessionBusy",
    message: "The session was still busy with an earlier result, so it was dropped.",
    hint: BUSY_HINT,
  });
}

export function exportDraining(): EngineFailure {
  return new EngineFailure({
    code: "sessionBusy",
    message: "An export is still reading this console's result.",
    hint: "Wait for the export to finish, or cancel it in Services, then run again.",
  });
}

export function waitCancelled(): EngineFailure {
  return new EngineFailure({
    code: "cancelled",
    message: STATEMENT_CANCELLED_MESSAGE,
    hint: "Run it again when ready.",
  });
}

export const OPEN_TRANSACTION_HINT = "Commit or roll back the open transaction first.";
export const SYNCHRONIZE_HINT = "Choose Synchronize (⌥⌘Y), then open the table again.";

export const FORMAT_OPTIONS_HINT = "Check the format options (encoding, delimiter, quote) against the file.";

export const FILE_HINT = "Check that the file exists and that TableCraft may read it, then choose it again.";
export const READ_ONLY_IMPORT = "This data source is read-only, so it cannot be imported into.";
export const READ_ONLY_IMPORT_HINT = "Clear Read-only in the data source's properties to import.";
export const PRIVATE_IMPORT =
  "An in-memory database cannot be imported into: the import's own connection would see another database.";
export const PRIVATE_IMPORT_HINT = "Save the database to a file, or insert the rows from a console.";
export const READ_ONLY_OBJECTS = "This data source is read-only, so its objects cannot be changed.";
export const READ_ONLY_OBJECTS_HINT = "Clear Read-only in the data source's properties to change its objects.";
export const PRIVATE_OBJECTS =
  "An in-memory database's objects cannot be changed from the tree: the change's own connection would see another database.";
export const PRIVATE_OBJECTS_HINT = "Save the database to a file, or run the statement from a console.";
export const DESIGN_HINT = "Fix the design and preview it again.";
export const ROUTINE_ARGUMENTS_HINT = "Change the arguments in the dialog and try again.";
export const OBJECT_BUSY_HINT = "Wait for it to finish or cancel it in the Services tool window, then try again.";
export const STALE_PREVIEW =
  "The object changed since the preview, so the statements to run differ from what was shown.";
export const STALE_PREVIEW_HINT = "Review the new preview, then apply again.";

export const READ_ONLY_SESSIONS =
  "This data source is read-only, so its server sessions cannot be cancelled or terminated.";
export const READ_ONLY_SESSIONS_HINT =
  "Clear Read-only in the data source's properties to cancel or terminate sessions.";
export const SESSION_STOP_HINT = "Refresh the list: the session may have ended, or this user may not have the right.";

export const STALE_CATALOG_REASON = "The table's columns differ from the cached catalog; synchronize to edit it.";
export const SERVER_SORT_HINT = "Sort a table editor on the server: click the column header or edit ORDER BY.";
