import type { KeyBytes, WireValue } from "@table-craft/desktop/engine/protocol.js";
import {
  isKubernetesEnvelope,
  KUBERNETES_VALUE_NOTICE,
  valueBytes,
} from "@table-craft/desktop/renderer/model/valueFormats.js";
import type { KeyTab } from "./keyTabs.js";

const SUBMITTED_NOTICE = "Changes saved atomically";
const encoder = new TextEncoder();

function draftBytes(draft: KeyBytes): Uint8Array {
  return draft.hex === null
    ? encoder.encode(draft.text)
    : Uint8Array.from(draft.hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

/** True when the drafted string has exactly the bytes last read. */
export function sameStringBytes(value: WireValue | null, draft: KeyBytes): boolean {
  const before = valueBytes(value ?? undefined);
  const after = draftBytes(draft);
  return before !== null && before.length === after.length && before.every((byte, index) => byte === after[index]);
}

/** The notice a successful save shows, naming the new version when the datasource guards revisions. */
export function savedNoticeText(before: KeyTab): string {
  if (before.revisionGuardAvailable !== true) return SUBMITTED_NOTICE;
  const baseline = before.merge != null ? before.merge.snapshot.revision : before.details?.revision;
  const version = baseline?.version;
  if (version !== undefined && /^\d+$/.test(version)) return `Saved as v${String(BigInt(version) + 1n)}`;
  const missing = before.details !== null && before.details.type === null;
  return before.merge?.snapshot.value === null || before.recreating || missing ? "Saved as v1" : "Changes saved";
}

/** Why the key opens read-only; a Kubernetes envelope always does where revisions are guarded. */
export function readOnlyReason(
  revisionGuard: boolean,
  value: WireValue | null,
  readOnly: string | null,
): string | null {
  return revisionGuard && isKubernetesEnvelope(valueBytes(value ?? undefined) ?? new Uint8Array())
    ? KUBERNETES_VALUE_NOTICE
    : readOnly;
}
