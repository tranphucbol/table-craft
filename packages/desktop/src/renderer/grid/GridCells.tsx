import * as ContextMenu from "@radix-ui/react-context-menu";
import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { CellInput, SortDirection, TypeClass, WireValue } from "@table-craft/desktop/engine/protocol.js";
import { currentPlatform, formatChord } from "@table-craft/desktop/renderer/actions/chords.js";
import {
  GRID_ACTION_IDS,
  LOCAL_FILTER_LABELS,
  LOCAL_FILTER_MENU,
  type SortArgs,
} from "@table-craft/desktop/renderer/actions/gridActions.js";
import { invoke, registry, useActionEnabled } from "@table-craft/desktop/renderer/actions/index.js";
import { TemporalPicker } from "@table-craft/desktop/renderer/grid/TemporalPicker.js";
import { DEFAULT_TEXT, formatCell, type CellFormats } from "@table-craft/desktop/renderer/grid/format.js";
import { displayChars } from "@table-craft/desktop/renderer/grid/widths.js";
import { fittedTo, resizedTo, type ColumnLayout } from "@table-craft/desktop/renderer/model/columnLayout.js";
import type { EditBuffer } from "@table-craft/desktop/renderer/model/editBuffer.js";
import {
  selectColumn,
  type GridBounds,
  type GridSelection,
} from "@table-craft/desktop/renderer/model/gridSelection.js";
import { booleanOfText } from "@table-craft/desktop/renderer/model/resultEdits.js";
import { sortMarkOf } from "@table-craft/desktop/renderer/model/sortKeys.js";
import { pickerKindOf } from "@table-craft/desktop/renderer/model/temporalPicker.js";
import type { ResultSearch, ResultTab } from "@table-craft/desktop/renderer/state/resultTab.js";
import type { ResultWindows } from "@table-craft/desktop/renderer/state/resultWindows.js";
import { currentFormats } from "@table-craft/desktop/renderer/state/settings.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { Dropdown } from "@table-craft/desktop/renderer/ui/Dropdown.js";
import { MENU_MOTION } from "@table-craft/desktop/renderer/ui/motion.js";
import type { PopoverAnchor } from "@table-craft/desktop/renderer/ui/Popover.js";
import {
  CalendarIcon,
  ReadOnlyIcon,
  SortAscendingMark,
  SortDescendingMark,
  TYPE_GLYPHS,
} from "@table-craft/desktop/renderer/ui/icons.js";

export const CELL = "truncate border-r border-line px-cell leading-(--spacing-row)";
const MENU_ITEM =
  "flex h-row cursor-default items-center justify-between gap-gap rounded px-gap outline-none data-[disabled]:text-ink-muted data-[highlighted]:bg-selection";
const MENU_CONTENT = `z-50 min-w-48 rounded border border-line bg-raised p-1 text-ui text-ink shadow-lg ${MENU_MOTION}`;
const READ_ONLY_COLUMN_TITLE = " (read-only: not a column of the table)";

/** What the grid asks of the store that owns its result: a console's or a table tab's. */
export interface GridHost {
  readonly ensureWindow: (ownerId: string, resultId: string, offset: number) => void;
  readonly select: (ownerId: string, resultId: string, selection: GridSelection | null) => void;
  readonly setLayout: (ownerId: string, resultId: string, layout: ColumnLayout) => void;
  /** The find bar's typed query; its toggles and the chips are actions. */
  readonly search: (ownerId: string, resultId: string, change: (search: ResultSearch) => ResultSearch) => Promise<void>;
  readonly aggregate: ResultWindows["aggregate"];
  readonly cellBytes: ResultWindows["cellBytes"];
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

export type EditMark = "modified" | "inserted" | "deleted";

/** A cell the find query matches; `current` is the one the find bar is on. */
export type FindMark = "match" | "current";

export const GLYPH_OF: Readonly<Record<TypeClass, keyof typeof TYPE_GLYPHS>> = {
  integer: "number",
  float: "number",
  decimal: "number",
  boolean: "bool",
  temporal: "date",
  json: "json",
  bytes: "bytes",
  text: "text",
};

export const NUMERIC: ReadonlySet<TypeClass> = new Set(["integer", "float", "decimal"]);

/** The cells' context menu, when the owner gives one. */
export function CellMenu({
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

const EDITOR_CLASS =
  "absolute inset-0 w-full border border-accent bg-canvas px-cell font-grid text-grid text-ink outline-none";
const BOOLEAN_CHOICES = [
  { value: "true", label: "true" },
  { value: "false", label: "false" },
  { value: "", label: "NULL" },
] as const;
/** Padding, borders and the calendar button beside a temporal value's text. */
const TEMPORAL_EDITOR_ROOM = "2 * var(--spacing-cell) + var(--spacing-row) + 2px";

/** The cell editor: Enter commits, Escape cancels, Tab commits and moves right (plan 008 decision 9). */
export function CellEditorInput({
  name,
  row,
  position,
  text,
  typeClass,
  type,
  edits,
  onClosed,
  onTab,
}: {
  readonly name: string;
  readonly row: number;
  readonly position: number;
  readonly text: string;
  readonly typeClass: TypeClass;
  readonly type: string | null;
  readonly edits: GridEdits;
  readonly onClosed: () => void;
  readonly onTab: () => void;
}) {
  const closing = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [pickerAnchor, setPickerAnchor] = useState<PopoverAnchor | null>(null);
  const pickerKind = typeClass === "temporal" ? pickerKindOf(type) : null;

  function close(commit: boolean): void {
    closing.current = true;
    if (commit) edits.commit();
    else edits.cancel();
    onClosed();
  }

  function onKeyDown(event: KeyboardEvent): void {
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
  }

  if (typeClass === "boolean") {
    const chosen = booleanOfText(text);
    return (
      <div
        role="gridcell"
        data-row={row}
        data-col={position}
        data-editing
        className="relative h-full min-w-0"
        onKeyDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <Dropdown
          label={`Edit ${name}`}
          variant="cell"
          defaultOpen
          value={chosen === null ? text : String(chosen)}
          options={
            chosen === null && text !== "" ? [{ value: text, label: text }, ...BOOLEAN_CHOICES] : BOOLEAN_CHOICES
          }
          onChange={(value) => {
            edits.change(value);
            close(true);
          }}
          onOpenChange={(open) => {
            if (!open && !closing.current) close(false);
          }}
        />
      </div>
    );
  }

  const input = (
    <input
      ref={field}
      aria-label={`Edit ${name}`}
      autoFocus
      spellCheck={false}
      className={cn(EDITOR_CLASS, pickerKind !== null && "pr-row")}
      value={text}
      onChange={(event) => edits.change(event.target.value)}
      onMouseDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={onKeyDown}
      onBlur={() => {
        if (closing.current || pickerAnchor !== null) return;
        edits.commit();
      }}
    />
  );
  if (pickerKind === null) {
    return (
      <div role="gridcell" data-row={row} data-col={position} data-editing className="relative h-full min-w-0">
        {input}
      </div>
    );
  }
  return (
    <div role="gridcell" data-row={row} data-col={position} data-editing className="relative h-full min-w-0">
      <div
        ref={box}
        className="absolute inset-y-0 left-0 z-10 min-w-full font-grid text-grid"
        style={{ width: `calc(${String(text.length + 1)}ch + ${TEMPORAL_EDITOR_ROOM})` }}
      >
        {input}
        <button
          type="button"
          aria-label={`Pick ${name}`}
          aria-expanded={pickerAnchor !== null}
          title="Pick a value"
          className="absolute inset-y-0 right-0 flex w-row items-center justify-center text-ink-muted hover:text-ink"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          // The picker closes on a pointer down outside it; this button toggles it on click instead.
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setPickerAnchor(pickerAnchor === null ? anchorOf(box.current) : null)}
        >
          <CalendarIcon aria-hidden className="size-icon" />
        </button>
        {pickerAnchor === null ? null : (
          <TemporalPicker
            kind={pickerKind}
            name={name}
            text={text}
            anchor={pickerAnchor}
            onPick={(picked) => edits.change(picked)}
            onClose={() => {
              setPickerAnchor(null);
              // Radix hands focus back a task later; a key typed in between would reach nothing.
              if (!closing.current) field.current?.focus({ preventScroll: true });
            }}
            onOutside={(target) => {
              if (!(target instanceof Node && box.current?.contains(target) === true)) close(true);
            }}
          />
        )}
      </div>
    </div>
  );
}

function anchorOf(element: HTMLElement | null): PopoverAnchor | null {
  if (element === null) return null;
  const { left, top, right, bottom } = element.getBoundingClientRect();
  return { left, top, right, bottom };
}

/** What a cell shows: its pending input over the database's value. */
export function cellDisplay(
  value: WireValue | undefined,
  pending: CellInput | undefined,
  typeClass: TypeClass,
  formats: CellFormats,
): { readonly text: string; readonly tone: "null" | "default" | null } {
  if (pending?.kind === "text") return { text: pending.text, tone: null };
  if (pending?.kind === "null") return { text: formats.nullText, tone: "null" };
  if (pending?.kind === "default") return { text: DEFAULT_TEXT, tone: "default" };
  if (pending?.kind === "boolean") return { text: formatCell(pending.value, typeClass, formats), tone: null };
  if (pending?.kind === "bytes") {
    return {
      text: formatCell({ kind: "bytes", preview: pending.preview, length: pending.length }, typeClass, formats),
      tone: null,
    };
  }
  if (value === undefined) return { text: "…", tone: null };
  if (value === null) return { text: formats.nullText, tone: "null" };
  return { text: formatCell(value, typeClass, formats), tone: null };
}

const MARK_CLASS: Readonly<Record<EditMark, string>> = {
  modified: "bg-edit-modified",
  inserted: "bg-edit-inserted",
  deleted: "bg-edit-deleted",
};

export function GridCell({
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

export function HeaderCell({ ownerId, host, result, column, position, bounds, select, readOnly }: HeaderCellProps) {
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

export function MenuItem({
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
