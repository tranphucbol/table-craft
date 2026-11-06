const HANDLE_PREFIX = "c";

/** A console an agent opened: which session may touch it, and the window that shows it (decision 160). */
export interface OwnedConsole {
  readonly handle: string;
  readonly sessionId: string;
  readonly window: number;
  readonly datasourceId: string;
}

export interface ConsoleOwners {
  /** A handle no console of this host run has had. */
  next(): string;
  claim(owned: OwnedConsole): void;
  /** The session's console by handle; null for an unknown handle and for another session's alike. */
  find(sessionId: string, handle: string): OwnedConsole | null;
  ofSession(sessionId: string): readonly OwnedConsole[];
  drop(handle: string): void;
  /** Forgets the session's consoles and answers them, so their windows can clear the marker. */
  endSession(sessionId: string): readonly OwnedConsole[];
  /** Forgets every console and answers them. */
  clear(): readonly OwnedConsole[];
}

export function createConsoleOwners(): ConsoleOwners {
  let issued = 0;
  const owned = new Map<string, OwnedConsole>();

  function take(matches: (entry: OwnedConsole) => boolean): readonly OwnedConsole[] {
    const taken = [...owned.values()].filter(matches);
    for (const entry of taken) owned.delete(entry.handle);
    return taken;
  }

  return {
    next() {
      issued += 1;
      return `${HANDLE_PREFIX}${String(issued)}`;
    },
    claim(entry) {
      owned.set(entry.handle, entry);
    },
    find(sessionId, handle) {
      const entry = owned.get(handle);
      return entry?.sessionId === sessionId ? entry : null;
    },
    ofSession: (sessionId) => [...owned.values()].filter((entry) => entry.sessionId === sessionId),
    drop(handle) {
      owned.delete(handle);
    },
    endSession: (sessionId) => take((entry) => entry.sessionId === sessionId),
    clear: () => take(() => true),
  };
}

/** Groups consoles by the window that shows them, so one request per window covers them all. */
export function byWindow(consoles: readonly OwnedConsole[]): ReadonlyMap<number, readonly string[]> {
  const grouped = new Map<number, string[]>();
  for (const entry of consoles) grouped.set(entry.window, [...(grouped.get(entry.window) ?? []), entry.handle]);
  return grouped;
}
