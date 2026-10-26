import type { KeyType } from "@table-craft/plugin-api";
import { flagsOf, keyArguments, type CommandTable } from "./readOnly.js";

/** The reply a transaction gives each command it queues; the command has not read anything yet. */
export const QUEUED = "QUEUED";

const FIRST = "0";
const LAST = "-1";
const STREAM_START = "-";
const STREAM_END = "+";

/** The one key a read-only command reads, or null for writes, keyless and multi-key commands. */
export function keyRead<T>(table: CommandTable, words: readonly string[], args: readonly T[]): T | null {
  if (!flagsOf(table, words).includes("readonly")) return null;
  const keys = keyArguments(table, words, args);
  return keys === "movable" || keys.length !== 1 ? null : (keys[0] ?? null);
}

/**
 * Whether the command's reply holds the whole of a key of `type` (decision 119): `GET`, `HGETALL`,
 * `SMEMBERS`, `LRANGE k 0 -1`, `ZRANGE k 0 -1 [WITHSCORES]` and `XRANGE k - +`, with no other
 * option that narrows or reorders them.
 */
export function readsWholeKey(words: readonly string[], type: KeyType): boolean {
  const [name, , from, to, option] = words;
  switch (type) {
    case "string":
      return name === "GET" && words.length === 2;
    case "hash":
      return name === "HGETALL" && words.length === 2;
    case "set":
      return name === "SMEMBERS" && words.length === 2;
    case "list":
      return name === "LRANGE" && words.length === 4 && from === FIRST && to === LAST;
    case "zset":
      return (
        name === "ZRANGE" &&
        from === FIRST &&
        to === LAST &&
        (words.length === 4 || (words.length === 5 && option === "WITHSCORES"))
      );
    case "stream":
      return name === "XRANGE" && words.length === 4 && from === STREAM_START && to === STREAM_END;
    default:
      return false;
  }
}
