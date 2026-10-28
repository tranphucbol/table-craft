import type { EngineError, KeyHistoryEvent, KeyHistoryPage } from "@table-craft/desktop/engine/protocol.js";

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
