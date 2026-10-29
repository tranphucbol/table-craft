import { currentPlatform, formatChord } from "@table-craft/desktop/renderer/actions/chords.js";
import { REGION_ATTRIBUTE } from "@table-craft/desktop/renderer/actions/context.js";
import { invoke, registry } from "@table-craft/desktop/renderer/actions/index.js";
import { TABLE_ACTION_IDS, TABLE_CELL_MENU } from "@table-craft/desktop/renderer/actions/tableActions.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { useConsoleDatasource } from "@table-craft/desktop/renderer/console/useConsoleDatasource.js";
import { ResultGrid, type GridEdits } from "@table-craft/desktop/renderer/grid/ResultGrid.js";
import { ValueEditor, ValuePanel } from "@table-craft/desktop/renderer/grid/ValuePanel.js";
import { visibleColumns } from "@table-craft/desktop/renderer/model/columnLayout.js";
import { bufferRowAt, pendingCount, pendingText } from "@table-craft/desktop/renderer/model/editBuffer.js";
import { formatCount } from "@table-craft/desktop/renderer/model/format.js";
import { jsonOwnerKey } from "@table-craft/desktop/renderer/model/jsonView.js";
import { pluginOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { rowAt, shownHeld } from "@table-craft/desktop/renderer/state/resultTab.js";
import {
  cellText,
  isEditable,
  readOnlyReason,
  refusedBars,
  useTables,
  type TableSession,
} from "@table-craft/desktop/renderer/state/tables.js";
import { FilterBar } from "@table-craft/desktop/renderer/table/FilterBar.js";
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

const STALE_TEXT = "The connection closed; Reload reads the rows again.";
const WHERE_PLACEHOLDER = "e.g. id > 10";
const ORDER_BY_PLACEHOLDER = "e.g. name DESC";
/** Plan 008 decision 17: the editor always submits in one transaction of its own. */
const TX_TEXT = "Tx: Auto";

function shortcutText(actionId: string): string {
  const shortcut = registry.get(actionId)?.shortcut;
  return shortcut === undefined ? "" : formatChord(shortcut, currentPlatform());
}

function TablePanel({
  tableId,
  session,
  focus,
}: {
  readonly tableId: string;
  readonly session: TableSession;
  readonly focus: { readonly row: number; readonly column: number } | null;
}) {
  const result = session.result;
  const column = focus === null ? null : (result?.columns[focus.column] ?? null);
  if (result === null || focus === null) return <ValuePanel column={column} value={undefined} />;
  const jsonOwner = jsonOwnerKey(tableId, result.handle);
  const row = bufferRowAt(session.buffer, shownHeld(result), focus.row);
  const typeClass = result.typeClasses[focus.column];
  const deleted = row?.kind === "held" && session.buffer.deletes.has(row.row);
  if (isEditable(session) && row !== null && !deleted && typeClass !== "bytes") {
    const text = cellText(session, focus);
    const draft = session.panel?.row === focus.row && session.panel.column === focus.column ? session.panel : null;
    return (
      <ValueEditor
        key={`${String(focus.row)}:${String(focus.column)}:${text}`}
        column={column}
        text={draft?.text ?? text}
        json={typeClass === "json"}
        jsonOwner={jsonOwner}
        applyHint={shortcutText(TABLE_ACTION_IDS.applyValue)}
        onChange={(next) => useTables.getState().editPanel(tableId, focus, next)}
      />
    );
  }
  const value = row?.kind === "held" ? rowAt(result.windows, focus.row)?.[focus.column] : null;
  return <ValuePanel column={column} value={value} jsonOwner={jsonOwner} />;
}

function Footer({ session }: { readonly session: TableSession }) {
  const pending = pendingText(pendingCount(session.buffer));
  return (
    <div className="flex h-row shrink-0 items-center gap-gap border-t border-line bg-panel px-gap text-ink-muted">
      {pending === null ? null : (
        <span data-testid="pending-changes" className="text-ink">
          {pending}
        </span>
      )}
      {session.count === null ? null : (
        <span data-testid="row-count">
          {formatCount(session.count)} {session.count === 1 ? "row" : "rows"}
        </span>
      )}
      {session.notice === null ? null : <span data-testid="table-notice">{session.notice}</span>}
      <span className="truncate">{STATUS_TEXT[session.status]}</span>
    </div>
  );
}

/** A table tab: the WHERE and ORDER BY bars, the editable grid and its pending changes (plan 008). */
export function TableEditor({ tableId }: { readonly tableId: string }) {
  const session = useTables((state) => state.tables[tableId]);
  const datasource = useConsoleDatasource(tableId);
  const plugin = useDatasources((state) => pluginOf(state.plugins, datasource?.pluginId ?? ""));
  if (session === undefined) return null;
  const { result, error, queryError } = session;
  const refused = refusedBars(session);
  const color = datasource?.color ?? null;
  const reason = readOnlyReason(session);
  const store = useTables.getState;
  const scope = { path: session.path, relation: session.relation };

  const edits: GridEdits | undefined =
    result === null
      ? undefined
      : {
          buffer: session.buffer,
          editing: session.editing,
          begin: (text) => {
            const focus = result.selection?.focus;
            const column = focus === undefined ? undefined : visibleColumns(result.layout)[focus.column];
            if (focus === undefined || column === undefined) return;
            store().beginEdit(tableId, { row: focus.row, column }, text);
          },
          change: (text) => store().changeEdit(tableId, text),
          commit: () => store().commitEdit(tableId),
          cancel: () => store().cancelEdit(tableId),
          menu: TABLE_CELL_MENU,
        };

  return (
    <div
      data-testid="table-editor"
      data-color={color ?? undefined}
      {...{ [REGION_ATTRIBUTE]: "tableEditor" }}
      className={cn("flex min-h-0 flex-1 flex-col", color !== null && `border-2 ${TINT_BORDER[color]}`)}
    >
      <div className="flex shrink-0 items-center gap-gap border-b border-line bg-panel p-gap">
        <FilterBar
          label="WHERE"
          value={session.draft.where}
          placeholderText={WHERE_PLACEHOLDER}
          highlight={plugin?.highlight}
          datasourceId={session.datasourceId}
          scope={scope}
          invalid={refused.where}
          onChange={(where) => store().setDraft(tableId, { where })}
          onApply={() => invoke(TABLE_ACTION_IDS.reload)}
          onRevert={() => invoke(TABLE_ACTION_IDS.revertFilter)}
        />
        <FilterBar
          label="ORDER BY"
          value={session.draft.orderBy}
          placeholderText={ORDER_BY_PLACEHOLDER}
          highlight={plugin?.highlight}
          datasourceId={session.datasourceId}
          scope={scope}
          invalid={refused.orderBy}
          onChange={(orderBy) => store().setDraft(tableId, { orderBy })}
          onApply={() => invoke(TABLE_ACTION_IDS.reload)}
          onRevert={() => invoke(TABLE_ACTION_IDS.revertFilter)}
        />
        {datasource === undefined ? null : (
          <span className="flex shrink-0 items-center gap-1 text-ink-muted">
            {datasource.readOnly ? <ReadOnlyIcon aria-hidden className="size-icon" /> : null}
            {datasource.readOnly ? "read-only · " : ""}
            {datasource.name}
            {plugin === undefined ? "" : ` · ${plugin.name}`}
          </span>
        )}
      </div>
      {queryError === null ? null : (
        <div
          role="alert"
          data-testid="query-error"
          className="shrink-0 border-b border-line bg-panel px-gap py-1 break-words text-danger"
        >
          {queryError.message} <span className="text-ink-muted">{queryError.hint}</span>
        </div>
      )}
      {error === null ? null : (
        <div
          role="alert"
          data-testid="table-error"
          className="shrink-0 border-b border-line bg-panel px-gap py-1 break-words text-danger"
        >
          {error.message} <span className="text-ink-muted">{error.hint}</span>
        </div>
      )}
      {reason === null ? null : (
        <div
          role="status"
          data-testid="read-only-banner"
          className="flex h-row shrink-0 items-center gap-1 border-b border-line bg-panel px-gap text-ink-muted"
        >
          <ReadOnlyIcon aria-hidden className="size-icon" />
          <span className="truncate">Read-only: {reason}</span>
        </div>
      )}
      {result === null ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-gap text-ink-muted">
          <p>{session.status === "disconnected" || session.status === "failed" ? "No rows read." : "Reading rows…"}</p>
          <ActionButton actionId={TABLE_ACTION_IDS.reload} />
        </div>
      ) : (
        <ResultGrid
          ownerId={tableId}
          result={result}
          host={useTables.getState}
          edits={edits}
          serverSorted
          staleText={STALE_TEXT}
          panel={(focus) => <TablePanel tableId={tableId} session={session} focus={focus} />}
          toolbar={
            <>
              <span className="mx-1 h-4 w-px shrink-0 bg-line" />
              <ActionButton actionId={TABLE_ACTION_IDS.addRow} compact />
              <ActionButton actionId={TABLE_ACTION_IDS.duplicateRow} compact />
              <ActionButton actionId={TABLE_ACTION_IDS.deleteRows} compact />
              <ActionButton actionId={TABLE_ACTION_IDS.revertSelected} compact />
              <ActionButton actionId={TABLE_ACTION_IDS.preview} compact />
              <ActionButton actionId={TABLE_ACTION_IDS.submit} compact />
              <span data-testid="tx-mode" className="shrink-0 px-1 text-ink-muted">
                {TX_TEXT}
              </span>
              <span className="mx-1 h-4 w-px shrink-0 bg-line" />
              <ActionButton actionId={TABLE_ACTION_IDS.countRows} compact />
            </>
          }
        />
      )}
      <Footer session={session} />
    </div>
  );
}
