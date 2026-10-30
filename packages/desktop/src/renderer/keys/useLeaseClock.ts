import { useSyncExternalStore } from "react";
import { remainingTtl, type KeyTab } from "@table-craft/desktop/renderer/state/keyTabs.js";

const TICK_MS = 1_000;
export const LEASE_WARNING_MS = 30_000;
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();
const snapshot = () => now;
const inactive = () => 0;
const noSubscribe = () => () => undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

export function useRemainingLease(tab: KeyTab): number | null {
  const expires = tab.details?.ttlMs != null;
  const current = useSyncExternalStore(expires ? subscribe : noSubscribe, expires ? snapshot : inactive, snapshot);
  return remainingTtl(tab.details, tab.readAt, current);
}
