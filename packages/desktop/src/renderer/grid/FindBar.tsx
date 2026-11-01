import { useEffect, useRef, useState } from "react";
import { REGION_ATTRIBUTE } from "@table-craft/desktop/renderer/actions/context.js";
import { chipLabel, GRID_ACTION_IDS } from "@table-craft/desktop/renderer/actions/gridActions.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import type { GridHost } from "@table-craft/desktop/renderer/grid/ResultGrid.js";
import { findStatusText, searchedScopeText, type ResultTab } from "@table-craft/desktop/renderer/state/resultTab.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { CloseIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { OptionToggle } from "@table-craft/desktop/renderer/ui/OptionToggle.js";

/** Typing waits this long before the engine searches, so a word costs one pass, not one per key. */
const TYPING_SETTLE_MS = 120;
const BAR = "flex h-row shrink-0 items-center gap-1 border-b border-line bg-panel px-1";

/**
 * The grid's find bar (plan 023): the query, its options, the match count, next and previous, and
 * "Filter rows". The engine searches the fetched rows; when the cursor holds more, the bar says so
 * and offers to fetch the rest. Enter, ⇧Enter and Escape are actions in the `gridFind` region.
 */
export function FindBar({
  ownerId,
  result,
  host,
}: {
  readonly ownerId: string;
  readonly result: ResultTab;
  readonly host: () => GridHost;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(result.search.query.text);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { query, rowsOnly, focusRequest } = result.search;

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusRequest]);

  useEffect(
    () => () => {
      if (pending.current !== null) clearTimeout(pending.current);
    },
    [],
  );

  function send(next: string): void {
    if (pending.current !== null) clearTimeout(pending.current);
    pending.current = null;
    void host().search(ownerId, result.id, (search) => ({ ...search, query: { ...search.query, text: next } }));
  }

  function type(next: string): void {
    setText(next);
    if (pending.current !== null) clearTimeout(pending.current);
    pending.current = setTimeout(() => send(next), TYPING_SETTLE_MS);
  }

  const status = findStatusText(result);
  const scope = text === "" ? null : searchedScopeText(result);
  return (
    <div
      role="search"
      aria-label="Find in result"
      {...{ [REGION_ATTRIBUTE]: "gridFind" }}
      className={cn(BAR, "flex-wrap")}
    >
      <input
        ref={input}
        type="search"
        aria-label="Find"
        data-testid="find-input"
        spellCheck={false}
        placeholder="Find in fetched rows"
        className="h-row w-60 min-w-0 border border-line bg-canvas px-cell font-grid text-grid text-ink outline-none focus:border-accent"
        value={text}
        onChange={(event) => type(event.target.value)}
        onKeyDown={(event) => {
          // Enter before the query settled: search now; the keymap's Find Next then has matches to step.
          if (event.key === "Enter" && pending.current !== null) send(text);
        }}
      />
      <OptionToggle actionId={GRID_ACTION_IDS.findMatchCase} label="Cc" pressed={query.caseSensitive} />
      <OptionToggle actionId={GRID_ACTION_IDS.findRegex} label=".*" pressed={query.regex} />
      <OptionToggle actionId={GRID_ACTION_IDS.findWholeCell} label="W" pressed={query.wholeCell} />
      <span
        data-testid="find-status"
        role="status"
        className={cn("ml-1 truncate", result.view?.error == null ? "text-ink-muted" : "text-danger")}
      >
        {status}
      </span>
      <ActionButton actionId={GRID_ACTION_IDS.findPrevious} compact />
      <ActionButton actionId={GRID_ACTION_IDS.findNext} compact />
      <ActionButton actionId={GRID_ACTION_IDS.filterRows} compact pressed={rowsOnly} />
      {scope === null ? null : (
        <span data-testid="find-scope" className="ml-gap flex items-center gap-1 truncate text-ink-muted">
          {scope}
          <ActionButton actionId={GRID_ACTION_IDS.searchAll} />
        </span>
      )}
      <div className="flex-1" />
      <ActionButton actionId={GRID_ACTION_IDS.closeFind} compact />
    </div>
  );
}

/**
 * The local filter's chips (plan 023): each removable, with Clear. `local` says so beside a table's
 * WHERE bar, which filters on the server.
 */
export function FilterChips({ result, local }: { readonly result: ResultTab; readonly local: boolean }) {
  return (
    <div role="group" aria-label="Local filter" data-testid="filter-chips" className={cn(BAR, "flex-wrap")}>
      <span className="text-ink-muted">{local ? "Local filter (fetched rows):" : "Filter:"}</span>
      {result.search.filters.map((chip, index) => {
        const label = chipLabel(result, chip);
        return (
          <span
            key={`${String(index)}:${label}`}
            data-testid="filter-chip"
            className="flex h-row max-w-80 items-center gap-1 border border-line bg-raised pl-cell"
          >
            <span className="truncate font-grid text-grid">{label}</span>
            <button
              type="button"
              aria-label={`Remove ${label}`}
              className="flex h-row items-center px-1 text-ink-muted hover:bg-selection hover:text-ink"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => invoke(GRID_ACTION_IDS.removeFilter, { index })}
            >
              <CloseIcon aria-hidden className="size-icon" />
            </button>
          </span>
        );
      })}
      <button
        type="button"
        className="ml-1 text-accent"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => invoke(GRID_ACTION_IDS.clearFilters)}
      >
        Clear
      </button>
    </div>
  );
}
