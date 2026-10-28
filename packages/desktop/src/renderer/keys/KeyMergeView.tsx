import { useEffect, useRef } from "react";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { KEY_ACTION_IDS } from "@table-craft/desktop/renderer/actions/keyActions.js";
import { diffText } from "@table-craft/desktop/renderer/model/keyDiff.js";
import { useKeyTabs, type KeyTab } from "@table-craft/desktop/renderer/state/keyTabs.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";

export function KeyMergeView({
  tab,
  tabId,
  editable,
}: {
  readonly tab: KeyTab;
  readonly tabId: string;
  readonly editable: boolean;
}) {
  const merge = tab.merge;
  const conflicts = useRef<HTMLDivElement>(null);
  const index = merge?.conflictIndex ?? 0;
  useEffect(() => {
    const target = conflicts.current?.querySelector<HTMLElement>(`[data-conflict-index="${String(index)}"]`);
    target?.scrollIntoView({ block: "nearest" });
    target?.focus({ preventScroll: true });
  }, [index]);
  if (merge == null) return null;
  const unresolved = merge.acknowledged ? 0 : merge.merged.conflicts.length;
  return (
    <section data-testid="key-merge" aria-label="Merge changes" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-gap border-b border-line bg-panel px-gap py-1">
        <p className="mr-auto text-danger" title={`Read at revision ${merge.snapshot.snapshotRevision}`}>
          {merge.snapshot.value === null
            ? "Someone else deleted this key while you were editing."
            : `${merge.changedAgain ? "Changed again:" : "Someone else saved"} v${merge.snapshot.revision?.version ?? "?"} while you were editing.`}
        </p>
        <ActionButton actionId={KEY_ACTION_IDS.discardMerge} />
        <ActionButton actionId={KEY_ACTION_IDS.cancelMerge} />
        <ActionButton
          actionId={KEY_ACTION_IDS.saveMerge}
          primary
          reason={
            unresolved > 0
              ? `${String(unresolved)} conflicts left. Choose a side or edit Result and mark it resolved.`
              : null
          }
        />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 overflow-auto border-b border-line">
        <section aria-label="Theirs" className="flex min-h-0 min-w-0 flex-col border-r border-line">
          <h3 className="sticky top-0 bg-panel px-gap py-1 text-ink-muted">
            Theirs ·{" "}
            {merge.snapshot.value === null
              ? "key absent"
              : `server snapshot · v${merge.snapshot.revision?.version ?? "?"}`}
          </h3>
          <pre className="overflow-auto p-gap font-editor text-editor whitespace-pre-wrap break-all">
            {diffText(merge.snapshot.value)}
          </pre>
        </section>
        <section aria-label="Yours" className="flex min-h-0 min-w-0 flex-col">
          <h3 className="sticky top-0 bg-panel px-gap py-1 text-ink-muted">
            Yours · your edit of v{tab.details?.revision?.version ?? "?"}
          </h3>
          <pre className="overflow-auto p-gap font-editor text-editor whitespace-pre-wrap break-all">
            {merge.binary ? diffText(merge.yoursValue) : merge.yours}
          </pre>
        </section>
      </div>
      <div
        ref={conflicts}
        className="max-h-console shrink-0 overflow-auto border-b border-line bg-panel"
        aria-label="Conflicts"
      >
        {merge.binary ? (
          <p role="status" className="p-gap text-warning">
            Binary merge is read-only. Discard your changes and reload, or cancel and save a copy before editing
            elsewhere.
          </p>
        ) : (
          merge.merged.conflicts.map((conflict, conflictIndex) => (
            <div
              key={conflict.path}
              tabIndex={-1}
              data-conflict-index={conflictIndex}
              className="flex flex-wrap items-baseline gap-gap border-l-2 border-danger bg-edit-deleted px-gap py-1"
            >
              <span className="mr-auto font-grid">
                {merge.acknowledged ? "✓" : "!"} {conflict.path || "Whole value"} ·{" "}
                {merge.acknowledged ? "Resolved in Result" : "Conflict"}
              </span>
              <button
                type="button"
                className="rounded px-cell hover:bg-raised disabled:opacity-50"
                disabled={merge.manual || !editable}
                title={conflict.theirs}
                onClick={() => void invoke(KEY_ACTION_IDS.chooseMerge, { path: conflict.path, side: "theirs" })}
              >
                Use theirs
              </button>
              <button
                type="button"
                className="rounded px-cell hover:bg-raised disabled:opacity-50"
                disabled={merge.manual || !editable}
                title={conflict.yours}
                onClick={() => void invoke(KEY_ACTION_IDS.chooseMerge, { path: conflict.path, side: "yours" })}
              >
                Use yours
              </button>
              <span className="w-full break-all font-editor text-ink-muted">
                Theirs: {conflict.theirs} · Yours: {conflict.yours}
              </span>
            </div>
          ))
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-gap border-b border-line bg-panel px-gap py-1">
        <label htmlFor={`${tabId}-merge-result`} className="mr-auto">
          Result{" "}
          <span className="text-ink-muted">
            · {merge.merged.automatic} changes merged automatically · {unresolved} conflicts left
          </span>
        </label>
        <ActionButton actionId={KEY_ACTION_IDS.nextMergeConflict} />
        {merge.manual ? <ActionButton actionId={KEY_ACTION_IDS.acknowledgeMerge} /> : null}
      </div>
      <textarea
        id={`${tabId}-merge-result`}
        aria-label="Merged result"
        spellCheck={false}
        value={merge.text}
        readOnly={merge.binary || !editable}
        className="min-h-0 flex-1 resize-none bg-canvas p-gap font-editor text-editor text-ink outline-none focus:ring-1 focus:ring-inset focus:ring-accent"
        onChange={(event) => useKeyTabs.getState().editMerge(tabId, event.target.value)}
      />
      <p className="shrink-0 border-t border-line bg-panel px-gap py-1 text-ink-muted">
        {merge.merged.format === "json"
          ? "JSON objects merge by path; arrays are compared as a whole."
          : "Text merge only. YAML is not merged by structure."}{" "}
        Save Merged checks the server revision again.
      </p>
    </section>
  );
}
