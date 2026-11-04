import { Handle, Position, useStore, type Node, type NodeProps, type ReactFlowState } from "@xyflow/react";
import { memo } from "react";
import type { DiagramColumnMode } from "@table-craft/desktop/diagrams/state.js";
import { showsTypes, type DiagramTable } from "@table-craft/desktop/renderer/model/diagram.js";
import { DIAGRAM_DETAIL_ZOOM, tableRows } from "@table-craft/desktop/renderer/model/diagramLayout.js";
import {
  ExternalTableIcon,
  KeyIcon,
  MaterializedViewIcon,
  TableIcon,
  ViewIcon,
} from "@table-craft/desktop/renderer/ui/icons.js";

export interface TableNodeData extends Record<string, unknown> {
  readonly table: DiagramTable;
  readonly mode: DiagramColumnMode;
  readonly selected: boolean;
}

export type TableFlowNode = Node<TableNodeData, "table">;

const KIND_ICONS = {
  table: TableIcon,
  view: ViewIcon,
  materializedView: MaterializedViewIcon,
  external: ExternalTableIcon,
} as const satisfies Record<DiagramTable["kind"], unknown>;

const KIND_LABELS: Readonly<Record<DiagramTable["kind"], string>> = {
  table: "table",
  view: "view",
  materializedView: "materialized view",
  external: "table in another namespace",
};

const detailedAt = (state: ReactFlowState) => state.transform[2] >= DIAGRAM_DETAIL_ZOOM;

/**
 * One table: a header, then a row per shown column with its key marker and type. Edges compute their
 * own ends from the shared geometry, so the node carries one hidden handle per side for React Flow.
 */
export const TableNode = memo(function TableNode({ data }: NodeProps<TableFlowNode>) {
  const { table, mode, selected } = data;
  const detailed = useStore(detailedAt);
  const KindIcon = KIND_ICONS[table.kind];
  const types = showsTypes(mode);
  return (
    <div
      className="tc-diagram-table"
      data-testid="diagram-table"
      data-table={table.id}
      data-kind={table.kind}
      data-selected={selected}
      style={{ width: "100%", height: "100%" }}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
      <div className="tc-diagram-header" title={`${table.name} (${KIND_LABELS[table.kind]})`}>
        <KindIcon aria-label={KIND_LABELS[table.kind]} className="tc-diagram-icon" />
        <span>{table.name}</span>
      </div>
      {detailed &&
        tableRows(table, mode).map((column) => (
          <div key={column.name} className="tc-diagram-row" data-column={column.name}>
            {column.primaryKey || column.foreignKey ? (
              <KeyIcon
                aria-label={column.primaryKey ? "primary key" : "foreign key"}
                weight={column.primaryKey ? "fill" : "regular"}
                className="tc-diagram-icon"
                data-marker={column.primaryKey ? "primary" : "foreign"}
              />
            ) : (
              <span aria-hidden className="tc-diagram-icon" />
            )}
            <span className="tc-diagram-column">{column.name}</span>
            {types && <span className="tc-diagram-type">{column.type}</span>}
          </div>
        ))}
    </div>
  );
});
