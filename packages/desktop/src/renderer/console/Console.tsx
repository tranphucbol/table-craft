import { Group, Panel, type Layout } from "react-resizable-panels";
import { useEffect } from "react";
import { useCommandTxn } from "./transaction/store.js";
import { TransactionBuilder } from "./transaction/TransactionBuilder.js";
import { COMMAND_TXN_ACTION_IDS } from "@table-craft/desktop/renderer/actions/commandTxnActions.js";
import { ACTION_IDS } from "@table-craft/desktop/renderer/actions/appActions.js";
import { ERROR_ACTION_IDS } from "@table-craft/desktop/renderer/actions/errorActions.js";
import { EXPLAIN_ACTION_IDS } from "@table-craft/desktop/renderer/actions/explainActions.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { LOG_ACTION_IDS } from "@table-craft/desktop/renderer/actions/logActions.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { Editor } from "@table-craft/desktop/renderer/console/Editor.js";
import { NamespaceSwitcher } from "@table-craft/desktop/renderer/console/NamespaceSwitcher.js";
import { ResultTabs } from "@table-craft/desktop/renderer/console/ResultTabs.js";
import { RunOnPicker } from "@table-craft/desktop/renderer/console/RunOnPicker.js";
import { TxControls } from "@table-craft/desktop/renderer/console/TxControls.js";
import { useConsoleDatasource } from "@table-craft/desktop/renderer/console/useConsoleDatasource.js";
import { FILE_ACTION_IDS } from "@table-craft/desktop/renderer/actions/fileActions.js";
import { markOfError } from "@table-craft/desktop/renderer/model/errorLocation.js";
import {
  DETACHED,
  useConsoles,
  type DiskChange,
  type ErrorQuestion,
} from "@table-craft/desktop/renderer/state/consoles.js";
import { pluginOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { MIN_CONSOLE_PANE_PERCENT, useLayout } from "@table-craft/desktop/renderer/state/layout.js";
import { groupOf, useTabs } from "@table-craft/desktop/renderer/state/tabs.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { Handle } from "@table-craft/desktop/renderer/ui/Handle.js";
import { DatabaseIcon, ReadOnlyIcon, SchemaIcon, WarningIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { ToolbarDivider } from "@table-craft/desktop/renderer/ui/ToolbarDivider.js";
import { HISTORY_ACTION_IDS } from "@table-craft/desktop/renderer/actions/historyActions.js";
import { TINT_BORDER } from "@table-craft/desktop/renderer/ui/tint.js";
import { useSnippetsDialog } from "@table-craft/desktop/renderer/state/snippetsDialog.js";
import { SNIPPET_ACTION_IDS } from "@table-craft/desktop/renderer/actions/snippetActions.js";

/** Panel ids are also the DOM ids and test ids the library sets, so they must not clash with the Shell's `editor`. */
const EDITOR_PANEL = "console-editor";
const RESULTS_PANEL = "console-results";
const MIN_PANE_SIZE = String(MIN_CONSOLE_PANE_PERCENT);
/** The library's panels scroll by default; the editor and the result tabs scroll themselves. */
const PANEL_STYLE = { overflow: "hidden" } as const;

/** Only a drag is remembered; the sizes the library settles on at mount or a window resize are not. */
function persistConsoleEditor(layout: Layout, meta: { readonly isUserInteraction: boolean }, panelId: string): void {
  const size = layout[panelId];
  if (meta.isUserInteraction && size !== undefined) useLayout.getState().resizeConsoleEditor(size);
}

/** Running says nothing: Run's spinner and the title bar's elapsed time already do (plan 127 decision 4). */
const STATUS_TEXT = {
  connecting: "Connecting…",
  running: "",
  confirming: "Waiting for confirmation…",
  ready: "",
  failed: "",
  disconnected: "Disconnected; Run reconnects.",
} as const;

const ASKING_TEXT = "Waiting on the failed statement…";
/** Redis runs one command at a time; only a blocking one can be stopped (decision 22 of plan 058). */
const COMMAND_CANCEL_HINT = "Cancel stops blocking commands only";

const DISK_CHANGE_TEXT = {
  changed: "The file changed on disk.",
  deleted: "The file was deleted on disk; Save writes it again.",
} as const satisfies Record<DiskChange, string>;

/** A file console's edits and its file parted ways (plan 041 decision 6). */
function DiskChangedBanner({ change }: { readonly change: DiskChange }) {
  return (
    <div
      role="alert"
      data-testid="disk-changed"
      data-change={change}
      className="flex items-center gap-gap border-b border-line bg-panel px-gap py-1"
    >
      <WarningIcon aria-hidden weight="fill" className="size-icon shrink-0 text-warning" />
      <span className="min-w-0 flex-1 truncate">{DISK_CHANGE_TEXT[change]}</span>
      {change === "changed" ? (
        <button
          type="button"
          className="shrink-0 text-accent hover:underline"
          onClick={() => void invoke(FILE_ACTION_IDS.reload)}
        >
          Reload
        </button>
      ) : null}
      <button
        type="button"
        className="shrink-0 text-accent hover:underline"
        onClick={() => void invoke(FILE_ACTION_IDS.keepMine)}
      >
        Keep mine
      </button>
    </div>
  );
}

const ERROR_ANSWER_BUTTONS = [
  { actionId: ERROR_ACTION_IDS.skip, label: "Skip" },
  { actionId: ERROR_ACTION_IDS.skipAll, label: "Skip All" },
  { actionId: ERROR_ACTION_IDS.stop, label: "Stop" },
  { actionId: ERROR_ACTION_IDS.retry, label: "Retry" },
] as const;

/** A run of several statements waits here on the one that failed (decision 083). */
function ErrorQuestionBanner({ question }: { readonly question: ErrorQuestion }) {
  return (
    <div
      role="alert"
      data-testid="error-question"
      className="flex items-center gap-gap border-b border-line bg-panel px-gap py-1"
    >
      <WarningIcon aria-hidden weight="fill" className="size-icon shrink-0 text-danger" />
      <span className="min-w-0 flex-1 truncate" title={`${question.sql}\n${question.error.message}`}>
        {`Statement ${question.number} of ${question.total} failed: `}
        <span className="text-danger">{question.error.message}</span>
      </span>
      {ERROR_ANSWER_BUTTONS.map(({ actionId, label }) => (
        <button
          key={actionId}
          type="button"
          className="shrink-0 text-accent hover:underline"
          onClick={() => void invoke(actionId)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** One console tab: its toolbar, its SQL editor, and its Output and result tabs. */
export function Console({ consoleId }: { readonly consoleId: string }) {
  const session = useConsoles((state) => state.consoles[consoleId]);
  const datasource = useConsoleDatasource(consoleId);
  const plugin = useDatasources((state) => pluginOf(state.plugins, datasource?.pluginId ?? ""));
  const notice = useSnippetsDialog((state) => state.notice);
  const editorSize = useLayout((state) => state.layout.consoleEditor);
  const split = useTabs(
    (state) => state.tabs.some((tab) => groupOf(tab) === "left") && state.tabs.some((tab) => groupOf(tab) === "right"),
  );
  const editorPanelId = split ? `${EDITOR_PANEL}-${consoleId}` : EDITOR_PANEL;
  const resultsPanelId = split ? `${RESULTS_PANEL}-${consoleId}` : RESULTS_PANEL;
  const txnSupported = useCommandTxn((state) =>
    session === undefined ? false : state.supported[session.datasourceId] === true,
  );
  const txnOpen = useCommandTxn((state) => state.drafts[consoleId]?.open === true);
  const txnDatasourceId = session?.datasourceId;
  const commandCapable = plugin?.capabilities.includes("commands") === true;
  useEffect(() => {
    if (txnDatasourceId !== undefined && commandCapable) void useCommandTxn.getState().probe(txnDatasourceId);
  }, [txnDatasourceId, commandCapable]);
  if (session === undefined) return null;
  const { status } = session;
  // While the run asks about a failure, the banner shows it; the toolbar has no room for both.
  const error = session.question === null ? session.error : null;
  const capabilities = plugin?.capabilities ?? [];
  const color = datasource?.color ?? null;
  const statusText = session.question === null ? STATUS_TEXT[status] : ASKING_TEXT;

  return (
    <div data-testid="console" data-color={color ?? undefined} className="flex min-h-0 flex-1 flex-col">
      <div
        role="toolbar"
        aria-label="Console toolbar"
        className="flex shrink-0 items-center gap-gap overflow-x-auto border-b border-line bg-panel px-gap py-1"
      >
        <div className="flex shrink-0 items-center gap-1">
          <ActionButton actionId={ACTION_IDS.run} compact tone="success" />
          <ActionButton actionId={ACTION_IDS.runAll} compact />
          {capabilities.includes("explain") ? <ActionButton actionId={EXPLAIN_ACTION_IDS.explain} compact /> : null}
          {capabilities.includes("explainAnalyze") ? (
            <ActionButton actionId={EXPLAIN_ACTION_IDS.explainAnalyze} compact tone="warning" />
          ) : null}
          {capabilities.includes("cancel") ? (
            <ActionButton
              actionId={ACTION_IDS.cancel}
              compact
              tone="danger"
              hint={capabilities.includes("commands") ? COMMAND_CANCEL_HINT : undefined}
            />
          ) : null}
        </div>
        <ToolbarDivider />
        <div className="flex shrink-0 items-center gap-1">
          <ActionButton actionId={HISTORY_ACTION_IDS.show} compact />
          {capabilities.includes("sql") ? <ActionButton actionId={ACTION_IDS.reformat} compact /> : null}
        </div>
        {capabilities.includes("transactions") ? (
          <>
            <ToolbarDivider />
            <TxControls session={session} />
          </>
        ) : null}
        {txnSupported ? <ActionButton actionId={COMMAND_TXN_ACTION_IDS.toggle} pressed={txnOpen} /> : null}
        {statusText === "" ? null : <span className="shrink-0 text-ink-muted">{statusText}</span>}
        {error === null ? null : (
          // The room the datasource label leaves, but never none; Output holds the whole error.
          <span
            role="alert"
            className="min-w-16 flex-1 basis-0 truncate text-danger"
            title={`${error.message} ${error.hint}`}
          >
            {error.message} <span className="text-ink-muted">{error.hint}</span>
          </span>
        )}
        {error === null ? null : (
          <button
            type="button"
            className="shrink-0 text-accent hover:underline"
            onClick={() => void invoke(LOG_ACTION_IDS.showFor, { requestId: null, message: error.message })}
          >
            Show in Log
          </button>
        )}
        {markOfError(session.errorMarks, error) === null ? null : (
          <button
            type="button"
            className="shrink-0 text-accent hover:underline"
            onClick={() => void invoke(ERROR_ACTION_IDS.show)}
          >
            Go to Error
          </button>
        )}
        <div className="ml-auto flex min-w-0 items-center gap-gap">
          {capabilities.includes("nodes") ? <RunOnPicker session={session} /> : null}
          {datasource === undefined && session.datasourceId === DETACHED ? (
            <span data-testid="console-datasource" className="shrink-0 text-ink-muted">
              No data source; Run asks for one.
            </span>
          ) : null}
          {datasource === undefined ? null : (
            // The datasource name gives up its width first, the namespace last: it is what changes
            // under the console, and a long error beside it once squeezed it out of sight (plan 022).
            // A namespace longer than the whole toolbar's room still ends in an ellipsis.
            <span
              data-testid="console-datasource"
              className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-pre text-ink-muted"
            >
              {capabilities.includes("currentNamespace") ? (
                <span className="flex min-w-0 items-center">
                  <SchemaIcon aria-hidden className="size-icon shrink-0" />
                  <NamespaceSwitcher consoleId={consoleId} session={session} />
                </span>
              ) : null}
              <span
                title={datasource.readOnly ? `${datasource.name} (read-only)` : datasource.name}
                className="flex min-w-0 shrink-first items-center gap-1 px-1"
              >
                {datasource.readOnly ? (
                  <ReadOnlyIcon aria-label="read-only" className="size-icon shrink-0" />
                ) : (
                  <DatabaseIcon aria-hidden className="size-icon shrink-0" />
                )}
                <span className="min-w-0 truncate">{datasource.name}</span>
              </span>
            </span>
          )}
        </div>
      </div>
      {session.diskChanged === null ? null : <DiskChangedBanner change={session.diskChanged} />}
      <Group
        orientation="vertical"
        className="min-h-0 flex-1"
        onLayoutChanged={(layout, meta) => persistConsoleEditor(layout, meta, editorPanelId)}
      >
        <Panel
          id={editorPanelId}
          data-testid={EDITOR_PANEL}
          defaultSize={String(editorSize)}
          minSize={MIN_PANE_SIZE}
          className="flex flex-col"
          style={PANEL_STYLE}
        >
          <TransactionBuilder consoleId={consoleId} />
          <div className={cn("min-h-0 flex-1 overflow-hidden", color !== null && `border-2 ${TINT_BORDER[color]}`)}>
            <Editor consoleId={consoleId} />
          </div>
          {notice?.consoleId === consoleId ? (
            <div role="status" className="flex shrink-0 items-center gap-gap bg-success px-gap py-cell text-accent-ink">
              <span className="min-w-0 flex-1">
                ✓ Snippet “{notice.snippet.name}” created. Type{" "}
                <code className="font-editor">{notice.snippet.prefix}</code> to use it.
              </span>
              <button
                type="button"
                className="shrink-0 hover:underline"
                onClick={() => invoke(SNIPPET_ACTION_IDS.openCreated)}
              >
                Open Snippets
              </button>
            </div>
          ) : null}
        </Panel>
        <Handle axis="horizontal" />
        <Panel
          id={resultsPanelId}
          data-testid={RESULTS_PANEL}
          minSize={MIN_PANE_SIZE}
          className="flex flex-col"
          style={PANEL_STYLE}
        >
          {session.question === null ? null : <ErrorQuestionBanner question={session.question} />}
          <ResultTabs consoleId={consoleId} session={session} />
        </Panel>
      </Group>
    </div>
  );
}
