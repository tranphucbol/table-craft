import { formatClock } from "@table-craft/desktop/renderer/model/format.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { useClock } from "@table-craft/desktop/renderer/ui/useClock.js";

/** The live time since `startedAt` to the second, for work measured in minutes; only this text re-renders each tick. */
export function Clock({
  startedAt,
  testId,
  className,
}: {
  readonly startedAt: number;
  readonly testId?: string;
  readonly className?: string;
}) {
  const now = useClock();
  return (
    <span data-testid={testId} className={cn("tabular-nums", className)}>
      {formatClock(now - startedAt)}
    </span>
  );
}
