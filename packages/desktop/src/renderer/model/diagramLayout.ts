import { getSmoothStepPath, Position } from "@xyflow/react";
import type { ElkExtendedEdge, ElkNode, ElkPort } from "elkjs/lib/elk-api.js";
import type { DiagramColumnMode, DiagramPosition } from "@table-craft/desktop/diagrams/state.js";
import {
  showsTypes,
  visibleColumns,
  type DiagramEdge,
  type DiagramGraph,
  type DiagramTable,
} from "@table-craft/desktop/renderer/model/diagram.js";

export type Positions = Readonly<Record<string, DiagramPosition>>;

export interface DiagramSize {
  readonly width: number;
  readonly height: number;
}
export type Sizes = ReadonlyMap<string, DiagramSize>;

/** Which font a measured text is drawn in: headers in the UI font, columns in the grid font (decision 17). */
export type DiagramFont = "ui" | "grid";

/** What sizes a table: the density's row height and padding, and a text measure for the current fonts. */
export interface DiagramMetrics {
  readonly rowHeight: number;
  readonly padding: number;
  /** The glyph box a key marker or kind icon takes. */
  readonly icon: number;
  readonly measure: (text: string, font: DiagramFont) => number;
}

/** Tables new since the last save sit this far right of the saved ones (plan 152 phase 1). */
export const DIAGRAM_NEW_TABLES_GAP_PX = 120;
/** Between ELK's layers, wide enough for a step path's bends and a crow's foot at each end. */
export const DIAGRAM_LAYER_GAP_PX = 96;
export const DIAGRAM_NODE_GAP_PX = 40;
/** How far a step path runs straight out of a table before it bends. */
export const DIAGRAM_EDGE_OFFSET_PX = 24;
export const DIAGRAM_EDGE_RADIUS_PX = 6;
/** The length of a crow's foot, bar and ring along the edge. */
export const DIAGRAM_MARKER_PX = 12;
export const DIAGRAM_MIN_TABLE_WIDTH_PX = 120;
/** Below this zoom a table draws its header alone, at full size, which keeps 500 tables smooth. */
export const DIAGRAM_DETAIL_ZOOM = 0.45;

/** The rows a table draws: none for a ghost, which is header-only (decision 15). */
export function tableRows(table: DiagramTable, mode: DiagramColumnMode): DiagramTable["columns"] {
  return table.kind === "external" ? [] : visibleColumns(table, mode);
}

/** One table's box: the header and one row per shown column, as wide as its widest line. */
export function tableSize(table: DiagramTable, mode: DiagramColumnMode, metrics: DiagramMetrics): DiagramSize {
  const rows = tableRows(table, mode);
  const types = showsTypes(mode);
  const header = metrics.icon + metrics.padding + metrics.measure(table.name, "ui");
  const widest = rows.reduce((width, column) => {
    const type = types ? metrics.padding * 2 + metrics.measure(column.type, "grid") : 0;
    return Math.max(width, metrics.icon + metrics.padding + metrics.measure(column.name, "grid") + type);
  }, header);
  return {
    width: Math.max(DIAGRAM_MIN_TABLE_WIDTH_PX, Math.ceil(widest + metrics.padding * 2)),
    height: metrics.rowHeight * (rows.length + 1),
  };
}

export function tableSizes(tables: readonly DiagramTable[], mode: DiagramColumnMode, metrics: DiagramMetrics): Sizes {
  return new Map(tables.map((table) => [table.id, tableSize(table, mode, metrics)]));
}

/** The y of a row's middle inside its table, the header being row −1; a column not shown answers the header. */
export function rowMiddle(table: DiagramTable, column: string | undefined, mode: DiagramColumnMode, rowHeight: number) {
  const index = column === undefined ? -1 : tableRows(table, mode).findIndex((row) => row.name === column);
  return rowHeight * (index + 1) + rowHeight / 2;
}

function portId(table: string, column: string): string {
  return JSON.stringify([table, column]);
}

/**
 * The ELK input for a graph (plan 152 decision 11): `layered`, left to right, each keyed column a port
 * on the side its edges leave (east) or arrive (west) at its row's height, in row order, so the layout
 * minimises crossings between columns rather than table centres.
 */
export function elkGraph(
  graph: DiagramGraph,
  sizes: Sizes,
  mode: DiagramColumnMode,
  rowHeight: number,
): ElkNode & { readonly children: ElkNode[]; readonly edges: ElkExtendedEdge[] } {
  const ends = new Map<string, "EAST" | "WEST">();
  for (const edge of graph.edges) {
    const from = edge.from.columns[0];
    const to = edge.to.columns[0];
    if (from !== undefined) ends.set(portId(edge.source, from), "EAST");
    if (to !== undefined && !ends.has(portId(edge.target, to))) ends.set(portId(edge.target, to), "WEST");
  }
  const portsOf = new Map<string, Set<string>>();
  const children = graph.tables.map((table): ElkNode => {
    const size = sizes.get(table.id) ?? { width: DIAGRAM_MIN_TABLE_WIDTH_PX, height: rowHeight };
    const ports: ElkPort[] = [];
    for (const column of tableRows(table, mode)) {
      const id = portId(table.id, column.name);
      const side = ends.get(id);
      if (side === undefined) continue;
      ports.push({
        id,
        x: side === "EAST" ? size.width : 0,
        y: rowMiddle(table, column.name, mode, rowHeight),
        width: 0,
        height: 0,
        layoutOptions: { "elk.port.side": side },
      });
    }
    portsOf.set(table.id, new Set(ports.map((port) => port.id)));
    return {
      id: table.id,
      width: size.width,
      height: size.height,
      ports,
      layoutOptions: { "elk.portConstraints": "FIXED_ORDER" },
    };
  });
  const endpoint = (table: string, column: string | undefined): string => {
    if (column === undefined) return table;
    const id = portId(table, column);
    return portsOf.get(table)?.has(id) === true ? id : table;
  };
  const edges = graph.edges.map((edge): ElkExtendedEdge => ({
    id: edge.id,
    sources: [endpoint(edge.source, edge.from.columns[0])],
    targets: [endpoint(edge.target, edge.to.columns[0])],
  }));
  return {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": String(DIAGRAM_LAYER_GAP_PX),
      "elk.spacing.nodeNode": String(DIAGRAM_NODE_GAP_PX),
      "elk.spacing.componentComponent": String(DIAGRAM_NODE_GAP_PX),
    },
    children,
    edges,
  };
}

/** The top-left corner ELK gave each table. */
export function positionsOf(laidOut: ElkNode): Positions {
  return Object.fromEntries(
    (laidOut.children ?? []).map((child) => [child.id, { x: Math.round(child.x ?? 0), y: Math.round(child.y ?? 0) }]),
  );
}

/**
 * Keeps every saved position and places the tables without one (decision 9): `laidOut` holds them laid
 * out among themselves, shifted as a block to the right of the saved tables' bounds, top-aligned with them.
 */
export function placeNew(saved: Positions, laidOut: Positions, sizes: Sizes): Positions {
  const savedIds = Object.keys(saved);
  const fresh = Object.entries(laidOut).filter(([id]) => !(id in saved));
  if (savedIds.length === 0 || fresh.length === 0) return { ...laidOut, ...saved };
  const right = Math.max(...savedIds.map((id) => (saved[id]?.x ?? 0) + (sizes.get(id)?.width ?? 0)));
  const top = Math.min(...savedIds.map((id) => saved[id]?.y ?? 0));
  const freshLeft = Math.min(...fresh.map(([, at]) => at.x));
  const freshTop = Math.min(...fresh.map(([, at]) => at.y));
  const shifted = fresh.map(([id, at]): [string, DiagramPosition] => [
    id,
    { x: at.x - freshLeft + right + DIAGRAM_NEW_TABLES_GAP_PX, y: at.y - freshTop + top },
  ]);
  return { ...saved, ...Object.fromEntries(shifted) };
}

export type DiagramSide = "left" | "right";

export interface EdgeGeometry {
  readonly path: string;
  readonly sourceX: number;
  readonly sourceY: number;
  readonly sourceSide: DiagramSide;
  readonly targetX: number;
  readonly targetY: number;
  readonly targetSide: DiagramSide;
}

const POSITION_OF: Readonly<Record<DiagramSide, Position>> = { left: Position.Left, right: Position.Right };

/**
 * An edge as drawn on screen and in an export (decision 11): a step path from the source column's row
 * to the target column's row, leaving and arriving on the sides that face each other; a table pointing
 * at itself, or one overlapping its target, loops out of the right side.
 */
export function edgeGeometry(
  edge: DiagramEdge,
  ends: {
    readonly source: { readonly table: DiagramTable; readonly at: DiagramPosition; readonly size: DiagramSize };
    readonly target: { readonly table: DiagramTable; readonly at: DiagramPosition; readonly size: DiagramSize };
  },
  mode: DiagramColumnMode,
  rowHeight: number,
): EdgeGeometry {
  const { source, target } = ends;
  const sourceRight = source.at.x + source.size.width;
  const targetRight = target.at.x + target.size.width;
  const [sourceSide, targetSide]: [DiagramSide, DiagramSide] =
    edge.source === edge.target || (source.at.x < targetRight && target.at.x < sourceRight)
      ? ["right", "right"]
      : sourceRight <= target.at.x
        ? ["right", "left"]
        : ["left", "right"];
  const sourceX = sourceSide === "right" ? sourceRight : source.at.x;
  const targetX = targetSide === "right" ? targetRight : target.at.x;
  const sourceY = source.at.y + rowMiddle(source.table, edge.from.columns[0], mode, rowHeight);
  const targetY = target.at.y + rowMiddle(target.table, edge.to.columns[0], mode, rowHeight);
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition: POSITION_OF[sourceSide],
    targetX,
    targetY,
    targetPosition: POSITION_OF[targetSide],
    borderRadius: DIAGRAM_EDGE_RADIUS_PX,
    offset: DIAGRAM_EDGE_OFFSET_PX,
  });
  return { path, sourceX, sourceY, sourceSide, targetX, targetY, targetSide };
}

/** The end markers (decision 2): a crow's foot at the many end, a bar at the one end, a ring before it when optional. */
export interface EdgeMarkers {
  readonly lines: string;
  readonly ring: { readonly cx: number; readonly cy: number; readonly r: number } | null;
}

export function edgeMarkers(geometry: EdgeGeometry, optional: boolean): EdgeMarkers {
  const out = (side: DiagramSide): number => (side === "right" ? 1 : -1);
  const m = DIAGRAM_MARKER_PX;
  const sx = geometry.sourceX;
  const sy = geometry.sourceY;
  const sd = out(geometry.sourceSide);
  const crowsFoot = `M ${sx} ${sy - m / 2} L ${sx + sd * m} ${sy} L ${sx} ${sy + m / 2}`;
  const tx = geometry.targetX;
  const ty = geometry.targetY;
  const td = out(geometry.targetSide);
  const barX = tx + (td * m) / 2;
  const bar = `M ${barX} ${ty - m / 2} L ${barX} ${ty + m / 2}`;
  const ring = optional ? { cx: tx + td * m, cy: ty, r: m / 4 } : null;
  return { lines: `${crowsFoot} ${bar}`, ring };
}
