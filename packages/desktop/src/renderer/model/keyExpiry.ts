import type { KeyExpiry } from "@table-craft/desktop/engine/protocol.js";

const MS_PER_SECOND = 1000;
const SECONDS = /^\d+$/;

export const EXPIRY_HINT =
  "Type seconds, like 3600, or a date and time, like 2026-12-31T23:00:00Z; leave it empty to remove the TTL.";

/** What Set TTL… typed (plan 058 decision 17): seconds from now, a moment, or nothing for no TTL. */
export function parseExpiry(text: string, now: number): { readonly expiry: KeyExpiry } | { readonly problem: string } {
  const typed = text.trim();
  if (typed === "") return { expiry: null };
  if (SECONDS.test(typed)) {
    const seconds = Number(typed);
    return seconds > 0 ? { expiry: { inMs: seconds * MS_PER_SECOND } } : { problem: "A TTL takes at least 1 second." };
  }
  const at = Date.parse(typed);
  if (Number.isNaN(at)) return { problem: EXPIRY_HINT };
  if (at <= now) return { problem: `${typed} has passed; pick a moment ahead.` };
  return { expiry: { at: new Date(at).toISOString() } };
}
