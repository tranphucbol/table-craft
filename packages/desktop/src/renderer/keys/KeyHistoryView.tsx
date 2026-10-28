import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { KEY_ACTION_IDS } from "@table-craft/desktop/renderer/actions/keyActions.js";
import { KeyDiffView } from "@table-craft/desktop/renderer/keys/KeyDiffView.js";
import { bytesOfValue } from "@table-craft/desktop/renderer/model/keyChanges.js";
import { EMPTY_KEY_HISTORY, historyEventId, revisionAge } from "@table-craft/desktop/renderer/model/keyHistory.js";
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
  const history = tab.history ?? EMPTY_KEY_HISTORY;
  const selected = history.events.find((event) => historyEventId(event) === history.selected);
  const page = history.page;
  const partial =
    typeof tab.value === "object" &&
    tab.value !== null &&
    tab.value.kind === "bytes" &&
    tab.value.preview.length !== tab.value.length * HEX_DIGITS_PER_BYTE;
  const current = tab.details?.type === null || partial ? null : bytesOfValue(tab.value);
  return (
    <div data-testid="key-history" className="flex min-h-0 min-w-0 flex-1">
      <aside aria-label="Key versions" className="flex w-dialog-list shrink-0 flex-col border-r border-line bg-panel">
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
                <span className="text-ink-muted">{event.kind}</span>
                {event.modRevision === tab.details?.revision?.modRevision ? (
                  <span className="ml-auto text-accent">Current</span>
                ) : null}
              </span>
              <span className="text-ink-muted tabular-nums">
                {revisionAge(page?.snapshotRevision ?? event.modRevision, event.modRevision)}
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
          <div className="flex shrink-0 items-center gap-gap border-b border-line bg-panel px-gap py-1">
            <span className="mr-auto text-ink-muted">
              Comparing {selected.kind === "DELETE" ? "deletion" : `v${selected.version}`} with Current (last read)
            </span>
            <ActionButton
              actionId={KEY_ACTION_IDS.restoreHistory}
              reason={
                pendingKeyCount(tab) > 0
                  ? "Save or revert your unsaved edits before restoring a version."
                  : selected.kind === "DELETE"
                    ? "A deletion has no value to restore."
                    : selected.value?.hex != null
                      ? "Binary history is read-only; restore is not available here."
                      : "Choose an older version in a writable, connected key tab."
              }
            />
          </div>
          {partial ? (
            <p role="status" className="p-gap text-ink-muted">
              The current value was only partly read. Reload the complete value before comparing it.
            </p>
          ) : (
            <KeyDiffView
              before={selected.value}
              after={current}
              leftTitle={`${selected.kind === "DELETE" ? "Deleted" : `v${selected.version}`} · rev ${selected.modRevision}`}
              rightTitle={
                tab.details?.type === null
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
