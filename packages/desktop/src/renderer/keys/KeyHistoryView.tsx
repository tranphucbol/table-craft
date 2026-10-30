import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { KEY_ACTION_IDS } from "@table-craft/desktop/renderer/actions/keyActions.js";
import { KeyDiffView } from "@table-craft/desktop/renderer/keys/KeyDiffView.js";
import { bytesOfValue } from "@table-craft/desktop/renderer/model/keyChanges.js";
import {
  EMPTY_KEY_HISTORY,
  historyEventId,
  revisionAge,
  previousHistoryVersion,
  historyLineDelta,
} from "@table-craft/desktop/renderer/model/keyHistory.js";
import { formatBytes } from "@table-craft/desktop/renderer/model/format.js";
import { pendingKeyCount, type KeyTab } from "@table-craft/desktop/renderer/state/keyTabs.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";

const STOP_LABELS = {
  snapshotEnd: "end of the retained snapshot",
  pageLimit: "version limit reached",
  byteLimit: "byte limit reached",
  deadline: "time limit reached",
  compacted: "older revisions compacted",
} as const;
const HEX_DIGITS_PER_BYTE = 2;

export function KeyHistoryView({ tab }: { readonly tab: KeyTab }) {
  const [target, setTarget] = useState("current");
  const history = tab.history ?? EMPTY_KEY_HISTORY;
  const selected = history.events.find((event) => historyEventId(event) === history.selected);
  const page = history.page;
  const partial =
    typeof tab.value === "object" &&
    tab.value !== null &&
    tab.value.kind === "bytes" &&
    tab.value.preview.length !== tab.value.length * HEX_DIGITS_PER_BYTE;
  const current = tab.details?.type === null || partial ? null : bytesOfValue(tab.value);
  const previous = selected === undefined ? null : previousHistoryVersion(history.events, selected);
  const unsaved = tab.stringValue !== null && tab.stringProblem == null;
  const activeTarget =
    (target === "previous" && previous === null) || (target === "unsaved" && !unsaved) ? "current" : target;
  const compared =
    activeTarget === "previous" ? (previous?.value ?? null) : activeTarget === "unsaved" ? tab.stringValue : current;
  const deltas = useMemo(
    () =>
      new Map(
        history.events.map((event) => [
          historyEventId(event),
          historyLineDelta(event, previousHistoryVersion(history.events, event)),
        ]),
      ),
    [history.events],
  );
  return (
    <div data-testid="key-history" className="@container/history flex min-h-0 min-w-0 flex-1">
      <aside
        aria-label="Key versions"
        className="flex w-dialog-list max-w-1/3 shrink-0 flex-col border-r border-line bg-panel"
      >
        <div className="min-h-0 flex-1 overflow-auto">
          {history.events.map((event) => (
            <button
              key={historyEventId(event)}
              type="button"
              aria-pressed={historyEventId(event) === history.selected}
              title={`${event.kind} · v${event.version} · rev ${event.modRevision} · lease ${event.lease}`}
              className={cn(
                "flex w-full flex-col px-gap py-1 text-left hover:bg-raised",
                historyEventId(event) === history.selected && "bg-grid-selection",
              )}
              onClick={() => void invoke(KEY_ACTION_IDS.selectHistory, { eventId: historyEventId(event) })}
            >
              <span className="flex items-baseline gap-gap">
                <strong>{event.kind === "DELETE" ? "Deleted" : `v${event.version}`}</strong>
                {event.kind === "DELETE" ? (
                  <span className="text-ink-muted">Key removed</span>
                ) : event.modRevision === tab.details?.revision?.modRevision ? null : event.version === "1" ? (
                  <span className="text-ink-muted">Created</span>
                ) : deltas.get(historyEventId(event)) == null ? null : (
                  <span className="text-ink-muted tabular-nums">
                    <span className="text-success">+{deltas.get(historyEventId(event))?.added}</span>{" "}
                    <span className="text-danger">−{deltas.get(historyEventId(event))?.removed}</span> lines
                  </span>
                )}
                {event.modRevision === tab.details?.revision?.modRevision ? (
                  <span className="ml-auto text-accent">Current</span>
                ) : null}
              </span>
              <span className="text-ink-muted tabular-nums" title={`Revision ${event.modRevision}`}>
                {revisionAge(page?.snapshotRevision ?? event.modRevision, event.modRevision)}
                {event.value === null
                  ? ""
                  : ` · ${formatBytes(event.value.hex === null ? new TextEncoder().encode(event.value.text).length : event.value.hex.length / HEX_DIGITS_PER_BYTE)}`}
              </span>
            </button>
          ))}
          {history.loading ? (
            <p role="status" className="p-gap text-ink-muted">
              Reading history…
            </p>
          ) : null}
          {history.error !== null ? (
            <p role="alert" className="p-gap text-danger">
              {history.error.message} {history.error.hint}
            </p>
          ) : null}
          {page?.cursor != null || history.error !== null ? (
            <ActionButton actionId={KEY_ACTION_IDS.loadHistory} />
          ) : null}
          {history.events.length === 0 && page?.complete === true ? (
            <p className="p-gap text-ink-muted">No retained versions.</p>
          ) : null}
        </div>
        {page === null ? null : (
          <div className="space-y-1 border-t border-line p-gap text-ink-muted">
            {page.unavailableThrough === null ? null : (
              <p>Older revisions through {page.unavailableThrough} were compacted.</p>
            )}
            {page.gaps.map((gap) => (
              <p key={`${gap.fromRevision}:${gap.toRevision}`}>
                Gap: revisions {gap.fromRevision}–{gap.toRevision} were compacted.
              </p>
            ))}
            {!page.complete ? (
              <p>
                History is incomplete: {STOP_LABELS[page.stopReason]}.
                {page.cursor === null ? " Reload the key to try again." : " Load more to continue."}
              </p>
            ) : null}
            <p>No timestamps are available. Ages count revisions.</p>
          </div>
        )}
      </aside>
      {selected === undefined ? (
        <p className="p-gap text-ink-muted">Choose a version to compare.</p>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-gap border-b border-line bg-panel px-gap py-1">
            <span className="mr-auto text-ink-muted">
              Comparing {selected.kind === "DELETE" ? "deletion" : `v${selected.version}`} with{" "}
              <select
                aria-label="Compare version with"
                className="rounded bg-canvas text-ink"
                value={activeTarget}
                onChange={(event) => setTarget(event.target.value)}
              >
                <option value="current">Current (last read)</option>
                <option value="previous" disabled={previous === null}>
                  Previous version
                </option>
                {unsaved ? <option value="unsaved">My unsaved edits</option> : null}
              </select>
            </span>
            <ActionButton
              actionId={KEY_ACTION_IDS.restoreHistory}
              reason={
                pendingKeyCount(tab) > 0
                  ? "Save or revert your unsaved edits before restoring a version."
                  : selected.kind === "DELETE"
                    ? "A deletion has no value to restore."
                    : "Choose an older version in a writable, connected key tab. Kubernetes protobuf values cannot be restored here."
              }
            />
          </div>
          {partial && activeTarget === "current" ? (
            <p role="status" className="p-gap text-ink-muted">
              The current value was only partly read. Reload the complete value before comparing it.
            </p>
          ) : (
            <KeyDiffView
              before={selected.value}
              after={compared}
              leftTitle={`${selected.kind === "DELETE" ? "Deleted" : `v${selected.version}`} · ${revisionAge(page?.snapshotRevision ?? selected.modRevision, selected.modRevision)}`}
              rightTitle={
                activeTarget === "previous"
                  ? `Previous version · v${previous?.version ?? "?"}`
                  : activeTarget === "unsaved"
                    ? "My unsaved edits"
                    : tab.details?.type === null
                      ? "Current · key absent"
                      : `Current · v${tab.details?.revision?.version ?? "?"}`
              }
            />
          )}
        </div>
      )}
    </div>
  );
}
import { useMemo, useState } from "react";
