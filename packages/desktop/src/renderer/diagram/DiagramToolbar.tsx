import { useMemo, useState } from "react";
import { DIAGRAM_COLUMN_MODES, type DiagramColumnMode } from "@table-craft/desktop/diagrams/state.js";
import { DIAGRAM_ACTION_IDS } from "@table-craft/desktop/renderer/actions/diagramActions.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { TablesPicker } from "@table-craft/desktop/renderer/diagram/TablesPicker.js";
import { EDGE_ORIGINS, type DiagramTable, type EdgeOrigin } from "@table-craft/desktop/renderer/model/diagram.js";
import { useDiagrams } from "@table-craft/desktop/renderer/state/diagrams.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { Dropdown } from "@table-craft/desktop/renderer/ui/Dropdown.js";
import { ToolbarDivider } from "@table-craft/desktop/renderer/ui/ToolbarDivider.js";

const COLUMN_MODE_LABELS: Readonly<Record<DiagramColumnMode, string>> = {
  all: "All Columns",
  keys: "Keys Only",
  names: "Names Only",
};
const COLUMN_OPTIONS = DIAGRAM_COLUMN_MODES.map((mode) => ({ value: mode, label: COLUMN_MODE_LABELS[mode] }));

const ORIGIN_LABELS: Readonly<Record<EdgeOrigin, string>> = {
  declared: "Declared",
  inferred: "Inferred",
  virtual: "Virtual",
};

/** The three edge styles, drawn with the same classes as the edges, so the legend follows the theme too. */
function Legend() {
  return (
    <span data-testid="diagram-legend" className="flex shrink-0 items-center gap-gap">
      {EDGE_ORIGINS.map((origin) => (
        <span key={origin} className="flex items-center gap-1">
          <svg aria-hidden className="tc-diagram-legend-swatch" viewBox="0 0 24 12" preserveAspectRatio="none">
            <g className="tc-diagram-edge" data-edge-origin={origin}>
              <line className="tc-diagram-edge-line" x1="0" y1="6" x2="24" y2="6" />
            </g>
          </svg>
          {ORIGIN_LABELS[origin]}
        </span>
      ))}
    </span>
  );
}

export function DiagramToolbar({
  diagramId,
  mode,
  inferKeys,
  pickerOpen,
  tables,
  hidden,
  status,
}: {
  readonly diagramId: string;
  readonly mode: DiagramColumnMode;
  readonly inferKeys: boolean;
  readonly pickerOpen: boolean;
  /** The namespace's own tables, which the picker lists. */
  readonly tables: readonly DiagramTable[];
  readonly hidden: readonly string[];
  readonly status: string;
}) {
  const [anchorElement, setAnchorElement] = useState<HTMLElement | null>(null);
  const anchor = useMemo(() => {
    if (!pickerOpen || anchorElement === null) return null;
    const { left, top, right, bottom } = anchorElement.getBoundingClientRect();
    return { left, top, right, bottom };
  }, [pickerOpen, anchorElement]);
  return (
    <div
      data-testid="diagram-toolbar"
      className="flex h-tab shrink-0 items-center gap-gap border-b border-line bg-panel px-gap text-ink-muted"
    >
      <ActionButton actionId={DIAGRAM_ACTION_IDS.refresh} compact />
      <ActionButton actionId={DIAGRAM_ACTION_IDS.fit} compact />
      <ActionButton actionId={DIAGRAM_ACTION_IDS.zoomIn} compact />
      <ActionButton actionId={DIAGRAM_ACTION_IDS.zoomOut} compact />
      <ActionButton actionId={DIAGRAM_ACTION_IDS.relayout} compact />
      <ToolbarDivider />
      <Dropdown
        label="Diagram columns"
        testId="diagram-columns"
        variant="inline"
        value={mode}
        options={COLUMN_OPTIONS}
        onChange={(value) => invoke(DIAGRAM_ACTION_IDS.columns, { mode: value })}
      />
      <ActionButton actionId={DIAGRAM_ACTION_IDS.toggleInferred} compact pressed={inferKeys} />
      <span ref={setAnchorElement} className="flex">
        <ActionButton actionId={DIAGRAM_ACTION_IDS.tables} compact expanded={pickerOpen} />
      </span>
      <ToolbarDivider />
      <Legend />
      <span data-testid="diagram-status" className="ml-auto truncate">
        {status}
      </span>
      {anchor === null ? null : (
        <TablesPicker
          diagramId={diagramId}
          tables={tables}
          hidden={hidden}
          anchor={anchor}
          onClose={() => useDiagrams.getState().setPickerOpen(diagramId, false)}
        />
      )}
    </div>
  );
}
