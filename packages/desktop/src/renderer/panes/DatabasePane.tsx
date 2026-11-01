import * as ContextMenu from "@radix-ui/react-context-menu";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { ACTION_IDS } from "@table-craft/desktop/renderer/actions/appActions.js";
import { currentPlatform, formatChord } from "@table-craft/desktop/renderer/actions/chords.js";
import { DDL_ACTION_IDS } from "@table-craft/desktop/renderer/actions/ddlActions.js";
import { EXPORT_ACTION_IDS } from "@table-craft/desktop/renderer/actions/exportActions.js";
import { IMPORT_ACTION_IDS } from "@table-craft/desktop/renderer/actions/importActions.js";
import { SCRIPT_ACTION_IDS } from "@table-craft/desktop/renderer/actions/scriptActions.js";
import { OBJECT_ACTION_IDS } from "@table-craft/desktop/renderer/actions/objectActions.js";
import { HISTORY_ACTION_IDS } from "@table-craft/desktop/renderer/actions/historyActions.js";
import {
  KEY_HIDDEN_WHEN_DISABLED,
  KEY_MENU,
  KEY_TREE_KINDS,
  KEYSPACE_MENU,
} from "@table-craft/desktop/renderer/panes/keyMenus.js";
import { KEY_ACTION_IDS, type KeyDatabaseArgs } from "@table-craft/desktop/renderer/actions/keyActions.js";
import { KEY_EDIT_ACTION_IDS, type KeyChildrenArgs } from "@table-craft/desktop/renderer/actions/keyEditActions.js";
import { invoke, registry, subscribeToActions, useActionEnabled } from "@table-craft/desktop/renderer/actions/index.js";
import { ROUTINE_ACTION_IDS } from "@table-craft/desktop/renderer/actions/routineActions.js";
import { SERVER_ACTION_IDS } from "@table-craft/desktop/renderer/actions/serverActions.js";
import { SESSIONS_ACTION_IDS } from "@table-craft/desktop/renderer/actions/sessionsActions.js";
import { SETTINGS_ACTION_IDS } from "@table-craft/desktop/renderer/actions/settingsActions.js";
import { TABLE_ACTION_IDS } from "@table-craft/desktop/renderer/actions/tableActions.js";
import type { OpenTableArgs } from "@table-craft/desktop/renderer/actions/tableCommands.js";
import { buildTree } from "@table-craft/desktop/renderer/model/datasourceTree.js";
import { DRAG_OBJECT_TYPE, draggedObjectOf } from "@table-craft/desktop/renderer/model/dragObject.js";
import {
  datasourceKey,
  explorerRows,
  shownNamespaceCount,
  type ExplorerNode,
  type ExplorerRow,
} from "@table-craft/desktop/renderer/model/explorerTree.js";
import { arrangeTreeOf } from "@table-craft/desktop/renderer/model/treeDrop.js";
import {
  isRowSelected,
  nextSelection,
  rowItem,
  rowSelection,
  type SelectGesture,
} from "@table-craft/desktop/renderer/model/treeSelection.js";
import { DropLine, useTreeDrag } from "@table-craft/desktop/renderer/panes/useTreeDrag.js";
import { connectionText } from "@table-craft/desktop/renderer/model/format.js";
import { keyIdentity, undescribedKeys } from "@table-craft/desktop/renderer/model/keyTree.js";
import type { OpenKeyArgs } from "@table-craft/desktop/renderer/palette/keysProvider.js";
import { KeyFilterRow } from "@table-craft/desktop/renderer/panes/KeyFilterRow.js";
import { useKeys } from "@table-craft/desktop/renderer/state/keys.js";
import {
  currentMatch,
  SPEED_SEARCH_MAX_LENGTH,
  speedSearchMatches,
  startsSpeedSearch,
  stepMatch,
} from "@table-craft/desktop/renderer/model/speedSearch.js";
import {
  Highlighted,
  EscapedKeyName,
  NodeDetail,
  NodeIcon,
  nodeAriaLabel,
  nodeText,
  nodeTitle,
} from "@table-craft/desktop/renderer/panes/explorerLabels.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import {
  capabilitiesOf,
  connectionOf,
  DISCONNECTED,
  pluginOf,
  treeSelectionOf,
  useDatasources,
  type TreeSelection,
} from "@table-craft/desktop/renderer/state/datasources.js";
import { useLayout } from "@table-craft/desktop/renderer/state/layout.js";
import { ICON_BUTTON_ROW_INSET } from "@table-craft/desktop/renderer/shell/islands.js";
import { themeOf, useIslands, useRowHeightPx, useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import { DatasourceGlyph, useBrandLogo, useDatasourceBrand } from "@table-craft/desktop/renderer/ui/brandIcons.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { isRunningOn, useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { WIDE_MENU_CONTENT } from "@table-craft/desktop/renderer/ui/menu.js";
import { MissingPlugin } from "@table-craft/desktop/renderer/ui/MissingPlugin.js";
import {
  ACTION_ICONS,
  CollapsedIcon,
  DatabaseIcon,
  ExpandedIcon,
  FolderIcon,
  ReadOnlyIcon,
  WarningIcon,
} from "@table-craft/desktop/renderer/ui/icons.js";
import { TINT_SWATCH } from "@table-craft/desktop/renderer/ui/tint.js";
import { AgentAccessBadge } from "@table-craft/desktop/renderer/ui/AgentAccessBadge.js";
import { Tooltip } from "@table-craft/desktop/renderer/ui/Tooltip.js";

const PLAIN_TEXT_TYPE = "text/plain";

const TOOLBAR_ACTIONS = [
  ACTION_IDS.newDatasource,
  ACTION_IDS.datasourceProperties,
  ACTION_IDS.synchronize,
  ACTION_IDS.connect,
  ACTION_IDS.disconnect,
  ACTION_IDS.newConsole,
  ACTION_IDS.collapseAll,
] as const;
const DATASOURCE_MENU = [
  ACTION_IDS.newConsole,
  HISTORY_ACTION_IDS.show,
  HISTORY_ACTION_IDS.reopen,
  SCRIPT_ACTION_IDS.run,
  SESSIONS_ACTION_IDS.show,
  SERVER_ACTION_IDS.show,
  ACTION_IDS.connect,
  ACTION_IDS.disconnect,
  ACTION_IDS.synchronize,
  OBJECT_ACTION_IDS.newDatabase,
  KEY_ACTION_IDS.goTo,
  ACTION_IDS.manageShownSchemas,
  null,
  ACTION_IDS.datasourceProperties,
  ACTION_IDS.duplicateDatasource,
  ACTION_IDS.copyDatasourceUrl,
  ACTION_IDS.moveToFolder,
  null,
  ACTION_IDS.deleteDatasource,
] as const;
const FOLDER_MENU = [
  ACTION_IDS.newDatasource,
  ACTION_IDS.newFolder,
  null,
  ACTION_IDS.moveToFolder,
  null,
  ACTION_IDS.deleteDatasource,
] as const;
const CATALOG_MENU = [
  TABLE_ACTION_IDS.openData,
  ACTION_IDS.newConsole,
  null,
  OBJECT_ACTION_IDS.rename,
  OBJECT_ACTION_IDS.drop,
  null,
  ACTION_IDS.synchronize,
  ACTION_IDS.copyName,
  null,
  ACTION_IDS.toggleSystemSchemas,
] as const;
const ROUTINE_MENU = [
  ROUTINE_ACTION_IDS.execute,
  ACTION_IDS.newConsole,
  null,
  OBJECT_ACTION_IDS.rename,
  OBJECT_ACTION_IDS.drop,
  null,
  ACTION_IDS.synchronize,
  ACTION_IDS.copyName,
  null,
  ACTION_IDS.toggleSystemSchemas,
] as const;
const NAMESPACE_MENU = [
  TABLE_ACTION_IDS.openData,
  ACTION_IDS.newConsole,
  IMPORT_ACTION_IDS.importNewTable,
  SCRIPT_ACTION_IDS.run,
  null,
  OBJECT_ACTION_IDS.newTable,
  OBJECT_ACTION_IDS.newSchema,
  OBJECT_ACTION_IDS.newDatabase,
  null,
  ACTION_IDS.synchronize,
  ACTION_IDS.copyName,
  null,
  ACTION_IDS.toggleSystemSchemas,
  ACTION_IDS.manageShownSchemas,
] as const;
const RELATION_MENU = [
  TABLE_ACTION_IDS.openData,
  EXPORT_ACTION_IDS.exportRelation,
  IMPORT_ACTION_IDS.importIntoTable,
  DDL_ACTION_IDS.open,
  DDL_ACTION_IDS.quickDoc,
  DDL_ACTION_IDS.generator,
  ACTION_IDS.newConsole,
  null,
  OBJECT_ACTION_IDS.modifyTable,
  OBJECT_ACTION_IDS.rename,
  OBJECT_ACTION_IDS.truncate,
  OBJECT_ACTION_IDS.drop,
  null,
  ACTION_IDS.synchronize,
  ACTION_IDS.copyName,
  null,
  ACTION_IDS.toggleSystemSchemas,
] as const;
const COLUMN_MENU = [
  DDL_ACTION_IDS.quickDoc,
  ACTION_IDS.newConsole,
  null,
  ACTION_IDS.synchronize,
  ACTION_IDS.copyName,
  null,
  ACTION_IDS.toggleSystemSchemas,
] as const;
const DOT_CLASS = {
  disconnected: null,
  connecting: "bg-ink-muted animate-pulse",
  connected: "bg-success",
  failed: "bg-danger",
} as const;
const INDENT_PX = 16;
const OVERSCAN_ROWS = 20;
const NO_POSITIONS: readonly number[] = [];
const LEFT_BUTTON = 0;

function shortcutOf(actionId: string): string | undefined {
  const shortcut = registry.get(actionId)?.shortcut;
  return shortcut === undefined ? undefined : formatChord(shortcut, currentPlatform());
}

function ToolbarButton({ actionId }: { readonly actionId: string }) {
  const enabled = useActionEnabled(actionId);
  const action = registry.get(actionId);
  if (action === undefined) return null;
  const Icon = action.icon === undefined ? DatabaseIcon : ACTION_ICONS[action.icon];
  return (
    <Tooltip label={action.title} shortcut={shortcutOf(actionId)} side="bottom">
      <button
        type="button"
        aria-label={action.title}
        disabled={!enabled}
        className="press flex size-tab items-center justify-center rounded text-ink-muted hover:bg-raised hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
        onClick={() => invoke(actionId)}
      >
        <Icon aria-hidden className="size-icon" />
      </button>
    </Tooltip>
  );
}

/** Items that only some plugins offer, left out rather than greyed where they do not apply. */
const HIDDEN_WHEN_DISABLED: ReadonlySet<string> = new Set([
  OBJECT_ACTION_IDS.newSchema,
  OBJECT_ACTION_IDS.newDatabase,
  OBJECT_ACTION_IDS.modifyTable,
  OBJECT_ACTION_IDS.rename,
  OBJECT_ACTION_IDS.truncate,
  OBJECT_ACTION_IDS.drop,
  SESSIONS_ACTION_IDS.show,
  SERVER_ACTION_IDS.show,
  ROUTINE_ACTION_IDS.execute,
  KEY_ACTION_IDS.goTo,
  KEY_ACTION_IDS.loadMore,
  ACTION_IDS.manageShownSchemas,
  ...KEY_HIDDEN_WHEN_DISABLED,
  KEY_EDIT_ACTION_IDS.refreshFolder,
]);

function MenuItem({ actionId }: { readonly actionId: string }) {
  const enabled = useActionEnabled(actionId);
  const action = registry.get(actionId);
  if (action === undefined) return null;
  const shortcut = shortcutOf(actionId);
  return (
    <ContextMenu.Item
      disabled={!enabled}
      className="flex h-row cursor-default items-center justify-between gap-gap rounded px-gap outline-none data-[disabled]:text-ink-muted data-[highlighted]:bg-selection"
      onSelect={() => invoke(actionId)}
    >
      <span>{action.title}</span>
      {shortcut === undefined ? null : <span className="text-ink-muted">{shortcut}</span>}
    </ContextMenu.Item>
  );
}

/** The items to show: plugin-specific ones that do not apply left out, and no separator doubled or at an end. */
function shownItems(items: readonly (string | null)[]): readonly (string | null)[] {
  const shown: (string | null)[] = [];
  for (const item of items) {
    if (item !== null && HIDDEN_WHEN_DISABLED.has(item) && !registry.isEnabled(item)) continue;
    if (item === null && (shown.length === 0 || shown[shown.length - 1] === null)) continue;
    shown.push(item);
  }
  if (shown[shown.length - 1] === null) shown.pop();
  return shown;
}

/** Mounted when the menu opens, so the items left out are those that do not apply to this selection. */
function MenuItems({ items }: { readonly items: readonly (string | null)[] }) {
  useSyncExternalStore(subscribeToActions, () => shownItems(items).join("\n"));
  return shownItems(items).map((actionId, index) =>
    actionId === null ? (
      <ContextMenu.Separator key={`separator-${String(index)}`} className="my-1 h-px bg-line" />
    ) : (
      <MenuItem key={actionId} actionId={actionId} />
    ),
  );
}

function Menu({ items }: { readonly items: readonly (string | null)[] }) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Content className={WIDE_MENU_CONTENT}>
        <MenuItems items={items} />
      </ContextMenu.Content>
    </ContextMenu.Portal>
  );
}

/** Whether the row is the selection's lead, the one focus and the keyboard sit on. */
function isLead(selection: TreeSelection | null, row: ExplorerRow): boolean {
  if (selection === null) return false;
  const { node } = row;
  if (node.kind === "folder") return selection.kind === "folder" && selection.path === node.path;
  if (node.kind === "datasource") return selection.kind === "datasource" && selection.id === node.datasource.id;
  return selection.kind === "catalog" && selection.key === row.key;
}

function menuOf(node: ExplorerNode): readonly (string | null)[] {
  if (node.kind === "folder") return FOLDER_MENU;
  if (node.kind === "datasource") return DATASOURCE_MENU;
  if (node.kind === "relation") return RELATION_MENU;
  if (node.kind === "column") return COLUMN_MENU;
  if (node.kind === "routine") return ROUTINE_MENU;
  if (node.kind === "keyEntry") return KEY_MENU;
  if (KEY_TREE_KINDS.has(node.kind)) return [KEY_EDIT_ACTION_IDS.refreshFolder, ...KEYSPACE_MENU];
  if (node.kind === "namespace" || node.kind === "objectGroup") return NAMESPACE_MENU;
  return CATALOG_MENU;
}

/** "N of M" when Manage Shown Schemas hides some of the datasource's listed namespaces (decision 117). */
function useShownText(node: ExplorerNode): string | null {
  const namespaces = useCatalog((state) =>
    node.kind === "datasource" ? (state.catalogs[node.datasource.id]?.namespaces ?? null) : null,
  );
  const showSystem = useLayout((state) => state.layout.showSystemSchemas);
  if (node.kind !== "datasource") return null;
  const count = shownNamespaceCount(node.datasource, namespaces, showSystem);
  return count === null ? null : `${String(count.shown)} of ${String(count.total)}`;
}

function DatasourceLabel({
  node,
  positions,
  shown,
}: {
  readonly node: Extract<ExplorerNode, { kind: "datasource" }>;
  readonly positions: readonly number[];
  readonly shown: string | null;
}) {
  const { datasource } = node;
  const connection = useDatasources((state) => connectionOf(state, datasource.id));
  const plugin = useDatasources((state) => pluginOf(state.plugins, datasource.pluginId));
  const missing = useDatasources(
    (state) => plugin === undefined && state.catalog.some((entry) => entry.id === datasource.pluginId),
  );
  const brand = useDatasourceBrand(datasource);
  const logo = useBrandLogo(brand);
  const running = useConsoles(
    (state) => connection.status === "connected" && isRunningOn(state.consoles, datasource.id),
  );
  const dot = DOT_CLASS[connection.status];
  const failed = connection.status === "failed";
  return (
    <>
      <DatasourceGlyph
        brand={brand}
        tone={failed ? "danger" : missing ? "muted" : null}
        className="size-icon shrink-0"
      />
      <span className={cn("contents", missing && "text-ink-muted")}>
        <Highlighted text={datasource.name} positions={positions} />
      </span>
      {datasource.color === null ? null : (
        <span aria-hidden data-swatch className={cn("size-2.5 shrink-0 rounded-sm", TINT_SWATCH[datasource.color])} />
      )}
      {datasource.readOnly ? (
        <ReadOnlyIcon aria-label="read-only" className="size-icon shrink-0 text-ink-muted" />
      ) : null}
      <AgentAccessBadge datasource={datasource} />
      {shown === null ? null : (
        <span
          data-testid="shown-namespaces"
          className="shrink-0 text-ink-muted tabular-nums"
          title={`${shown} schemas shown; Manage Shown Schemas… changes which`}
        >
          {shown}
        </span>
      )}
      {dot === null ? null : (
        <span
          aria-hidden
          data-running={running || undefined}
          className={cn("size-2 shrink-0 rounded-full", dot, running && "halo")}
        />
      )}
      {connection.status === "disconnected" || connection.status === "connected" ? null : (
        <span className={cn("truncate", failed ? "text-danger" : "text-ink-muted")}>{connectionText(connection)}</span>
      )}
      {plugin === undefined || logo || connection.status !== "disconnected" ? null : (
        <span data-testid="datasource-product" className="truncate text-ink-muted">
          {brand?.name ?? plugin.name}
        </span>
      )}
      {missing ? <MissingPlugin pluginId={datasource.pluginId} /> : null}
    </>
  );
}

interface RowProps {
  readonly row: ExplorerRow;
  readonly index: number;
  readonly selected: boolean;
  /** The lead of the selection, which takes focus. */
  readonly lead: boolean;
  /** A drag hovers on this folder and would drop into it. */
  readonly dropInto: boolean;
  readonly positions: readonly number[];
  /** `keepFocus` selects the row and leaves focus where it is, in the row's own field say. */
  readonly onSelect: (row: ExplorerRow, keepFocus?: boolean) => void;
  readonly onPress: (row: ExplorerRow, event: MouseEvent<HTMLLIElement>) => void;
  readonly onClick: (row: ExplorerRow, event: MouseEvent<HTMLLIElement>) => void;
  readonly onMenu: (row: ExplorerRow) => void;
  readonly onToggle: (row: ExplorerRow) => void;
  readonly onActivate: (row: ExplorerRow) => void;
  readonly onItemDragStart: (row: ExplorerRow, event: DragEvent<HTMLLIElement>) => void;
  readonly onItemDragEnd: () => void;
  readonly register: (key: string, element: HTMLLIElement | null) => void;
}

function TreeRow({
  row,
  index,
  selected,
  lead,
  dropInto,
  positions,
  onSelect,
  onPress,
  onClick,
  onMenu,
  onToggle,
  onActivate,
  onItemDragStart,
  onItemDragEnd,
  register,
}: RowProps) {
  const { node, depth } = row;
  const connection = useDatasources((state) =>
    node.kind === "datasource" ? connectionOf(state, node.datasource.id) : null,
  );
  const shown = useShownText(node);
  const brand = useDatasourceBrand(
    node.kind === "datasource" ? node.datasource : { id: "", pluginId: "", brand: undefined },
  );
  const label =
    node.kind === "folder"
      ? `${node.name}, folder`
      : node.kind === "datasource"
        ? `${node.datasource.name}, ${connectionText(connection ?? DISCONNECTED)}${shown === null ? "" : `, ${shown} schemas shown`}`
        : nodeAriaLabel(row);
  const failedNamespace = node.kind === "namespace" && node.state?.error != null;
  const title =
    node.kind === "datasource"
      ? connection?.error == null
        ? brand?.name
        : `${connection.error.message} ${connection.error.hint}`
      : nodeTitle(node);
  const dragged = draggedObjectOf(node);
  const movable = rowItem(row) !== null && !(node.kind === "datasource" && node.datasource.ephemeral);
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <li
          ref={(element) => register(row.key, element)}
          role="treeitem"
          aria-label={label}
          aria-description={brand?.name}
          aria-level={depth + 1}
          aria-selected={selected}
          aria-expanded={row.expandable ? row.expanded : undefined}
          title={title}
          tabIndex={lead ? 0 : -1}
          data-index={index}
          data-drop={dropInto ? "into" : undefined}
          data-state={connection?.status ?? (failedNamespace ? "failed" : undefined)}
          data-kind={node.kind}
          style={{
            paddingLeft:
              node.kind === "keyFilter" && node.serverChildren === true
                ? "var(--spacing-pane-inset)"
                : `calc(var(--spacing-pane-inset) + ${String(depth * INDENT_PX)}px)`,
          }}
          className={cn(
            "flex h-row cursor-default items-center gap-cell pr-pane-inset whitespace-nowrap outline-none hover:bg-raised",
            // The filter row is as wide as the pane and pinned there: sized by its controls it
            // would widen the whole tree and let the pane scroll sideways off its own fields.
            node.kind === "keyFilter" ? "sticky left-0 w-[100cqw]" : "w-full",
            // Selection blue only while the tree has focus; elsewhere the row stays marked in grey, as
            // DataGrip draws an inactive selection (plan 130 decision 24).
            selected && "bg-raised group-focus-within/tree:bg-selection",
            dropInto && "bg-selection/50 outline outline-1 -outline-offset-1 outline-accent",
            (failedNamespace || node.kind === "error") && "text-danger",
          )}
          onMouseDown={(event) => onPress(row, event)}
          onClick={(event) => onClick(row, event)}
          onContextMenu={() => onMenu(row)}
          onDoubleClick={() => onActivate(row)}
          draggable={dragged !== null || movable}
          onDragStart={(event) => {
            if (movable) {
              onItemDragStart(row, event);
              return;
            }
            if (dragged === null) return;
            event.dataTransfer.setData(DRAG_OBJECT_TYPE, JSON.stringify(dragged));
            event.dataTransfer.setData(PLAIN_TEXT_TYPE, dragged.name);
            event.dataTransfer.effectAllowed = "copy";
          }}
          onDragEnd={movable ? onItemDragEnd : undefined}
        >
          {row.expandable ? (
            <button
              type="button"
              tabIndex={-1}
              aria-hidden
              className="flex size-icon shrink-0 items-center justify-center text-ink-muted"
              onClick={() => onToggle(row)}
            >
              {row.expanded ? <ExpandedIcon /> : <CollapsedIcon />}
            </button>
          ) : node.kind === "keyFilter" && node.serverChildren === true ? null : (
            <span aria-hidden className="size-icon shrink-0" />
          )}
          {node.kind === "folder" ? (
            <>
              <FolderIcon aria-hidden className="size-icon shrink-0 text-ink-muted" />
              <Highlighted text={node.name} positions={positions} />
            </>
          ) : node.kind === "datasource" ? (
            <DatasourceLabel node={node} positions={positions} shown={shown} />
          ) : node.kind === "keyFilter" ? (
            <KeyFilterRow key={JSON.stringify(node.filter)} node={node} onFocus={() => onSelect(row, true)} />
          ) : (
            <>
              <NodeIcon node={node} />
              {node.kind === "keyEntry" && node.key.hex !== null ? (
                <EscapedKeyName text={nodeText(row)} positions={positions} />
              ) : (
                <Highlighted text={nodeText(row)} positions={positions} />
              )}
              <NodeDetail node={node} />
            </>
          )}
        </li>
      </ContextMenu.Trigger>
      {node.kind === "loading" || node.kind === "error" ? null : <Menu items={menuOf(node)} />}
    </ContextMenu.Root>
  );
}

function EmptyState() {
  const shortcut = shortcutOf(ACTION_IDS.newDatasource);
  return (
    <div className="flex flex-col items-start gap-gap px-pane-inset py-gap text-ink-muted">
      <p>No data sources.</p>
      <button
        type="button"
        className="rounded border border-line px-gap py-1 text-ink hover:bg-raised"
        onClick={() => invoke(ACTION_IDS.newDatasource)}
      >
        New Data Source{shortcut === undefined ? "" : ` (${shortcut})`}
      </button>
    </div>
  );
}

function LoadWarning() {
  const warning = useDatasources((state) => state.warning);
  const dismiss = useDatasources((state) => state.dismissWarning);
  if (warning === null) return null;
  return (
    <div
      role="alert"
      className="mx-pane-inset mb-gap flex items-start gap-cell rounded border border-danger p-cell text-ink"
    >
      <WarningIcon aria-hidden className="mt-0.5 size-icon shrink-0 text-danger" />
      <span className="min-w-0 flex-1">{warning}</span>
      <button type="button" className="text-ink-muted hover:text-ink" onClick={dismiss}>
        Dismiss
      </button>
    </div>
  );
}

/** Why settings.json was set aside, a save failed, or the chosen theme could not be used. */
function SettingsNotice() {
  const notice = useSettings((state) => state.notice);
  const themeNotice = useSettings((state) => themeOf(state).notice);
  const dismiss = useSettings((state) => state.dismissNotice);
  if (notice === null && themeNotice === null) return null;
  return (
    <div
      role="alert"
      data-testid="settings-notice"
      className="mx-pane-inset mb-gap flex items-start gap-cell rounded border border-warning p-cell text-ink"
    >
      <WarningIcon aria-hidden className="mt-0.5 size-icon shrink-0 text-warning" />
      <span className="flex min-w-0 flex-1 flex-col gap-1 break-words">
        {notice === null ? null : <span>{notice}</span>}
        {themeNotice === null ? null : <span>{themeNotice}</span>}
        <span className="flex justify-end gap-gap">
          <button
            type="button"
            className="text-ink-muted hover:text-ink"
            onClick={() => invoke(SETTINGS_ACTION_IDS.show)}
          >
            Settings…
          </button>
          {notice === null ? null : (
            <button type="button" className="text-ink-muted hover:text-ink" onClick={dismiss}>
              Dismiss
            </button>
          )}
        </span>
      </span>
    </div>
  );
}

/** The index of the row's parent: the nearest row above it one level up. */
function parentIndex(rows: readonly ExplorerRow[], index: number): number {
  const depth = rows[index]?.depth ?? 0;
  for (let at = index - 1; at >= 0; at -= 1) if ((rows[at]?.depth ?? 0) < depth) return at;
  return -1;
}

/** Whether the row at `index` sits somewhere under the row at `ancestor`. */
function isUnder(rows: readonly ExplorerRow[], ancestor: number, index: number): boolean {
  if (index <= ancestor) return false;
  const depth = rows[ancestor]?.depth ?? 0;
  for (let at = ancestor + 1; at <= index; at += 1) if ((rows[at]?.depth ?? 0) <= depth) return false;
  return true;
}

/**
 * Datasources in their folders (plan 004) and, below each, its namespaces and their objects
 * (plan 005): one flat virtualized list of the expanded rows.
 */
export function DatabasePane() {
  const islands = useIslands();
  const datasources = useDatasources((state) => state.datasources);
  const plugins = useDatasources((state) => state.plugins);
  const folders = useDatasources((state) => state.folders);
  const loaded = useDatasources((state) => state.loaded);
  const selection = useDatasources((state) => state.selection);
  const multi = useDatasources((state) => state.multi);
  const anchor = useDatasources((state) => state.anchor);
  const select = useDatasources((state) => state.select);
  const setTreeSelection = useDatasources((state) => state.setTreeSelection);
  const catalogs = useCatalog((state) => state.catalogs);
  const expanded = useCatalog((state) => state.expanded);
  const collapsedFolders = useCatalog((state) => state.collapsedFolders);
  const focusRequest = useCatalog((state) => state.focusRequest);
  const query = useCatalog((state) => state.speedSearch);
  const setQuery = useCatalog((state) => state.setSpeedSearch);
  const showSystem = useLayout((state) => state.layout.showSystemSchemas);
  const showEmptyDatabases = useLayout((state) => state.layout.showEmptyDatabases);
  const keyspaces = useKeys((state) => state.keyspaces);
  const elements = useRef(new Map<string, HTMLLIElement>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const tree = useMemo(() => buildTree(datasources, folders), [datasources, folders]);
  const arrangeTree = useMemo(() => arrangeTreeOf(datasources, folders), [datasources, folders]);
  const treeSelection = useMemo(() => ({ lead: selection, multi, anchor }), [selection, multi, anchor]);
  const rows = useMemo(
    () =>
      explorerRows({
        tree,
        catalogs,
        expanded,
        collapsedFolders,
        showSystem,
        canExpand: (datasource) => {
          const capabilities = capabilitiesOf(plugins, datasource.pluginId);
          return capabilities.includes("schemaTree") || capabilities.includes("keyValue");
        },
        keyspaces,
        browsesKeys: (datasource) => capabilitiesOf(plugins, datasource.pluginId).includes("keyValue"),
        showEmptyDatabases,
      }),
    [tree, catalogs, expanded, collapsedFolders, showSystem, plugins, keyspaces, showEmptyDatabases],
  );
  const matches = useMemo(
    () =>
      query === null
        ? []
        : speedSearchMatches(
            rows.map((row) => row.label),
            query,
          ),
    [rows, query],
  );
  const positionsByIndex = useMemo(() => new Map(matches.map((found) => [found.index, found.positions])), [matches]);
  const selectedIndex = rows.findIndex((row) => isLead(selection, row));
  const rowHeightPx = useRowHeightPx();
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeightPx,
    overscan: OVERSCAN_ROWS,
  });
  useEffect(() => virtualizer.measure(), [virtualizer, rowHeightPx]);
  const { drop, startDrag, endDrag, dropHandlers } = useTreeDrag({ rows, tree: arrangeTree, scrollRef, rowHeightPx });
  const virtualItems = virtualizer.getVirtualItems();
  const undescribed = undescribedKeys(virtualItems.map((item) => rows[item.index]));
  const undescribedSignature = undescribed.map(({ datasourceId, database, keys }) =>
    JSON.stringify([datasourceId, database, keys.map(keyIdentity)]),
  );
  useEffect(() => {
    for (const { datasourceId, database, keys } of undescribed)
      void useKeys.getState().describe(datasourceId, database, keys);
    // The signature names what `undescribed` holds; the array itself is new every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undescribedSignature.join("\n")]);

  const visibleFolders = virtualItems.flatMap((item) => {
    const node = rows[item.index]?.node;
    return node?.kind === "keyFolder" && node.key !== undefined ? [node] : [];
  });
  const visibleFolderSignature = visibleFolders
    .map((node) => JSON.stringify([node.datasourceId, node.database, node.key]))
    .join("\n");
  useEffect(() => {
    for (const node of visibleFolders) {
      if (node.key !== undefined) void useKeys.getState().countFolder(node.datasourceId, node.database, node.key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleFolderSignature]);

  const expandedKeyFolders = virtualItems.flatMap((item) => {
    const row = rows[item.index];
    return row?.expanded === true && row.node.kind === "keyFolder" && row.node.key !== undefined ? [row.node] : [];
  });
  const expandedKeyFolderSignature = expandedKeyFolders
    .map((node) =>
      JSON.stringify([
        node.datasourceId,
        node.database,
        node.key,
        node.key === undefined
          ? false
          : keyspaces[node.datasourceId]?.byDatabase[node.database]?.folders?.[keyIdentity(node.key)]?.started,
      ]),
    )
    .join("\n");
  useEffect(() => {
    for (const node of expandedKeyFolders) {
      if (node.key !== undefined) void useKeys.getState().expandFolder(node.datasourceId, node.database, node.key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedKeyFolderSignature]);

  const visibleLeases = virtualItems.flatMap((item) => {
    const node = rows[item.index]?.node;
    if (node?.kind !== "keyEntry" || node.revision === undefined || node.revision.lease === "0") return [];
    const datasource = datasources.find((candidate) => candidate.id === node.datasourceId);
    return datasource !== undefined && capabilitiesOf(plugins, datasource.pluginId).includes("leases")
      ? [[node.datasourceId, node.revision.lease] as const]
      : [];
  });
  const visibleLeaseSignature = visibleLeases
    .map(([id, lease]) => JSON.stringify([id, lease, keyspaces[id]?.leaseTtls?.[lease]]))
    .join("\n");
  useEffect(() => {
    for (const [id, lease] of visibleLeases) void useKeys.getState().readLeaseTtl(id, lease);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleLeaseSignature]);

  // A catalog node that stopped being a row (its datasource detached, system schemas hidden)
  // hands the selection to its datasource, as DataGrip does.
  useEffect(() => {
    if (selection?.kind !== "catalog" || selectedIndex !== -1) return;
    const owner = rows.some((row) => row.key === datasourceKey(selection.id));
    select(owner ? { kind: "datasource", id: selection.id } : null);
  }, [rows, selection, selectedIndex, select]);

  useEffect(() => {
    if (focusRequest === 0) return;
    pendingFocus.current = selectedIndex === -1 ? null : (rows[selectedIndex]?.key ?? null);
    if (selectedIndex !== -1) virtualizer.scrollToIndex(selectedIndex, { align: "auto" });
    // Only a new request moves focus; the selection changing on its own must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  useEffect(() => {
    const key = pendingFocus.current;
    if (key === null) return;
    const element = elements.current.get(key);
    if (element === undefined) return;
    pendingFocus.current = null;
    // After the palette or a menu closes and restores focus, so this focus is the one that stays.
    requestAnimationFrame(() => element.focus());
  });

  function selectIndex(index: number, gesture: SelectGesture = "click"): void {
    const at = Math.max(0, Math.min(rows.length - 1, index));
    const row = rows[at];
    if (row === undefined || rowSelection(row) === null) return;
    setTreeSelection(nextSelection(treeSelectionOf(useDatasources.getState()), rows, at, gesture));
    pendingFocus.current = row.key;
    virtualizer.scrollToIndex(at, { align: "auto" });
  }

  function selectRow(row: ExplorerRow, keepFocus = false, gesture: SelectGesture = "click"): void {
    if (rowSelection(row) === null) return;
    setTreeSelection(nextSelection(treeSelectionOf(useDatasources.getState()), rows, rows.indexOf(row), gesture));
    if (!keepFocus) elements.current.get(row.key)?.focus();
  }

  function gestureOf(event: MouseEvent<HTMLLIElement>): SelectGesture {
    if (event.button !== LEFT_BUTTON) return "pressKeep";
    if (event.shiftKey) return "range";
    if (currentPlatform() === "mac" ? event.metaKey : event.ctrlKey) return "toggle";
    return "pressKeep";
  }

  function press(row: ExplorerRow, event: MouseEvent<HTMLLIElement>): void {
    setQuery(null);
    const gesture = gestureOf(event);
    // Shift and Mod clicks would otherwise select the text between rows.
    if (gesture === "range" || gesture === "toggle") event.preventDefault();
    selectRow(row, false, gesture);
  }

  /** A plain click on a row of a multiple selection that did not start a drag keeps only that row. */
  function click(row: ExplorerRow, event: MouseEvent<HTMLLIElement>): void {
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    if (useDatasources.getState().multi.length > 0) selectRow(row);
  }

  /** A right click inside the selection keeps it for the menu; outside, it selects the row alone. */
  function menu(row: ExplorerRow): void {
    setQuery(null);
    selectRow(row, false, isRowSelected(treeSelectionOf(useDatasources.getState()), row) ? "pressKeep" : "click");
  }

  function toggle(row: ExplorerRow): void {
    const catalog = useCatalog.getState();
    const { node } = row;
    if (row.expanded) {
      const index = rows.indexOf(row);
      if (selectedIndex !== -1 && isUnder(rows, index, selectedIndex)) selectRow(row);
      if (node.kind === "folder") catalog.toggleFolder(node.path);
      else catalog.setExpanded(row.key, false);
      return;
    }
    if (node.kind === "folder") catalog.toggleFolder(node.path);
    else if (node.kind === "datasource" && capabilitiesOf(plugins, node.datasource.pluginId).includes("keyValue")) {
      void useKeys.getState().expandDatasource(node.datasource.id);
    } else if (node.kind === "datasource") void catalog.expandDatasource(node.datasource.id);
    else if (node.kind === "keyDatabase") void useKeys.getState().expandDatabase(node.datasourceId, node.database);
    else if (node.kind === "keyFolder")
      void useKeys
        .getState()
        .expandFolder(node.datasourceId, node.database, node.key ?? { text: node.prefix, hex: null });
    else if (node.kind === "namespace") void catalog.expandNamespace(node.datasourceId, node.namespace);
    else catalog.setExpanded(row.key, true);
  }

  function activate(row: ExplorerRow): void {
    const { node } = row;
    if (node.kind === "datasource") invoke(ACTION_IDS.newConsole);
    else if (node.kind === "relation") {
      const args: OpenTableArgs = { datasourceId: node.datasourceId, path: node.path, relation: node.relation.name };
      invoke(TABLE_ACTION_IDS.openData, args);
    } else if (node.kind === "keyEntry") {
      const args: OpenKeyArgs = { datasourceId: node.datasourceId, database: node.database, key: node.key };
      invoke(KEY_ACTION_IDS.open, args);
    } else if (node.kind === "keyLoadMore") {
      if (node.parent !== undefined) {
        const args: KeyChildrenArgs = {
          datasourceId: node.datasourceId,
          database: node.database,
          parent: node.parent,
          ...(node.restart === undefined ? {} : { restart: node.restart }),
        };
        invoke(KEY_EDIT_ACTION_IDS.loadChildren, args);
        return;
      }
      const args: KeyDatabaseArgs = { datasourceId: node.datasourceId, database: node.database };
      invoke(KEY_ACTION_IDS.loadMore, args);
    } else if (node.kind === "keyFilter") {
      elements.current.get(row.key)?.querySelector("input")?.focus();
    } else if (row.expandable) toggle(row);
  }

  function searchKey(event: KeyboardEvent<HTMLUListElement>): boolean {
    if (query === null) {
      if (!startsSpeedSearch(event)) return false;
      typed(event.key);
      return true;
    }
    if (event.key === "Escape" || event.key === "Enter") setQuery(null);
    else if (event.key === "Backspace") typed(null);
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const next = stepMatch(matches, selectedIndex, event.key === "ArrowDown" ? 1 : -1);
      if (next !== null) selectIndex(next);
    } else if (startsSpeedSearch(event)) typed(event.key);
    else return false;
    return true;
  }

  function typed(character: string | null): void {
    const current = query ?? "";
    const next = character === null ? current.slice(0, -1) : `${current}${character}`.slice(0, SPEED_SEARCH_MAX_LENGTH);
    if (next === "") {
      setQuery(null);
      return;
    }
    setQuery(next);
    const found = currentMatch(
      speedSearchMatches(
        rows.map((row) => row.label),
        next,
      ),
      selectedIndex,
    );
    if (found !== null) selectIndex(found);
  }

  function onKeyDown(event: KeyboardEvent<HTMLUListElement>): void {
    if (searchKey(event)) {
      event.preventDefault();
      return;
    }
    const current = rows[selectedIndex];
    const rangeKey = event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
    if (rangeKey && event.key === "ArrowDown") selectIndex(selectedIndex + 1, "range");
    else if (rangeKey && event.key === "ArrowUp") selectIndex(Math.max(0, selectedIndex - 1), "range");
    else if (event.key === "Escape" && multi.length > 0) select(selection);
    else if (event.key === "ArrowDown") selectIndex(selectedIndex + 1);
    else if (event.key === "ArrowUp") selectIndex(selectedIndex === -1 ? 0 : selectedIndex - 1);
    else if (event.key === "Home") selectIndex(0);
    else if (event.key === "End") selectIndex(rows.length - 1);
    else if (event.key === "ArrowRight" && current !== undefined) {
      if (current.expandable && !current.expanded) toggle(current);
      else if (current.expanded) selectIndex(selectedIndex + 1);
    } else if (event.key === "ArrowLeft" && current !== undefined) {
      if (current.expanded) toggle(current);
      else {
        const parent = parentIndex(rows, selectedIndex);
        if (parent !== -1) selectIndex(parent);
      }
    } else if (event.key === "Enter" && current !== undefined) {
      activate(current);
    } else return;
    event.preventDefault();
  }

  const noMatch = query !== null && matches.length === 0;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="toolbar"
        aria-label="Database toolbar"
        className={cn("flex shrink-0 items-center gap-1", islands ? ICON_BUTTON_ROW_INSET : "px-1")}
      >
        {TOOLBAR_ACTIONS.map((actionId) => (
          <ToolbarButton key={actionId} actionId={actionId} />
        ))}
      </div>
      <LoadWarning />
      <SettingsNotice />
      {loaded && rows.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
          {query === null ? null : (
            <div
              role="status"
              aria-label="Speed search"
              data-state={noMatch ? "noMatch" : "match"}
              className={cn(
                "absolute top-1 right-gap z-10 max-w-[80%] truncate rounded border bg-raised px-cell leading-(--spacing-row) shadow-lg",
                noMatch ? "border-danger text-danger" : "border-line text-ink",
              )}
            >
              {query}
            </div>
          )}
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-1" {...dropHandlers}>
            {/* Long names scroll sideways by trackpad, Shift+wheel or focus, with no bar: the
                tree's own height never overflows here, so the vertical bar stays the outer one's. */}
            <div data-testid="database-tree-scroll" className="relative @container overflow-x-auto scrollbar-none">
              <DropLine
                drop={drop}
                rowHeightPx={rowHeightPx}
                totalPx={virtualizer.getTotalSize()}
                indentPx={INDENT_PX}
              />
              <ul
                role="tree"
                aria-label="Datasources"
                tabIndex={selectedIndex === -1 ? 0 : -1}
                className="group/tree w-max min-w-full outline-none"
                style={{ height: virtualizer.getTotalSize(), paddingTop: virtualItems[0]?.start ?? 0 }}
                onKeyDown={onKeyDown}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) setQuery(null);
                }}
                onFocus={(event) => {
                  if (event.target === event.currentTarget && selectedIndex === -1 && rows[0] !== undefined) {
                    selectIndex(0);
                  }
                }}
              >
                {virtualItems.map((item) => {
                  const row = rows[item.index];
                  if (row === undefined) return null;
                  return (
                    <TreeRow
                      key={row.key}
                      row={row}
                      index={item.index}
                      selected={isRowSelected(treeSelection, row)}
                      lead={item.index === selectedIndex}
                      dropInto={drop?.indicator.kind === "into" && drop.indicator.index === item.index}
                      positions={positionsByIndex.get(item.index) ?? NO_POSITIONS}
                      onSelect={(clicked, keepFocus) => {
                        setQuery(null);
                        selectRow(clicked, keepFocus);
                      }}
                      onPress={press}
                      onClick={click}
                      onMenu={menu}
                      onToggle={toggle}
                      onActivate={activate}
                      onItemDragStart={startDrag}
                      onItemDragEnd={endDrag}
                      register={(key, element) => {
                        if (element === null) elements.current.delete(key);
                        else elements.current.set(key, element);
                      }}
                    />
                  );
                })}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
