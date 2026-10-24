import type { ListedSession, ServerSession } from "@table-craft/desktop/engine/protocol.js";

/** The Sessions tab's filters (plan 045 decision 4). */
export interface SessionsFilters {
  readonly hideIdle: boolean;
  readonly hideSystem: boolean;
  readonly blockedOnly: boolean;
  readonly search: string;
}

export const NO_FILTERS: SessionsFilters = { hideIdle: false, hideSystem: false, blockedOnly: false, search: "" };

/** A row's identity across refreshes: TiDB ids repeat across servers before Global Kill, so the instance is part of it. */
export function sessionKey(session: Pick<ServerSession, "id" | "instance">): string {
  return session.instance === null ? session.id : `${session.instance}/${session.id}`;
}

function isBlocked(session: ServerSession): boolean {
  return session.state === "blocked" || (session.blockedBy !== null && session.blockedBy.length > 0);
}

function searchedText(session: ServerSession): readonly (string | null)[] {
  return [
    session.id,
    session.user,
    session.database,
    session.client,
    session.application,
    session.rawState,
    session.waitEvent,
    session.query,
  ];
}

/** The rows the filters keep, in the server's order. Search matches any text column, ignoring case. */
export function visibleSessions<S extends ServerSession>(sessions: readonly S[], filters: SessionsFilters): S[] {
  const needle = filters.search.trim().toLowerCase();
  return sessions.filter((session) => {
    if (filters.hideIdle && session.state === "idle") return false;
    if (filters.hideSystem && session.system) return false;
    if (filters.blockedOnly && !isBlocked(session)) return false;
    if (needle === "") return true;
    return searchedText(session).some((text) => text !== null && text.toLowerCase().includes(needle));
  });
}

export type SessionTone = "warning" | "danger";

/** Blocked rows are a failure to look at; a transaction left open is something to look at (design-system tones). */
export function sessionTone(session: ServerSession): SessionTone | null {
  if (isBlocked(session)) return "danger";
  if (session.state === "idleInTransaction") return "warning";
  return null;
}

const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const NONE = "—";

/** How long a query or transaction has run: `850 ms`, `42 s`, `3 min 5 s`, `2 h 4 min`, `3 d 1 h`. */
export function sessionDuration(ms: number | null): string {
  if (ms === null) return NONE;
  if (ms < MS_PER_SECOND) return `${Math.max(0, Math.round(ms))} ms`;
  const seconds = Math.floor(ms / MS_PER_SECOND);
  if (seconds < SECONDS_PER_MINUTE) return `${seconds} s`;
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) return `${minutes} min ${seconds % SECONDS_PER_MINUTE} s`;
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) return `${hours} h ${minutes % MINUTES_PER_HOUR} min`;
  return `${Math.floor(hours / HOURS_PER_DAY)} d ${hours % HOURS_PER_DAY} h`;
}

/** A nullable cell as the grid prints it. */
export function sessionText(value: string | null): string {
  return value === null || value === "" ? NONE : value;
}

const STATE_LABELS: Readonly<Record<ServerSession["state"], string>> = {
  active: "active",
  idle: "idle",
  idleInTransaction: "idle in transaction",
  blocked: "blocked",
  other: "other",
};

export function stateLabel(session: ServerSession): string {
  return STATE_LABELS[session.state];
}

export function blockedByText(session: ServerSession): string {
  if (session.blockedBy === null) return NONE;
  return session.blockedBy.length === 0 ? NONE : session.blockedBy.join(", ");
}

/** The row Show in Sessions selects: the backend of that console's engine session. */
export function rowOfEngineSession(sessions: readonly ListedSession[], sessionId: string): ListedSession | null {
  return sessions.find((session) => session.ownSessionId === sessionId) ?? null;
}
