import type { KeySource } from "./keyspace.js";
import type { ResultState, ResultWindow } from "./results.js";
import type { CancelReach, Capability, Column, CommandReply, ProbeResult, ServerTimeout, TypeClass } from "./wire.js";

/** Mirrors `ServerSessionState` in plugin-api. */
export type ServerSessionState = "active" | "idle" | "idleInTransaction" | "blocked" | "other";

/** Mirrors `ServerSession` in plugin-api: one session on the server (decision 088). */
export interface ServerSession {
  readonly id: string;
  readonly instance: string | null;
  readonly state: ServerSessionState;
  readonly rawState: string | null;
  readonly user: string | null;
  readonly database: string | null;
  readonly client: string | null;
  readonly application: string | null;
  readonly queryMs: number | null;
  readonly transactionMs: number | null;
  readonly waitEvent: string | null;
  readonly blockedBy: readonly string[] | null;
  readonly query: string | null;
  readonly system: boolean;
  readonly cancel: string | null;
  readonly terminate: string | null;
}

/** Mirrors `SessionTarget` in plugin-api. */
export interface SessionTarget {
  readonly id: string;
  readonly instance: string | null;
}

/** A listed server session, and whether it is one of this engine's own connections. */
export interface ListedSession extends ServerSession {
  /** This engine's session id for it, as `session.open` returned it; null for the catalog's connection and everyone else's. */
  readonly ownSessionId: string | null;
  readonly own: boolean;
}

/** What `sessions.list` answers: the server's sessions, and what the listing leaves out and why. */
export interface SessionsListing {
  readonly sessions: readonly ListedSession[];
  readonly notes: readonly string[];
}

/** Mirrors `TransactionMode` in plugin-api: `auto` commits each statement, `manual` holds one transaction open. */
export type TransactionMode = "auto" | "manual";

/** A session's transaction after a transaction request. */
export interface TransactionState {
  readonly mode: TransactionMode;
  readonly transactionOpen: boolean;
  /** The session's namespace after a commit or rollback, which may undo a switch; see `ExecutedStatement`. */
  readonly namespace?: CurrentNamespace;
}

/**
 * The namespace a console's session is in, as an introspector path (decision 048); null when the
 * plugin reports none, such as a search_path that names no schema.
 */
export type CurrentNamespace = readonly string[] | null;

/** A namespace switch as the plugin writes it; `transactional` when a rollback undoes it. */
export interface SwitchStatement {
  readonly sql: string;
  readonly transactional: boolean;
}

/** Mirrors `ResultSummary` in core, with the first window and the session's transaction attached. */
export interface ExecutedStatement extends ResultState {
  readonly handle: string;
  readonly columns: readonly Column[];
  readonly typeClasses: readonly TypeClass[];
  readonly rowsAffected: number | null;
  readonly firstWindow: ResultWindow;
  /** Whether the session holds a transaction open after the statement; always false without `transactions`. */
  readonly transactionOpen: boolean;
  /**
   * Present only when the engine read the session's namespace after the statement: it may have
   * switched one (decision 048). Absent, the console keeps the namespace it had.
   */
  readonly namespace?: CurrentNamespace;
  /** Present when the engine replaced a lost session before running the statement (decision 054). */
  readonly reconnected?: Reconnection;
  /**
   * A command's scalar answer (decision 112): Output shows it, and the result holds it as one
   * `value` row. Only a `read` reply opens that result as a tab; Show as Result opens the rest
   * (decision 119).
   */
  readonly reply?: CommandReply;
  /** The one key the command read, when the plugin can tell (decision 119). */
  readonly source?: KeySource;
}

/** A lost session the engine replaced with a new one under the same `sessionId`. */
export interface Reconnection {
  /** Where the new session starts. */
  readonly namespace: CurrentNamespace;
  /** Whether the old session had moved away from where a session starts, by USE or a search path. */
  readonly namespaceLost: boolean;
  /**
   * Why the old session was replaced when it was not lost (decision 058): its last result did not
   * close within the grace, or the plugin refused a statement as busy. Absent when it was lost.
   */
  readonly reason?: "resultNotClosed" | "sessionBusy";
}

export interface OpenedSession {
  readonly sessionId: string;
  /** The datasource's plugin, by its manifest name, for display only. */
  readonly pluginName: string;
  readonly capabilities: readonly Capability[];
  /** What the server reports about itself, for the status bar; null when it reports nothing. */
  readonly serverVersion: string | null;
  /** The product the server is, one of the plugin's `brands` ids; null when the plugin names none. */
  readonly serverBrand: string | null;
  /** Where the session starts; always null without `currentNamespace`. */
  readonly namespace: CurrentNamespace;
  /** What the server stops by itself under `StatementLimit.serverEnforced`; null when nothing (decision 129). */
  readonly serverTimeout: ServerTimeout | null;
  /** What the app's cancel sends and reaches; null when the plugin does not say (decision 131). */
  readonly cancelReach: CancelReach | null;
}

/**
 * The facts a session or Test Connection last reported, kept on the datasource so Settings › MCP
 * Server can say how a timeout is enforced without connecting (decision 131).
 */
export interface LastServer {
  readonly version: string | null;
  /** Absent without the `serverTimeout` capability; null when the server stops nothing itself. */
  readonly timeout?: ServerTimeout | null | undefined;
  /** Absent when the plugin does not say what its cancel reaches. */
  readonly cancel?: CancelReach | undefined;
  /** Epoch ms. */
  readonly seenAt: number;
}

/** What one connection reported, for main to remember. */
export interface ServerSeen {
  /** One of the plugin's `brands` ids; null when the plugin names none. */
  readonly brand: string | null;
  readonly lastServer: LastServer;
}

/** What an opened session says of its server, as `rememberServer` takes it. */
export function serverSeenOf(opened: OpenedSession, seenAt: number): ServerSeen {
  const timeout = opened.capabilities.includes("serverTimeout") ? { timeout: opened.serverTimeout } : {};
  const cancel = opened.cancelReach === null ? {} : { cancel: opened.cancelReach };
  return { brand: opened.serverBrand, lastServer: { version: opened.serverVersion, ...timeout, ...cancel, seenAt } };
}

/** What a Test Connection that reached the server says of it, as `rememberServer` takes it. */
export function probeSeenOf(probed: Extract<ProbeResult, { ok: true }>, seenAt: number): ServerSeen {
  const timeout = probed.serverTimeout === undefined ? {} : { timeout: probed.serverTimeout };
  const cancel = probed.cancelReach === null ? {} : { cancel: probed.cancelReach };
  return { brand: probed.serverBrand, lastServer: { version: probed.serverVersion, ...timeout, ...cancel, seenAt } };
}
