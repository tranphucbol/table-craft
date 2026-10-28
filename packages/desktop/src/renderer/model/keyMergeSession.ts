import type { KeyBytes, KeyConflictSnapshot } from "@table-craft/desktop/engine/protocol.js";
import { mergeKeyText, type KeyMerge, type MergeChoices } from "@table-craft/desktop/renderer/model/keyMerge.js";

export interface KeyMergeSession {
  readonly snapshot: KeyConflictSnapshot;
  readonly base: string | null;
  readonly yours: string;
  readonly yoursValue: KeyBytes;
  readonly choices: MergeChoices;
  readonly merged: KeyMerge;
  readonly text: string;
  readonly visible: boolean;
  readonly manual: boolean;
  readonly acknowledged: boolean;
  readonly binary: boolean;
  readonly changedAgain: boolean;
  readonly conflictIndex: number;
}

/** A fresh typed failure is the only source of the next save's revision baseline. */
export function beginKeyMerge(
  snapshot: KeyConflictSnapshot,
  base: KeyBytes | null,
  yours: KeyBytes,
  previous?: KeyMergeSession | null,
): KeyMergeSession {
  const binary = base?.hex != null || yours.hex !== null || snapshot.value?.hex != null;
  const baseline = previous == null ? base : previous.snapshot.value;
  const baseText = baseline === null ? null : baseline.text;
  const yoursText = previous?.text ?? yours.text;
  const merged = mergeKeyText(baseText, snapshot.value?.text ?? "", yoursText);
  // An absent key is a real concurrent deletion, not an empty-string edit.
  const deletion = snapshot.value === null;
  return {
    snapshot,
    base: baseText,
    yours: yoursText,
    yoursValue: previous?.binary === true ? previous.yoursValue : yours,
    choices: {},
    merged: deletion ? { ...merged, conflicts: [{ path: "", theirs: "(key absent)", yours: yoursText }] } : merged,
    text: deletion ? yoursText : merged.text,
    visible: true,
    manual: false,
    acknowledged: false,
    binary,
    changedAgain: previous != null,
    conflictIndex: 0,
  };
}

export function canSaveKeyMerge(merge: KeyMergeSession): boolean {
  return !merge.binary && (merge.merged.conflicts.length === 0 || merge.acknowledged);
}
