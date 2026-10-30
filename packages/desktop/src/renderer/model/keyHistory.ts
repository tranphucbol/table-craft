import type { EngineError, KeyHistoryEvent, KeyHistoryPage } from "@table-craft/desktop/engine/protocol.js";
import { diffText, keyDiff } from "@table-craft/desktop/renderer/model/keyDiff.js";

export interface KeyHistoryState {
  readonly mode: "value" | "history";
  readonly events: readonly KeyHistoryEvent[];
  readonly page: KeyHistoryPage | null;
  readonly selected: string | null;
  readonly loading: boolean;
  readonly error: EngineError | null;
}

export const EMPTY_KEY_HISTORY: KeyHistoryState = {
  mode: "value",
  events: [],
  page: null,
  selected: null,
  loading: false,
  error: null,
};

export function historyEventId(event: KeyHistoryEvent): string {
  return `${event.modRevision}:${event.kind}`;
}

export function previousHistoryVersion(
  events: readonly KeyHistoryEvent[],
  event: KeyHistoryEvent,
): KeyHistoryEvent | null {
  const index = events.findIndex((candidate) => historyEventId(candidate) === historyEventId(event));
  const previous = events[index + 1];
  return index >= 0 &&
    previous?.kind === "PUT" &&
    event.kind === "PUT" &&
    previous.createRevision === event.createRevision &&
    BigInt(previous.version) + 1n === BigInt(event.version)
    ? previous
    : null;
}

export function historyLineDelta(
  event: KeyHistoryEvent,
  previous: KeyHistoryEvent | null,
): { readonly added: number; readonly removed: number } | null {
  if (event.value === null || event.value.hex !== null || previous?.value == null || previous.value.hex !== null)
    return null;
  const lines = keyDiff(diffText(previous.value), diffText(event.value));
  return {
    added: lines.filter((line) => line.kind === "insert").length,
    removed: lines.filter((line) => line.kind === "delete").length,
  };
}

/** Deduplicate pages without converting int64 revision strings into imprecise numbers. */
export function appendHistory(
  before: readonly KeyHistoryEvent[],
  incoming: readonly KeyHistoryEvent[],
): readonly KeyHistoryEvent[] {
  const found = new Map(before.map((event) => [historyEventId(event), event]));
  for (const event of incoming) found.set(historyEventId(event), event);
  return [...found.values()].sort((a, b) =>
    BigInt(a.modRevision) > BigInt(b.modRevision) ? -1 : BigInt(a.modRevision) < BigInt(b.modRevision) ? 1 : 0,
  );
}

/** Revision distance only; etcd supplies no timestamps. */
export function revisionAge(current: string, revision: string): string {
  const distance = BigInt(current) - BigInt(revision);
  if (distance <= 0n) return "Current revision";
  return `${distance.toLocaleString("en-US")} ${distance === 1n ? "revision" : "revisions"} ago`;
}
