import * as Primitive from "@radix-ui/react-popover";
import { useEffect, useState } from "react";
import type { SelectionAggregates } from "@table-craft/desktop/engine/protocol.js";
import { GRID_HELPER_ACTION_IDS, type AggregateArgs } from "@table-craft/desktop/renderer/actions/gridHelperActions.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import type { GridHost } from "@table-craft/desktop/renderer/grid/GridCells.js";
import {
  AGGREGATE_LABELS,
  aggregateParts,
  aggregateRequest,
  aggregateText,
} from "@table-craft/desktop/renderer/model/aggregates.js";
import type { ResultTab } from "@table-craft/desktop/renderer/state/resultTab.js";
import { useCellFormats, useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import { DropdownIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { SURFACE_MOTION } from "@table-craft/desktop/renderer/ui/motion.js";
import { AGGREGATE_NAMES } from "@table-craft/desktop/settings/settings.js";

/** Drag-selecting fires a selection per cell crossed; only the one the pointer rests on is added up. */
const AGGREGATE_DEBOUNCE_MS = 120;
const SIDE_OFFSET_PX = 4;

/**
 * The selection's Count, Distinct, Sum, Avg, Min and Max under the rows (plan 043), added up in the
 * engine; a click copies the line, the caret chooses which show.
 */
export function AggregateLine({
  ownerId,
  result,
  host,
}: {
  readonly ownerId: string;
  readonly result: ResultTab;
  readonly host: () => GridHost;
}) {
  const chosen = useSettings((state) => state.settings.data.aggregates);
  const formats = useCellFormats();
  const [answer, setAnswer] = useState<{ readonly key: string; readonly aggregates: SelectionAggregates | null }>();
  const request = aggregateRequest(result);
  const key = request === null ? null : JSON.stringify(request);
  const aggregates = answer !== undefined && answer.key === key ? answer.aggregates : null;

  useEffect(() => {
    if (request === null || key === null) return;
    let current = true;
    const timer = setTimeout(() => {
      void host()
        .aggregate(ownerId, result.id, request.rows, request.columns)
        .then((answered) => {
          if (current) setAnswer({ key, aggregates: answered });
        });
    }, AGGREGATE_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // The request is keyed by its text; a new object with the same ranges asks nothing new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, host, ownerId, result.id, result.rowCount, result.sort, result.view]);

  if (request === null) return null;
  const parts = aggregates === null ? [] : aggregateParts(aggregates, chosen, formats);
  return (
    <div
      role="status"
      aria-label="Selection aggregates"
      data-testid="aggregate-line"
      className="flex h-row shrink-0 items-center gap-1 border-t border-line bg-panel px-gap text-ui text-ink-muted"
    >
      <button
        type="button"
        title="Copy"
        data-testid="aggregate-copy"
        className="flex min-w-0 cursor-default items-center gap-gap truncate rounded px-1 hover:bg-selection"
        onClick={() => invoke(GRID_HELPER_ACTION_IDS.copyAggregates)}
        aria-label={aggregateText(parts)}
      >
        {parts.map((part) => (
          <span key={part.name} data-aggregate={part.name} className="whitespace-nowrap">
            {part.label}: <span className="text-ink">{part.text}</span>
          </span>
        ))}
      </button>
      <div className="flex-1" />
      <Primitive.Root>
        <Primitive.Trigger
          aria-label="Choose aggregates"
          className="flex size-row items-center justify-center rounded hover:bg-selection"
        >
          <DropdownIcon aria-hidden className="size-icon" />
        </Primitive.Trigger>
        <Primitive.Portal>
          <Primitive.Content
            side="top"
            align="end"
            sideOffset={SIDE_OFFSET_PX}
            aria-label="Shown aggregates"
            className={`z-50 flex flex-col rounded border border-line bg-raised p-1 text-ui text-ink shadow-lg outline-none ${SURFACE_MOTION}`}
          >
            {AGGREGATE_NAMES.map((name) => {
              const args: AggregateArgs = { name };
              return (
                <label key={name} className="flex h-row cursor-default items-center gap-gap rounded px-gap">
                  <input
                    type="checkbox"
                    checked={chosen.includes(name)}
                    onChange={() => invoke(GRID_HELPER_ACTION_IDS.toggleAggregate, args)}
                  />
                  {AGGREGATE_LABELS[name]}
                </label>
              );
            })}
          </Primitive.Content>
        </Primitive.Portal>
      </Primitive.Root>
    </div>
  );
}
