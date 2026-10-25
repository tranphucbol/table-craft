import type { KeyDetails, KeyType } from "@table-craft/desktop/engine/protocol.js";
import { formatBytes, formatCount } from "@table-craft/desktop/renderer/model/format.js";
import { ttlText } from "@table-craft/desktop/renderer/model/keyTree.js";

const MS_PER_SECOND = 1000;

const LENGTH_UNITS: Readonly<Record<KeyType, readonly [string, string]>> = {
  string: ["byte", "bytes"],
  hash: ["field", "fields"],
  list: ["item", "items"],
  set: ["member", "members"],
  zset: ["member", "members"],
  stream: ["entry", "entries"],
  json: ["value", "values"],
  other: ["element", "elements"],
};

/** `5 fields`, `1 entry`, `12 bytes`. */
export function lengthText(type: KeyType, length: number): string {
  const [one, many] = LENGTH_UNITS[type];
  return `${formatCount(length)} ${length === 1 ? one : many}`;
}

/** The key tab's info line (plan 058 decision 18): length, memory, encoding, idle time; each left out when unknown. */
export function keyInfoParts(details: KeyDetails): readonly string[] {
  if (details.type === null) return [];
  return [
    details.length === null ? null : lengthText(details.type, details.length),
    details.memoryBytes === null ? null : formatBytes(details.memoryBytes),
    details.encoding,
    details.idleSeconds === null ? null : `idle ${ttlText(details.idleSeconds * MS_PER_SECOND)}`,
  ].filter((part): part is string => part !== null);
}

/** The header's TTL: `TTL 14 m`, or `no TTL`. */
export function ttlLabel(remainingMs: number | null): string {
  return remainingMs === null ? ttlText(null) : `TTL ${ttlText(remainingMs)}`;
}
