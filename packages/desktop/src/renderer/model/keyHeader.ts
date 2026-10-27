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

/** The attribute the header shortens to `v14`: how many times the key was written. */
const VERSION_ATTRIBUTE = "version";
const WHOLE_NUMBER = /^\d+$/;
const ATTRIBUTE_WORD_BREAK = /[_\-\s]+/g;

/** `create_revision` → `Create revision`: an attribute name as a label. */
export function attributeLabel(name: string): string {
  const words = name.replace(ATTRIBUTE_WORD_BREAK, " ").trim();
  return words === "" ? name : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** The key's size: bytes for a string, else its element count. */
export function sizeText(details: KeyDetails): string | null {
  if (details.type === null || details.length === null) return null;
  return details.type === "string" ? formatBytes(details.length) : lengthText(details.type, details.length);
}

/**
 * The one-line header's facts for a key that carries attributes: `v14 · 2.4 KiB`. Every other
 * attribute waits in Details, so the header stays one row.
 */
export function attributeFacts(details: KeyDetails): readonly string[] {
  if (details.type === null || details.attributes === undefined) return [];
  const version = details.attributes.find((attribute) => attribute.name === VERSION_ATTRIBUTE)?.value;
  return [version !== undefined && WHOLE_NUMBER.test(version) ? `v${version}` : null, sizeText(details)].filter(
    (part): part is string => part !== null,
  );
}

export interface DetailRow {
  readonly label: string;
  readonly value: string;
}

/** What the Details panel lists: the size, then every attribute in the plugin's order. */
export function detailRows(details: KeyDetails): readonly DetailRow[] {
  const size = sizeText(details);
  return [
    ...(size === null ? [] : [{ label: "Size", value: size }]),
    ...(details.attributes ?? []).map((attribute) => ({
      label: attributeLabel(attribute.name),
      value: attribute.value,
    })),
  ];
}

/** The header's TTL: `TTL 14 m`, or `no TTL`. */
export function ttlLabel(remainingMs: number | null): string {
  return remainingMs === null ? ttlText(null) : `TTL ${ttlText(remainingMs)}`;
}
