import { useEffect, useState } from "react";

const TICK_MS = 1000;

/** `Date.now()`, re-read every second while the component is mounted, for countdowns and elapsed times. */
export function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}
