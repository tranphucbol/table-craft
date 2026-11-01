import { cn } from "@table-craft/desktop/renderer/ui/cn.js";

const PERCENT_MAX = 100;

/**
 * A thin bar: filled to `percent`, or a sweeping stripe when `percent` is null, so work with no
 * known end never shows a made-up figure. `className` sets its width. The canvas track reads as a
 * groove on both the status bar's panel and a popover's raised surface.
 */
export function ProgressBar({ percent, className }: { readonly percent: number | null; readonly className?: string }) {
  return (
    <span
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={PERCENT_MAX}
      aria-valuenow={percent ?? undefined}
      data-indeterminate={percent === null || undefined}
      className={cn("relative block h-1 shrink-0 overflow-hidden rounded bg-canvas", className)}
    >
      {percent === null ? (
        <span className="absolute inset-y-0 left-0 w-2/5 animate-indeterminate rounded bg-accent" />
      ) : (
        <span className="block h-full bg-accent" style={{ width: `${String(percent)}%` }} />
      )}
    </span>
  );
}
