import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { EXPORT_ACTION_IDS } from "@table-craft/desktop/renderer/actions/exportActions.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import {
  exportChip,
  exportFlashEndsAt,
  type ExportChipTone,
  type ExportChipView,
} from "@table-craft/desktop/renderer/model/exportText.js";
import { ExportsPopover } from "@table-craft/desktop/renderer/shell/ExportsPopover.js";
import { useExports } from "@table-craft/desktop/renderer/state/exports.js";
import { Clock } from "@table-craft/desktop/renderer/ui/Clock.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { ACTION_ICONS, ErrorIcon, SpinnerIcon, SuccessIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import type { PopoverAnchor } from "@table-craft/desktop/renderer/ui/Popover.js";
import { ProgressBar } from "@table-craft/desktop/renderer/ui/ProgressBar.js";

const TONE_CLASSES: Readonly<Record<ExportChipTone, string>> = {
  running: "text-ink",
  done: "text-success",
  failed: "border border-danger text-danger",
};
const CLOCK_SEPARATOR = " · ";
const CancelGlyph = ACTION_ICONS.cancel;

/** One busy or outcome mark: the bar while it runs, a spinner while it stops, then how it ended. */
function ChipGlyph({ view }: { readonly view: ExportChipView }) {
  if (view.cancelling) return <SpinnerIcon aria-hidden className="size-icon shrink-0 animate-spin text-accent" />;
  if (view.startedAt !== null) return <ProgressBar percent={view.percent} className="w-12" />;
  if (view.tone === "done") return <SuccessIcon aria-hidden className="size-icon shrink-0" />;
  if (view.tone === "failed") return <ErrorIcon aria-hidden className="size-icon shrink-0" />;
  return null;
}

/** What the chip keeps showing while its popover is open and nothing else would. */
const OPEN_VIEW: ExportChipView = {
  tone: "running",
  label: "Exports",
  tooltip: "Exports",
  percent: null,
  startedAt: null,
  cancelTaskId: null,
  cancelling: false,
};

/**
 * The time the chip judges its done flash by, read again when the flash ends, so the chip goes away
 * without waiting for an event. Only the flash depends on it, and a stale earlier time keeps a new
 * flash showing, as it should.
 */
function useFlashNow(endsAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endsAt === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, endsAt - Date.now()));
    return () => clearTimeout(timer);
  }, [endsAt]);
  return now;
}

/**
 * The Exports chip at the right of the status bar (plan 138): the running export's name, rows or
 * percent, bar and clock, with a Cancel beside it when only one runs; a done export for a few
 * seconds; a failure until it is seen. A click opens the popover.
 */
export function ExportsChip() {
  const entries = useExports((state) => state.entries);
  const cancelling = useExports((state) => state.cancelling);
  const seen = useExports((state) => state.seen);
  const open = useExports((state) => state.popoverOpen);
  const now = useFlashNow(exportFlashEndsAt(entries));
  const button = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);

  useLayoutEffect(() => {
    if (!open || button.current === null) {
      setAnchor(null);
      return;
    }
    const { left, top, right, bottom } = button.current.getBoundingClientRect();
    setAnchor({ left, top, right, bottom });
  }, [open]);

  const view = exportChip(entries, { cancelling, seen }, now) ?? (open ? OPEN_VIEW : null);
  if (view === null) return null;
  const running = view.startedAt !== null;
  const { cancelTaskId } = view;
  return (
    <span className="flex h-full min-w-0 items-center">
      <button
        ref={button}
        type="button"
        data-testid="status-exporting"
        data-tone={view.tone}
        title={view.tooltip}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(
          "flex h-full min-w-0 items-center gap-1.5 rounded px-1 whitespace-nowrap hover:bg-raised",
          open && "bg-raised",
          TONE_CLASSES[view.tone],
        )}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => invoke(EXPORT_ACTION_IDS.show)}
      >
        <ChipGlyph view={view} />
        <span className="flex min-w-0 items-center">
          <span data-testid="status-exporting-label" className="max-w-status-chip truncate">
            {view.label}
          </span>
          {running && !view.cancelling && view.startedAt !== null ? (
            <span className="shrink-0 whitespace-pre">
              {CLOCK_SEPARATOR}
              <Clock startedAt={view.startedAt} testId="status-exporting-clock" />
            </span>
          ) : null}
        </span>
      </button>
      {cancelTaskId === null || view.cancelling ? null : (
        <button
          type="button"
          data-testid="status-exporting-cancel"
          aria-label="Cancel Export"
          title="Cancel Export"
          className="press flex h-full shrink-0 items-center rounded px-1 text-danger hover:bg-raised"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => invoke(EXPORT_ACTION_IDS.cancel, { taskId: cancelTaskId })}
        >
          <CancelGlyph aria-hidden weight="fill" className="size-icon" />
        </button>
      )}
      {open && anchor !== null ? <ExportsPopover anchor={anchor} /> : null}
    </span>
  );
}
