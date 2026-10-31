import type { ServerSession, Session } from "@table-craft/plugin-api";

/** What each session's `findServerInstance` answered, null for a failure; a reconnect brings a new `Session`. */
const found = new WeakMap<Session, string | null>();
const asking = new WeakMap<Session, Promise<void>>();

/** Ids a listing shows on more than one instance: only there does a session need its instance. */
export function repeatedIds(rows: readonly ServerSession[]): ReadonlySet<string> {
  const instances = new Map<string, Set<string | null>>();
  for (const row of rows) {
    const seen = instances.get(row.id) ?? new Set();
    seen.add(row.instance);
    instances.set(row.id, seen);
  }
  return new Set([...instances].filter(([, seen]) => seen.size > 1).map(([id]) => id));
}

/**
 * Asks `session` for its instance when the listing repeats its id and nothing told it yet; the one
 * lookup in flight otherwise. Null when there is nothing to wait for. Never rejects.
 */
export function learnInstance(session: Session, repeated: ReadonlySet<string>): Promise<void> | null {
  const pending = asking.get(session);
  if (pending !== undefined) return pending;
  const id = session.serverSessionId;
  if (id === undefined || !repeated.has(id) || session.serverInstance !== undefined || found.has(session)) return null;
  if (session.findServerInstance === undefined) return null;
  const lookup = session.findServerInstance().then(
    (instance) => {
      found.set(session, instance);
    },
    () => {
      found.set(session, null);
    },
  );
  asking.set(session, lookup);
  void lookup.then(() => asking.delete(session));
  return lookup;
}

/** Whether `row` is `session`'s own connection, by id and, where the instance is known, instance. */
export function isListedAs(session: Session, row: ServerSession): boolean {
  if (session.serverSessionId !== row.id) return false;
  const instance = session.serverInstance ?? found.get(session) ?? undefined;
  return instance === undefined || instance === row.instance;
}
