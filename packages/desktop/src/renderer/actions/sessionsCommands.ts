import { sessionsTabOf, useSessions, type SessionsStore } from "@table-craft/desktop/renderer/state/sessions.js";
import { useTabs, type TabsStore } from "@table-craft/desktop/renderer/state/tabs.js";

const SESSIONS_ID_PREFIX = "sessions-";
const SESSIONS_TITLE = "Sessions";
let sessionsOpened = 0;

/**
 * Opens the data source's Sessions tab in `stores`, or brings its open one forward and lists again
 * (plan 045 decision 1); with `engineSessionId`, the row of that console's backend is selected.
 */
export async function openSessionsIn(
  stores: { readonly tabs: TabsStore; readonly sessions: SessionsStore },
  datasourceId: string,
  engineSessionId?: string,
): Promise<void> {
  const existing = sessionsTabOf(stores.sessions.getState().tabs, datasourceId);
  if (existing !== null) {
    stores.tabs.getState().activate(existing);
    await stores.sessions.getState().refresh(existing, engineSessionId);
    return;
  }
  const id = `${SESSIONS_ID_PREFIX}${String(sessionsOpened++)}`;
  stores.tabs.getState().open({ id, kind: "sessions", title: SESSIONS_TITLE });
  await stores.sessions.getState().open(id, datasourceId, engineSessionId);
}

export function openSessions(datasourceId: string, engineSessionId?: string): Promise<void> {
  return openSessionsIn({ tabs: useTabs, sessions: useSessions }, datasourceId, engineSessionId);
}
