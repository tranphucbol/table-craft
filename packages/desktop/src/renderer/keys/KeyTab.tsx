import { ACTION_IDS } from "@table-craft/desktop/renderer/actions/appActions.js";
import { REGION_ATTRIBUTE } from "@table-craft/desktop/renderer/actions/context.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { formatPatternOf, KEY_ACTION_IDS } from "@table-craft/desktop/renderer/actions/keyActions.js";
import { useConsoleDatasource } from "@table-craft/desktop/renderer/console/useConsoleDatasource.js";
import { ResultGrid } from "@table-craft/desktop/renderer/grid/ResultGrid.js";
import { ValuePanel } from "@table-craft/desktop/renderer/grid/ValuePanel.js";
import { KeyFilterBar } from "@table-craft/desktop/renderer/keys/KeyFilterBar.js";
import { KeyHeader } from "@table-craft/desktop/renderer/keys/KeyHeader.js";
import { StringValueEditor } from "@table-craft/desktop/renderer/keys/StringValueEditor.js";
import { formatCount } from "@table-craft/desktop/renderer/model/format.js";
import { keyMissing, useKeyTabs, type KeyTab as KeyTabState } from "@table-craft/desktop/renderer/state/keyTabs.js";
import { useLayout } from "@table-craft/desktop/renderer/state/layout.js";
import { rowAt } from "@table-craft/desktop/renderer/state/resultTab.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { ReadOnlyIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { TINT_BORDER } from "@table-craft/desktop/renderer/ui/tint.js";

const STATUS_TEXT = {
  connecting: "Connecting…",
  loading: "Loading…",
  ready: "",
  failed: "",
  disconnected: "Disconnected; Reload reconnects.",
} as const;

const STALE_TEXT = "The connection closed; Reload reads the key again.";
const ERROR_CLASS = "shrink-0 border-b border-line bg-panel px-gap py-1 break-words text-danger";

function KeyPanel({
  tab,
  focus,
}: {
  readonly tab: KeyTabState;
  readonly focus: { readonly row: number; readonly column: number } | null;
}) {
  const result = tab.result;
  const column = focus === null ? null : (result?.columns[focus.column] ?? null);
  const pattern = formatPatternOf(tab);
  const format = useLayout((state) => (pattern === null ? undefined : state.layout.valueFormats[pattern])) ?? "auto";
  const value = result === null || focus === null ? undefined : rowAt(result.windows, focus.row)?.[focus.column];
  return (
    <ValuePanel
      column={column}
      value={value}
      format={{ format, onChange: (next) => void invoke(KEY_ACTION_IDS.valueFormat, { format: next }) }}
    />
  );
}

function MissingBanner({ tabId, name }: { readonly tabId: string; readonly name: string }) {
  return (
    <div
      role="status"
      data-testid="key-missing"
      className="flex h-row shrink-0 items-center gap-gap border-b border-line bg-panel px-gap text-ink-muted"
    >
      <span className="truncate">
        <code className="font-mono text-ink">{name}</code> no longer exists
      </span>
      <button
        type="button"
        className="ml-auto shrink-0 rounded px-cell hover:bg-raised hover:text-ink"
        onClick={() => void invoke(ACTION_IDS.closeTab, { tabId })}
      >
        Close
      </button>
    </div>
  );
}

function Footer({ tab }: { readonly tab: KeyTabState }) {
  const rows = tab.result?.rowCount;
  return (
    <div className="flex h-row shrink-0 items-center gap-gap border-t border-line bg-panel px-gap text-ink-muted">
      {rows === undefined ? null : (
        <span data-testid="row-count">
          {formatCount(rows)}
          {tab.result?.complete === false ? "+" : ""} {rows === 1 ? "row" : "rows"}
        </span>
      )}
      <span className="truncate">{STATUS_TEXT[tab.status]}</span>
    </div>
  );
}

/** A key's tab (plan 058 decision 14): its header, its filter, and its rows or its string value. */
export function KeyTab({ tabId }: { readonly tabId: string }) {
  const tab = useKeyTabs((state) => state.tabs[tabId]);
  const datasource = useConsoleDatasource(tabId);
  const pattern = tab === undefined ? null : formatPatternOf(tab);
  const format = useLayout((state) => (pattern === null ? undefined : state.layout.valueFormats[pattern])) ?? "auto";
  if (tab === undefined) return null;
  const color = datasource?.color ?? null;
  const missing = keyMissing(tab);
  return (
    <div
      data-testid="key-tab"
      data-color={color ?? undefined}
      data-key-type={tab.details?.type ?? undefined}
      {...{ [REGION_ATTRIBUTE]: "tableEditor" }}
      className={cn("flex min-h-0 flex-1 flex-col", color !== null && `border-2 ${TINT_BORDER[color]}`)}
    >
      <KeyHeader tab={tab} datasourceName={datasource?.name ?? ""} />
      {missing ? <MissingBanner tabId={tabId} name={tab.key.text} /> : <KeyFilterBar tabId={tabId} tab={tab} />}
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
          <span className="truncate">Read-only: {tab.readOnly}</span>
        </div>
      )}
      {tab.result !== null ? (
        <ResultGrid
          ownerId={tabId}
          result={tab.result}
          host={useKeyTabs.getState}
          staleText={STALE_TEXT}
          panel={(focus) => <KeyPanel tab={tab} focus={focus} />}
          toolbar={
            <>
              <span className="mx-1 h-4 w-px shrink-0 bg-line" />
              <ActionButton actionId={KEY_ACTION_IDS.reload} compact />
            </>
          }
        />
      ) : tab.value !== null ? (
        <StringValueEditor tab={tab} format={format} />
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
