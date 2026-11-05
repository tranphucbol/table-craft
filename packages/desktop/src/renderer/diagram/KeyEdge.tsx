import { useInternalNode, type Edge, type EdgeProps, type InternalNode } from "@xyflow/react";
import { memo } from "react";
import type { DiagramColumnMode } from "@table-craft/desktop/diagrams/state.js";
import type { DiagramEdge } from "@table-craft/desktop/renderer/model/diagram.js";
import { edgeGeometry, edgeMarkers, type DiagramSize } from "@table-craft/desktop/renderer/model/diagramLayout.js";
import type { TableFlowNode } from "@table-craft/desktop/renderer/diagram/TableNode.js";

export interface KeyEdgeData extends Record<string, unknown> {
  readonly edge: DiagramEdge;
  readonly mode: DiagramColumnMode;
  readonly rowHeight: number;
  readonly label: string;
  readonly selected: boolean;
}

export type KeyFlowEdge = Edge<KeyEdgeData, "key">;

function endOf(node: InternalNode<TableFlowNode>) {
  const size: DiagramSize = {
    width: node.width ?? node.measured.width ?? 0,
    height: node.height ?? node.measured.height ?? 0,
  };
  return { table: node.data.table, at: node.internals.positionAbsolute, size };
}

/**
 * A key between two column rows (plan 152 decision 11): the step path the export draws too, with a
 * crow's foot at the referencing end and a bar (and a ring when optional) at the referenced one.
 */
export const KeyEdge = memo(function KeyEdge({ id, source, target, data }: EdgeProps<KeyFlowEdge>) {
  const from = useInternalNode<TableFlowNode>(source);
  const to = useInternalNode<TableFlowNode>(target);
  if (from === undefined || to === undefined || data === undefined) return null;
  const geometry = edgeGeometry(data.edge, { source: endOf(from), target: endOf(to) }, data.mode, data.rowHeight);
  const markers = edgeMarkers(geometry, data.edge.optional);
  return (
    <g
      className="tc-diagram-edge"
      data-testid="diagram-edge"
      data-edge-id={id}
      data-edge-origin={data.edge.origin}
      data-selected={data.selected}
    >
      <title>{data.label}</title>
      <path className="tc-diagram-edge-hit" d={geometry.path} />
      <path className="tc-diagram-edge-line" d={geometry.path} />
      <path d={markers.lines} />
      {markers.ring !== null && (
        <circle className="tc-diagram-edge-ring" cx={markers.ring.cx} cy={markers.ring.cy} r={markers.ring.r} />
      )}
    </g>
  );
});
