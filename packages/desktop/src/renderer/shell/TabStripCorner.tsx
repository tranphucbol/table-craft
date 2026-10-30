import { Fragment, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ACTION_IDS, type TabArgs } from "@table-craft/desktop/renderer/actions/appActions.js";
import { invoke, registry, useActionEnabled } from "@table-craft/desktop/renderer/actions/index.js";
import { useConsoleDatasource } from "@table-craft/desktop/renderer/console/useConsoleDatasource.js";
import { TabIcon, labelOfTab } from "@table-craft/desktop/renderer/shell/TabIcon.js";
import {
  groupStrip,
  unpinnedTabIds,
  useTabs,
  type EditorGroupId,
  type Tab,
} from "@table-craft/desktop/renderer/state/tabs.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { ACTION_ICONS, CurrentIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { Popover, type PopoverAnchor } from "@table-craft/desktop/renderer/ui/Popover.js";
import { Tooltip } from "@table-craft/desktop/renderer/ui/Tooltip.js";

const OPEN_TABS_LABEL = "Open Tabs";
const TAB_ACTIONS_LABEL = "Tab Actions";
const OpenTabsIcon = ACTION_ICONS.tabs;
const TabActionsIcon = ACTION_ICONS.more;
const CORNER_BUTTON_CLASS =
  "press flex h-row shrink-0 items-center rounded px-1 text-ink-muted hover:bg-raised hover:text-ink aria-expanded:bg-raised aria-expanded:text-ink";
const ROW_CLASS =
  "flex h-row w-full cursor-default items-center gap-cell rounded px-gap text-left whitespace-nowrap outline-none hover:bg-selection focus-visible:bg-selection disabled:text-ink-muted disabled:hover:bg-transparent";
const MENU_ITEM_SELECTOR = '[role^="menuitem"]:not(:disabled)';

type MenuKind = "tabs" | "actions";

interface StripFacts {
  readonly groupId: EditorGroupId;
  readonly others: boolean;
  readonly unpinned: boolean;
}

interface CornerEntry {
  readonly actionId: string;
  readonly shows?: (facts: StripFacts) => boolean;
  readonly enabled?: (facts: StripFacts) => boolean;
}

/** The strip's own menu (plan 127 decision 6): what acts on the side as a whole, a separator between groups. */
const TAB_STRIP_MENU: readonly (readonly CornerEntry[])[] = [
  [
    { actionId: ACTION_IDS.closeOtherTabs, enabled: (facts) => facts.others },
    { actionId: ACTION_IDS.closeAllTabs, enabled: (facts) => facts.unpinned },
  ],
  [{ actionId: ACTION_IDS.reopenClosedTab }],
  [
    { actionId: ACTION_IDS.splitRight, shows: (facts) => facts.groupId === "left" },
    { actionId: ACTION_IDS.splitLeft, shows: (facts) => facts.groupId === "right" },
    { actionId: ACTION_IDS.unsplit },
  ],
];

/** Arrow keys walk a menu's rows, wrapping, as a native menu does. */
function stepFocus(event: KeyboardEvent<HTMLDivElement>): void {
  const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
  if (step === 0) return;
  event.preventDefault();
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)];
  if (rows.length === 0) return;
  const at = rows.indexOf(document.activeElement as HTMLElement);
  rows[(at + step + rows.length) % rows.length]?.focus();
}

function CornerMenu({
  label,
  anchor,
  onClose,
  children,
}: {
  readonly label: string;
  readonly anchor: PopoverAnchor;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Popover anchor={anchor} label={label} onClose={onClose}>
      <div role="menu" aria-label={label} className="min-h-0 overflow-y-auto p-1" onKeyDown={stepFocus}>
        {children}
      </div>
    </Popover>
  );
}

function OpenTabRow({
  tab,
  active,
  onPick,
}: {
  readonly tab: Tab;
  readonly active: boolean;
  readonly onPick: () => void;
}) {
  const datasource = useConsoleDatasource(tab.id);
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      className={ROW_CLASS}
      onClick={() => {
        useTabs.getState().activate(tab.id);
        onPick();
      }}
    >
      <span className="flex size-icon shrink-0 items-center">
        {active ? <CurrentIcon aria-hidden className="size-icon text-accent" /> : null}
      </span>
      <TabIcon kind={tab.kind} />
      <span className="max-w-popover truncate">{labelOfTab(tab, datasource?.name)}</span>
    </button>
  );
}

function ActionRow({
  entry,
  facts,
  args,
  onPick,
}: {
  readonly entry: CornerEntry;
  readonly facts: StripFacts;
  readonly args: TabArgs | undefined;
  readonly onPick: () => void;
}) {
  const enabled = useActionEnabled(entry.actionId) && (entry.enabled?.(facts) ?? true);
  const action = registry.get(entry.actionId);
  if (action === undefined) return null;
  return (
    <button
      type="button"
      role="menuitem"
      disabled={!enabled}
      className={ROW_CLASS}
      onClick={() => {
        onPick();
        invoke(entry.actionId, args);
      }}
    >
      {action.title}
    </button>
  );
}

function CornerButton({
  label,
  expanded,
  onOpen,
  children,
}: {
  readonly label: string;
  readonly expanded: boolean;
  readonly onOpen: (anchor: PopoverAnchor) => void;
  readonly children: ReactNode;
}) {
  const button = useRef<HTMLButtonElement>(null);
  return (
    <Tooltip label={label} side="bottom">
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={expanded}
        className={CORNER_BUTTON_CLASS}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          const rect = button.current?.getBoundingClientRect();
          if (rect !== undefined) onOpen({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
        }}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/**
 * The tab strip's fixed right corner (plan 127 decision 6): New Console, a list of this side's
 * tabs for when the strip scrolls them out of sight, and the side's tab actions.
 */
export function TabStripCorner({ groupId }: { readonly groupId: EditorGroupId }) {
  const strip = groupStrip(useTabs(), groupId);
  const [menu, setMenu] = useState<{ readonly kind: MenuKind; readonly anchor: PopoverAnchor } | null>(null);
  const close = () => setMenu(null);
  const facts: StripFacts = {
    groupId,
    others: strip.tabs.length > 1,
    unpinned: unpinnedTabIds(strip).length > 0,
  };
  const args: TabArgs | undefined = strip.activeId === null ? undefined : { tabId: strip.activeId };
  const groups = TAB_STRIP_MENU.map((group) => group.filter((entry) => entry.shows?.(facts) ?? true)).filter(
    (group) => group.length > 0,
  );
  return (
    <div data-testid="tab-strip-corner" className="flex shrink-0 items-center gap-1 border-b border-l border-line px-1">
      <ActionButton actionId={ACTION_IDS.newConsole} compact icon="add" />
      <CornerButton
        label={OPEN_TABS_LABEL}
        expanded={menu?.kind === "tabs"}
        onOpen={(anchor) => setMenu({ kind: "tabs", anchor })}
      >
        <OpenTabsIcon aria-hidden className="size-icon" />
      </CornerButton>
      <CornerButton
        label={TAB_ACTIONS_LABEL}
        expanded={menu?.kind === "actions"}
        onOpen={(anchor) => setMenu({ kind: "actions", anchor })}
      >
        <TabActionsIcon aria-hidden weight="bold" className="size-icon" />
      </CornerButton>
      {menu?.kind === "tabs" ? (
        <CornerMenu label={OPEN_TABS_LABEL} anchor={menu.anchor} onClose={close}>
          {strip.tabs.map((tab) => (
            <OpenTabRow key={tab.id} tab={tab} active={tab.id === strip.activeId} onPick={close} />
          ))}
        </CornerMenu>
      ) : null}
      {menu?.kind === "actions" ? (
        <CornerMenu label={TAB_ACTIONS_LABEL} anchor={menu.anchor} onClose={close}>
          {groups.map((group, index) => (
            <Fragment key={group[0]?.actionId}>
              {index === 0 ? null : <div role="separator" className="my-1 h-px bg-line" />}
              {group.map((entry) => (
                <ActionRow key={entry.actionId} entry={entry} facts={facts} args={args} onPick={close} />
              ))}
            </Fragment>
          ))}
        </CornerMenu>
      ) : null}
    </div>
  );
}
