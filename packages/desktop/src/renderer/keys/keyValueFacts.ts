import type { KeyTab } from "@table-craft/desktop/renderer/state/keyTabs.js";
import { valueBytes } from "@table-craft/desktop/renderer/model/valueFormats.js";

export const DEFAULT_REQUEST_BYTES = 1_572_864;
export const SIZE_WARNING_RATIO = 0.75;
export const SIZE_DANGER_RATIO = 0.95;
export const SIZE_REFERENCE_NOTICE =
  "Compared with etcd's default 1.5 MiB request limit, not a measured server limit. Key and transaction overhead are not included.";
const encoder = new TextEncoder();

export function keyValueSize(tab: KeyTab): number | null {
  if (tab.merge != null) return tab.merge.binary ? null : encoder.encode(tab.merge.text).length;
  if (tab.stringValue !== null)
    return tab.stringValue.hex === null ? encoder.encode(tab.stringValue.text).length : tab.stringValue.hex.length / 2;
  return valueBytes(tab.value ?? undefined)?.length ?? (tab.details?.type === "string" ? tab.details.length : null);
}

export function keyValueCount(tab: KeyTab): string | null {
  const bytes = keyValueSize(tab);
  const value = tab.merge != null && !tab.merge.binary ? { text: tab.merge.text, hex: null } : tab.stringValue;
  const text = value?.hex === null ? value.text : value === null && typeof tab.value === "string" ? tab.value : null;
  if (text !== null) {
    const lines = text.split("\n").length;
    return `${String(lines)} ${lines === 1 ? "line" : "lines"} · ${String(bytes ?? 0)} bytes`;
  }
  return bytes === null ? null : `${String(bytes)} bytes`;
}
