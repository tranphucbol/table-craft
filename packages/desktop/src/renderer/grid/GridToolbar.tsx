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
import { resultStateText } from "@table-craft/desktop/renderer/model/format.js";
import type { ResultTab } from "@table-craft/desktop/renderer/state/resultTab.js";
import { useLayout } from "@table-craft/desktop/renderer/state/layout.js";
import { Dropdown } from "@table-craft/desktop/renderer/ui/Dropdown.js";
import { SpinnerIcon } from "@table-craft/desktop/renderer/ui/icons.js";

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
        })}
      </span>
      {result.fetching === null ? null : (
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
