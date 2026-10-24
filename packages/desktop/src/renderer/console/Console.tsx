import { ACTION_IDS } from "@table-craft/desktop/renderer/actions/appActions.js";
import { ERROR_ACTION_IDS } from "@table-craft/desktop/renderer/actions/errorActions.js";
import { EXPLAIN_ACTION_IDS } from "@table-craft/desktop/renderer/actions/explainActions.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { LOG_ACTION_IDS } from "@table-craft/desktop/renderer/actions/logActions.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { Editor } from "@table-craft/desktop/renderer/console/Editor.js";
import { NamespaceSwitcher } from "@table-craft/desktop/renderer/console/NamespaceSwitcher.js";
import { ResultTabs } from "@table-craft/desktop/renderer/console/ResultTabs.js";
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
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { ReadOnlyIcon, WarningIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { TINT_BORDER } from "@table-craft/desktop/renderer/ui/tint.js";

const STATUS_TEXT = {
  connecting: "Connecting…",
  running: "Running…",
  confirming: "Waiting for confirmation…",
  ready: "",
  failed: "",
  disconnected: "Disconnected; Run reconnects.",
} as const;

const ASKING_TEXT = "Waiting on the failed statement…";

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
  if (session === undefined) return null;
  const { status } = session;
  // While the run asks about a failure, the banner shows it; the toolbar has no room for both.
  const error = session.question === null ? session.error : null;
  const capabilities = plugin?.capabilities ?? [];
  const color = datasource?.color ?? null;

  return (
    <div data-testid="console" data-color={color ?? undefined} className="flex min-h-0 flex-1 flex-col">
      <div
        role="toolbar"
        aria-label="Console toolbar"
        className="flex items-center gap-gap border-b border-line bg-panel p-gap"
      >
        <ActionButton actionId={ACTION_IDS.run} primary />
        <ActionButton actionId={ACTION_IDS.runAll} />
        {capabilities.includes("explain") ? <ActionButton actionId={EXPLAIN_ACTION_IDS.explain} compact /> : null}
        {capabilities.includes("explainAnalyze") ? (
          <ActionButton actionId={EXPLAIN_ACTION_IDS.explainAnalyze} compact tone="warning" />
        ) : null}
        {capabilities.includes("cancel") ? <ActionButton actionId={ACTION_IDS.cancel} /> : null}
        {capabilities.includes("transactions") ? <TxControls session={session} /> : null}
        <span className="shrink-0 text-ink-muted">{session.question === null ? STATUS_TEXT[status] : ASKING_TEXT}</span>
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
        {datasource === undefined && session.datasourceId === DETACHED ? (
          <span data-testid="console-datasource" className="ml-auto shrink-0 text-ink-muted">
            No data source; Run asks for one.
          </span>
        ) : null}
        {datasource === undefined ? null : (
          // The datasource and plugin names give up their width first, the namespace last: it is what
          // changes under the console, and a long error beside it once squeezed it out of sight
          // (plan 022). A namespace longer than the whole toolbar's room still ends in an ellipsis.
          <span
            data-testid="console-datasource"
            className="ml-auto flex min-w-0 items-center overflow-hidden whitespace-pre text-ink-muted"
          >
            {datasource.readOnly ? <ReadOnlyIcon aria-hidden className="mr-1 size-icon shrink-0" /> : null}
            <span className="min-w-0 shrink-first truncate">
              {datasource.readOnly ? "read-only · " : ""}
              {datasource.name}
            </span>
            {capabilities.includes("currentNamespace") ? (
              <span className="flex min-w-0 items-center">
                {" · "}
                <NamespaceSwitcher consoleId={consoleId} session={session} />
              </span>
            ) : null}
            {plugin === undefined ? null : (
              <span className="min-w-0 shrink-first overflow-hidden text-ellipsis">{` · ${plugin.name}`}</span>
            )}
          </span>
        )}
      </div>
      {session.diskChanged === null ? null : <DiskChangedBanner change={session.diskChanged} />}
      <div
        className={cn(
          "min-h-0 flex-1 basis-1/2 overflow-hidden border-b border-line",
          color !== null && `border-2 ${TINT_BORDER[color]}`,
        )}
      >
        <Editor consoleId={consoleId} />
      </div>
      {session.question === null ? null : <ErrorQuestionBanner question={session.question} />}
      <ResultTabs consoleId={consoleId} session={session} />
    </div>
  );
}
