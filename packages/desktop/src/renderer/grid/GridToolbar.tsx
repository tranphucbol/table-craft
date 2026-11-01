import type { ReactNode } from "react";
import { EXTRACTOR_KINDS, type ExtractorKind } from "@table-craft/desktop/engine/protocol.js";
import {
  copyBlockedReason,
  EXTRACTOR_LABELS,
  GRID_ACTION_IDS,
} from "@table-craft/desktop/renderer/actions/gridActions.js";
import { GRID_HELPER_ACTION_IDS } from "@table-craft/desktop/renderer/actions/gridHelperActions.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { EXPORT_ACTION_IDS } from "@table-craft/desktop/renderer/actions/exportActions.js";
import { exportRowsText } from "@table-craft/desktop/renderer/model/exportText.js";
import { resultStateText } from "@table-craft/desktop/renderer/model/format.js";
import { isRunning, useExports } from "@table-craft/desktop/renderer/state/exports.js";
import type { ResultTab } from "@table-craft/desktop/renderer/state/resultTab.js";
import { useLayout } from "@table-craft/desktop/renderer/state/layout.js";
import { Clock } from "@table-craft/desktop/renderer/ui/Clock.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { Dropdown } from "@table-craft/desktop/renderer/ui/Dropdown.js";
import { SpinnerIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { TEXT_PRESS } from "@table-craft/desktop/renderer/ui/pressClasses.js";

const EXTRACTOR_OPTIONS = EXTRACTOR_KINDS.map((kind) => ({ value: kind, label: EXTRACTOR_LABELS[kind] }));

const FETCHING_TEXT: Readonly<Record<NonNullable<ResultTab["fetching"]>, string>> = {
  page: "Fetching…",
  all: "Fetching all…",
  export: "Exporting…",
};

function isExtractor(value: string): value is ExtractorKind {
  return (EXTRACTOR_KINDS as readonly string[]).includes(value);
}

/**
 * The export draining this result's cursor: its rows, clock and a Cancel that frees the grid. Until
 * the start's answer names the task, only `Exporting…`.
 */
function DrainingExport({ handle }: { readonly handle: string }) {
  const task = useExports(
    (state) => state.entries.find((entry) => isRunning(entry) && entry.task.drains === handle)?.task ?? null,
  );
  const cancelling = useExports((state) => task !== null && state.cancelling.has(task.taskId));
  return (
    <span data-testid="result-exporting" className="flex shrink-0 items-center gap-1.5 text-ink">
      <SpinnerIcon aria-hidden className="size-icon animate-spin text-accent" />
      {task === null ? (
        FETCHING_TEXT.export
      ) : (
        <>
          <span className="whitespace-pre">
            {cancelling ? "Cancelling export · " : "Exporting "}
            {exportRowsText(task.rows)}
            {" · "}
            <Clock startedAt={task.startedAt} />
          </span>
          <button
            type="button"
            data-testid="result-exporting-cancel"
            disabled={cancelling}
            className={cn(
              "flex h-row shrink-0 items-center rounded border border-line px-gap text-ink hover:bg-raised disabled:opacity-50",
              TEXT_PRESS,
            )}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => invoke(EXPORT_ACTION_IDS.cancel, { taskId: task.taskId })}
          >
            Cancel
          </button>
        </>
      )}
    </span>
  );
}

/**
 * Above the rows, in DataGrip's order: fetch and rerun, the owner's buttons, the row count, then
 * extract and view. `serverSorted` results order in the database, so their count never says sorted.
 */
export function GridToolbar({
  result,
  serverSorted = false,
  children,
}: {
  readonly result: ResultTab;
  readonly serverSorted?: boolean;
  readonly children?: ReactNode;
}) {
  const extractor = useLayout((state) => state.layout.extractor);
  const valuePanel = useLayout((state) => state.layout.valuePanel);
  const fetching = result.fetching === "page" || result.fetching === "all";
  return (
    <div
      role="toolbar"
      aria-label="Result"
      className="flex h-row shrink-0 items-center gap-1 border-b border-line bg-panel px-1"
    >
      <ActionButton actionId={GRID_ACTION_IDS.fetchNextPage} compact />
      <ActionButton actionId={GRID_ACTION_IDS.fetchAll} compact />
      <ActionButton actionId={GRID_ACTION_IDS.rerun} compact />
      {fetching ? <ActionButton actionId={GRID_ACTION_IDS.cancelFetch} compact /> : null}
      {children}
      <span data-testid="result-state" className="ml-gap truncate text-ink-muted">
        {resultStateText({
          rowCount: result.rowCount,
          complete: result.complete,
          cursorOpen: result.cursorOpen,
          sorted: !serverSorted && result.sort.length > 0,
          fetchAllCap: result.paging.fetchAllCap,
          shown: result.view?.filtered === true ? result.view.shown : null,
          exportEnded: result.exportEnded ?? null,
          pagedByConsole: result.pagedByConsole === true,
        })}
      </span>
      {result.fetching === null ? null : result.fetching === "export" ? (
        <DrainingExport handle={result.handle} />
      ) : (
        <span className="flex items-center gap-1 text-ink-muted">
          <SpinnerIcon aria-hidden className="size-icon animate-spin" />
          {FETCHING_TEXT[result.fetching]}
        </span>
      )}
      <div className="flex-1" />
      <ActionButton actionId={GRID_ACTION_IDS.find} compact pressed={result.search.open} />
      <ActionButton
        actionId={GRID_ACTION_IDS.filterRows}
        compact
        pressed={result.search.open && result.search.rowsOnly}
      />
      <Dropdown
        label="Extractor"
        variant="inline"
        value={extractor}
        options={EXTRACTOR_OPTIONS}
        onChange={(chosen) => {
          if (isExtractor(chosen)) invoke(GRID_ACTION_IDS.setExtractor, { extractor: chosen });
        }}
      />
      <ActionButton actionId={GRID_ACTION_IDS.copy} compact reason={copyBlockedReason(result)} />
      <ActionButton actionId={GRID_ACTION_IDS.export} compact />
      <ActionButton actionId={GRID_HELPER_ACTION_IDS.transpose} compact pressed={result.layout.transposed === true} />
      <ActionButton actionId={GRID_ACTION_IDS.toggleValuePanel} compact pressed={valuePanel} />
    </div>
  );
}
