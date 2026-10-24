/** What a server session is doing, from the dialect's own state (plan 045). */
export const SERVER_SESSION_STATES = ["active", "idle", "idleInTransaction", "blocked", "other"] as const;

export type ServerSessionState = (typeof SERVER_SESSION_STATES)[number];

/**
 * One session on the server, as `SessionMonitor.list` reads it (decision 088). Every field the
 * dialect or the account's grants cannot supply is null.
 */
export interface ServerSession {
  /** The server's id: PostgreSQL's pid, MySQL's connection id. Text, because TiDB's pass 2^53. */
  readonly id: string;
  /** The cluster member the session lives on, as the server names it; null on a single server. */
  readonly instance: string | null;
  readonly state: ServerSessionState;
  /** The server's own words for the state, shown beside it. */
  readonly rawState: string | null;
  readonly user: string | null;
  readonly database: string | null;
  /** Client address, as the server reports it. */
  readonly client: string | null;
  readonly application: string | null;
  /** How long the current or last query has run, by the server's clock when listed. */
  readonly queryMs: number | null;
  /** How long its open transaction has been open, by the server's clock; null when none is. */
  readonly transactionMs: number | null;
  readonly waitEvent: string | null;
  /** Ids of the sessions this one waits on; null when the dialect or the grants cannot tell. */
  readonly blockedBy: readonly string[] | null;
  readonly query: string | null;
  /** A server worker rather than a client connection. */
  readonly system: boolean;
  /** The exact statement `cancelSession` runs for it; null when cancelling it is unsupported or unsafe. */
  readonly cancel: string | null;
  /** The exact statement `terminateSession` runs for it; null when terminating it is unsupported or unsafe. */
  readonly terminate: string | null;
}

export interface SessionListing {
  readonly sessions: readonly ServerSession[];
  /** What the listing leaves out and why, such as a missing grant, with the grant to ask for. */
  readonly notes: readonly string[];
}

/** Which session `cancelSession` and `terminateSession` act on: a listed row's `id` and `instance`. */
export interface SessionTarget {
  readonly id: string;
  readonly instance: string | null;
}

/**
 * The server's sessions, read and stopped by the plugin's own SQL (decisions 008, 088). Calls
 * queue on the session they hang off, like the introspector's.
 */
export interface SessionMonitor {
  list(): Promise<SessionListing>;
  /**
   * Interrupts the target's running statement and leaves it connected. Rejects with
   * `statementFailed` when the server refuses, the target is gone, or it cannot be reached safely.
   */
  cancelSession(target: SessionTarget): Promise<void>;
  /** Ends the target's connection; rejects as `cancelSession` does. */
  terminateSession(target: SessionTarget): Promise<void>;
}
