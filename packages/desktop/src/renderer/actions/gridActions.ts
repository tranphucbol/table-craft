import { writeClipboard } from "@table-craft/desktop/renderer/state/clipboard.js";
import type { ExtractorKind, FilterChip, FindQuery, SortDirection } from "@table-craft/desktop/engine/protocol.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { askExport } from "@table-craft/desktop/renderer/actions/exportActions.js";
import { allShown, hiddenColumn, visibleColumns } from "@table-craft/desktop/renderer/model/columnLayout.js";
import { formatCount } from "@table-craft/desktop/renderer/model/format.js";
import { rowCountOf, selectAll, selectedRanges } from "@table-craft/desktop/renderer/model/gridSelection.js";
import { cycledSort, sortedBy } from "@table-craft/desktop/renderer/model/sortKeys.js";
import { formatCell } from "@table-craft/desktop/renderer/grid/format.js";
import { canFetch, canRun, rowAt, useConsoles, type ResultTab } from "@table-craft/desktop/renderer/state/consoles.js";
import { findsCells, shownRowCount, type ResultSearch } from "@table-craft/desktop/renderer/state/resultTab.js";
import { canReload, tableRowCount, useTables } from "@table-craft/desktop/renderer/state/tables.js";
import { canReloadKey, useKeyTabs } from "@table-craft/desktop/renderer/state/keyTabs.js";
import { reloadTable, settlePendingEdits } from "@table-craft/desktop/renderer/actions/tableCommands.js";
import { focusRegion } from "@table-craft/desktop/renderer/shell/focus.js";
import { useLayout } from "@table-craft/desktop/renderer/state/layout.js";
import { jsonOwnerKey } from "@table-craft/desktop/renderer/model/jsonView.js";
import { useJsonView, type ShownJsonView } from "@table-craft/desktop/renderer/state/jsonView.js";

export const GRID_ACTION_IDS = {
  fetchNextPage: "grid.fetchNextPage",
  fetchAll: "grid.fetchAll",
  cancelFetch: "grid.cancelFetch",
  rerun: "grid.rerun",
  copy: "grid.copy",
  selectAll: "grid.selectAll",
  export: "grid.export",
  toggleValuePanel: "grid.toggleValuePanel",
  toggleJsonView: "grid.toggleJsonView",
  setExtractor: "grid.setExtractor",
  sort: "grid.sort",
  clearSort: "grid.clearSort",
  hideColumn: "grid.hideColumn",
  showAllColumns: "grid.showAllColumns",
  copyColumnName: "grid.copyColumnName",
  find: "grid.find",
  findNext: "grid.findNext",
  findPrevious: "grid.findPrevious",
  closeFind: "grid.closeFind",
  findMatchCase: "grid.findMatchCase",
  findRegex: "grid.findRegex",
  findWholeCell: "grid.findWholeCell",
  filterRows: "grid.filterRows",
  searchAll: "grid.searchAll",
  filterByValue: "grid.filterByValue",
  excludeValue: "grid.excludeValue",
  filterIsNull: "grid.filterIsNull",
  filterIsNotNull: "grid.filterIsNotNull",
  removeFilter: "grid.removeFilter",
  clearFilters: "grid.clearFilters",
} as const;

/** The header menu's local filter entries (plan 023); they act on the focused row's value. */
export const LOCAL_FILTER_MENU: readonly string[] = [
  GRID_ACTION_IDS.filterByValue,
  GRID_ACTION_IDS.excludeValue,
  GRID_ACTION_IDS.filterIsNull,
  GRID_ACTION_IDS.filterIsNotNull,
];

/** How the header menu, under its "Local filter" label, names those entries. */
export const LOCAL_FILTER_LABELS: Readonly<Record<string, string>> = {
  [GRID_ACTION_IDS.filterByValue]: "Filter by This Value",
  [GRID_ACTION_IDS.excludeValue]: "Exclude This Value",
  [GRID_ACTION_IDS.filterIsNull]: "Is NULL",
  [GRID_ACTION_IDS.filterIsNotNull]: "Is Not NULL",
};

/** Above this many selected rows Copy is off: the clipboard is the wrong place, Export is the right one. */
export const MAX_COPY_ROWS = 100_000;

export const EXTRACTOR_LABELS: Readonly<Record<ExtractorKind, string>> = {
  csv: "CSV",
  tsv: "TSV",
  json: "JSON",
  sqlInsert: "SQL Inserts",
  markdown: "Markdown",
};

const EXPORT_RESULT_NOTE =
  "Every row of the result. A read runs again on a connection of its own; anything else exports the rows this result holds and fetches.";
const EXPORT_SHOWN_NOTE =
  "The rows the grid shows, in its order: the fetched rows the local filter keeps, without fetching more.";
const WHOLE_RESULT_LABEL = "Whole result";

/** A header menu entry names its column by result index. */
export interface ColumnArgs {
  readonly column: number;
}

/** A filter chip's place in the result's chip list. */
export interface FilterIndexArgs {
  readonly index: number;
}

/** A header click: `add` (⌥-click) makes it a further key; `direction` sets it rather than cycling. */
export interface SortArgs extends ColumnArgs {
  readonly add?: boolean;
  readonly direction?: SortDirection;
}

export interface ExtractorArgs {
  readonly extractor: ExtractorKind;
}

/** What the grid's actions ask of the store holding the shown result; consoles and tables share it. */
type ResultHost = Pick<
  ReturnType<typeof useConsoles.getState>,
  | "fetchMore"
  | "stopFetch"
  | "sort"
  | "setLayout"
  | "select"
  | "extract"
  | "aggregate"
  | "cellBytes"
  | "saveBytes"
  | "loadBytes"
  | "exportTo"
  | "search"
  | "findNext"
>;

export interface ShownResult {
  /** The console or table tab showing the result. */
  readonly ownerId: string;
  readonly result: ResultTab;
  readonly host: ResultHost;
  /** Rows the grid draws, the table editor's added ones included. */
  readonly rows: number;
}

/** The result the active tab shows, with the store that holds it. */
export function shown(context: ActionContext): ShownResult | null {
  if (context.activeTab === null || context.result === null) return null;
  const ownerId = context.activeTab.id;
  if (context.console !== null) {
    return { ownerId, result: context.result, host: useConsoles.getState(), rows: shownRowCount(context.result) };
  }
  if (context.table !== null) {
    return { ownerId, result: context.result, host: useTables.getState(), rows: tableRowCount(context.table) };
  }
  if (context.keyTab !== null) {
    return { ownerId, result: context.result, host: useKeyTabs.getState(), rows: shownRowCount(context.result) };
  }
  return null;
}

/** The JSON-capable value the shown result's value panel draws, if any. */
function shownJsonView(context: ActionContext): ShownJsonView | null {
  const target = shown(context);
  if (target === null) return null;
  return useJsonView.getState().panels[jsonOwnerKey(target.ownerId, target.result.handle)] ?? null;
}

/** Whether Rerun can start: a console's Run or a table's Reload. */
function canRerun(context: ActionContext): boolean {
  if (shown(context) === null) return false;
  if (context.console !== null) return canRun(context.console.status);
  if (context.keyTab !== null) return canReloadKey(context.keyTab.status);
  return context.table !== null && canReload(context.table.status);
}

/** The shown result while its connection is open. */
export function live(context: ActionContext): ShownResult | null {
  const target = shown(context);
  return target === null || target.result.stale ? null : target;
}

/** The column a header menu named, or from the palette the focused cell's column. */
function columnOf(result: ResultTab, args: Partial<ColumnArgs> | undefined): number | null {
  const column = args?.column ?? visibleColumns(result.layout)[result.selection?.focus.column ?? -1];
  if (column === undefined || !Number.isInteger(column) || column < 0 || column >= result.columns.length) return null;
  return column;
}

/** Why Copy is off for the selection, or null when it can run. */
export function copyBlockedReason(result: ResultTab | null): string | null {
  if (result === null || result.selection === null) return "Select cells to copy";
  if (result.stale) return "Rerun to copy from a closed connection's results";
  if (rowCountOf(result.selection) > MAX_COPY_ROWS) {
    return `Copy takes at most ${formatCount(MAX_COPY_ROWS)} rows; use Export`;
  }
  return null;
}

/** The shown result while its find bar is open. */
function searching(context: ActionContext): ShownResult | null {
  const target = live(context);
  return target?.result.search.open === true ? target : null;
}

async function changeSearch(target: ShownResult, change: (search: ResultSearch) => ResultSearch): Promise<void> {
  await target.host.search(target.ownerId, target.result.id, change);
}

function toggled(key: "caseSensitive" | "regex" | "wholeCell") {
  return (search: ResultSearch): ResultSearch => ({ ...search, query: { ...search.query, [key]: !search.query[key] } });
}

function sameChip(a: FilterChip, b: FilterChip): boolean {
  return a.column === b.column && a.op === b.op && ("text" in a ? a.text : null) === ("text" in b ? b.text : null);
}

function withChip(search: ResultSearch, chip: FilterChip): ResultSearch {
  return search.filters.some((each) => sameChip(each, chip))
    ? search
    : { ...search, filters: [...search.filters, chip] };
}

/**
 * The chip a header menu entry makes for `column`: the null tests as they are, a value from the
 * focused row (its database text, as the engine compares it); null when that row is not loaded.
 */
function chipFor(result: ResultTab, column: number, op: FilterChip["op"]): FilterChip | null {
  if (op === "isNull" || op === "isNotNull") return { column, op };
  const focus = result.selection?.focus;
  const value = focus === undefined ? undefined : rowAt(result.windows, focus.row)?.[column];
  if (value === undefined) return null;
  if (value === null) return { column, op: op === "equals" ? "isNull" : "isNotNull" };
  return { column, op, text: formatCell(value) };
}

function filterAction(id: string, title: string, op: FilterChip["op"]): AnyAction {
  return defineAction<ColumnArgs | undefined>({
    id,
    title,
    category: "Result Grid",
    icon: "filter",
    when: (context) => {
      const target = live(context);
      if (target === null) return false;
      if (op === "isNull" || op === "isNotNull") return true;
      const focus = target.result.selection?.focus;
      return focus !== undefined && rowAt(target.result.windows, focus.row) !== undefined;
    },
    run: async (context, args) => {
      const target = live(context);
      const column = target === null ? null : columnOf(target.result, args);
      const chip = target === null || column === null ? null : chipFor(target.result, column, op);
      if (target === null || chip === null) return;
      await changeSearch(target, (search) => withChip(search, chip));
    },
  });
}

export const GRID_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: GRID_ACTION_IDS.fetchNextPage,
    title: "Fetch Next Page",
    category: "Result Grid",
    icon: "fetchNextPage",
    when: (context) => {
      const target = live(context);
      return target !== null && canFetch(target.result);
    },
    run: async (context) => {
      const target = live(context);
      if (target !== null) await target.host.fetchMore(target.ownerId, target.result.id, false);
    },
  }),
  defineAction({
    id: GRID_ACTION_IDS.fetchAll,
    title: "Fetch All",
    category: "Result Grid",
    icon: "fetchAll",
    when: (context) => {
      const target = live(context);
      return target !== null && canFetch(target.result);
    },
    run: async (context) => {
      const target = live(context);
      if (target !== null) await target.host.fetchMore(target.ownerId, target.result.id, true);
    },
  }),
  defineAction({
    id: GRID_ACTION_IDS.cancelFetch,
    title: "Cancel Fetch",
    category: "Result Grid",
    icon: "cancel",
    when: (context) => {
      const fetching = live(context)?.result.fetching;
      return fetching === "page" || fetching === "all";
    },
    run: async (context) => {
      const target = live(context);
      if (target !== null) await target.host.stopFetch(target.ownerId, target.result.id);
    },
  }),
  defineAction({
    id: GRID_ACTION_IDS.rerun,
    title: "Rerun",
    category: "Result Grid",
    icon: "rerun",
    shortcut: "Mod+R",
    shortcutRegion: "grid",
    when: canRerun,
    run: async (context) => {
      const target = shown(context);
      if (target === null) return;
      if (context.table !== null) await reloadTable(target.ownerId);
      else if (context.keyTab !== null) await useKeyTabs.getState().reload(target.ownerId);
      else await useConsoles.getState().rerun(target.ownerId, target.result.id);
    },
  }),
  defineAction({
    id: GRID_ACTION_IDS.copy,
    title: "Copy",
    category: "Result Grid",
    icon: "copy",
    shortcut: "Mod+C",
    shortcutRegion: "grid",
    when: (context) => copyBlockedReason(context.result) === null,
    run: async (context) => {
      const target = live(context);
      const selection = target?.result.selection ?? null;
      if (target === null || selection === null) return;
      const { rows, columns } = selectedRanges(selection, visibleColumns(target.result.layout));
      // Rows added in the table editor are not in the engine yet; Copy takes the held ones it shows.
      const shownRows = shownRowCount(target.result);
      const held = rows.flatMap((range) =>
        range.from >= shownRows ? [] : [{ from: range.from, to: Math.min(range.to, shownRows) }],
      );
      if (held.length === 0) return;
      const { extractor } = useLayout.getState().layout;
      const text = await target.host.extract(target.ownerId, target.result.id, extractor, held, columns);
      if (text !== null) await writeClipboard(text);
    },
  }),
  defineAction({
    id: GRID_ACTION_IDS.selectAll,
    title: "Select All Rows",
    category: "Result Grid",
    shortcut: "Mod+A",
    shortcutRegion: "grid",
    when: (context) => (shown(context)?.rows ?? 0) > 0,
    run: (context) => {
      const target = shown(context);
      if (target === null) return;
      const { result } = target;
      const bounds = { rows: target.rows, columns: visibleColumns(result.layout).length };
      target.host.select(target.ownerId, result.id, selectAll(bounds));
    },
  }),
  defineAction({
    id: GRID_ACTION_IDS.export,
    title: "Export Data…",
    category: "Result Grid",
    icon: "export",
    when: (context) => {
      const target = live(context);
      return target !== null && target.result.fetching === null;
    },
    run: async (context) => {
      const target = live(context);
      if (target === null) return;
      const { result } = target;
      const narrowed = result.view?.filtered === true;
      const choice = await askExport({
        name: result.title,
        columns: result.columns.map((column) => column.name),
        chosen: visibleColumns(result.layout),
        note: EXPORT_RESULT_NOTE,
        ...(narrowed
          ? {
              rows: {
                shownLabel: `Visible rows only (${formatCount(shownRowCount(result))})`,
                wholeLabel: WHOLE_RESULT_LABEL,
                shownNote: EXPORT_SHOWN_NOTE,
              },
            }
          : {}),
      });
      if (choice === null) return;
      await target.host.exportTo(
        target.ownerId,
        result.id,
        choice.format,
        choice.path,
        choice.columns,
        narrowed && choice.shownOnly,
      );
    },
  }),
  defineAction({
    id: GRID_ACTION_IDS.toggleValuePanel,
    title: "Value Panel",
    category: "Result Grid",
    icon: "valuePanel",
    shortcut: "Shift+Enter",
    shortcutRegion: "grid",
    when: (context) => shown(context) !== null,
    run: () => useLayout.getState().toggleValuePanel(),
  }),
  defineAction({
    id: GRID_ACTION_IDS.toggleJsonView,
    title: "Toggle JSON View",
    category: "Result Grid",
    icon: "jsonView",
    shortcut: "Mod+Alt+J",
    shortcutRegion: ["grid", "valuePanel"],
    when: (context) => shownJsonView(context) !== null,
    run: (context) => {
      const panel = shownJsonView(context);
      if (panel !== null) useJsonView.getState().set(panel.key, !panel.on);
    },
  }),
  defineAction<ExtractorArgs | undefined>({
    id: GRID_ACTION_IDS.setExtractor,
    title: "Choose Extractor",
    category: "Result Grid",
    run: (_context, args) => {
      if (args !== undefined) useLayout.getState().setExtractor(args.extractor);
    },
  }),
  defineAction<SortArgs | undefined>({
    id: GRID_ACTION_IDS.sort,
    title: "Sort",
    category: "Result Grid",
    icon: "sortAscending",
    when: (context) => live(context) !== null,
    run: async (context, args) => {
      const target = live(context);
      const column = target === null ? null : columnOf(target.result, args);
      if (target === null || column === null) return;
      const keys =
        args?.direction === undefined
          ? cycledSort(target.result.sort, column, args?.add === true)
          : sortedBy(column, args.direction);
      if (context.table !== null && !(await settlePendingEdits([target.ownerId], "sort"))) return;
      await target.host.sort(target.ownerId, target.result.id, keys);
    },
  }),
  defineAction({
    id: GRID_ACTION_IDS.clearSort,
    title: "Clear Sort",
    category: "Result Grid",
    when: (context) => (live(context)?.result.sort.length ?? 0) > 0,
    run: async (context) => {
      const target = live(context);
      if (target === null) return;
      if (context.table !== null && !(await settlePendingEdits([target.ownerId], "sort"))) return;
      await target.host.sort(target.ownerId, target.result.id, []);
    },
  }),
  defineAction<ColumnArgs | undefined>({
    id: GRID_ACTION_IDS.hideColumn,
    title: "Hide Column",
    category: "Result Grid",
    icon: "hide",
    when: (context) => visibleColumns(context.result?.layout ?? { widths: [], hidden: [] }).length > 1,
    run: (context, args) => {
      const target = shown(context);
      const column = target === null ? null : columnOf(target.result, args);
      if (target === null || column === null) return;
      const layout = hiddenColumn(target.result.layout, column);
      target.host.setLayout(target.ownerId, target.result.id, layout);
    },
  }),
  defineAction({
    id: GRID_ACTION_IDS.showAllColumns,
    title: "Show All Columns",
    category: "Result Grid",
    when: (context) => context.result?.layout.hidden.includes(true) === true,
    run: (context) => {
      const target = shown(context);
      if (target === null) return;
      target.host.setLayout(target.ownerId, target.result.id, allShown(target.result.layout));
    },
  }),
  defineAction<ColumnArgs | undefined>({
    id: GRID_ACTION_IDS.copyColumnName,
    title: "Copy Column Name",
    category: "Result Grid",
    icon: "copy",
    when: (context) => shown(context) !== null,
    run: async (context, args) => {
      const target = shown(context);
      const index = target === null ? null : columnOf(target.result, args);
      const column = index === null ? undefined : target?.result.columns[index];
      if (column !== undefined) await writeClipboard(column.name);
    },
  }),
  defineAction({
    id: GRID_ACTION_IDS.find,
    title: "Find in Result",
    category: "Result Grid",
    icon: "search",
    shortcut: "Mod+F",
    shortcutRegion: ["grid", "gridFind"],
    when: (context) => live(context) !== null,
    run: async (context) => {
      const target = live(context);
      if (target === null) return;
      await changeSearch(target, (search) => ({ ...search, open: true, focusRequest: search.focusRequest + 1 }));
    },
  }),
  defineAction({
    id: GRID_ACTION_IDS.findNext,
    title: "Find Next",
    category: "Result Grid",
    icon: "findNext",
    shortcut: "Enter",
    shortcutRegion: "gridFind",
    when: (context) => {
      const target = searching(context);
      return target !== null && findsCells(target.result) && (target.result.view?.matches ?? 0) > 0;
    },
    run: async (context) => {
      const target = searching(context);
      if (target !== null) await target.host.findNext(target.ownerId, target.result.id, false);
    },
  }),
  defineAction({
    id: GRID_ACTION_IDS.findPrevious,
    title: "Find Previous",
    category: "Result Grid",
    icon: "findPrevious",
    shortcut: "Shift+Enter",
    shortcutRegion: "gridFind",
    when: (context) => {
      const target = searching(context);
      return target !== null && findsCells(target.result) && (target.result.view?.matches ?? 0) > 0;
    },
    run: async (context) => {
      const target = searching(context);
      if (target !== null) await target.host.findNext(target.ownerId, target.result.id, true);
    },
  }),
  defineAction({
    id: GRID_ACTION_IDS.closeFind,
    title: "Close Find",
    category: "Result Grid",
    icon: "close",
    shortcut: "Escape",
    shortcutRegion: "gridFind",
    when: (context) => searching(context) !== null,
    run: async (context) => {
      const target = searching(context);
      if (target === null) return;
      focusRegion("grid");
      await changeSearch(target, (search) => ({ ...search, open: false, current: null }));
    },
  }),
  defineAction({
    id: GRID_ACTION_IDS.findMatchCase,
    title: "Match Case",
    category: "Result Grid",
    when: (context) => searching(context) !== null,
    run: async (context) => {
      const target = searching(context);
      if (target !== null) await changeSearch(target, toggled("caseSensitive"));
    },
  }),
  defineAction({
    id: GRID_ACTION_IDS.findRegex,
    title: "Regular Expression",
    category: "Result Grid",
    when: (context) => searching(context) !== null,
    run: async (context) => {
      const target = searching(context);
      if (target !== null) await changeSearch(target, toggled("regex"));
    },
  }),
  defineAction({
    id: GRID_ACTION_IDS.findWholeCell,
    title: "Whole Cell",
    category: "Result Grid",
    when: (context) => searching(context) !== null,
    run: async (context) => {
      const target = searching(context);
      if (target !== null) await changeSearch(target, toggled("wholeCell"));
    },
  }),
  defineAction({
    id: GRID_ACTION_IDS.filterRows,
    title: "Filter Rows",
    category: "Result Grid",
    icon: "filter",
    when: (context) => live(context) !== null,
    run: async (context) => {
      const target = live(context);
      if (target === null) return;
      await changeSearch(target, (search) => ({
        ...search,
        open: true,
        rowsOnly: !search.rowsOnly,
        focusRequest: search.open ? search.focusRequest : search.focusRequest + 1,
      }));
    },
  }),
  defineAction({
    id: GRID_ACTION_IDS.searchAll,
    title: "Search All Rows",
    category: "Result Grid",
    icon: "fetchAll",
    when: (context) => {
      const target = live(context);
      return target !== null && target.result.view !== null && !target.result.complete && canFetch(target.result);
    },
    run: async (context) => {
      const target = live(context);
      if (target !== null) await target.host.fetchMore(target.ownerId, target.result.id, true);
    },
  }),
  filterAction(GRID_ACTION_IDS.filterByValue, "Local Filter: This Value", "equals"),
  filterAction(GRID_ACTION_IDS.excludeValue, "Local Filter: Exclude This Value", "notEquals"),
  filterAction(GRID_ACTION_IDS.filterIsNull, "Local Filter: Is NULL", "isNull"),
  filterAction(GRID_ACTION_IDS.filterIsNotNull, "Local Filter: Is Not NULL", "isNotNull"),
  defineAction<FilterIndexArgs | undefined>({
    id: GRID_ACTION_IDS.removeFilter,
    title: "Remove Local Filter",
    category: "Result Grid",
    icon: "close",
    when: (context) => (live(context)?.result.search.filters.length ?? 0) > 0,
    run: async (context, args) => {
      const target = live(context);
      if (target === null) return;
      const index = args?.index ?? target.result.search.filters.length - 1;
      await changeSearch(target, (search) => ({
        ...search,
        filters: search.filters.filter((_, at) => at !== index),
      }));
    },
  }),
  defineAction({
    id: GRID_ACTION_IDS.clearFilters,
    title: "Clear Local Filters",
    category: "Result Grid",
    when: (context) => (live(context)?.result.search.filters.length ?? 0) > 0,
    run: async (context) => {
      const target = live(context);
      if (target === null) return;
      await changeSearch(target, (search) => ({ ...search, filters: [] }));
    },
  }),
];

/** What a chip says: `name = text`, `name ≠ text`, `name IS NULL`. */
export function chipLabel(result: ResultTab, chip: FilterChip): string {
  const name = result.columns[chip.column]?.name ?? `#${String(chip.column + 1)}`;
  switch (chip.op) {
    case "equals":
      return `${name} = ${chip.text}`;
    case "notEquals":
      return `${name} ≠ ${chip.text}`;
    case "isNull":
      return `${name} IS NULL`;
    case "isNotNull":
      return `${name} IS NOT NULL`;
  }
}

export type { FindQuery };
