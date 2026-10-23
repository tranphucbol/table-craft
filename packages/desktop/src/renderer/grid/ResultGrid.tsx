import * as ContextMenu from "@radix-ui/react-context-menu";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  RESULT_WINDOW_ROWS,
  type CellInput,
  type SortDirection,
  type TypeClass,
  type WireValue,
} from "@table-craft/desktop/engine/protocol.js";
import { currentPlatform, formatChord } from "@table-craft/desktop/renderer/actions/chords.js";
import { REGION_ATTRIBUTE } from "@table-craft/desktop/renderer/actions/context.js";
import {
  GRID_ACTION_IDS,
  LOCAL_FILTER_LABELS,
  LOCAL_FILTER_MENU,
  type SortArgs,
} from "@table-craft/desktop/renderer/actions/gridActions.js";
import { invoke, registry, useActionEnabled } from "@table-craft/desktop/renderer/actions/index.js";
import { DEFAULT_TEXT, formatCell, type CellFormats } from "@table-craft/desktop/renderer/grid/format.js";
import { GridToolbar } from "@table-craft/desktop/renderer/grid/GridToolbar.js";
import { ValuePanel } from "@table-craft/desktop/renderer/grid/ValuePanel.js";
import { displayChars, widerChars } from "@table-craft/desktop/renderer/grid/widths.js";
import {
  columnTemplate,
  fittedTo,
  resizedTo,
  visibleColumns,
  type ColumnLayout,
} from "@table-craft/desktop/renderer/model/columnLayout.js";
import { bufferRowAt, gridRowCount, type EditBuffer } from "@table-craft/desktop/renderer/model/editBuffer.js";
import {
  contains,
  extendTo,
  moveBy,
  rectOf,
  selectCell,
  selectColumn,
  selectRows,
  type Cell,
  type GridBounds,
  type GridSelection,
} from "@table-craft/desktop/renderer/model/gridSelection.js";
import { sortMarkOf } from "@table-craft/desktop/renderer/model/sortKeys.js";
import {
  rowAt,
  shownHeld,
  shownRowCount,
  windowOffsetOf,
  type ResultSearch,
  type ResultTab,
} from "@table-craft/desktop/renderer/state/resultTab.js";
import { FilterChips, FindBar } from "@table-craft/desktop/renderer/grid/FindBar.js";
import { useLayout } from "@table-craft/desktop/renderer/state/layout.js";
import { currentFormats, useCellFormats, useRowHeightPx } from "@table-craft/desktop/renderer/state/settings.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import {
  ReadOnlyIcon,
  SortAscendingMark,
  SortDescendingMark,
  TYPE_GLYPHS,
} from "@table-craft/desktop/renderer/ui/icons.js";

const OVERSCAN_ROWS = 20;
const MIN_GUTTER_DIGITS = 2;
const STALE_TEXT = "Results from a closed connection; rerun to refresh";
const CELL = "truncate border-r border-line px-cell leading-(--spacing-row)";
const MENU_ITEM =
  "flex h-row cursor-default items-center justify-between gap-gap rounded px-gap outline-none data-[disabled]:text-ink-muted data-[highlighted]:bg-selection";
const MENU_CONTENT = "z-50 min-w-48 rounded border border-line bg-raised p-1 text-ui text-ink shadow-lg";
const PRINTABLE_KEY_LENGTH = 1;
const READ_ONLY_COLUMN_TITLE = " (read-only: not a column of the table)";

/** What the grid asks of the store that owns its result: a console's or a table tab's. */
export interface GridHost {
  readonly ensureWindow: (ownerId: string, resultId: string, offset: number) => void;
  readonly select: (ownerId: string, resultId: string, selection: GridSelection | null) => void;
  readonly setLayout: (ownerId: string, resultId: string, layout: ColumnLayout) => void;
  /** The find bar's typed query; its toggles and the chips are actions. */
  readonly search: (ownerId: string, resultId: string, change: (search: ResultSearch) => ResultSearch) => Promise<void>;
}

/** The cell open for editing: its grid row, result column and text. */
export interface GridCellEditor {
  readonly row: number;
  readonly column: number;
  readonly text: string;
}

/**
 * The table editor's layer over the grid (plan 008): pending changes drawn on the cells, rows
 * added after the held ones, and a cell editor in place.
 */
export interface GridEdits {
  readonly buffer: EditBuffer;
  readonly editing: GridCellEditor | null;
  /** Opens the editor on the focused cell; `text` replaces its value, as typing does. */
  readonly begin: (text?: string) => void;
  readonly change: (text: string) => void;
  readonly commit: () => void;
  readonly cancel: () => void;
  /** Cell context menu entries by action id; null draws a separator. */
  readonly menu: readonly (string | null)[];
  /** By result column: true for one that takes no edits, such as an expression in a console result. */
  readonly readOnlyColumns?: readonly boolean[];
}

type EditMark = "modified" | "inserted" | "deleted";

/** A cell the find query matches; `current` is the one the find bar is on. */
type FindMark = "match" | "current";

const GLYPH_OF: Readonly<Record<TypeClass, keyof typeof TYPE_GLYPHS>> = {
  integer: "number",
  float: "number",
  decimal: "number",
  boolean: "bool",
  temporal: "date",
  json: "json",
  bytes: "bytes",
  text: "text",
};

const NUMERIC: ReadonlySet<TypeClass> = new Set(["integer", "float", "decimal"]);

export interface ResultGridProps {
  /** The console or table tab the result belongs to. */
  readonly ownerId: string;
  readonly result: ResultTab;
  readonly host: () => GridHost;
  readonly edits?: GridEdits;
  /** The rows are ordered and filtered in the database, as a table tab's are; sorting and filter chips here are local. */
  readonly serverSorted?: boolean;
  /** Buttons the owner adds to the grid's toolbar, after fetch and rerun. */
  readonly toolbar?: ReactNode;
  readonly staleText?: string;
  /** Replaces the read-only value panel, given the focused grid row and result column. */
  readonly panel?: (focus: { readonly row: number; readonly column: number } | null) => ReactNode;
}

/** The result grid: toolbar, rows, and the value panel beside them (plan 007). */
export function ResultGrid({
  ownerId,
  result,
  host,
  edits,
  serverSorted = false,
  toolbar,
  staleText,
  panel,
}: ResultGridProps) {
  const valuePanel = useLayout((state) => state.layout.valuePanel);
  const visible = useMemo(() => visibleColumns(result.layout), [result.layout]);
  const focus = result.selection?.focus ?? null;
  const focusColumn = focus === null ? undefined : visible[focus.column];
  const focusValue =
    focus === null || focusColumn === undefined ? undefined : rowAt(result.windows, focus.row)?.[focusColumn];
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-loaded-windows={Object.keys(result.windows).length}
      data-stale={result.stale}
    >
      <GridToolbar result={result} serverSorted={serverSorted}>
        {toolbar}
      </GridToolbar>
      {result.search.open ? <FindBar ownerId={ownerId} result={result} host={host} /> : null}
      {result.search.filters.length > 0 ? <FilterChips result={result} local={serverSorted} /> : null}
      {result.stale ? (
        <div
          role="status"
          className="h-row shrink-0 border-b border-line bg-panel px-gap leading-(--spacing-row) text-ink-muted italic"
        >
          {staleText ?? STALE_TEXT}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <Rows key={result.handle} ownerId={ownerId} result={result} visible={visible} host={host} edits={edits} />
        {!valuePanel ? null : panel !== undefined ? (
          panel(focus === null || focusColumn === undefined ? null : { row: focus.row, column: focusColumn })
        ) : (
          <ValuePanel
            column={focusColumn === undefined ? null : (result.columns[focusColumn] ?? null)}
            value={focusValue}
          />
        )}
      </div>
    </div>
  );
}

interface RowsProps {
  readonly ownerId: string;
  readonly result: ResultTab;
  /** Result column indices in drawing order. */
  readonly visible: readonly number[];
  readonly host: () => GridHost;
  readonly edits: GridEdits | undefined;
}

/** A row's values and pending inputs as the grid draws them. */
interface DrawnRow {
  readonly values: readonly WireValue[] | undefined;
  readonly pending: (column: number) => CellInput | undefined;
  readonly mark: EditMark | null;
}

/** Grid row `index`: a shown row's window values, with the buffer's edits named by its held row. */
function drawnRow(result: ResultTab, buffer: EditBuffer | undefined, index: number): DrawnRow {
  const values = rowAt(result.windows, index);
  if (buffer === undefined) return { values, pending: () => undefined, mark: null };
  const row = bufferRowAt(buffer, shownHeld(result), index);
  if (row?.kind === "inserted") {
    const inserted = buffer.inserts.find((each) => each.id === row.id);
    return { values: [], pending: (column) => inserted?.values[column], mark: "inserted" };
  }
  if (row === null) return { values, pending: () => undefined, mark: null };
  const updates = buffer.updates.get(row.row);
  return {
    values,
    pending: (column) => updates?.get(column),
    mark: buffer.deletes.has(row.row) ? "deleted" : null,
  };
}

/** The loaded windows' matched cells as `row * columnCount + column` keys. */
function matchKeys(matches: ResultTab["matches"], width: number): ReadonlySet<number> {
  const keys = new Set<number>();
  for (const pairs of Object.values(matches)) {
    for (let index = 0; index + 1 < pairs.length; index += 2) {
      keys.add((pairs[index] as number) * width + (pairs[index + 1] as number));
    }
  }
  return keys;
}

function cellOf(target: EventTarget): Cell | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest("[data-row][data-col]");
  if (element === null) return null;
  return { row: Number(element.getAttribute("data-row")), column: Number(element.getAttribute("data-col")) };
}

function Rows({ ownerId, result, visible, host, edits }: RowsProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const { windows, selection } = result;
  const rowCount = edits === undefined ? shownRowCount(result) : gridRowCount(edits.buffer, shownHeld(result));
  const width = result.columns.length;
  const matched = useMemo(() => matchKeys(result.matches, width), [result.matches, width]);
  const current = result.search.current;
  const bounds: GridBounds = { rows: rowCount, columns: visible.length };
  const rowHeightPx = useRowHeightPx();
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowHeightPx,
    overscan: OVERSCAN_ROWS,
    // The sticky header row sits above the rows in the scroller, so a row brought into view at the
    // bottom must clear one more row height than the virtualizer knows of.
    scrollPaddingEnd: rowHeightPx,
  });
  useEffect(() => virtualizer.measure(), [virtualizer, rowHeightPx]);
  const formats = useCellFormats();
  const { autoChars: storedChars, typeClasses } = result;
  /** Widths were measured with the formats of their time; a later NULL text or grouping must still fit. */
  const autoChars = useMemo(
    () => widerChars(storedChars, Object.values(windows).flat(), typeClasses, formats),
    [storedChars, windows, typeClasses, formats],
  );
  const items = virtualizer.getVirtualItems();
  const first = items[0]?.index;
  const last = items.at(-1)?.index;

  useEffect(() => {
    if (first === undefined || last === undefined) return;
    const { ensureWindow } = host();
    for (let offset = windowOffsetOf(first); offset <= last; offset += RESULT_WINDOW_ROWS) {
      ensureWindow(ownerId, result.id, offset);
    }
  }, [host, ownerId, result.id, first, last, windows]);

  useEffect(() => {
    const stop = () => {
      dragging.current = false;
    };
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);
  }, []);

  // Add Row and Duplicate select a row past the bottom; bring it into view.
  const focusRow = selection?.focus.row;
  useEffect(() => {
    if (focusRow !== undefined) virtualizer.scrollToIndex(focusRow, { align: "auto" });
  }, [focusRow, virtualizer]);

  // The find bar's current match may sit in a column scrolled out of view.
  const currentPosition = current === null ? -1 : visible.indexOf(current.column);
  const currentRow = current?.row;
  useEffect(() => {
    if (currentRow !== undefined && currentPosition >= 0) reveal({ row: currentRow, column: currentPosition });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reveal reads the scroller, not state
  }, [currentRow, currentPosition]);

  const select = (next: ResultTab["selection"]) => host().select(ownerId, result.id, next);

  /** Gives the keyboard back to the grid once the cell editor closes. */
  function refocus(): void {
    scroller.current?.focus({ preventScroll: true });
  }

  function reveal(cell: Cell): void {
    virtualizer.scrollToIndex(cell.row, { align: "auto" });
    const container = scroller.current;
    const header = container?.querySelector<HTMLElement>(`[data-header-col="${String(cell.column)}"]`);
    const gutter = container?.querySelector<HTMLElement>("[data-gutter-header]");
    if (container == null || header == null) return;
    const left = header.offsetLeft - (gutter?.offsetWidth ?? 0);
    const right = header.offsetLeft + header.offsetWidth;
    if (left < container.scrollLeft) container.scrollLeft = left;
    else if (right > container.scrollLeft + container.clientWidth) container.scrollLeft = right - container.clientWidth;
  }

  function onMouseDown(event: MouseEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    const cell = cellOf(event.target);
    if (cell === null) return;
    dragging.current = true;
    select(event.shiftKey && selection !== null ? extendTo(selection, cell) : selectCell(cell));
  }

  function onMouseOver(event: MouseEvent<HTMLDivElement>): void {
    if (!dragging.current || (event.buttons & 1) === 0) return;
    const cell = cellOf(event.target);
    if (cell === null || selection === null) return;
    if (cell.row !== selection.focus.row || cell.column !== selection.focus.column) select(extendTo(selection, cell));
  }

  function onContextMenu(event: MouseEvent<HTMLDivElement>): void {
    const cell = cellOf(event.target);
    if (cell === null) return;
    const rect = selection === null ? null : rectOf(selection);
    if (rect === null || !contains(rect, cell.row, cell.column)) select(selectCell(cell));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.target !== event.currentTarget) return;
    if (event.metaKey || event.ctrlKey || event.altKey || rowCount === 0 || visible.length === 0) return;
    if (edits !== undefined && selection !== null) {
      if (event.key === "F2") {
        event.preventDefault();
        edits.begin();
        return;
      }
      if (event.key.length === PRINTABLE_KEY_LENGTH && event.key !== " ") {
        event.preventDefault();
        edits.begin(event.key);
        return;
      }
    }
    const page = Math.max(Math.floor((scroller.current?.clientHeight ?? rowHeightPx) / rowHeightPx) - 1, 1);
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      PageUp: [-page, 0],
      PageDown: [page, 0],
      Home: [0, -visible.length],
      End: [0, visible.length],
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    const from = selection ?? selectCell({ row: 0, column: 0 });
    const next = selection === null ? from : moveBy(from, move[0], move[1], bounds, event.shiftKey);
    select(next);
    reveal(next.focus);
  }

  const gutterDigits = Math.max(String(rowCount).length, MIN_GUTTER_DIGITS);
  const template = `calc(${String(gutterDigits)}ch + 2 * var(--spacing-cell)) ${columnTemplate(result.layout, autoChars)}`;
  const rect = selection === null ? null : rectOf(selection);

  return (
    <div
      ref={scroller}
      role="grid"
      aria-label={result.title}
      aria-rowcount={rowCount + 1}
      aria-colcount={visible.length}
      aria-multiselectable
      tabIndex={0}
      {...{ [REGION_ATTRIBUTE]: "grid" }}
      className="min-h-0 min-w-0 flex-1 overflow-auto font-grid text-grid outline-none select-none"
      onKeyDown={onKeyDown}
    >
      <div
        role="row"
        className="sticky top-0 z-20 grid h-row w-max min-w-full border-b border-line bg-panel"
        style={{ gridTemplateColumns: template }}
      >
        <div data-gutter-header className="sticky left-0 z-30 border-r border-line bg-panel" />
        {visible.map((column, position) => (
          <HeaderCell
            key={column}
            ownerId={ownerId}
            host={host}
            result={result}
            column={column}
            position={position}
            bounds={bounds}
            select={select}
            readOnly={edits?.readOnlyColumns?.[column] === true}
          />
        ))}
      </div>
      <CellMenu entries={edits?.menu}>
        <div
          role="rowgroup"
          className="relative"
          style={{ height: virtualizer.getTotalSize() }}
          onMouseDown={onMouseDown}
          onMouseOver={onMouseOver}
          onContextMenu={onContextMenu}
          onDoubleClick={(event) => {
            if (cellOf(event.target) === null) return;
            if (edits !== undefined) edits.begin();
            else if (!useLayout.getState().layout.valuePanel) invoke(GRID_ACTION_IDS.toggleValuePanel);
          }}
        >
          {items.map((item) => {
            const row = drawnRow(result, edits?.buffer, item.index);
            const selectedRow = rect !== null && item.index >= rect.top && item.index <= rect.bottom;
            return (
              <div
                key={item.key}
                role="row"
                aria-rowindex={item.index + 2}
                className={cn("absolute left-0 grid h-row w-max min-w-full", item.index % 2 === 1 && "bg-grid-stripe")}
                style={{ gridTemplateColumns: template, transform: `translateY(${String(item.start)}px)` }}
              >
                <div
                  role="rowheader"
                  className={cn(
                    "sticky left-0 z-10 border-r border-line bg-panel px-cell text-right leading-(--spacing-row) text-ink-muted",
                    selectedRow && "text-ink",
                  )}
                  onMouseDown={(event) => {
                    if (event.button !== 0) return;
                    event.stopPropagation();
                    const from = event.shiftKey && selection !== null ? selection.anchor.row : undefined;
                    select(selectRows(item.index, bounds, from));
                  }}
                >
                  {item.index + 1}
                </div>
                {visible.map((column, position) => {
                  const editing = edits?.editing;
                  if (edits !== undefined && editing?.row === item.index && editing.column === column) {
                    return (
                      <CellEditorInput
                        key={column}
                        name={result.columns[column]?.name ?? ""}
                        row={item.index}
                        position={position}
                        text={editing.text}
                        edits={edits}
                        onClosed={refocus}
                        onTab={() => {
                          const right = { row: item.index, column: Math.min(position + 1, visible.length - 1) };
                          select(selectCell(right));
                        }}
                      />
                    );
                  }
                  const pending = row.pending(column);
                  const find: FindMark | null =
                    current?.row === item.index && current.column === column
                      ? "current"
                      : matched.has(item.index * width + column)
                        ? "match"
                        : null;
                  return (
                    <GridCell
                      find={find}
                      key={column}
                      value={row.mark === "inserted" ? undefined : row.values?.[column]}
                      pending={pending}
                      mark={row.mark ?? (pending === undefined ? null : "modified")}
                      row={item.index}
                      position={position}
                      typeClass={result.typeClasses[column] ?? "text"}
                      formats={formats}
                      selected={rect !== null && contains(rect, item.index, position)}
                      focused={selection?.focus.row === item.index && selection.focus.column === position}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      </CellMenu>
    </div>
  );
}

/** The cells' context menu, when the owner gives one. */
function CellMenu({
  entries,
  children,
}: {
  readonly entries: readonly (string | null)[] | undefined;
  readonly children: ReactNode;
}) {
  if (entries === undefined) return children;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={MENU_CONTENT}>
          {entries.map((actionId, index) =>
            actionId === null ? (
              <ContextMenu.Separator key={`separator-${String(index)}`} className="my-1 h-px bg-line" />
            ) : (
              <MenuItem key={actionId} actionId={actionId} />
            ),
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** The cell editor: Enter commits, Escape cancels, Tab commits and moves right (plan 008 decision 9). */
function CellEditorInput({
  name,
  row,
  position,
  text,
  edits,
  onClosed,
  onTab,
}: {
  readonly name: string;
  readonly row: number;
  readonly position: number;
  readonly text: string;
  readonly edits: GridEdits;
  readonly onClosed: () => void;
  readonly onTab: () => void;
}) {
  const closing = useRef(false);

  function close(commit: boolean): void {
    closing.current = true;
    if (commit) edits.commit();
    else edits.cancel();
    onClosed();
  }

  return (
    <div role="gridcell" data-row={row} data-col={position} data-editing className="relative min-w-0">
      <input
        aria-label={`Edit ${name}`}
        autoFocus
        spellCheck={false}
        className="absolute inset-0 w-full border border-accent bg-canvas px-cell font-grid text-grid text-ink outline-none"
        value={text}
        onChange={(event) => edits.change(event.target.value)}
        onMouseDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
            event.preventDefault();
            close(true);
          } else if (event.key === "Escape") {
            event.preventDefault();
            close(false);
          } else if (event.key === "Tab") {
            event.preventDefault();
            close(true);
            onTab();
          }
        }}
        onBlur={() => {
          if (!closing.current) edits.commit();
        }}
      />
    </div>
  );
}

/** What a cell shows: its pending input over the database's value. */
function cellDisplay(
  value: WireValue | undefined,
  pending: CellInput | undefined,
  typeClass: TypeClass,
  formats: CellFormats,
): { readonly text: string; readonly tone: "null" | "default" | null } {
  if (pending?.kind === "text") return { text: pending.text, tone: null };
  if (pending?.kind === "null") return { text: formats.nullText, tone: "null" };
  if (pending?.kind === "default") return { text: DEFAULT_TEXT, tone: "default" };
  if (value === undefined) return { text: "…", tone: null };
  if (value === null) return { text: formats.nullText, tone: "null" };
  return { text: formatCell(value, typeClass, formats), tone: null };
}

const MARK_CLASS: Readonly<Record<EditMark, string>> = {
  modified: "bg-edit-modified",
  inserted: "bg-edit-inserted",
  deleted: "bg-edit-deleted",
};

function GridCell({
  value,
  pending,
  mark,
  find,
  row,
  position,
  typeClass,
  formats,
  selected,
  focused,
}: {
  readonly value: WireValue | undefined;
  readonly pending: CellInput | undefined;
  readonly mark: EditMark | null;
  readonly find: FindMark | null;
  readonly row: number;
  readonly position: number;
  readonly typeClass: TypeClass;
  readonly formats: CellFormats;
  readonly selected: boolean;
  readonly focused: boolean;
}) {
  const shown = cellDisplay(value, pending, typeClass, formats);
  const numeric = NUMERIC.has(typeClass);
  return (
    <div
      role="gridcell"
      data-row={row}
      data-col={position}
      aria-selected={selected}
      data-null={shown.tone === "null" ? true : undefined}
      data-edit={mark ?? undefined}
      data-match={find ?? undefined}
      className={cn(
        CELL,
        numeric && "text-right",
        find === "current"
          ? "bg-search-match font-semibold"
          : selected
            ? "bg-grid-selection"
            : find === "match"
              ? "bg-search-match"
              : mark !== null && MARK_CLASS[mark],
        mark === "deleted" && "line-through",
        focused && "outline outline-1 -outline-offset-1 outline-accent",
        shown.tone !== null && "text-grid-null italic",
      )}
    >
      {shown.text}
    </div>
  );
}

function SortMark({
  direction,
  position,
  several,
}: {
  readonly direction: SortDirection;
  readonly position: number;
  readonly several: boolean;
}) {
  const Mark = direction === "asc" ? SortAscendingMark : SortDescendingMark;
  return (
    <span data-sort={direction} className="flex shrink-0 items-center text-accent">
      <Mark aria-label={direction === "asc" ? "ascending" : "descending"} className="size-icon" />
      {several ? <span data-sort-position>{position}</span> : null}
    </span>
  );
}

interface HeaderCellProps {
  readonly ownerId: string;
  readonly host: () => GridHost;
  readonly result: ResultTab;
  readonly column: number;
  readonly position: number;
  readonly bounds: GridBounds;
  readonly select: (selection: ResultTab["selection"]) => void;
  readonly readOnly: boolean;
}

function HeaderCell({ ownerId, host, result, column, position, bounds, select, readOnly }: HeaderCellProps) {
  const name = result.columns[column]?.name ?? "";
  const type = result.columns[column]?.type ?? null;
  const Glyph = TYPE_GLYPHS[GLYPH_OF[result.typeClasses[column] ?? "text"]];
  const mark = sortMarkOf(result.sort, column);
  const resizing = useRef<{ readonly x: number; readonly width: number } | null>(null);

  function setLayout(layout: ResultTab["layout"]): void {
    host().setLayout(ownerId, result.id, layout);
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    event.stopPropagation();
    event.preventDefault();
    const cell = event.currentTarget.parentElement;
    if (cell === null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    resizing.current = { x: event.clientX, width: cell.getBoundingClientRect().width };
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    const start = resizing.current;
    if (start === null) return;
    setLayout(resizedTo(result.layout, column, start.width + event.clientX - start.x));
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>): void {
    resizing.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function fit(): void {
    let widest = displayChars(name);
    const typeClass = result.typeClasses[column];
    const formats = currentFormats();
    for (const rows of Object.values(result.windows)) {
      for (const row of rows) {
        widest = Math.max(widest, displayChars(formatCell(row[column] ?? null, typeClass, formats)));
      }
    }
    setLayout(fittedTo(result.layout, column, widest));
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          role="columnheader"
          data-header-col={position}
          data-column-name={name}
          aria-sort={mark === null ? "none" : mark.direction === "asc" ? "ascending" : "descending"}
          title={`${name}: ${type ?? "unknown"}${readOnly ? READ_ONLY_COLUMN_TITLE : ""}`}
          data-read-only={readOnly ? "" : undefined}
          className="relative flex min-w-0 cursor-default items-center gap-1 overflow-hidden border-r border-line px-cell text-ink"
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey) {
              select(selectColumn(position, bounds));
              return;
            }
            const args: SortArgs = { column, add: event.altKey };
            invoke(GRID_ACTION_IDS.sort, args);
          }}
        >
          <Glyph aria-hidden className="size-icon shrink-0 text-ink-muted" />
          <span className={cn("truncate", readOnly && "text-ink-muted italic")}>{name}</span>
          {readOnly ? <ReadOnlyIcon aria-label="read-only" className="size-icon shrink-0 text-ink-muted" /> : null}
          {mark === null ? null : (
            <SortMark direction={mark.direction} position={mark.position} several={result.sort.length > 1} />
          )}
          <div
            aria-hidden
            data-resize-handle
            className="absolute top-0 right-0 z-10 h-full w-2 cursor-col-resize"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => {
              event.stopPropagation();
              fit();
            }}
          />
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={MENU_CONTENT}>
          <MenuItem actionId={GRID_ACTION_IDS.sort} label="Sort Ascending" args={{ column, direction: "asc" }} />
          <MenuItem actionId={GRID_ACTION_IDS.sort} label="Sort Descending" args={{ column, direction: "desc" }} />
          <MenuItem actionId={GRID_ACTION_IDS.clearSort} />
          <ContextMenu.Separator className="my-1 h-px bg-line" />
          <MenuItem actionId={GRID_ACTION_IDS.hideColumn} args={{ column }} />
          <MenuItem actionId={GRID_ACTION_IDS.showAllColumns} />
          <ContextMenu.Separator className="my-1 h-px bg-line" />
          <ContextMenu.Label className="px-gap text-ink-muted">Local filter</ContextMenu.Label>
          {LOCAL_FILTER_MENU.map((actionId) => (
            <MenuItem key={actionId} actionId={actionId} label={LOCAL_FILTER_LABELS[actionId]} args={{ column }} />
          ))}
          <ContextMenu.Separator className="my-1 h-px bg-line" />
          <MenuItem actionId={GRID_ACTION_IDS.copyColumnName} args={{ column }} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function MenuItem({
  actionId,
  label,
  args,
}: {
  readonly actionId: string;
  readonly label?: string;
  readonly args?: unknown;
}) {
  const enabled = useActionEnabled(actionId);
  const action = registry.get(actionId);
  if (action === undefined) return null;
  return (
    <ContextMenu.Item disabled={!enabled} className={MENU_ITEM} onSelect={() => invoke(actionId, args)}>
      <span>{label ?? action.title}</span>
      {action.shortcut === undefined ? null : (
        <span className="text-ink-muted">{formatChord(action.shortcut, currentPlatform())}</span>
      )}
    </ContextMenu.Item>
  );
}
