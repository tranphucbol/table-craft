import {
  PluginError,
  type ServerSession,
  type SessionListing,
  type SessionMonitor,
  type SessionTarget,
} from "@table-craft/plugin-api";
import type { Client } from "./connect.js";

const MS_PER_SECOND = 1000;
/** The `CLIENT LIST` flags of a replica's or the primary's replication link, not a client. */
const REPLICATION_FLAGS = /[SM]/;
const BLOCKED_FLAG = "b";
const NOT_IN_MULTI = "-1";
const NO_COMMAND = "NULL";

/** What the monitor reads through: every primary, and its own calls queued on the session. */
export interface SessionsHost {
  readonly mode: "standalone" | "cluster";
  primaries(): Promise<readonly { readonly node: string; readonly client: Client }[]>;
  queued<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * A listed client's id. Client ids repeat across the nodes of a cluster, so there it carries the
 * node: `12@127.0.0.1:7001`.
 */
export function sessionId(clientId: string, node: string | null): string {
  return node === null ? clientId : `${clientId}@${node}`;
}

export function parseSessionId(id: string): { readonly clientId: string; readonly node: string | null } {
  const at = id.indexOf("@");
  return at < 0 ? { clientId: id, node: null } : { clientId: id.slice(0, at), node: id.slice(at + 1) };
}

/** One `CLIENT LIST` line as its `field=value` pairs; Redis allows no space in a client name. */
export function clientFields(line: string): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  for (const pair of line.trim().split(" ")) {
    const equals = pair.indexOf("=");
    if (equals > 0) fields.set(pair.slice(0, equals), pair.slice(equals + 1));
  }
  return fields;
}

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

/** One client of `CLIENT LIST` as a server session (decision 21 of plan 058). */
export function clientSession(line: string, node: string | null): ServerSession | null {
  const fields = clientFields(line);
  const clientId = fields.get("id");
  if (clientId === undefined) return null;
  const flags = fields.get("flags") ?? "";
  const blocked = flags.includes(BLOCKED_FLAG);
  const inMulti = (fields.get("multi") ?? NOT_IN_MULTI) !== NOT_IN_MULTI;
  const idleSeconds = Number(fields.get("idle") ?? "0");
  const command = fields.get("cmd");
  return {
    id: sessionId(clientId, node),
    instance: null,
    state: blocked ? "active" : inMulti ? "idleInTransaction" : "idle",
    rawState: `flags=${flags}`,
    user: nonEmpty(fields.get("user")),
    database: node ?? `db${fields.get("db") ?? "0"}`,
    client: nonEmpty(fields.get("addr")),
    application: nonEmpty(fields.get("name")),
    queryMs: blocked ? idleSeconds * MS_PER_SECOND : null,
    transactionMs: null,
    waitEvent: blocked ? "blocking command" : null,
    blockedBy: null,
    query: command === undefined || command === NO_COMMAND ? null : command,
    system: REPLICATION_FLAGS.test(flags),
    cancel: blocked ? `CLIENT UNBLOCK ${clientId} ERROR` : null,
    terminate: `CLIENT KILL ID ${clientId}`,
  };
}

/** The server's clients, from `CLIENT LIST` on every primary (decision 21 of plan 058). */
export class RedisSessionMonitor implements SessionMonitor {
  readonly #host: SessionsHost;

  constructor(host: SessionsHost) {
    this.#host = host;
  }

  list(): Promise<SessionListing> {
    return this.#host.queued(async () => {
      const cluster = this.#host.mode === "cluster";
      const sessions: ServerSession[] = [];
      for (const { node, client } of await this.#host.primaries()) {
        const text = String(await client.sendCommand<Buffer | string>(["CLIENT", "LIST"]));
        for (const line of text.split("\n")) {
          const session = clientSession(line, cluster ? node : null);
          if (session !== null) sessions.push(session);
        }
      }
      return { sessions, notes: [] };
    });
  }

  cancelSession(target: SessionTarget): Promise<void> {
    return this.#on(target, ["CLIENT", "UNBLOCK"], ["ERROR"], "is not running a blocking command");
  }

  terminateSession(target: SessionTarget): Promise<void> {
    return this.#on(target, ["CLIENT", "KILL", "ID"], [], "is gone");
  }

  #on(target: SessionTarget, command: readonly string[], after: readonly string[], missing: string): Promise<void> {
    return this.#host.queued(async () => {
      const { clientId, node } = parseSessionId(target.id);
      const primaries = await this.#host.primaries();
      const primary = node === null ? primaries[0] : primaries.find((candidate) => candidate.node === node);
      if (primary === undefined) {
        throw new PluginError("statementFailed", `No primary ${node ?? ""} in this datasource; refresh the sessions.`);
      }
      try {
        const done = await primary.client.sendCommand([...command, clientId, ...after]);
        if (Number(done) === 0) throw new PluginError("statementFailed", `Client ${target.id} ${missing}.`);
      } catch (cause) {
        if (cause instanceof PluginError) throw cause;
        throw new PluginError("statementFailed", cause instanceof Error ? cause.message : String(cause), { cause });
      }
    });
  }
}
