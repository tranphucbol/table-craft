import { useEffect, useRef, useState } from "react";
import { subscribeToCopies } from "@table-craft/desktop/renderer/state/clipboard.js";

/** How long after a click a write still counts as that click's: a grid copy first fetches its rows. */
const ARMED_MS = 5000;
const CONFIRMED_MS = 1500;

export const COPIED_LABEL = "Copied";

/**
 * A copy button's confirmation: `arm` on click, and `copied` holds for a moment after the next
 * successful clipboard write. A copy that fails, or copies nothing, never confirms.
 */
export function useCopyConfirmation(): { readonly copied: boolean; readonly arm: () => void } {
  const [copied, setCopied] = useState(false);
  const armedAt = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeToCopies(() => {
      const at = armedAt.current;
      if (at === null || Date.now() - at > ARMED_MS) return;
      armedAt.current = null;
      setCopied(true);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), CONFIRMED_MS);
    });
    return () => {
      unsubscribe();
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  return {
    copied,
    arm: () => {
      armedAt.current = Date.now();
    },
  };
}
