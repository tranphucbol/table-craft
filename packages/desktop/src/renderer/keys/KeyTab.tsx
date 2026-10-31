import { useCallback, type ReactNode } from "react";
import type { EngineError } from "@table-craft/desktop/engine/protocol.js";
import { ACTION_IDS } from "@table-craft/desktop/renderer/actions/appActions.js";
import { currentPlatform, formatChord } from "@table-craft/desktop/renderer/actions/chords.js";
import { REGION_ATTRIBUTE } from "@table-craft/desktop/renderer/actions/context.js";
import { invoke, registry } from "@table-craft/desktop/renderer/actions/index.js";
import { formatPatternOf, hasAttributes, KEY_ACTION_IDS } from "@table-craft/desktop/renderer/actions/keyActions.js";
import { TABLE_ACTION_IDS, TABLE_CELL_MENU } from "@table-craft/desktop/renderer/actions/tableActions.js";
import { useConsoleDatasource } from "@table-craft/desktop/renderer/console/useConsoleDatasource.js";
import { ResultGrid, type GridEdits } from "@table-craft/desktop/renderer/grid/ResultGrid.js";
import { ValueEditor, ValuePanel } from "@table-craft/desktop/renderer/grid/ValuePanel.js";
import { KeyDetailsPanel } from "@table-craft/desktop/renderer/keys/KeyDetailsPanel.js";
import { KeyFilterBar } from "@table-craft/desktop/renderer/keys/KeyFilterBar.js";
import { KeyHeader } from "@table-craft/desktop/renderer/keys/KeyHeader.js";
import { KeyHistoryView } from "@table-craft/desktop/renderer/keys/KeyHistoryView.js";
import { KeyMergeView } from "@table-craft/desktop/renderer/keys/KeyMergeView.js";
import { StringValueEditor } from "@table-craft/desktop/renderer/keys/StringValueEditor.js";
import { keyValueCount } from "@table-craft/desktop/renderer/keys/keyValueFacts.js";
import { visibleColumns } from "@table-craft/desktop/renderer/model/columnLayout.js";
import { bufferRowAt, pendingText } from "@table-craft/desktop/renderer/model/editBuffer.js";
import { formatCount } from "@table-craft/desktop/renderer/model/format.js";
import { editsRows } from "@table-craft/desktop/renderer/model/keyChanges.js";
import { canEditCell, editCellText } from "@table-craft/desktop/renderer/model/resultEdits.js";
import {
  isKeyEditable,
  keyEditTarget,
  keyMissing,
  pendingKeyCount,
  useKeyTabs,
  type KeyTab as KeyTabState,
} from "@table-craft/desktop/renderer/state/keyTabs.js";
import { useKeyDetails } from "@table-craft/desktop/renderer/state/keyDetails.js";
import { useLayout } from "@table-craft/desktop/renderer/state/layout.js";
import { rowAt, shownHeld } from "@table-craft/desktop/renderer/state/resultTab.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { ReadOnlyIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { TINT_BORDER } from "@table-craft/desktop/renderer/ui/tint.js";

const STATUS_TEXT = {
  connecting: "Connecting…",
  loading: "Loading…",
  submitting: "Submitting…",
  ready: "",
  failed: "",
  disconnected: "Disconnected; Reload reconnects.",
} as const;

const STALE_TEXT = "The connection closed; Reload reads the key again.";
/** Plan 058 decision 16: where the table editor reads `Tx: Auto`. */
const SUBMIT_TEXT = "Submit applies changes atomically · not undoable";
const GUARDED_TEXT = "Saves only if no one changed it since you opened it";
const RECREATE_PENDING_TEXT = "; Submit writes it back as it was read";
const ERROR_CLASS = "shrink-0 border-b border-line bg-panel px-gap py-1 break-words text-danger";

function shortcutText(actionId: string): string {
  const shortcut = registry.get(actionId)?.shortcut;
  return shortcut === undefined ? "" : formatChord(shortcut, currentPlatform());
}

function KeyPanel({
  tabId,
  tab,
  editable,
  focus,
}: {
  readonly tabId: string;
  readonly tab: KeyTabState;
  readonly editable: boolean;
  readonly focus: { readonly row: number; readonly column: number } | null;
}) {
  const result = tab.result;
  const column = focus === null ? null : (result?.columns[focus.column] ?? null);
  const pattern = formatPatternOf(tab);
  const format = useLayout((state) => (pattern === null ? undefined : state.layout.valueFormats[pattern])) ?? "auto";
  if (result !== null && focus !== null && editable) {
    const row = bufferRowAt(tab.buffer, shownHeld(result), focus.row);
    const deleted = row?.kind === "held" && tab.buffer.deletes.has(row.row);
    const target = keyEditTarget(tab);
    if (row !== null && !deleted && result.typeClasses[focus.column] !== "bytes" && canEditCell(target, focus)) {
      const text = editCellText(target, focus);
      const draft = tab.panel?.row === focus.row && tab.panel.column === focus.column ? tab.panel : null;
      return (
        <ValueEditor
          key={`${String(focus.row)}:${String(focus.column)}:${text}`}
          column={column}
          text={draft?.text ?? text}
          json={false}
          applyHint={shortcutText(TABLE_ACTION_IDS.applyValue)}
          onChange={(next) => useKeyTabs.getState().editPanel(tabId, focus, next)}
        />
      );
    }
  }
  const held = result === null || focus === null ? null : bufferRowAt(tab.buffer, shownHeld(result), focus.row);
  const value =
    result === null || focus === null || held?.kind !== "held"
      ? undefined
      : rowAt(result.windows, held.row)?.[focus.column];
  return (
    <ValuePanel
      column={column}
      value={value}
      format={{ format, onChange: (next) => void invoke(KEY_ACTION_IDS.valueFormat, { format: next }) }}
    />
  );
}

function BannerButton({
  testId,
  onClick,
  children,
}: {
  readonly testId?: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      className="shrink-0 rounded px-cell hover:bg-raised hover:text-ink"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function MissingBanner({
  tabId,
  tab,
  canRecreate,
}: {
  readonly tabId: string;
  readonly tab: KeyTabState;
  readonly canRecreate: boolean;
}) {
  return (
    <div
      role="status"
      data-testid="key-missing"
      className="flex h-row shrink-0 items-center gap-gap border-b border-line bg-panel px-gap text-ink-muted"
    >
      <span className="mr-auto truncate">
        <code className="font-grid text-ink">{tab.key.text}</code> no longer exists
        {tab.recreating ? RECREATE_PENDING_TEXT : ""}
      </span>
      {canRecreate && !tab.recreating ? (
        <BannerButton testId="key-recreate" onClick={() => useKeyTabs.getState().recreate(tabId)}>
          Recreate
        </BannerButton>
      ) : null}
      {tab.recreating ? <ActionButton actionId={TABLE_ACTION_IDS.submit} compact /> : null}
      <BannerButton onClick={() => void invoke(ACTION_IDS.closeTab, { tabId })}>Close</BannerButton>
    </div>
  );
}

/** A guarded Submit found the key changed (decision 115): reload it, or write over the change. */
function ConflictBanner({
  tabId,
  conflict,
  revisionAware,
}: {
  readonly tabId: string;
  readonly conflict: EngineError;
  readonly revisionAware: boolean;
}) {
  const store = useKeyTabs.getState;
  return (
    <div
      role="alertdialog"
      aria-label="The key changed"
      data-testid="key-conflict"
      className="flex shrink-0 flex-wrap items-center gap-gap border-b border-line bg-panel px-gap py-1 text-danger"
    >
      <span className="mr-auto break-words">{conflict.message}</span>
      <BannerButton
        testId="key-conflict-reload"
        onClick={() => {
          store().revertAll(tabId);
          void store().reload(tabId);
        }}
      >
        Reload
      </BannerButton>
      {revisionAware ? null : (
        <BannerButton testId="key-conflict-overwrite" onClick={() => void store().submit(tabId, false)}>
          Overwrite
        </BannerButton>
      )}
      <BannerButton onClick={() => store().dismissConflict(tabId)}>Dismiss</BannerButton>
    </div>
  );
}

function Footer({ tab }: { readonly tab: KeyTabState }) {
  const rows = tab.result?.rowCount;
  const pending = pendingText(pendingKeyCount(tab));
  const merge = tab.merge;
  const count = tab.result === null ? keyValueCount(tab) : null;
  const saved = tab.notice?.startsWith("Saved as v") === true || tab.notice === "Changes saved";
  return (
    <div className="flex h-row shrink-0 items-center gap-gap border-t border-line bg-panel px-gap text-ink-muted">
      {tab.revisionGuardAvailable === true && tab.status === "submitting" ? (
        <span role="status">Saving…</span>
      ) : merge != null ? (
        <span className="text-danger" role="status">
          {merge.binary
            ? "● Not saved · binary merge is read-only"
            : merge.manual && !merge.acknowledged
              ? "● Not saved · review Result and mark it resolved"
              : `● Not saved · ${String(merge.acknowledged ? 0 : merge.merged.conflicts.length)} conflicts left · ${String(merge.merged.automatic)} changes merged automatically`}
        </span>
      ) : saved ? null : pending === null ? (
        tab.revisionGuardAvailable === true ? (
          <span>No unsaved changes</span>
        ) : null
      ) : (
        <span data-testid="pending-changes" className="text-ink">
          {pending}
        </span>
      )}
      {rows === undefined ? null : (
        <span data-testid="row-count">
          {formatCount(rows)}
          {tab.result?.complete === false ? "+" : ""} {rows === 1 ? "row" : "rows"}
        </span>
      )}
      {tab.notice === null ? null : (
        <span role="status" data-testid="key-notice" className="truncate" title={tab.notice}>
          {tab.notice}
        </span>
      )}
      <span className="truncate">
        {tab.revisionGuardAvailable === true && tab.status === "submitting" ? "" : STATUS_TEXT[tab.status]}
      </span>
      {count === null ? null : (
        <span
          className="ml-auto shrink-0 tabular-nums"
          title={tab.stringProblem != null ? "Last valid value; the current input is invalid." : undefined}
        >
          {count}
        </span>
      )}
    </div>
  );
}

/** A key's tab (plan 058 decision 14): its header, its filter, and its rows or its string value. */
export function KeyTab({ tabId }: { readonly tabId: string }) {
  const tab = useKeyTabs((state) => state.tabs[tabId]);
  const datasource = useConsoleDatasource(tabId);
  const pattern = tab === undefined ? null : formatPatternOf(tab);
  const format = useLayout((state) => (pattern === null ? undefined : state.layout.valueFormats[pattern])) ?? "auto";
  const onExpired = useCallback(() => {
    const current = useKeyTabs.getState().tabs[tabId];
    if (current !== undefined && pendingKeyCount(current) === 0) void useKeyTabs.getState().reload(tabId);
  }, [tabId]);
  const detailsOpen = useKeyDetails((state) => state.open[tabId] === true);
  if (tab === undefined) return null;
  const withDetails = hasAttributes(tab);
  const color = datasource?.color ?? null;
  const missing = keyMissing(tab);
  const readOnly = datasource?.readOnly === true;
  const editable = isKeyEditable(tab, readOnly);
  const result = tab.result;
  const store = useKeyTabs.getState;
  const edits: GridEdits | undefined =
    result === null || !editsRows(tab.details?.type ?? null)
      ? undefined
      : {
          buffer: tab.buffer,
          editing: tab.editing,
          begin: (text) => {
            const focus = result.selection?.focus;
            const column = focus === undefined ? undefined : visibleColumns(result.layout)[focus.column];
            if (focus === undefined || column === undefined) return;
            store().beginEdit(tabId, { row: focus.row, column }, text);
          },
          change: (text) => store().changeEdit(tabId, text),
          commit: () => store().commitEdit(tabId),
          cancel: () => store().cancelEdit(tabId),
          menu: TABLE_CELL_MENU,
        };
  const submitTools = (
    <>
      <ActionButton actionId={TABLE_ACTION_IDS.preview} compact />
      <ActionButton actionId={TABLE_ACTION_IDS.submit} compact />
      <span
        data-testid="tx-mode"
        className="min-w-0 truncate px-1 text-ink-muted"
        title={
          tab.revisionGuardAvailable === true
            ? `Submit writes only if the key is still at modified rev ${tab.merge?.snapshot.revision?.modRevision ?? tab.details?.revision?.modRevision ?? "0"}; otherwise you get to merge.`
            : SUBMIT_TEXT
        }
      >
        {tab.revisionGuardAvailable === true ? GUARDED_TEXT : SUBMIT_TEXT}
      </span>
    </>
  );
  const detailsTool = withDetails ? (
    <span className="ml-auto flex shrink-0 items-center">
      <ActionButton actionId={KEY_ACTION_IDS.details} compact pressed={detailsOpen} />
    </span>
  ) : null;
  const details =
    withDetails && detailsOpen && tab.details !== null ? <KeyDetailsPanel details={tab.details} tab={tab} /> : null;
  return (
    <div
      data-testid="key-tab"
      data-color={color ?? undefined}
      data-key-type={tab.details?.type ?? undefined}
      {...{ [REGION_ATTRIBUTE]: "tableEditor" }}
      className={cn("flex min-h-0 flex-1 flex-col", color !== null && `border-2 ${TINT_BORDER[color]}`)}
    >
      <KeyHeader tab={tab} datasourceName={datasource?.name ?? ""} onExpired={onExpired} />
      {missing ? (
        <MissingBanner tabId={tabId} tab={tab} canRecreate={!readOnly && tab.lostType !== null} />
      ) : (
        <KeyFilterBar tabId={tabId} tab={tab} />
      )}
      {tab.conflict === null || tab.merge != null ? null : (
        <ConflictBanner tabId={tabId} conflict={tab.conflict} revisionAware={tab.revisionGuardAvailable === true} />
      )}
      {tab.error === null ? null : (
        <div role="alert" data-testid="key-error" className={ERROR_CLASS}>
          {tab.error.message} <span className="text-ink-muted">{tab.error.hint}</span>
        </div>
      )}
      {tab.queryError === null ? null : (
        <div role="alert" data-testid="query-error" className={ERROR_CLASS}>
          {tab.queryError.message} <span className="text-ink-muted">{tab.queryError.hint}</span>
        </div>
      )}
      {tab.readOnly === null ? null : (
        <div
          role="status"
          data-testid="read-only-banner"
          className="flex h-row shrink-0 items-center gap-1 border-b border-line bg-panel px-gap text-ink-muted"
        >
          <ReadOnlyIcon aria-hidden className="size-icon" />
          <span className="truncate" title={tab.readOnly}>
            Read-only: {tab.readOnly}
          </span>
        </div>
      )}
      {tab.merge?.visible === true ? (
        <div className="flex min-h-0 flex-1">
          <KeyMergeView tab={tab} tabId={tabId} editable={editable} />
          {details}
        </div>
      ) : result !== null ? (
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <ResultGrid
              ownerId={tabId}
              result={result}
              host={useKeyTabs.getState}
              edits={edits}
              staleText={STALE_TEXT}
              panel={(focus) => <KeyPanel tabId={tabId} tab={tab} editable={editable} focus={focus} />}
              toolbar={
                <>
                  <span className="mx-1 h-4 w-px shrink-0 bg-line" />
                  <ActionButton actionId={KEY_ACTION_IDS.reload} compact />
                  {edits === undefined ? null : (
                    <>
                      <span className="mx-1 h-4 w-px shrink-0 bg-line" />
                      <ActionButton actionId={TABLE_ACTION_IDS.addRow} compact />
                      <ActionButton actionId={TABLE_ACTION_IDS.deleteRows} compact />
                      <ActionButton actionId={TABLE_ACTION_IDS.revertSelected} compact />
                      {submitTools}
                    </>
                  )}
                  {withDetails ? (
                    <>
                      <span className="mx-1 h-4 w-px shrink-0 bg-line" />
                      <ActionButton actionId={KEY_ACTION_IDS.details} compact pressed={detailsOpen} />
                    </>
                  ) : null}
                </>
              }
            />
          </div>
          {details}
        </div>
      ) : tab.value !== null || tab.historyAvailable === true ? (
        <>
          {tab.details?.type === "string" && !missing ? (
            <div className="flex h-row shrink-0 items-center gap-1 border-b border-line bg-panel px-gap">
              <ActionButton actionId={KEY_ACTION_IDS.reload} compact />
              <span className="mx-1 h-4 w-px shrink-0 bg-line" />
              <ActionButton actionId={TABLE_ACTION_IDS.revertAll} compact />
              {submitTools}
              {detailsTool}
            </div>
          ) : null}
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              {tab.historyAvailable ? (
                <div
                  className="flex h-row shrink-0 items-center gap-1 border-b border-line bg-canvas px-gap"
                  role="group"
                  aria-label="Key view"
                >
                  <button
                    type="button"
                    aria-pressed={tab.history?.mode !== "history"}
                    className="rounded px-gap text-ink-muted hover:bg-raised aria-pressed:bg-selection aria-pressed:text-ink"
                    onClick={() => {
                      if (tab.history?.mode === "history") void invoke(KEY_ACTION_IDS.history);
                    }}
                  >
                    Value
                  </button>
                  <button
                    type="button"
                    aria-pressed={tab.history?.mode === "history"}
                    className="rounded px-gap text-ink-muted hover:bg-raised aria-pressed:bg-selection aria-pressed:text-ink"
                    onClick={() => {
                      if (tab.history?.mode !== "history") void invoke(KEY_ACTION_IDS.history);
                    }}
                  >
                    History
                  </button>
                </div>
              ) : null}
              <div className={cn("min-h-0 flex-1 flex-col", tab.history?.mode === "history" ? "hidden" : "flex")}>
                <StringValueEditor tab={tab} tabId={tabId} format={format} editable={editable} />
              </div>
              {tab.history?.mode === "history" ? <KeyHistoryView tab={tab} /> : null}
            </div>
            {details}
          </div>
        </>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-gap text-ink-muted">
          <p>{tab.details === null ? "Reading the key…" : missing ? "No value to show." : ""}</p>
          <ActionButton actionId={KEY_ACTION_IDS.reload} />
        </div>
      )}
      <Footer tab={tab} />
    </div>
  );
}
