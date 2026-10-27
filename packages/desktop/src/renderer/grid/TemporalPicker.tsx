import { useEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent, type WheelEvent } from "react";
import {
  DAYS_PER_WEEK,
  MONTHS_PER_YEAR,
  dayOf,
  firstDayOfWeek,
  monthGrid,
  monthOf,
  monthTitle,
  shiftDay,
  shiftMonth,
  weekdayInitials,
  weekEnd,
  weekStart,
  wrapSegment,
} from "@table-craft/desktop/renderer/model/calendar.js";
import {
  pickedText,
  pickerValueAt,
  pickerValueOf,
  type PickerKind,
  type PickerTime,
  type PickerValue,
} from "@table-craft/desktop/renderer/model/temporalPicker.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { NextMonthIcon, PreviousMonthIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { Popover, type PopoverAnchor } from "@table-craft/desktop/renderer/ui/Popover.js";

type Segment = keyof PickerTime;

const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SEGMENTS: readonly { readonly key: Segment; readonly label: string; readonly size: number }[] = [
  { key: "hour", label: "Hour", size: HOURS_PER_DAY },
  { key: "minute", label: "Minute", size: MINUTES_PER_HOUR },
  { key: "second", label: "Second", size: MINUTES_PER_HOUR },
];
const MIDNIGHT: PickerTime = { hour: 0, minute: 0, second: 0 };
const SEGMENT_DIGITS = 2;
const DIGIT = /^\d$/u;

const ICON_BUTTON =
  "flex size-row items-center justify-center rounded text-ink-muted hover:bg-selection hover:text-ink";
const DAY_BUTTON =
  "flex size-row items-center justify-center rounded outline-none focus:outline-solid focus:outline-1 focus:outline-offset-1 focus:outline-accent";
const SEGMENT_FIELD =
  "flex h-row cursor-default px-1 items-center justify-center rounded border border-line bg-canvas font-grid text-grid text-ink outline-none focus:border-accent";

/** Keys the picker owns; React hands events up through the portal, so none may reach the grid. */
function contain(event: SyntheticEvent): void {
  event.stopPropagation();
}

function pad(value: number): string {
  return String(value).padStart(SEGMENT_DIGITS, "0");
}

/**
 * The themed date and time picker beside a temporal cell's text (plan 111). It writes every
 * change into the field at once through `onPick`, reading its state back from `text`, so the
 * field stays the one source of truth.
 */
export function TemporalPicker({
  kind,
  name,
  text,
  anchor,
  onPick,
  onClose,
  onOutside,
}: {
  readonly kind: PickerKind;
  readonly name: string;
  readonly text: string;
  readonly anchor: PopoverAnchor;
  readonly onPick: (text: string) => void;
  readonly onClose: () => void;
  readonly onOutside: (target: EventTarget | null) => void;
}) {
  const locale = navigator.language;
  const [today] = useState(() => dayOf(new Date()));
  const [firstDay] = useState(() => firstDayOfWeek(locale));
  const value = pickerValueOf(kind, text);
  const [cursor, setCursor] = useState(() => value.day ?? today);
  const typed = useRef("");
  const body = useRef<HTMLDivElement>(null);

  // Runs before Radix's open focus, which then leaves a focused element inside the content be.
  useEffect(() => {
    body.current?.querySelector<HTMLElement>("[data-cursor], [role=spinbutton]")?.focus({ preventScroll: true });
  }, [cursor]);

  function write(picked: PickerValue, keepFraction = true): void {
    onPick(pickedText(kind, picked, text, { keepFraction }));
  }

  function pickDay(day: string, close: boolean): void {
    setCursor(day);
    write({ day, time: value.time });
    if (close || kind === "date") onClose();
  }

  function now(): void {
    const at = pickerValueAt(new Date());
    if (at.day !== null) setCursor(at.day);
    write(at, false);
    if (kind === "date") onClose();
  }

  function setSegment(segment: Segment, next: number): void {
    write({ day: value.day ?? cursor, time: { ...(value.time ?? MIDNIGHT), [segment]: next } });
  }

  function onDayKey(event: KeyboardEvent, day: string): void {
    const moves: Readonly<Record<string, () => string>> = {
      ArrowLeft: () => shiftDay(cursor, -1),
      ArrowRight: () => shiftDay(cursor, 1),
      ArrowUp: () => shiftDay(cursor, -DAYS_PER_WEEK),
      ArrowDown: () => shiftDay(cursor, DAYS_PER_WEEK),
      PageUp: () => shiftMonth(cursor, event.shiftKey ? -MONTHS_PER_YEAR : -1),
      PageDown: () => shiftMonth(cursor, event.shiftKey ? MONTHS_PER_YEAR : 1),
      Home: () => weekStart(cursor, firstDay),
      End: () => weekEnd(cursor, firstDay),
    };
    const move = moves[event.key];
    if (move !== undefined) {
      event.preventDefault();
      setCursor(move());
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      pickDay(day, event.key === "Enter");
    }
  }

  function onSegmentKey(event: KeyboardEvent, segment: Segment, size: number, current: number): void {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      typed.current = "";
      setSegment(segment, wrapSegment(current, event.key === "ArrowUp" ? 1 : -1, size));
    } else if (event.key === "Enter") {
      event.preventDefault();
      onClose();
    } else if (DIGIT.test(event.key)) {
      event.preventDefault();
      let buffer = `${typed.current}${event.key}`;
      if (Number(buffer) >= size) buffer = event.key;
      setSegment(segment, Number(buffer));
      if (buffer.length < SEGMENT_DIGITS) {
        typed.current = buffer;
        return;
      }
      typed.current = "";
      const fields = [...(body.current?.querySelectorAll<HTMLElement>("[role=spinbutton]") ?? [])];
      fields[fields.indexOf(event.currentTarget as HTMLElement) + 1]?.focus();
    }
  }

  function onSegmentWheel(event: WheelEvent, segment: Segment, size: number, current: number): void {
    if (event.deltaY === 0) return;
    setSegment(segment, wrapSegment(current, event.deltaY < 0 ? 1 : -1, size));
  }

  const month = monthOf(cursor);
  const time = value.time ?? MIDNIGHT;
  return (
    <Popover anchor={anchor} label={`Pick ${name}`} testId="temporal-picker" onClose={onClose} onOutside={onOutside}>
      <div
        ref={body}
        data-picker-kind={kind}
        className="flex flex-col gap-gap p-gap select-none"
        onKeyDown={contain}
        onMouseDown={contain}
        onPointerDown={contain}
        onClick={contain}
        onDoubleClick={contain}
        onContextMenu={contain}
      >
        {kind === "time" ? null : (
          <>
            <div className="flex items-center justify-between">
              <button
                type="button"
                aria-label="Previous month"
                tabIndex={-1}
                className={ICON_BUTTON}
                onClick={() => setCursor(shiftMonth(cursor, -1))}
              >
                <PreviousMonthIcon aria-hidden className="size-icon" />
              </button>
              <span data-month={month} className="font-semibold">
                {monthTitle(month, locale)}
              </span>
              <button
                type="button"
                aria-label="Next month"
                tabIndex={-1}
                className={ICON_BUTTON}
                onClick={() => setCursor(shiftMonth(cursor, 1))}
              >
                <NextMonthIcon aria-hidden className="size-icon" />
              </button>
            </div>
            <div role="grid" aria-label={monthTitle(month, locale)} className="grid grid-cols-7">
              {weekdayInitials(locale, firstDay).map((initial, index) => (
                <span
                  key={`weekday-${String(index)}`}
                  aria-hidden
                  className="flex size-row items-center justify-center text-ink-muted"
                >
                  {initial}
                </span>
              ))}
              {monthGrid(month, firstDay, today).map((cell) => {
                const chosen = cell.day === value.day;
                return (
                  <button
                    key={cell.day}
                    type="button"
                    role="gridcell"
                    aria-label={cell.day}
                    aria-selected={chosen}
                    tabIndex={cell.day === cursor ? 0 : -1}
                    data-cursor={cell.day === cursor ? "" : undefined}
                    data-today={cell.today ? "" : undefined}
                    className={cn(
                      DAY_BUTTON,
                      chosen
                        ? "bg-accent font-semibold text-accent-ink"
                        : cn("hover:bg-selection", cell.inMonth ? "text-ink" : "text-ink-muted"),
                      cell.today && !chosen && "border border-accent",
                    )}
                    onClick={() => pickDay(cell.day, false)}
                    onKeyDown={(event) => onDayKey(event, cell.day)}
                  >
                    {Number(cell.day.slice(-2))}
                  </button>
                );
              })}
            </div>
          </>
        )}
        {kind === "date" ? null : (
          <div className={cn("flex items-center gap-1", kind === "datetime" && "border-t border-line pt-gap")}>
            <span className="mr-gap text-ink-muted">Time</span>
            {SEGMENTS.map((segment, index) => (
              <span key={segment.key} className="flex items-center gap-1">
                {index === 0 ? null : <span className="text-ink-muted">:</span>}
                <span
                  role="spinbutton"
                  tabIndex={0}
                  aria-label={segment.label}
                  aria-valuenow={time[segment.key]}
                  aria-valuemin={0}
                  aria-valuemax={segment.size - 1}
                  aria-valuetext={pad(time[segment.key])}
                  className={SEGMENT_FIELD}
                  onBlur={() => {
                    typed.current = "";
                  }}
                  onKeyDown={(event) => onSegmentKey(event, segment.key, segment.size, time[segment.key])}
                  onWheel={(event) => onSegmentWheel(event, segment.key, segment.size, time[segment.key])}
                >
                  {pad(time[segment.key])}
                </span>
              </span>
            ))}
          </div>
        )}
        <div className="flex justify-end">
          <button type="button" className="rounded px-1 text-accent hover:bg-selection" onClick={now}>
            {kind === "date" ? "Today" : "Now"}
          </button>
        </div>
      </div>
    </Popover>
  );
}
