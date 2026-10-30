import * as ContextMenu from "@radix-ui/react-context-menu";
import { Fragment, useEffect, useRef, useState, type WheelEvent } from "react";
import { Group, Panel } from "react-resizable-panels";
import { ACTION_IDS, type TabArgs } from "@table-craft/desktop/renderer/actions/appActions.js";
import { currentPlatform, formatChord } from "@table-craft/desktop/renderer/actions/chords.js";
import { REGION_ATTRIBUTE } from "@table-craft/desktop/renderer/actions/context.js";
import { FILE_ACTION_IDS } from "@table-craft/desktop/renderer/actions/fileActions.js";
import { ActionTabContext, invoke, registry, useActionEnabled } from "@table-craft/desktop/renderer/actions/index.js";
import { Console } from "@table-craft/desktop/renderer/console/Console.js";
import { useConsoleDatasource } from "@table-craft/desktop/renderer/console/useConsoleDatasource.js";
import { DdlView } from "@table-craft/desktop/renderer/ddl/DdlView.js";
import { KeyTab } from "@table-craft/desktop/renderer/keys/KeyTab.js";
import { ServerTab } from "@table-craft/desktop/renderer/server/ServerTab.js";
import { deferTabDrag } from "@table-craft/desktop/renderer/model/tabDrag.js";
import { fileSourceOf, isDirty, useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { SessionsView } from "@table-craft/desktop/renderer/sessions/SessionsView.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import {
  EDITOR_GROUPS,
  groupOf,
  groupStrip,
  otherTabIds,
  rightTabIds,
  unpinnedTabIds,
  useTabs,
  type Tab,
  type EditorGroupId,
} from "@table-craft/desktop/renderer/state/tabs.js";
import { useLayout } from "@table-craft/desktop/renderer/state/layout.js";
import { Handle } from "@table-craft/desktop/renderer/ui/Handle.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { MENU_MOTION } from "@table-craft/desktop/renderer/ui/motion.js";
import { TableEditor } from "@table-craft/desktop/renderer/table/TableEditor.js";
import { ACTION_ICONS, CloseIcon, ReadOnlyIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { TabIcon, labelOfTab } from "@table-craft/desktop/renderer/shell/TabIcon.js";
import { TabStripCorner } from "@table-craft/desktop/renderer/shell/TabStripCorner.js";
import { TINT_TAB } from "@table-craft/desktop/renderer/ui/tint.js";
import { AUTOFOCUS_ATTRIBUTE, focusActivatedEditor } from "@table-craft/desktop/renderer/shell/focus.js";

const PinIcon = ACTION_ICONS.pin;
const TAB_DRAG_TYPE = "application/x-tablecraft-editor-tab";
const MIN_GROUP_SIZE = "25";
const PANEL_STYLE = { overflow: "hidden" } as const;

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
  [{ actionId: ACTION_IDS.splitLeft }, { actionId: ACTION_IDS.splitRight }, { actionId: ACTION_IDS.unsplit }],
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

/** With the bar hidden, a mouse wheel's vertical turn is the only way it can reach the far tabs. */
function scrollTabsSideways(event: WheelEvent<HTMLDivElement>) {
  if (event.deltaX !== 0 || event.deltaY === 0) return;
  event.currentTarget.scrollLeft += event.deltaY;
}

function TabButton({
  tab,
  active,
  onDrag,
}: {
  readonly tab: Tab;
  readonly active: boolean;
  readonly onDrag: (id: string | null) => void;
}) {
  const activate = useTabs((state) => state.activate);
  const tabElement = useRef<HTMLDivElement>(null);
  const cancelDragFrame = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelDragFrame.current?.(), []);
  useEffect(() => {
    if (active) tabElement.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  const args: TabArgs = { tabId: tab.id };
  const datasource = useConsoleDatasource(tab.id);
  const label = labelOfTab(tab, datasource?.name);
  const tint = datasource?.color == null ? null : TINT_TAB[datasource.color];
  const path = useConsoles((state) => fileSourceOf(state.consoles[tab.id])?.path);
  const dirty = useConsoles((state) => {
    const session = state.consoles[tab.id];
    return session !== undefined && isDirty(session);
  });
  const isConsole = useConsoles((state) => tab.kind === "console" && state.consoles[tab.id] !== undefined);
  const others = useTabs((state) => otherTabIds(groupStrip(state, groupOf(tab)), tab.id).length > 0);
  const right = useTabs((state) => rightTabIds(groupStrip(state, groupOf(tab)), tab.id).length > 0);
  const unpinned = useTabs((state) => unpinnedTabIds(groupStrip(state, groupOf(tab))).length > 0);
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
          ref={tabElement}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData(TAB_DRAG_TYPE, tab.id);
            event.dataTransfer.effectAllowed = "move";
            cancelDragFrame.current?.();
            cancelDragFrame.current = deferTabDrag(tab.id, onDrag);
          }}
          onDragEnd={() => {
            cancelDragFrame.current?.();
            cancelDragFrame.current = null;
            onDrag(null);
          }}
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
            onClick={(event) => {
              activate(tab.id);
              if (active)
                event.currentTarget
                  .closest('[data-testid="editor-group"]')
                  ?.querySelector<HTMLElement>(`[${AUTOFOCUS_ATTRIBUTE}]`)
                  ?.focus();
            }}
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
        <ContextMenu.Content
          className={cn(
            "z-50 min-w-48 rounded border border-line bg-raised p-1 text-ui text-ink shadow-lg",
            MENU_MOTION,
          )}
        >
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

function EditorGroup({
  groupId,
  onDrag,
}: {
  readonly groupId: EditorGroupId;
  readonly onDrag: (id: string | null) => void;
}) {
  const state = useTabs();
  const { tabs, activeId } = groupStrip(state, groupId);
  const active = tabs.find((tab) => tab.id === activeId) ?? null;
  const groupRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (groupRef.current !== null) focusActivatedEditor(groupRef.current, state.activeId, activeId);
  }, [state.activeId, activeId]);
  return (
    <div
      ref={groupRef}
      data-testid="editor-group"
      data-group-id={groupId}
      data-focused={groupOf(state.tabs.find((tab) => tab.id === state.activeId)) === groupId}
      onFocusCapture={() => state.focusGroup(groupId)}
      onPointerDownCapture={(event) => {
        state.focusGroup(groupId);
        if (
          !event.currentTarget.contains(document.activeElement) &&
          event.target instanceof Element &&
          event.target.closest('[role="toolbar"]') !== null
        ) {
          event.currentTarget.querySelector<HTMLElement>(`[${AUTOFOCUS_ATTRIBUTE}]`)?.focus();
        }
      }}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    >
      {tabs.length === 0 ? null : (
        <div className="flex shrink-0 bg-panel">
          <div
            role="tablist"
            aria-label="Editor tabs"
            className="flex min-w-0 flex-1 overflow-x-auto border-b border-line scrollbar-none"
            onWheel={scrollTabsSideways}
          >
            {tabs.map((tab) => (
              <TabButton key={tab.id} tab={tab} active={tab.id === activeId} onDrag={onDrag} />
            ))}
          </div>
          <ActionTabContext value={active?.id}>
            <TabStripCorner groupId={groupId} />
          </ActionTabContext>
        </div>
      )}
      <ActionTabContext value={active?.id}>
        <EditorContent active={active} />
      </ActionTabContext>
    </div>
  );
}

function EditorContent({ active }: { readonly active: Tab | null }) {
  return active === null ? (
    <EmptyEditor />
  ) : active.kind === "table" ? (
    <TableEditor key={active.id} tableId={active.id} />
  ) : active.kind === "ddl" ? (
    <DdlView key={active.id} ddlId={active.id} />
  ) : active.kind === "sessions" ? (
    <SessionsView key={active.id} sessionsId={active.id} />
  ) : active.kind === "key" ? (
    <KeyTab key={active.id} tabId={active.id} />
  ) : active.kind === "server" ? (
    <ServerTab key={active.id} tabId={active.id} />
  ) : (
    <Console key={active.id} consoleId={active.id} />
  );
}

export function EditorArea() {
  const tabs = useTabs((state) => state.tabs);
  const [dragged, setDragged] = useState<string | null>(null);
  const [preview, setPreview] = useState<EditorGroupId | null>(null);
  const size = useLayout((state) => state.layout.editorGroupWidth);
  const groups = EDITOR_GROUPS.filter((id) => tabs.some((tab) => groupOf(tab) === id));
  const split = groups.length > 1;
  const onDrag = (id: string | null) => {
    setDragged(id);
    setPreview(null);
  };
  return (
    <section
      aria-label="Editor"
      {...{ [REGION_ATTRIBUTE]: "editor" }}
      className="relative flex h-full min-h-0 min-w-0 flex-col bg-canvas"
    >
      {split ? (
        <Group
          orientation="horizontal"
          className="min-h-0 flex-1"
          onLayoutChanged={(layout, meta) => {
            if (meta.isUserInteraction && layout["editor-group-left"] !== undefined)
              useLayout.getState().resizeEditorGroups(layout["editor-group-left"]);
          }}
        >
          <Panel id="editor-group-left" defaultSize={String(size)} minSize={MIN_GROUP_SIZE} style={PANEL_STYLE}>
            <EditorGroup groupId="left" onDrag={onDrag} />
          </Panel>
          <Handle axis="vertical" label="Editor groups" />
          <Panel id="editor-group-right" minSize={MIN_GROUP_SIZE} style={PANEL_STYLE}>
            <EditorGroup groupId="right" onDrag={onDrag} />
          </Panel>
        </Group>
      ) : (
        <EditorGroup groupId={groups[0] ?? "left"} onDrag={onDrag} />
      )}
      {dragged === null || tabs.length < 2 ? null : (
        <div className="absolute inset-0 z-20 flex">
          {EDITOR_GROUPS.map((side) => (
            <div
              key={side}
              data-testid={`editor-drop-${side}`}
              aria-label={`Split ${side}`}
              className={cn(
                "flex w-1/2 items-center justify-center border-2 border-dashed border-accent bg-selection/50",
                preview === side && "bg-selection/90",
              )}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setPreview(side);
              }}
              onDragEnter={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setPreview(side);
              }}
              onDragLeave={() => setPreview(null)}
              onDrop={(event) => {
                event.preventDefault();
                const id = event.dataTransfer.getData(TAB_DRAG_TYPE);
                if (id === dragged)
                  void invoke(side === "left" ? ACTION_IDS.splitLeft : ACTION_IDS.splitRight, { tabId: id });
                onDrag(null);
              }}
            >
              <span className="pointer-events-none rounded border border-accent bg-panel px-gap py-cell text-ink">
                {split ? `Move ${side}` : `Split ${side}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
