import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { RESULT_WINDOW_ROWS } from "@table-craft/desktop/engine/protocol.js";
import { REGION_ATTRIBUTE } from "@table-craft/desktop/renderer/actions/context.js";
import { CELL, CellEditorInput, CellMenu, GLYPH_OF, GridCell } from "@table-craft/desktop/renderer/grid/GridCells.js";
import {
  beganEdit,
  drawnRow,
  matchKeys,
  useCellPointer,
  type RowsProps,
} from "@table-craft/desktop/renderer/grid/gridRows.js";
import { displayChars } from "@table-craft/desktop/renderer/grid/widths.js";
import { gridRowCount } from "@table-craft/desktop/renderer/model/editBuffer.js";
import {
  contains,
  moveBy,
  rectOf,
  selectCell,
  selectColumn,
  selectRows,
  type GridBounds,
} from "@table-craft/desktop/renderer/model/gridSelection.js";
import {
  shownHeld,
  shownRowCount,
  windowOffsetOf,
  type ResultTab,
} from "@table-craft/desktop/renderer/state/resultTab.js";
import { useCellFormats, useRowHeightPx, useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { TYPE_GLYPHS } from "@table-craft/desktop/renderer/ui/icons.js";

/** Every record is as wide as this many characters; a wider value is cut, as a narrow column cuts it. */
const RECORD_CHARS = 24;
const OVERSCAN_RECORDS = 4;
const MIN_NAME_CHARS = 8;
const MAX_NAME_CHARS = 32;
/** The type glyph and the gaps beside a column name, in `ch`. */
const NAME_EXTRA_CHARS = 4;

/**
 * The result transposed (plan 043): a row per visible column, a column per record, virtualised
 * across the records. Cells keep record coordinates (`data-row` is the record, `data-col` the
 * visible position), so selection, copy, aggregates and edits act on the same cells as the grid.
 */
export function TransposedRows({ ownerId, result, visible, host, edits }: RowsProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  const [recordPx, setRecordPx] = useState(0);
  const { selection } = result;
  const recordCount = edits === undefined ? shownRowCount(result) : gridRowCount(edits.buffer, shownHeld(result));
  const width = result.columns.length;
  const matched = useMemo(() => matchKeys(result.matches, width), [result.matches, width]);
  const bounds: GridBounds = { rows: recordCount, columns: visible.length };
  const rowHeightPx = useRowHeightPx();
  const formats = useCellFormats();
  const striped = useSettings((state) => state.settings.data.stripedRows);
  const nameChars = Math.min(
    MAX_NAME_CHARS,
    Math.max(MIN_NAME_CHARS, ...visible.map((column) => displayChars(result.columns[column]?.name ?? ""))),
  );

  useLayoutEffect(() => {
    setRecordPx(probe.current?.getBoundingClientRect().width ?? 0);
  }, [rowHeightPx]);

  const virtualizer = useVirtualizer({
    horizontal: true,
    count: recordCount,
    getScrollElement: () => scroller.current,
    estimateSize: () => recordPx,
    overscan: OVERSCAN_RECORDS,
  });
  useEffect(() => virtualizer.measure(), [virtualizer, recordPx]);
  const items = recordPx === 0 ? [] : virtualizer.getVirtualItems();
  const first = items[0]?.index;
  const last = items.at(-1)?.index;

  useEffect(() => {
    if (first === undefined || last === undefined) return;
    const { ensureWindow } = host();
    for (let offset = windowOffsetOf(first); offset <= last; offset += RESULT_WINDOW_ROWS) {
      ensureWindow(ownerId, result.id, offset);
    }
  }, [host, ownerId, result.id, first, last, result.windows]);

  const select = (next: ResultTab["selection"]) => host().select(ownerId, result.id, next);
  const pointer = useCellPointer(selection, select, edits);

  const focus = selection?.focus;
  useEffect(() => {
    if (focus === undefined) return;
    virtualizer.scrollToIndex(focus.row, { align: "auto" });
    scroller.current
      ?.querySelector(`[data-transposed-col="${String(focus.column)}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [focus, virtualizer]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.target !== event.currentTarget) return;
    if (event.metaKey || event.ctrlKey || event.altKey || recordCount === 0 || visible.length === 0) return;
    if (beganEdit(event, edits, selection)) return;
    const page = Math.max(Math.floor((scroller.current?.clientHeight ?? rowHeightPx) / rowHeightPx) - 2, 1);
    const moves: Record<string, [number, number]> = {
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      PageUp: [0, -page],
      PageDown: [0, page],
      Home: [-recordCount, 0],
      End: [recordCount, 0],
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    const from = selection ?? selectCell({ row: 0, column: 0 });
    select(selection === null ? from : moveBy(from, move[0], move[1], bounds, event.shiftKey));
  }

  const rect = selection === null ? null : rectOf(selection);
  const lead = items[0]?.start ?? 0;
  const nameWidth = `${String(nameChars + NAME_EXTRA_CHARS)}ch`;
  const rowWidth = `calc(${nameWidth} + ${String(virtualizer.getTotalSize())}px)`;
  const recordStyle = { width: recordPx };

  return (
    <div
      ref={scroller}
      role="grid"
      aria-label={result.title}
      aria-rowcount={visible.length + 1}
      aria-colcount={recordCount}
      aria-multiselectable
      data-transposed
      tabIndex={0}
      {...{ [REGION_ATTRIBUTE]: "grid" }}
      className="min-h-0 min-w-0 flex-1 overflow-auto font-grid text-grid outline-none select-none"
      onKeyDown={onKeyDown}
    >
      <div ref={probe} aria-hidden className="invisible absolute h-0" style={{ width: `${String(RECORD_CHARS)}ch` }} />
      <div
        role="row"
        className="sticky top-0 z-20 flex h-row border-b border-line bg-panel"
        style={{ width: rowWidth }}
      >
        <div className="sticky left-0 z-30 shrink-0 border-r border-line bg-panel" style={{ width: nameWidth }} />
        <div className="shrink-0" style={{ width: lead }} />
        {items.map((item) => (
          <div
            key={item.key}
            role="columnheader"
            data-record-header={item.index}
            className={cn(
              CELL,
              "shrink-0 text-ink-muted",
              rect !== null && item.index >= rect.top && item.index <= rect.bottom && "text-ink",
            )}
            style={recordStyle}
            onMouseDown={(event) => {
              if (event.button !== 0) return;
              const from = event.shiftKey && selection !== null ? selection.anchor.row : undefined;
              select(selectRows(item.index, bounds, from));
            }}
          >
            {item.index + 1}
          </div>
        ))}
      </div>
      <CellMenu entries={edits?.menu}>
        <div role="rowgroup" {...pointer}>
          {visible.map((column, position) => {
            const name = result.columns[column]?.name ?? "";
            const Glyph = TYPE_GLYPHS[GLYPH_OF[result.typeClasses[column] ?? "text"]];
            return (
              <div
                key={column}
                role="row"
                data-transposed-col={position}
                className={cn("flex h-row", striped && position % 2 === 1 && "bg-grid-stripe")}
                style={{ width: rowWidth }}
              >
                <div
                  role="rowheader"
                  data-transposed-name={name}
                  title={`${name}: ${result.columns[column]?.type ?? "unknown"}`}
                  className="sticky left-0 z-10 flex shrink-0 items-center gap-1 border-r border-line bg-panel px-cell text-ink"
                  style={{ width: nameWidth }}
                  onMouseDown={(event) => {
                    if (event.button !== 0) return;
                    event.stopPropagation();
                    select(selectColumn(position, bounds));
                  }}
                >
                  <Glyph aria-hidden className="size-icon shrink-0 text-ink-muted" />
                  <span className="truncate">{name}</span>
                </div>
                <div className="shrink-0" style={{ width: lead }} />
                {items.map((item) => (
                  <div key={item.key} className="h-full shrink-0" style={recordStyle}>
                    <TransposedCell
                      result={result}
                      edits={edits}
                      record={item.index}
                      column={column}
                      position={position}
                      rect={rect}
                      matched={matched}
                      formats={formats}
                      onClosed={() => scroller.current?.focus({ preventScroll: true })}
                      onTab={() =>
                        select(selectCell({ row: Math.min(item.index + 1, recordCount - 1), column: position }))
                      }
                    />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </CellMenu>
    </div>
  );
}

function TransposedCell({
  result,
  edits,
  record,
  column,
  position,
  rect,
  matched,
  formats,
  onClosed,
  onTab,
}: {
  readonly result: ResultTab;
  readonly edits: RowsProps["edits"];
  readonly record: number;
  readonly column: number;
  readonly position: number;
  readonly rect: ReturnType<typeof rectOf> | null;
  readonly matched: ReadonlySet<number>;
  readonly formats: ReturnType<typeof useCellFormats>;
  readonly onClosed: () => void;
  readonly onTab: () => void;
}) {
  const editing = edits?.editing;
  if (edits !== undefined && editing?.row === record && editing.column === column) {
    return (
      <CellEditorInput
        name={result.columns[column]?.name ?? ""}
        row={record}
        position={position}
        text={editing.text}
        typeClass={result.typeClasses[column] ?? "text"}
        type={result.columns[column]?.type ?? null}
        edits={edits}
        onClosed={onClosed}
        onTab={onTab}
      />
    );
  }
  const row = drawnRow(result, edits?.buffer, record);
  const pending = row.pending(column);
  const current = result.search.current;
  const find =
    current?.row === record && current.column === column
      ? "current"
      : matched.has(record * result.columns.length + column)
        ? "match"
        : null;
  const { selection } = result;
  return (
    <GridCell
      find={find}
      value={row.mark === "inserted" ? undefined : row.values?.[column]}
      pending={pending}
      mark={row.mark ?? (pending === undefined ? null : "modified")}
      row={record}
      position={position}
      typeClass={result.typeClasses[column] ?? "text"}
      formats={formats}
      selected={rect !== null && contains(rect, record, position)}
      focused={selection?.focus.row === record && selection.focus.column === position}
    />
  );
}
