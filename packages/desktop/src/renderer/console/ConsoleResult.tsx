import { useEffect } from "react";
import { currentPlatform, formatChord } from "@table-craft/desktop/renderer/actions/chords.js";
import { registry } from "@table-craft/desktop/renderer/actions/index.js";
import { KEY_ACTION_IDS } from "@table-craft/desktop/renderer/actions/keyActions.js";
import { TABLE_ACTION_IDS } from "@table-craft/desktop/renderer/actions/tableActions.js";
import { CommandValuePanel } from "@table-craft/desktop/renderer/console/CommandValuePanel.js";
import { ResultGrid, type GridEdits } from "@table-craft/desktop/renderer/grid/ResultGrid.js";
import { ValueEditor, ValuePanel } from "@table-craft/desktop/renderer/grid/ValuePanel.js";
import { visibleColumns } from "@table-craft/desktop/renderer/model/columnLayout.js";
import { bufferRowAt, pendingCount, pendingText } from "@table-craft/desktop/renderer/model/editBuffer.js";
import { canEditCell, editCellText } from "@table-craft/desktop/renderer/model/resultEdits.js";
import { jsonOwnerKey } from "@table-craft/desktop/renderer/model/jsonView.js";
import { formatPattern } from "@table-craft/desktop/renderer/model/valueFormats.js";
import {
  consoleReadOnlyReason,
  editsOf,
  editTargetOf,
  isConsoleEditable,
  type ConsoleResultEdits,
} from "@table-craft/desktop/renderer/state/consoleEdits.js";
import { useConsoles, type ConsoleSession } from "@table-craft/desktop/renderer/state/consoles.js";
import { capabilitiesOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useKeys } from "@table-craft/desktop/renderer/state/keys.js";
import { useLayout } from "@table-craft/desktop/renderer/state/layout.js";
import { rowAt, shownHeld, type ResultTab } from "@table-craft/desktop/renderer/state/resultTab.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { ReadOnlyIcon } from "@table-craft/desktop/renderer/ui/icons.js";

/** The cell menu of an editable console result: the table editor's edit commands (plan 026). */
export const CONSOLE_CELL_MENU: readonly (string | null)[] = [
  TABLE_ACTION_IDS.editCell,
  TABLE_ACTION_IDS.setNull,
  TABLE_ACTION_IDS.setDefault,
  null,
  TABLE_ACTION_IDS.addRow,
  TABLE_ACTION_IDS.duplicateRow,
  TABLE_ACTION_IDS.deleteRows,
  TABLE_ACTION_IDS.revertSelected,
];

function shortcutText(actionId: string): string {
  const shortcut = registry.get(actionId)?.shortcut;
  return shortcut === undefined ? "" : formatChord(shortcut, currentPlatform());
}

function EditablePanel({
  consoleId,
  result,
  edits,
  editable,
  focus,
}: {
  readonly consoleId: string;
  readonly result: ResultTab;
  readonly edits: ConsoleResultEdits;
  readonly editable: boolean;
  readonly focus: { readonly row: number; readonly column: number } | null;
}) {
  const column = focus === null ? null : (result.columns[focus.column] ?? null);
  if (focus === null) return <ValuePanel column={column} value={undefined} />;
  const target = editTargetOf(result, edits);
  const jsonOwner = jsonOwnerKey(consoleId, result.handle);
  if (editable && canEditCell(target, focus)) {
    const text = editCellText(target, focus);
    const draft = edits.panel?.row === focus.row && edits.panel.column === focus.column ? edits.panel : null;
    return (
      <ValueEditor
        key={`${String(focus.row)}:${String(focus.column)}:${text}`}
        column={column}
        text={draft?.text ?? text}
        json={result.typeClasses[focus.column] === "json"}
        jsonOwner={jsonOwner}
        applyHint={shortcutText(TABLE_ACTION_IDS.applyValue)}
        onChange={(next) => useConsoles.getState().editPanel(consoleId, result.id, focus, next)}
      />
    );
  }
  const row = bufferRowAt(edits.buffer, shownHeld(result), focus.row);
  const value = row?.kind === "held" ? rowAt(result.windows, focus.row)?.[focus.column] : null;
  return <ValuePanel column={column} value={value} jsonOwner={jsonOwner} />;
}

function EditToolbar({ edits, editable }: { readonly edits: ConsoleResultEdits; readonly editable: boolean }) {
  const reason = consoleReadOnlyReason(edits);
  if (reason !== null) {
    return (
      // The reason is a sentence the toolbar truncated mid-word; it lives in the tooltip (plan 130 decision 10).
      <span
        role="status"
        data-testid="result-read-only"
        title={`Read-only: ${reason}`}
        aria-label={`Read-only: ${reason}`}
        className="flex shrink-0 items-center gap-1 px-1 text-ink-muted"
      >
        <span className="mx-1 h-4 w-px shrink-0 bg-line" />
        <ReadOnlyIcon aria-hidden className="size-icon shrink-0" />
        <span>Read-only</span>
      </span>
    );
  }
  if (!editable && edits.editable === null) return null;
  const pending = pendingText(pendingCount(edits.buffer));
  return (
    <>
      <span className="mx-1 h-4 w-px shrink-0 bg-line" />
      <ActionButton actionId={TABLE_ACTION_IDS.addRow} compact />
      <ActionButton actionId={TABLE_ACTION_IDS.duplicateRow} compact />
      <ActionButton actionId={TABLE_ACTION_IDS.deleteRows} compact />
      <ActionButton actionId={TABLE_ACTION_IDS.revertSelected} compact />
      <ActionButton actionId={TABLE_ACTION_IDS.preview} compact />
      <ActionButton actionId={TABLE_ACTION_IDS.submit} compact />
      {pending === null ? null : (
        <span data-testid="pending-changes" className="shrink-0 px-1 text-ink">
          {pending}
        </span>
      )}
    </>
  );
}

/** Whether the console's datasource holds keys, so its results read values as the key tab does (decision 119). */
function useKeyValue(datasourceId: string): boolean {
  return useDatasources((state) => {
    const datasource = state.datasources.find((candidate) => candidate.id === datasourceId);
    return datasource !== undefined && capabilitiesOf(state.plugins, datasource.pluginId).includes("keyValue");
  });
}

/**
 * A console's row result: the grid, editable like the table editor's when the engine says the
 * statement reads one table by its key (plan 026), or one whole key (decision 119), else read-only
 * with the reason in its toolbar.
 */
export function ConsoleResult({
  consoleId,
  session,
  result,
}: {
  readonly consoleId: string;
  readonly session: ConsoleSession;
  readonly result: ResultTab;
}) {
  const checkEditable = useConsoles((state) => state.checkEditable);
  const { handle, stale } = result;
  const resultId = result.id;
  useEffect(() => {
    if (!stale) void checkEditable(consoleId, resultId);
  }, [checkEditable, consoleId, resultId, handle, stale]);

  const edits = editsOf(session, result);
  const editable = isConsoleEditable(session, result);
  const store = useConsoles.getState;
  const keyValue = useKeyValue(session.datasourceId);
  const delimiter = useKeys((state) => state.keyspaces[session.datasourceId]?.delimiter ?? "");
  const pattern = result.source === undefined ? null : formatPattern(result.source.key.text, delimiter);
  const remembered = useLayout((state) => (pattern === null ? undefined : state.layout.valueFormats[pattern]));
  const format = remembered ?? result.valueFormat ?? "auto";
  const gridEdits: GridEdits | undefined =
    edits === null || !("identity" in (edits.editable ?? {}))
      ? undefined
      : {
          buffer: edits.buffer,
          editing: edits.editing,
          begin: (text) => {
            const focus = result.selection?.focus;
            const column = focus === undefined ? undefined : visibleColumns(result.layout)[focus.column];
            if (focus === undefined || column === undefined) return;
            store().beginEdit(consoleId, resultId, { row: focus.row, column }, text);
          },
          change: (text) => store().changeEdit(consoleId, resultId, text),
          commit: () => void store().commitEdit(consoleId, resultId),
          cancel: () => store().cancelEdit(consoleId, resultId),
          menu: CONSOLE_CELL_MENU,
          readOnlyColumns: edits.readOnlyColumns,
        };

  return (
    <>
      {edits?.error == null ? null : (
        <div
          role="alert"
          data-testid="result-edit-error"
          className="shrink-0 border-b border-line bg-panel px-gap py-1 break-words text-danger"
        >
          {edits.error.message} <span className="text-ink-muted">{edits.error.hint}</span>
        </div>
      )}
      <ResultGrid
        ownerId={consoleId}
        result={result}
        host={useConsoles.getState}
        edits={gridEdits}
        toolbar={
          edits === null && result.source === undefined ? undefined : (
            <>
              {result.source === undefined ? null : (
                <>
                  <span className="mx-1 h-4 w-px shrink-0 bg-line" />
                  <ActionButton actionId={KEY_ACTION_IDS.openFromResult} compact />
                </>
              )}
              {edits === null ? null : <EditToolbar edits={edits} editable={editable} />}
            </>
          )
        }
        panel={
          keyValue
            ? (focus) => (
                <CommandValuePanel
                  key={focus === null ? "none" : `${String(focus.row)}:${String(focus.column)}`}
                  consoleId={consoleId}
                  result={result}
                  edits={gridEdits === undefined ? null : edits}
                  editable={editable}
                  format={format}
                  focus={focus}
                />
              )
            : gridEdits === undefined || edits === null
              ? undefined
              : (focus) => (
                  <EditablePanel
                    consoleId={consoleId}
                    result={result}
                    edits={edits}
                    editable={editable}
                    focus={focus}
                  />
                )
        }
      />
    </>
  );
}
