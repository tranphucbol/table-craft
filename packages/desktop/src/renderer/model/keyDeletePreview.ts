import type { KeyDeletePreview, KeyRange } from "@table-craft/desktop/engine/protocol.js";
import type { ModalRequest } from "@table-craft/desktop/renderer/state/modal.js";

const LISTED_NAMES = 20;
const TYPED_DELETE_THRESHOLD = 10_000n;
const EMPTY_PREFIX_CONFIRMATION = "DELETE";

/** Confirms the prepared namespace-relative range, never a sampled or locally scanned count. */
export function keyDeleteConfirmation(
  preview: KeyDeletePreview,
  range: Extract<KeyRange, { kind: "key" | "prefix" }>,
): Extract<ModalRequest, { kind: "confirm" }> {
  const { keys, leasedKeys } = preview.counts;
  const prefix = range.kind === "prefix" ? range.prefix.text : null;
  const typed =
    prefix !== null &&
    (prefix === "" || prefix === "/" || keys === null || leasedKeys === null || BigInt(keys) > TYPED_DELETE_THRESHOLD);
  const count = keys === null ? "Key count unknown" : `Exact key count: ${keys}`;
  const leased = leasedKeys === null ? "Leased key count unknown" : `Leased key count: ${leasedKeys}`;
  const target = range.kind === "key" ? `key ${range.key.text}` : `prefix ${JSON.stringify(prefix)}`;
  return {
    kind: "confirm",
    title: range.kind === "key" ? "Delete Key" : "Delete Keys Under Folder",
    message: `Delete ${target}? ${count}. ${leased}. Preview pinned to revision ${preview.revision}. Deletion is atomic and rejects new or modified keys since this preview; this cannot be undone. First ${LISTED_NAMES} keys shown at most.`,
    items: preview.sampleKeys.slice(0, LISTED_NAMES).map((key) => ({
      label: key.text,
      detail: key.hex === null ? "" : `Hex: ${key.hex}`,
      tone: "info",
    })),
    confirm: "Delete",
    destructive: true,
    ...(typed ? { typed: prefix === "" || prefix === null ? EMPTY_PREFIX_CONFIRMATION : prefix } : {}),
  };
}
