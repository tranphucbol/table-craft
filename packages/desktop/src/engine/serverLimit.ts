import type { Capability, ExecuteOptions, ServerTimeout, Session } from "@table-craft/plugin-api";
import type { StatementLimit } from "@table-craft/desktop/engine/protocol.js";
import { hasService, serviceOf } from "@table-craft/desktop/engine/services.js";

const MS_PER_SECOND = 1000;

/**
 * The `serverTimeoutMs` the statement carries: the same limit as the engine's timer, and only for
 * a plugin that declares `serverTimeout` on a server that stops something (decision 129). Read
 * from the live session, so a reconnect gets the new server's answer.
 */
export function serverTimeoutOptions(
  limit: StatementLimit,
  session: Session,
  capabilities: readonly Capability[],
): Pick<ExecuteOptions, "serverTimeoutMs"> {
  const seconds = limit.timeoutSeconds ?? 0;
  if (limit.serverEnforced !== true || seconds <= 0) return {};
  if (!capabilities.includes("serverTimeout") || serverTimeoutOf(session) === null) return {};
  return { serverTimeoutMs: seconds * MS_PER_SECOND };
}

/** What the server stops by itself, or null without the `serverTimeout` service or a server limit. */
export function serverTimeoutOf(session: Session): ServerTimeout | null {
  if (!hasService(session, "serverTimeout")) return null;
  const { limit } = serviceOf(session, "serverTimeout");
  return limit === null ? null : { ...limit };
}
