import { useEffect, useState } from "react";

const TICK_MS = 1000;
/** A live elapsed time's tick: fast enough that its milliseconds visibly run, prime so the last digit never settles into a pattern. */
export const ELAPSED_TICK_MS = 47;

/** `Date.now()`, re-read every `intervalMs` (a second by default) while the component is mounted, for countdowns and elapsed times. */
export function useClock(intervalMs: number = TICK_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
