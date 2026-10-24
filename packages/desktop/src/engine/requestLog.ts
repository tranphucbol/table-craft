import type { ConnectionField } from "@table-craft/plugin-api";
import type { EngineError } from "@table-craft/desktop/engine/protocol.js";
import type { Logger, LogFields } from "@table-craft/desktop/log/record.js";

/**
 * What the engine logs about each request (plan 017 decisions 5 and 7): the envelope at debug,
 * a summary of the requests a developer reconstructs a session from at info, and every failure.
 * Never a statement's text, a row value or a config secret.
 */

export interface LoggedRequest {
  readonly id: number;
  readonly type: string;
  readonly [field: string]: unknown;
}

export interface RequestContext {
  readonly log: Logger;
  readonly elapsedMs: number;
  /** The statement kind from the plugin's classifier, for requests that carry SQL; null otherwise. */
  readonly statementKind: string | null;
  /** The datasource's connection fields that are safe to log, for `session.open`. */
  readonly target: LogFields;
}

/** Field keys that name a person rather than a place, left out of the connect record with the secrets. */
const IDENTITY_KEY = /user|login|account/i;

/** The config values a connect record carries: every manifest field that is neither secret, a password, nor a user name. */
export function connectionTarget(fields: readonly ConnectionField[], config: unknown): LogFields {
  const values = (typeof config === "object" && config !== null ? config : {}) as Record<string, unknown>;
  const target: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.secret === true || field.kind === "password" || IDENTITY_KEY.test(field.key)) continue;
    const value = values[field.key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") target[field.key] = value;
  }
  return target;
}

const SCOPES: Readonly<Record<string, string>> = {
  "session.open": "connection",
  "session.close": "connection",
  "statement.execute": "query",
  "statement.cancel": "query",
  "statement.explain": "query",
  "table.query": "query",
  "result.fetchMore": "query",
  "transaction.setMode": "transaction",
  "transaction.commit": "transaction",
  "transaction.rollback": "transaction",
  "export.start": "export",
  "export.cancel": "export",
  "export.retry": "export",
  "import.start": "import",
  "import.cancel": "import",
  "import.resume": "import",
  "edits.submit": "edits",
  "objects.apply": "objects",
  "sessions.cancel": "sessions",
  "sessions.terminate": "sessions",
};
const DEFAULT_SCOPE = "request";

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** What a change touched, by kind and name only (plan 024): never a design's columns, defaults or comments. */
function changedObject(change: unknown): LogFields {
  const value = record(change);
  const object = record(value.object);
  const design = record(value.design);
  const kind = value.kind;
  if (kind === "rename" || kind === "drop")
    return { change: kind, objectKind: object.kind, object: object.name, to: value.name };
  if (kind === "truncate" || kind === "alterTable")
    return { change: kind, objectKind: "table", object: value.relation };
  if (kind === "createTable") return { change: kind, objectKind: "table", object: design.name };
  return { change: kind, objectKind: "namespace", object: value.name };
}

/** How many messages the server raised and their codes; their text may quote the user's data, so it never is (decision 066). */
/** How many messages the server left and their codes, never their text, which can quote data (decision 066). */
export function messageFields(messages: unknown): LogFields {
  if (!Array.isArray(messages) || messages.length === 0) return {};
  const codes = messages.map((message) => record(message).code).filter((code) => typeof code === "string");
  return { messageCount: messages.length, messageCodes: [...new Set(codes)] };
}

/** Which server session a cancel or terminate aimed at, by id and instance; never the statement it ran. */
function serverSession(target: unknown): LogFields {
  const value = record(target);
  return { serverSession: value.id, instance: value.instance };
}

function summary(request: LoggedRequest, result: unknown, context: RequestContext): [string, LogFields] | null {
  const value = record(result);
  const base = { requestId: request.id, elapsedMs: context.elapsedMs };
  switch (request.type) {
    case "session.open":
      return [
        "connected",
        { ...base, sessionId: value.sessionId, serverVersion: value.serverVersion, ...context.target },
      ];
    case "session.close":
      return ["session closed", { ...base, sessionId: request.sessionId }];
    case "statement.execute":
      return [
        "statement finished",
        {
          ...base,
          sessionId: request.sessionId,
          kind: context.statementKind,
          rowCount: value.rowCount,
          rowsAffected: value.rowsAffected,
          complete: value.complete,
          transactionOpen: value.transactionOpen,
          ...messageFields(value.messages),
        },
      ];
    case "statement.cancel":
      return ["cancel requested", { ...base, sessionId: request.sessionId }];
    case "statement.explain":
      return [
        "plan explained",
        {
          ...base,
          sessionId: request.sessionId,
          kind: context.statementKind,
          analyze: request.analyze,
          ...messageFields(record(value.plan).messages),
        },
      ];
    case "table.query":
      return ["table opened", { ...base, sessionId: request.sessionId, rowCount: record(value.statement).rowCount }];
    case "transaction.setMode":
      return ["transaction mode set", { ...base, sessionId: request.sessionId, mode: value.mode }];
    case "transaction.commit":
      return ["transaction committed", { ...base, sessionId: request.sessionId }];
    case "transaction.rollback":
      return ["transaction rolled back", { ...base, sessionId: request.sessionId }];
    case "export.start":
    case "export.retry":
      return [
        "export started",
        { ...base, taskId: value.taskId, format: value.format, origin: value.origin, retryOf: request.taskId },
      ];
    case "export.cancel":
      return ["export cancel requested", { ...base, taskId: request.taskId }];
    case "import.start":
    case "import.resume":
      return [
        "import started",
        {
          ...base,
          taskId: value.taskId,
          transaction: record(value.transaction).mode,
          size: value.size,
          resumeFrom: value.resumeFrom,
          resumeOf: request.taskId,
        },
      ];
    case "import.cancel":
      return ["import cancel requested", { ...base, taskId: request.taskId }];
    case "edits.submit":
      return [
        "edits submitted",
        {
          ...base,
          sessionId: request.sessionId,
          edits: Array.isArray(request.edits) ? request.edits.length : null,
          rowsAffected: value.rowsAffected,
        },
      ];
    case "objects.apply":
      return ["object changed", { ...base, ...changedObject(request.change), statements: value.statements }];
    case "sessions.cancel":
      return ["cancelled query of session", { ...base, ...serverSession(request.target), ...context.target }];
    case "sessions.terminate":
      return ["terminated session", { ...base, ...serverSession(request.target), ...context.target }];
    default:
      return null;
  }
}

const FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  "session.open": "connect failed",
  "statement.execute": "statement failed",
  "export.start": "export refused",
  "export.retry": "export refused",
  "import.start": "import refused",
  "import.resume": "import refused",
  "edits.submit": "edits rejected",
  "objects.apply": "object change failed",
  "sessions.cancel": "session cancel failed",
  "sessions.terminate": "session terminate failed",
};

export type RequestOutcome =
  | { readonly result: unknown }
  /** `cause` is what was thrown, logged as `err` so the driver's code and the cause chain survive. */
  | { readonly error: EngineError; readonly cause: unknown };

export function logResponse(request: LoggedRequest, outcome: RequestOutcome, context: RequestContext): void {
  const scoped = context.log.child(SCOPES[request.type] ?? DEFAULT_SCOPE);
  const failed = "error" in outcome;
  scoped.debug("request", {
    requestId: request.id,
    type: request.type,
    elapsedMs: context.elapsedMs,
    outcome: failed ? outcome.error.code : "ok",
  });
  if (!failed) {
    const described = summary(request, outcome.result, context);
    if (described !== null) scoped.info(...described);
    return;
  }
  const fields = {
    requestId: request.id,
    type: request.type,
    elapsedMs: context.elapsedMs,
    code: outcome.error.code,
    error: outcome.error.message,
    ...(context.statementKind === null ? {} : { kind: context.statementKind }),
    ...(request.type === "session.open" ? context.target : {}),
    ...(request.type === "objects.apply" ? changedObject(request.change) : {}),
    ...(request.type === "sessions.cancel" || request.type === "sessions.terminate"
      ? { ...serverSession(request.target), ...context.target }
      : {}),
    err: outcome.cause,
  };
  const message = FAILURE_MESSAGES[request.type] ?? "request failed";
  if (outcome.error.code === "cancelled") scoped.info(message, fields);
  else scoped.warn(message, fields);
}
