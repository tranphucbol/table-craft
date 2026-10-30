import { sessionsTabLabel, tabLabel } from "@table-craft/desktop/renderer/model/format.js";
import type { Tab, TabKind } from "@table-craft/desktop/renderer/state/tabs.js";
import {
  ConsoleIcon,
  DdlIcon,
  KeyTabIcon,
  ServerTabIcon,
  SessionsIcon,
  TableIcon,
} from "@table-craft/desktop/renderer/ui/icons.js";

const TAB_ICONS = {
  console: ConsoleIcon,
  table: TableIcon,
  ddl: DdlIcon,
  sessions: SessionsIcon,
  key: KeyTabIcon,
  server: ServerTabIcon,
  keyAdmin: ServerTabIcon,
} as const satisfies Record<TabKind, unknown>;

export function TabIcon({ kind }: { readonly kind: TabKind }) {
  const Icon = TAB_ICONS[kind];
  return <Icon aria-hidden data-tab-kind={kind} className="size-icon shrink-0" />;
}

/** What an editor tab reads as, in the strip and in its Open Tabs list. */
export function labelOfTab(tab: Pick<Tab, "kind" | "title">, datasourceName: string | undefined): string {
  return (tab.kind === "sessions" || tab.kind === "server" ? sessionsTabLabel : tabLabel)(tab.title, datasourceName);
}
