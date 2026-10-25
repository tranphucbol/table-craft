import * as ContextMenu from "@radix-ui/react-context-menu";
import { Fragment } from "react";
import { ACTION_IDS, type TabArgs } from "@table-craft/desktop/renderer/actions/appActions.js";
import { currentPlatform, formatChord } from "@table-craft/desktop/renderer/actions/chords.js";
import { REGION_ATTRIBUTE } from "@table-craft/desktop/renderer/actions/context.js";
import { FILE_ACTION_IDS } from "@table-craft/desktop/renderer/actions/fileActions.js";
import { invoke, registry, useActionEnabled } from "@table-craft/desktop/renderer/actions/index.js";
import { Console } from "@table-craft/desktop/renderer/console/Console.js";
import { useConsoleDatasource } from "@table-craft/desktop/renderer/console/useConsoleDatasource.js";
import { DdlView } from "@table-craft/desktop/renderer/ddl/DdlView.js";
import { KeyTab } from "@table-craft/desktop/renderer/keys/KeyTab.js";
import { sessionsTabLabel, tabLabel } from "@table-craft/desktop/renderer/model/format.js";
import { fileSourceOf, isDirty, useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { SessionsView } from "@table-craft/desktop/renderer/sessions/SessionsView.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import {
  activeTab,
  otherTabIds,
  rightTabIds,
  unpinnedTabIds,
  useTabs,
  type Tab,
  type TabKind,
} from "@table-craft/desktop/renderer/state/tabs.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { TableEditor } from "@table-craft/desktop/renderer/table/TableEditor.js";
import {
  ACTION_ICONS,
  CloseIcon,
  ConsoleIcon,
  DdlIcon,
  KeyTabIcon,
  ReadOnlyIcon,
  SessionsIcon,
  TableIcon,
} from "@table-craft/desktop/renderer/ui/icons.js";
import { TINT_TAB } from "@table-craft/desktop/renderer/ui/tint.js";

const PinIcon = ACTION_ICONS.pin;

/** What the tab menu needs to know about the tab it opened on. */
interface TabFacts {
  readonly console: boolean;
  /** The tab's console has a `.sql` on disk: its file, or a saved datasource's scratch file. */
  readonly path: boolean;
  readonly pinned: boolean;
  readonly others: boolean;
  readonly right: boolean;
  readonly unpinned: boolean;
}

interface TabMenuEntry {
  readonly actionId: string;
  /** Left out of the menu when false; the action does not apply to this tab. */
  readonly shows?: (facts: TabFacts) => boolean;
  /** Greyed out when false, on top of the action's own `when`. */
  readonly enabled?: (facts: TabFacts) => boolean;
  readonly label?: (facts: TabFacts) => string | undefined;
}

const UNPIN_LABEL = "Unpin Tab";

/** DataGrip's editor tab menu, a separator between groups. */
const TAB_MENU: readonly (readonly TabMenuEntry[])[] = [
  [
    { actionId: ACTION_IDS.closeTab },
    { actionId: ACTION_IDS.closeOtherTabs, enabled: (facts) => facts.others },
    { actionId: ACTION_IDS.closeAllTabs, enabled: (facts) => facts.unpinned },
    { actionId: ACTION_IDS.closeTabsToRight, enabled: (facts) => facts.right },
  ],
  [{ actionId: ACTION_IDS.copyTabPath, shows: (facts) => facts.path }],
  [{ actionId: ACTION_IDS.togglePinTab, label: (facts) => (facts.pinned ? UNPIN_LABEL : undefined) }],
  [{ actionId: ACTION_IDS.reopenClosedTab }],
  [{ actionId: ACTION_IDS.duplicateTab, shows: (facts) => facts.console }],
  [{ actionId: ACTION_IDS.revealTab, shows: (facts) => facts.path }],
  [{ actionId: FILE_ACTION_IDS.rename, shows: (facts) => facts.console }],
];

function TabMenuItem({
  entry,
  facts,
  tabId,
}: {
  readonly entry: TabMenuEntry;
  readonly facts: TabFacts;
  readonly tabId: string;
}) {
  const { actionId } = entry;
  const enabled = useActionEnabled(actionId) && (entry.enabled?.(facts) ?? true);
  const action = registry.get(actionId);
  if (action === undefined) return null;
  const args: TabArgs = { tabId };
  return (
    <ContextMenu.Item
      disabled={!enabled}
      className="flex h-row cursor-default items-center justify-between gap-gap rounded px-gap outline-none data-[disabled]:text-ink-muted data-[highlighted]:bg-selection"
      onSelect={() => invoke(actionId, args)}
    >
      <span>{entry.label?.(facts) ?? action.title}</span>
      {action.shortcut === undefined ? null : (
        <span className="text-ink-muted">{formatChord(action.shortcut, currentPlatform())}</span>
      )}
    </ContextMenu.Item>
  );
}

const TAB_ICONS = {
  console: ConsoleIcon,
  table: TableIcon,
  ddl: DdlIcon,
  sessions: SessionsIcon,
  key: KeyTabIcon,
} as const satisfies Record<TabKind, unknown>;

function TabIcon({ kind }: { readonly kind: TabKind }) {
  const Icon = TAB_ICONS[kind];
  return <Icon aria-hidden data-tab-kind={kind} className="size-icon" />;
}

function TabButton({ tab, active }: { readonly tab: Tab; readonly active: boolean }) {
  const activate = useTabs((state) => state.activate);
  const args: TabArgs = { tabId: tab.id };
  const datasource = useConsoleDatasource(tab.id);
  const label = (tab.kind === "sessions" ? sessionsTabLabel : tabLabel)(tab.title, datasource?.name);
  const tint = datasource?.color == null ? null : TINT_TAB[datasource.color];
  const path = useConsoles((state) => fileSourceOf(state.consoles[tab.id])?.path);
  const dirty = useConsoles((state) => {
    const session = state.consoles[tab.id];
    return session !== undefined && isDirty(session);
  });
  const isConsole = useConsoles((state) => tab.kind === "console" && state.consoles[tab.id] !== undefined);
  const others = useTabs((state) => otherTabIds(state, tab.id).length > 0);
  const right = useTabs((state) => rightTabIds(state, tab.id).length > 0);
  const unpinned = useTabs((state) => unpinnedTabIds(state).length > 0);
  const pinned = tab.pinned === true;
  const facts: TabFacts = {
    console: isConsole,
    path: path !== undefined || (isConsole && datasource !== undefined && !datasource.ephemeral),
    pinned,
    others,
    right,
    unpinned,
  };
  const groups = TAB_MENU.map((group) => group.filter((entry) => entry.shows?.(facts) ?? true)).filter(
    (group) => group.length > 0,
  );
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          className={cn(
            "group flex h-tab shrink-0 items-center gap-cell border-r border-b-2 border-r-line px-gap",
            active ? "border-b-accent text-ink" : "border-b-transparent text-ink-muted hover:bg-raised",
            tint ?? (active ? "bg-canvas" : null),
          )}
        >
          <button
            type="button"
            role="tab"
            aria-selected={active}
            data-color={datasource?.color ?? undefined}
            data-path={path}
            title={path}
            className="flex items-center gap-cell outline-none"
            onClick={() => activate(tab.id)}
          >
            <TabIcon kind={tab.kind} />
            {label}
            {dirty ? (
              <span
                data-testid="tab-dirty"
                role="img"
                aria-label="unsaved"
                className="size-2 shrink-0 rounded-full bg-ink"
              />
            ) : null}
            {datasource?.readOnly === true ? (
              <ReadOnlyIcon aria-label="read-only" className="size-icon text-ink-muted" />
            ) : null}
            {pinned ? (
              <PinIcon data-testid="tab-pinned" aria-label="pinned" className="size-icon text-ink-muted" />
            ) : null}
          </button>
          <button
            type="button"
            aria-label={`Close ${label}`}
            tabIndex={-1}
            className={cn(
              "flex size-icon items-center justify-center rounded hover:bg-raised hover:text-ink",
              !active && "invisible group-hover:visible",
            )}
            onClick={() => invoke(ACTION_IDS.closeTab, args)}
          >
            <CloseIcon aria-hidden />
          </button>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-50 min-w-48 rounded border border-line bg-raised p-1 text-ui text-ink shadow-lg">
          {groups.map((group, index) => (
            <Fragment key={group[0]?.actionId}>
              {index === 0 ? null : <ContextMenu.Separator className="my-1 h-px bg-line" />}
              {group.map((entry) => (
                <TabMenuItem key={entry.actionId} entry={entry} facts={facts} tabId={tab.id} />
              ))}
            </Fragment>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function EmptyEditor() {
  const hasDatasources = useDatasources((state) => state.datasources.length > 0);
  const action = registry.get(hasDatasources ? ACTION_IDS.newConsole : ACTION_IDS.newDatasource);
  const shortcut = action?.shortcut === undefined ? "" : formatChord(action.shortcut, currentPlatform());
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-gap text-ink-muted">
      <p>No open consoles.</p>
      {hasDatasources ? (
        <p>
          Select a data source and press{" "}
          <kbd className="rounded border border-line px-1 font-ui text-ink">{shortcut}</kbd> to open a console on it.
        </p>
      ) : (
        <p>Add a data source in the Database tool window to start.</p>
      )}
    </div>
  );
}

/** The tab strip and the active tab's content. */
export function EditorArea() {
  const tabs = useTabs((state) => state.tabs);
  const active = useTabs(activeTab);
  return (
    <section
      aria-label="Editor"
      {...{ [REGION_ATTRIBUTE]: "editor" }}
      className="flex h-full min-h-0 flex-col bg-canvas"
    >
      {tabs.length === 0 ? null : (
        <div role="tablist" aria-label="Editor tabs" className="flex shrink-0 overflow-x-auto bg-panel">
          {tabs.map((tab) => (
            <TabButton key={tab.id} tab={tab} active={tab.id === active?.id} />
          ))}
        </div>
      )}
      {active === null ? (
        <EmptyEditor />
      ) : active.kind === "table" ? (
        <TableEditor key={active.id} tableId={active.id} />
      ) : active.kind === "ddl" ? (
        <DdlView key={active.id} ddlId={active.id} />
      ) : active.kind === "sessions" ? (
        <SessionsView key={active.id} sessionsId={active.id} />
      ) : active.kind === "key" ? (
        <KeyTab key={active.id} tabId={active.id} />
      ) : (
        <Console key={active.id} consoleId={active.id} />
      )}
    </section>
  );
}
