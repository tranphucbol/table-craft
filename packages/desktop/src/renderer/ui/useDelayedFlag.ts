import { useEffect, useState } from "react";

/** True once `on` has held for `delayMs`, false the moment it drops. */
export function useDelayedFlag(on: boolean, delayMs: number): boolean {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (!on) return;
    const timer = setTimeout(() => setHeld(true), delayMs);
    return () => {
      clearTimeout(timer);
      setHeld(false);
    };
  }, [on, delayMs]);

  return on && held;
}
