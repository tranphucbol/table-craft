import { PluginError, isPluginError, type Session } from "@table-craft/plugin-api";
import { TunnelError } from "@table-craft/core/errors.js";
import type { Tunnel } from "@table-craft/core/tunnels/tunnel.js";

/** One session's hold on the shared tunnel. */
export interface TunnelLease {
  readonly localPort: number;
  /** Why the tunnel under this lease closed; null while it is open. */
  readonly lost: string | null;
  readonly tunnel: Tunnel;
  /** Idempotent; the tunnel closes when the last lease is released. */
  release(): void;
}

export interface TunnelPool {
  acquire(): Promise<TunnelLease>;
  /** Closes the tunnel whatever its leases; later `acquire` calls fail. */
  close(): Promise<void>;
}

interface Shared {
  readonly tunnel: Tunnel;
  leases: number;
  lost: string | null;
}

const RELEASED = "the last session on it closed";
const CLOSED = "the tunnel was closed";

/**
 * One tunnel per data source, shared by every session its engine host opens (plan 036 decision 4):
 * opened on the first `acquire`, closed when the last lease goes, and opened afresh after a drop.
 */
export function createTunnelPool(open: () => Promise<Tunnel>): TunnelPool {
  let current: Promise<Shared> | null = null;
  let closed = false;

  function start(): Promise<Shared> {
    const opening = open().then((tunnel) => {
      const shared: Shared = { tunnel, leases: 0, lost: null };
      tunnel.onClose((reason) => {
        shared.lost ??= reason ?? CLOSED;
        if (current === opening) current = null;
      });
      return shared;
    });
    current = opening;
    opening.catch(() => {
      if (current === opening) current = null;
    });
    return opening;
  }

  return {
    async acquire() {
      for (;;) {
        if (closed) {
          throw new TunnelError(
            "sshTunnelLost",
            "The data source's engine is closing.",
            "Connect to the data source again.",
          );
        }
        const shared = await (current ?? start());
        if (shared.lost !== null) continue;
        shared.leases += 1;
        let released = false;
        return {
          localPort: shared.tunnel.localPort,
          get lost() {
            return shared.lost;
          },
          tunnel: shared.tunnel,
          release() {
            if (released) return;
            released = true;
            shared.leases -= 1;
            if (shared.leases > 0 || shared.lost !== null) return;
            shared.lost = RELEASED;
            void shared.tunnel.close();
          },
        };
      }
    },
    async close() {
      closed = true;
      const opening = current;
      current = null;
      if (opening === null) return;
      await opening.then(
        (shared) => shared.tunnel.close(),
        () => undefined,
      );
    },
  };
}

const UNGUARDED: ReadonlySet<PropertyKey> = new Set(["cancel"]);
const NESTED: ReadonlySet<PropertyKey> = new Set(["introspector", "transactions"]);

/**
 * `session` with its lease: `close()` releases it once, a call after the tunnel dropped is refused
 * `connectionLost` unsent (so the engine reconnects and runs it, decision 054), and a call the drop
 * cut short fails `sshTunnelLost`, since it may have reached the server.
 */
export function tunneledSession(session: Session, lease: TunnelLease, describe: string): Session {
  function guarded(call: () => Promise<unknown>): Promise<unknown> {
    const before = lease.lost;
    if (before !== null) {
      return Promise.reject(new PluginError("connectionLost", `The SSH tunnel to ${describe} closed: ${before}.`));
    }
    return call().catch((cause: unknown) => {
      const lost = lease.lost;
      if (lost === null || (isPluginError(cause) && cause.code === "connectionLost")) throw cause;
      throw new TunnelError(
        "sshTunnelLost",
        `The SSH tunnel to ${describe} closed while the statement ran (${lost}); it may have completed on the server.`,
        "Run it again; TableCraft reconnects through a new tunnel first, but check whether it took effect.",
      );
    });
  }

  function wrap<T extends object>(target: T): T {
    return new Proxy(target, {
      get(object, property) {
        const value: unknown = Reflect.get(object, property, object);
        if (typeof value !== "function") return value;
        const method = value as (...args: unknown[]) => unknown;
        if (UNGUARDED.has(property)) return method.bind(object);
        return (...args: unknown[]) => guarded(() => method.apply(object, args) as Promise<unknown>);
      },
    });
  }

  const wrapped = new WeakMap<object, object>();
  let closing: Promise<void> | null = null;
  return new Proxy(session, {
    get(object, property) {
      if (property === "close") {
        return () => {
          closing ??= object.close().finally(() => lease.release());
          return closing;
        };
      }
      const value: unknown = Reflect.get(object, property, object);
      if (NESTED.has(property) && typeof value === "object" && value !== null) {
        const known = wrapped.get(value) ?? wrap(value);
        wrapped.set(value, known);
        return known;
      }
      if (typeof value !== "function") return value;
      const method = value as (...args: unknown[]) => unknown;
      if (UNGUARDED.has(property)) return method.bind(object);
      return (...args: unknown[]) => guarded(() => method.apply(object, args) as Promise<unknown>);
    },
  });
}
