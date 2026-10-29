import type { McpKnownClient, McpPendingClient } from "@table-craft/desktop/settings/mcp.js";

/** How long a new client's first call waits for Allow or Block before it is refused. */
export const CLIENT_CONFIRM_TIMEOUT_MS = 60_000;

export type Admission = "allowed" | "blocked" | "timedOut" | "noWindow";

export const ADMISSION_REFUSALS: Readonly<Record<Exclude<Admission, "allowed">, (name: string) => string>> = {
  blocked: (name) => `The user blocked ${name} in TableCraft; it can no longer use TableCraft's tools.`,
  timedOut: (name) =>
    `Nobody allowed ${name} in TableCraft in time. Ask the user to allow it from the MCP chip in the status bar, then call again.`,
  noWindow: (name) => `TableCraft has no window open to ask whether ${name} may connect.`,
};

export interface ClientGate {
  /** Resolves at once for a known name; otherwise when the user answers or the wait runs out. */
  admit(name: string, version: string): Promise<Admission>;
  /** The user's list from the settings; settles every waiting name it now holds. */
  setKnown(known: readonly McpKnownClient[]): void;
  setWindows(open: boolean): void;
  pending(): readonly McpPendingClient[];
}

export interface ClientGateOptions {
  readonly onChange: () => void;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

interface Waiting {
  readonly view: McpPendingClient;
  readonly timer: unknown;
  readonly settles: ((admission: Admission) => void)[];
}

/**
 * Asks the user once per client name (decision 127). The name is what the client says it is, so
 * this is a prompt to notice a new agent, not authentication: the bearer token is that.
 */
export function createClientGate(options: ClientGateOptions): ClientGate {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? CLIENT_CONFIRM_TIMEOUT_MS;
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let known = new Map<string, boolean>();
  let windows = false;
  const waiting = new Map<string, Waiting>();

  function settle(name: string, admission: Admission): void {
    const entry = waiting.get(name);
    if (entry === undefined) return;
    waiting.delete(name);
    clearTimer(entry.timer);
    for (const resolve of entry.settles) resolve(admission);
    options.onChange();
  }

  return {
    admit(name, version) {
      const decided = known.get(name);
      if (decided !== undefined) return Promise.resolve(decided ? "allowed" : "blocked");
      if (!windows) return Promise.resolve("noWindow");
      return new Promise<Admission>((resolve) => {
        const existing = waiting.get(name);
        if (existing !== undefined) {
          existing.settles.push(resolve);
          return;
        }
        const since = now();
        const timer = setTimer(() => settle(name, "timedOut"), timeoutMs);
        waiting.set(name, { view: { name, version, since, deadline: since + timeoutMs }, timer, settles: [resolve] });
        options.onChange();
      });
    },
    setKnown(list) {
      known = new Map(list.map((client) => [client.name, client.allowed]));
      for (const name of [...waiting.keys()]) {
        const decided = known.get(name);
        if (decided !== undefined) settle(name, decided ? "allowed" : "blocked");
      }
    },
    setWindows(open) {
      windows = open;
      if (!open) for (const name of [...waiting.keys()]) settle(name, "noWindow");
    },
    pending: () => [...waiting.values()].map((entry) => entry.view),
  };
}
