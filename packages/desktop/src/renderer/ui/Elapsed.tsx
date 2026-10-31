import { formatElapsed } from "@table-craft/desktop/renderer/model/format.js";
import { ELAPSED_TICK_MS, useClock } from "@table-craft/desktop/renderer/ui/useClock.js";

/** The live time since `startedAt`, with milliseconds; its own component so only this text re-renders on each tick. */
export function Elapsed({ startedAt, testId }: { readonly startedAt: number; readonly testId?: string }) {
  const now = useClock(ELAPSED_TICK_MS);
  return (
    <span data-testid={testId} className="tabular-nums">
      {formatElapsed(now - startedAt)}
    </span>
  );
}
