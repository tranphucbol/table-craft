import { useState } from "react";
import type { DiagramTable } from "@table-craft/desktop/renderer/model/diagram.js";
import { useDiagrams } from "@table-craft/desktop/renderer/state/diagrams.js";
import { FIELD_CLASS } from "@table-craft/desktop/renderer/ui/fieldClasses.js";
import { MENU_BUTTON_ITEM } from "@table-craft/desktop/renderer/ui/menu.js";
import { Popover, type PopoverAnchor } from "@table-craft/desktop/renderer/ui/Popover.js";
import {
  POPOVER_BODY,
  POPOVER_FOOTER,
  POPOVER_HEADER,
  POPOVER_PANEL,
} from "@table-craft/desktop/renderer/ui/popoverParts.js";
import { TEXT_PRESS } from "@table-craft/desktop/renderer/ui/pressClasses.js";

const FOOTER_BUTTON = `${TEXT_PRESS} h-row rounded border border-line px-gap text-ink hover:bg-hover`;

/**
 * Which tables the diagram draws (plan 152 decision 13): a filter, a check per table, and Show All /
 * Hide All over the tables the filter matches. A schema above the auto-show limit opens here.
 */
export function TablesPicker({
  diagramId,
  tables,
  hidden,
  anchor,
  onClose,
}: {
  readonly diagramId: string;
  readonly tables: readonly DiagramTable[];
  readonly hidden: readonly string[];
  readonly anchor: PopoverAnchor;
  readonly onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const hiddenSet = new Set(hidden);
  const needle = filter.trim().toLowerCase();
  const matching = tables.filter((table) => table.name.toLowerCase().includes(needle));
  const shownCount = tables.length - tables.filter((table) => hiddenSet.has(table.id)).length;
  const setHidden = (ids: readonly string[], hide: boolean) =>
    useDiagrams.getState().updateLayout(diagramId, (layout) => {
      const next = new Set(layout.hiddenTables);
      for (const id of ids) {
        if (hide) next.add(id);
        else next.delete(id);
      }
      return { ...layout, hiddenTables: [...next] };
    });
  const matchingIds = matching.map((table) => table.id);
  return (
    <Popover anchor={anchor} label="Diagram tables" testId="diagram-tables-picker" onClose={onClose}>
      <div className={POPOVER_PANEL}>
        <div className={POPOVER_HEADER}>
          <span>Tables</span>
          <span className="ml-auto font-normal text-ink-muted">
            {shownCount} of {tables.length} shown
          </span>
        </div>
        <div className={POPOVER_BODY}>
          <input
            aria-label="Filter tables"
            placeholder="Filter tables"
            className={FIELD_CLASS}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <ul aria-label="Tables" className="flex max-h-picker-list flex-col overflow-y-auto">
            {matching.map((table) => (
              <li key={table.id}>
                <label className={MENU_BUTTON_ITEM}>
                  <input
                    type="checkbox"
                    className="accent-accent"
                    checked={!hiddenSet.has(table.id)}
                    onChange={(event) => setHidden([table.id], !event.target.checked)}
                  />
                  <span className="truncate">{table.name}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
        <div className={POPOVER_FOOTER}>
          <button type="button" className={FOOTER_BUTTON} onClick={() => setHidden(matchingIds, false)}>
            Show All
          </button>
          <button type="button" className={FOOTER_BUTTON} onClick={() => setHidden(matchingIds, true)}>
            Hide All
          </button>
        </div>
      </div>
    </Popover>
  );
}
