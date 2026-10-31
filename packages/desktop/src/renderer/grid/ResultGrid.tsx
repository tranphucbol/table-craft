import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Group, Panel, type PanelImperativeHandle } from "react-resizable-panels";
import { RESULT_WINDOW_ROWS } from "@table-craft/desktop/engine/protocol.js";
import { REGION_ATTRIBUTE } from "@table-craft/desktop/renderer/actions/context.js";
import {
  CellEditorInput,
  CellMenu,
  GridCell,
  HeaderCell,
  type FindMark,
  type GridEdits,
  type GridHost,
} from "@table-craft/desktop/renderer/grid/GridCells.js";
import {
  beganEdit,
  drawnRow,
  matchKeys,
  useCellPointer,
  type RowsProps,
} from "@table-craft/desktop/renderer/grid/gridRows.js";
import { TransposedRows } from "@table-craft/desktop/renderer/grid/TransposedRows.js";
import { AggregateLine } from "@table-craft/desktop/renderer/grid/AggregateLine.js";
import { FocusedBytes, type FocusedBytesReader } from "@table-craft/desktop/renderer/grid/BytesView.js";
import { GridToolbar } from "@table-craft/desktop/renderer/grid/GridToolbar.js";
import { ValuePanel } from "@table-craft/desktop/renderer/grid/ValuePanel.js";
import { widerChars } from "@table-craft/desktop/renderer/grid/widths.js";
import { focusedBinaryCell } from "@table-craft/desktop/renderer/model/binaryCells.js";
import { columnTemplate, visibleColumns } from "@table-craft/desktop/renderer/model/columnLayout.js";
import { jsonOwnerKey } from "@table-craft/desktop/renderer/model/jsonView.js";
import { gridRowCount } from "@table-craft/desktop/renderer/model/editBuffer.js";
import {
  contains,
  moveBy,
  rectOf,
  selectCell,
  selectRows,
  type Cell,
  type GridBounds,
} from "@table-craft/desktop/renderer/model/gridSelection.js";
import {
  rowAt,
  shownHeld,
  shownRowCount,
  windowOffsetOf,
  type ResultTab,
} from "@table-craft/desktop/renderer/state/resultTab.js";
import { FilterChips, FindBar } from "@table-craft/desktop/renderer/grid/FindBar.js";
import { MIN_VALUE_PANEL_PX, useLayout } from "@table-craft/desktop/renderer/state/layout.js";
import {
  useCellFormats,
  useDefaultValuePanelPx,
  useRowHeightPx,
  useSettings,
} from "@table-craft/desktop/renderer/state/settings.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { Handle } from "@table-craft/desktop/renderer/ui/Handle.js";

export type { GridCellEditor, GridEdits, GridHost } from "@table-craft/desktop/renderer/grid/GridCells.js";

const OVERSCAN_ROWS = 20;
const MIN_GUTTER_DIGITS = 2;
const STALE_TEXT = "Results from a closed connection; rerun to refresh";
/** The rows keep this much while the value panel's edge is dragged (plan 129 decision 5). */
const MIN_ROWS_PX = 240;
const MAX_VALUE_PANEL_SIZE = "70%";
/** The library's panels scroll by default; the rows and the value panel scroll themselves. */
const PANEL_STYLE = { overflow: "hidden" } as const;
const NOT_ID_CHAR = /[^\w-]/g;

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
  const defaultValuePanelPx = useDefaultValuePanelPx();
  const valuePanelPx = useLayout((state) => state.layout.valuePanelWidthPx) ?? defaultValuePanelPx;
  const valuePanelRef = useRef<PanelImperativeHandle>(null);
  /** Panel ids are DOM ids; React's own carry characters a selector would have to escape. */
  const panelIds = `result-grid-${useId().replace(NOT_ID_CHAR, "")}-`;
  const visible = useMemo(() => visibleColumns(result.layout), [result.layout]);
  const focus = result.selection?.focus ?? null;
  const focusColumn = focus === null ? undefined : visible[focus.column];
  const focusValue =
    focus === null || focusColumn === undefined ? undefined : rowAt(result.windows, focus.row)?.[focusColumn];
  const binary = focusedBinaryCell(result, edits?.buffer);
  const held = binary?.held;
  const resultId = result.id;
  const readBytes = useMemo<FocusedBytesReader>(
    () =>
      held === undefined || focusColumn === undefined
        ? null
        : (maxBytes) => host().cellBytes(ownerId, resultId, held, focusColumn, maxBytes),
    [host, ownerId, resultId, held, focusColumn],
  );
  const transposed = result.layout.transposed === true;
  const area = useRef<HTMLDivElement>(null);
  const shownTransposed = useRef(transposed);
  // Transposing by its chord unmounts the focused grid; hand the keyboard to the one that replaced it.
  useLayoutEffect(() => {
    if (shownTransposed.current === transposed) return;
    shownTransposed.current = transposed;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    area.current?.querySelector<HTMLElement>('[role="grid"]')?.focus({ preventScroll: true });
  }, [transposed]);
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
      <FocusedBytes.Provider value={readBytes}>
        <Group
          elementRef={area}
          orientation="horizontal"
          className="min-h-0 flex-1"
          onLayoutChanged={(_layout, meta) => {
            const size = valuePanelRef.current?.getSize();
            if (meta.isUserInteraction && size !== undefined) useLayout.getState().resizeValuePanel(size.inPixels);
          }}
        >
          <Panel id={`${panelIds}rows`} minSize={MIN_ROWS_PX} className="flex" style={PANEL_STYLE}>
            {transposed ? (
              <TransposedRows
                key={result.handle}
                ownerId={ownerId}
                result={result}
                visible={visible}
                host={host}
                edits={edits}
              />
            ) : (
              <Rows key={result.handle} ownerId={ownerId} result={result} visible={visible} host={host} edits={edits} />
            )}
          </Panel>
          {valuePanel ? <Handle axis="vertical" label="Value panel" /> : null}
          {valuePanel ? (
            <Panel
              id={`${panelIds}value`}
              panelRef={valuePanelRef}
              defaultSize={valuePanelPx}
              minSize={MIN_VALUE_PANEL_PX}
              maxSize={MAX_VALUE_PANEL_SIZE}
              groupResizeBehavior="preserve-pixel-size"
              className="flex"
              style={PANEL_STYLE}
            >
              {panel !== undefined ? (
                panel(focus === null || focusColumn === undefined ? null : { row: focus.row, column: focusColumn })
              ) : (
                <ValuePanel
                  column={focusColumn === undefined ? null : (result.columns[focusColumn] ?? null)}
                  value={focusValue}
                  jsonOwner={jsonOwnerKey(ownerId, result.handle)}
                />
              )}
            </Panel>
          ) : null}
        </Group>
      </FocusedBytes.Provider>
      <AggregateLine ownerId={ownerId} result={result} host={host} />
    </div>
  );
}

function Rows({ ownerId, result, visible, host, edits }: RowsProps) {
  const scroller = useRef<HTMLDivElement>(null);
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
  const striped = useSettings((state) => state.settings.data.stripedRows);
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
  const pointer = useCellPointer(selection, select, edits);

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

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.target !== event.currentTarget) return;
    if (event.metaKey || event.ctrlKey || event.altKey || rowCount === 0 || visible.length === 0) return;
    if (beganEdit(event, edits, selection)) return;
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
        <div role="rowgroup" className="relative" style={{ height: virtualizer.getTotalSize() }} {...pointer}>
          {items.map((item) => {
            const row = drawnRow(result, edits?.buffer, item.index);
            const selectedRow = rect !== null && item.index >= rect.top && item.index <= rect.bottom;
            return (
              <div
                key={item.key}
                role="row"
                aria-rowindex={item.index + 2}
                className={cn(
                  "absolute left-0 grid h-row w-max min-w-full",
                  striped && item.index % 2 === 1 && "bg-grid-stripe",
                )}
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
                        typeClass={result.typeClasses[column] ?? "text"}
                        type={result.columns[column]?.type ?? null}
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
