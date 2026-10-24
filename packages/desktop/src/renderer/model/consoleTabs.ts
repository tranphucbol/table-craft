import { fileSourceOf, type ConsoleSession } from "@table-craft/desktop/renderer/state/consoles.js";
import type { ClosedConsole, Tab } from "@table-craft/desktop/renderer/state/tabs.js";

type SessionSeed = Pick<ConsoleSession, "sql" | "namespace" | "pendingNamespace">;

/** What Duplicate opens a new scratch console with: the text, and the namespace it is in or is about to switch to. */
export function duplicateSeed(session: SessionSeed): {
  readonly sql: string;
  readonly namespace: readonly string[] | null;
} {
  return { sql: session.sql, namespace: session.namespace ?? session.pendingNamespace };
}

/** The entry Reopen Closed Tab keeps for a console tab as it closes. */
export function closedConsoleOf(
  tab: Pick<Tab, "pinned">,
  session: Pick<ConsoleSession, "datasourceId" | "name" | "sql" | "source">,
): ClosedConsole {
  const path = fileSourceOf(session)?.path;
  return {
    datasourceId: session.datasourceId,
    name: session.name,
    sql: session.sql,
    ...(path === undefined ? {} : { path }),
    ...(tab.pinned === true ? { pinned: true } : {}),
  };
}
