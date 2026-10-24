import { create } from "zustand";
import type { EngineError, ListedSession, SessionsListing } from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import {
  NO_FILTERS,
  rowOfEngineSession,
  sessionKey,
  type SessionsFilters,
} from "@table-craft/desktop/renderer/model/sessionsView.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";

export type SessionStop = "cancel" | "terminate";

/** One Sessions tab (plan 045): a data source's server sessions as last listed. */
export interface SessionsTab {
  readonly datasourceId: string;
  /** The last listing; kept while a refresh is in flight. */
  readonly listing: SessionsListing | null;
  readonly loading: boolean;
  readonly error: EngineError | null;
  readonly filters: SessionsFilters;
  /** The selected row's `sessionKey`; it stays selected across refreshes while listed. */
  readonly selected: string | null;
  readonly autoRefresh: boolean;
  /** What the last cancel or terminate did, for the status line. */
  readonly status: string | null;
}

export interface SessionsState {
  /** By tab id. */
  readonly tabs: Readonly<Record<string, SessionsTab>>;
  /** Adds a Sessions tab and lists; with `engineSessionId`, selects that console's backend. */
  readonly open: (id: string, datasourceId: string, engineSessionId?: string) => Promise<void>;
  readonly refresh: (id: string, engineSessionId?: string) => Promise<void>;
  readonly setFilters: (id: string, change: Partial<SessionsFilters>) => void;
  readonly select: (id: string, key: string | null) => void;
  readonly setAutoRefresh: (id: string, on: boolean) => void;
  /** Cancels the row's query or terminates it, then lists again; false when the engine refused. */
  readonly stop: (id: string, session: ListedSession, stop: SessionStop) => Promise<boolean>;
  readonly close: (id: string) => void;
}

export interface SessionsDependencies {
  readonly connect: (datasourceId: string) => Promise<EngineClient>;
}

const STOPPED: Readonly<Record<SessionStop, (id: string) => string>> = {
  cancel: (id) => `Cancelled the query of session ${id}.`,
  terminate: (id) => `Terminated session ${id}.`,
};

export function createSessionsStore(dependencies: SessionsDependencies) {
  /** The latest listing per tab, so an answer overtaken by a later refresh is dropped. */
  const reads = new Map<string, number>();
  let readCount = 0;

  return create<SessionsState>()((set, get) => {
    function patch(id: string, change: Partial<SessionsTab>): void {
      const current = get().tabs[id];
      if (current === undefined) return;
      set({ tabs: { ...get().tabs, [id]: { ...current, ...change } } });
    }

    async function refresh(id: string, engineSessionId?: string): Promise<void> {
      const current = get().tabs[id];
      if (current === undefined) return;
      const token = ++readCount;
      reads.set(id, token);
      patch(id, { loading: true });
      try {
        const client = await dependencies.connect(current.datasourceId);
        const listing = await client.call("sessions.list", {});
        if (reads.get(id) !== token) return;
        const focused = engineSessionId === undefined ? null : rowOfEngineSession(listing.sessions, engineSessionId);
        patch(id, {
          listing,
          loading: false,
          error: null,
          ...(focused === null ? {} : { selected: sessionKey(focused) }),
        });
      } catch (cause) {
        if (reads.get(id) === token) patch(id, { loading: false, error: toError(cause) });
      }
    }

    return {
      tabs: {},

      async open(id, datasourceId, engineSessionId) {
        set({
          tabs: {
            ...get().tabs,
            [id]: {
              datasourceId,
              listing: null,
              loading: false,
              error: null,
              filters: NO_FILTERS,
              selected: null,
              autoRefresh: false,
              status: null,
            },
          },
        });
        await refresh(id, engineSessionId);
      },

      refresh,

      setFilters(id, change) {
        const current = get().tabs[id];
        if (current !== undefined) patch(id, { filters: { ...current.filters, ...change } });
      },

      select(id, key) {
        patch(id, { selected: key });
      },

      setAutoRefresh(id, on) {
        patch(id, { autoRefresh: on });
      },

      async stop(id, session, stop) {
        const current = get().tabs[id];
        if (current === undefined) return false;
        const target = { id: session.id, instance: session.instance };
        try {
          const client = await dependencies.connect(current.datasourceId);
          await client.call(stop === "cancel" ? "sessions.cancel" : "sessions.terminate", { target });
        } catch (cause) {
          patch(id, { error: toError(cause), status: null });
          return false;
        }
        patch(id, { error: null, status: STOPPED[stop](session.id) });
        await refresh(id);
        return true;
      },

      close(id) {
        reads.delete(id);
        const { [id]: _gone, ...tabs } = get().tabs;
        set({ tabs });
      },
    };
  });
}

export type SessionsStore = ReturnType<typeof createSessionsStore>;

export const useSessions = createSessionsStore({ connect: (id) => useDatasources.getState().connect(id) });

/** The Sessions tab open on a data source, if any; there is at most one. */
export function sessionsTabOf(tabs: SessionsState["tabs"], datasourceId: string): string | null {
  return Object.entries(tabs).find(([, tab]) => tab.datasourceId === datasourceId)?.[0] ?? null;
}

/** The selected row as last listed, or null. */
export function selectedSession(tab: SessionsTab | undefined): ListedSession | null {
  if (tab === undefined || tab.selected === null || tab.listing === null) return null;
  return tab.listing.sessions.find((session) => sessionKey(session) === tab.selected) ?? null;
}
