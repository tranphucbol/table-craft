import { PluginError } from "@table-craft/plugin-api";

/**
 * A key-tree scan over etcd (decision 4 of plan 110): the glob's literal prefix becomes a Range,
 * the rest is matched here on bytes, and the cursor carries the revision the pass reads at and
 * the key it resumes from.
 */

/** What a scan starts from and returns at the end of a pass. */
export const START_CURSOR = "0";
const CURSOR_SEPARATOR = ":";
const MAX_BYTE = 0xff;
const GLOB_SPECIAL = new Set(["*", "?", "["]);
const ESCAPE = 0x5c;
const STAR = 0x2a;
const QUESTION = 0x3f;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const CARET = 0x5e;
const DASH = 0x2d;

/** The key every key sorts after: a range ending here runs to the end of the keyspace. */
export const NO_END = Buffer.from([0]);

/** The first key after every key starting with `prefix`; `NO_END` when no such key exists. */
export function prefixEnd(prefix: Uint8Array): Buffer {
  const end = Buffer.from(prefix);
  for (let index = end.length - 1; index >= 0; index -= 1) {
    if ((end[index] ?? 0) < MAX_BYTE) {
      end[index] = (end[index] ?? 0) + 1;
      return end.subarray(0, index + 1);
    }
  }
  return Buffer.from(NO_END);
}

/** The bytes every key a glob matches starts with: its text up to the first `*`, `?` or `[`, escapes undone. */
export function literalPrefix(glob: string): Buffer {
  let prefix = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] ?? "";
    if (GLOB_SPECIAL.has(char)) break;
    if (char === "\\") {
      if (index + 1 >= glob.length) break;
      index += 1;
      prefix += glob[index] ?? "";
      continue;
    }
    prefix += char;
  }
  return Buffer.from(prefix, "utf8");
}

/** The `[…]` class at `at` (just past the bracket): whether `byte` is in it and where the class ends. */
function matchClass(pattern: Uint8Array, at: number, byte: number): { matched: boolean; end: number } {
  let index = at;
  const negated = pattern[index] === CARET;
  if (negated) index += 1;
  let matched = false;
  while (index < pattern.length && pattern[index] !== CLOSE_BRACKET) {
    if (pattern[index] === ESCAPE && index + 1 < pattern.length) {
      index += 1;
      if (pattern[index] === byte) matched = true;
      index += 1;
      continue;
    }
    const low = pattern[index] ?? 0;
    if (pattern[index + 1] === DASH && index + 2 < pattern.length && pattern[index + 2] !== CLOSE_BRACKET) {
      const high = pattern[index + 2] ?? 0;
      const [from, to] = low <= high ? [low, high] : [high, low];
      if (byte >= from && byte <= to) matched = true;
      index += 3;
      continue;
    }
    if (low === byte) matched = true;
    index += 1;
  }
  return { matched: negated ? !matched : matched, end: Math.min(index + 1, pattern.length) };
}

function matchFrom(pattern: Uint8Array, p: number, key: Uint8Array, k: number): boolean {
  let pi = p;
  let ki = k;
  while (pi < pattern.length) {
    const token = pattern[pi];
    if (token === STAR) {
      while (pattern[pi] === STAR) pi += 1;
      if (pi === pattern.length) return true;
      for (let at = ki; at <= key.length; at += 1) if (matchFrom(pattern, pi, key, at)) return true;
      return false;
    }
    if (ki >= key.length) return false;
    const byte = key[ki] ?? 0;
    if (token === QUESTION) {
      pi += 1;
    } else if (token === OPEN_BRACKET) {
      const { matched, end } = matchClass(pattern, pi + 1, byte);
      if (!matched) return false;
      pi = end;
    } else {
      if (token === ESCAPE && pi + 1 < pattern.length) pi += 1;
      if (pattern[pi] !== byte) return false;
      pi += 1;
    }
    ki += 1;
  }
  return ki === key.length;
}

/** Whether `key` matches the glob as `SCAN … MATCH` reads one: `*`, `?`, `[a-z]`, `[^…]`, `\` escapes, on bytes. */
export function globMatches(glob: string, key: Uint8Array): boolean {
  if (glob === "*") return true;
  return matchFrom(Buffer.from(glob, "utf8"), 0, key, 0);
}

/** Where a pass resumes: the revision it reads at (0 for the head) and the first key of the next batch. */
export interface ScanPosition {
  readonly revision: string;
  readonly from: Buffer;
}

/** The cursor that resumes after `lastKey`: `<revision>:<hex of lastKey + 0x00>`. */
export function encodeCursor(revision: string, lastKey: Uint8Array): string {
  return `${revision}${CURSOR_SEPARATOR}${Buffer.concat([Buffer.from(lastKey), NO_END]).toString("hex")}`;
}

/** A cursor as a position; null when it starts a pass. Throws for one this plugin did not write. */
export function decodeCursor(cursor: string | null): ScanPosition | null {
  if (cursor === null || cursor === START_CURSOR) return null;
  const separator = cursor.indexOf(CURSOR_SEPARATOR);
  const revision = cursor.slice(0, separator);
  const hex = cursor.slice(separator + 1);
  if (separator < 0 || !/^\d+$/.test(revision) || !/^(?:[0-9a-f]{2})*$/.test(hex)) {
    throw new PluginError("statementFailed", `Not an etcd scan cursor: ${cursor}. Rescan the keys.`);
  }
  return { revision, from: Buffer.from(hex, "hex") };
}
