import * as ContextMenu from "@radix-ui/react-context-menu";
import { ACTION_IDS, type TabArgs } from "@table-craft/desktop/renderer/actions/appActions.js";
import { currentPlatform, formatChord } from "@table-craft/desktop/renderer/actions/chords.js";
import { REGION_ATTRIBUTE } from "@table-craft/desktop/renderer/actions/context.js";
import { invoke, registry, useActionEnabled } from "@table-craft/desktop/renderer/actions/index.js";
import { Console } from "@table-craft/desktop/renderer/console/Console.js";
import { useConsoleDatasource } from "@table-craft/desktop/renderer/console/useConsoleDatasource.js";
import { DdlView } from "@table-craft/desktop/renderer/ddl/DdlView.js";
import { sessionsTabLabel, tabLabel } from "@table-craft/desktop/renderer/model/format.js";
import { fileSourceOf, isDirty, useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { SessionsView } from "@table-craft/desktop/renderer/sessions/SessionsView.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { activeTab, useTabs, type Tab, type TabKind } from "@table-craft/desktop/renderer/state/tabs.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { TableEditor } from "@table-craft/desktop/renderer/table/TableEditor.js";
import {
  CloseIcon,
  ConsoleIcon,
  DdlIcon,
  ReadOnlyIcon,
  SessionsIcon,
  TableIcon,
} from "@table-craft/desktop/renderer/ui/icons.js";
import { TINT_TAB } from "@table-craft/desktop/renderer/ui/tint.js";

const TAB_MENU_ACTIONS = [ACTION_IDS.closeTab, ACTION_IDS.closeOtherTabs, ACTION_IDS.closeAllTabs] as const;

function TabMenuItem({ actionId, tabId }: { readonly actionId: string; readonly tabId: string }) {
  const enabled = useActionEnabled(actionId);
  const action = registry.get(actionId);
  if (action === undefined) return null;
  const args: TabArgs = { tabId };
  return (
    <ContextMenu.Item
      disabled={!enabled}
      className="flex h-row cursor-default items-center justify-between gap-gap rounded px-gap outline-none data-[disabled]:text-ink-muted data-[highlighted]:bg-selection"
      onSelect={() => invoke(actionId, args)}
    >
      <span>{action.title}</span>
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
          {TAB_MENU_ACTIONS.map((actionId) => (
            <TabMenuItem key={actionId} actionId={actionId} tabId={tab.id} />
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
      ) : (
        <Console key={active.id} consoleId={active.id} />
      )}
    </section>
  );
}
