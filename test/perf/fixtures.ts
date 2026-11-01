import { resolve } from "node:path";

/** The rows `seed.sql` loads into `perf_test.users`. */
export const PERF_ROWS = 1_000_000;
export const PERF_DATABASE = "perf_test";
export const PERF_ID_COUNT = 100_000;
export const IN_PREFIX = "SELECT * FROM users WHERE user_id IN (";
export const IN_SUFFIX = ");";
/**
 * Results go to this git-ignored folder, and the smoke benchmarks run only when
 * `TABLE_CRAFT_EVIDENCE_DIR` names it: the headless box passes that variable through, not others.
 */
export const PERF_EVIDENCE_NAME = "perf-in-list";
export const PERF_OUTPUT_DIR = resolve(import.meta.dirname, "../../docs/evidence", PERF_EVIDENCE_NAME);

const SEED_DAY_MS = Date.UTC(2024, 0, 1);
const SEED_DAYS = 730;
const DAY_MS = 86_400_000;
const SEQUENCE_DIGITS = 9;
const RANDOM_SEED = 20_240_101;

/** The `user_id` `seed.sql` gives sequence number `n`. */
export function userId(n: number): string {
  const day = new Date(SEED_DAY_MS + (n % SEED_DAYS) * DAY_MS);
  const yymmdd = [day.getUTCFullYear() % 100, day.getUTCMonth() + 1, day.getUTCDate()]
    .map((part) => String(part).padStart(2, "0"))
    .join("");
  return `${yymmdd}${String(n).padStart(SEQUENCE_DIGITS, "0")}`;
}

// mulberry32, so every run looks up the same ids in the same order.
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** `count` distinct existing ids, shuffled, the same on every call. */
export function perfIds(count = PERF_ID_COUNT): string[] {
  const next = random(RANDOM_SEED);
  const picked = new Set<number>();
  while (picked.size < count) picked.add(Math.floor(next() * PERF_ROWS));
  return [...picked].map(userId);
}

/** The IN query on one line, or with `perLine` ids on each line after the first. */
export function inListQuery(ids: readonly string[], perLine?: number): string {
  if (perLine === undefined) return `${IN_PREFIX}${ids.join(",")}${IN_SUFFIX}`;
  const lines: string[] = [];
  for (let i = 0; i < ids.length; i += perLine) lines.push(ids.slice(i, i + perLine).join(","));
  return `${IN_PREFIX}\n${lines.join(",\n")}\n${IN_SUFFIX}`;
}
