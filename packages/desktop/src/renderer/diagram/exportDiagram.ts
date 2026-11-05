import type { DiagramColumnMode } from "@table-craft/desktop/diagrams/state.js";
import {
  showsTypes,
  type DiagramGraph,
  type DiagramTable,
  type EdgeOrigin,
} from "@table-craft/desktop/renderer/model/diagram.js";
import {
  DIAGRAM_EDGE_OFFSET_PX,
  edgeGeometry,
  edgeMarkers,
  tableRows,
  type DiagramMetrics,
  type Positions,
  type Sizes,
} from "@table-craft/desktop/renderer/model/diagramLayout.js";

/** Around the drawn bounds of an exported diagram (plan 152 phase 3). */
export const DIAGRAM_EXPORT_MARGIN_PX = 24;
export const DIAGRAM_PNG_SCALE = 2;
/** Chromium will not allocate a canvas wider or taller than this, so a bigger PNG is drawn at a smaller scale. */
export const DIAGRAM_PNG_MAX_SIDE_PX = 16384;
const EDGE_STROKE_PX = 1.5;
const HEADER_WEIGHT = 600;
const EXTERNAL_OPACITY = 0.7;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** The `--tc-*` variables an export resolves into literal values (decision 18). */
export const DIAGRAM_PALETTE_VARIABLES = {
  canvas: "--tc-canvas",
  panel: "--tc-panel",
  raised: "--tc-raised",
  border: "--tc-border",
  ink: "--tc-ink",
  inkMuted: "--tc-ink-muted",
  accent: "--tc-accent",
  keyIcon: "--tc-key-icon",
  fontUi: "--tc-font-ui",
  fontUiSize: "--tc-font-ui-size",
  fontGrid: "--tc-font-grid",
  fontGridSize: "--tc-font-grid-size",
  radius: "--tc-popover-radius",
} as const;

export type DiagramPalette = Readonly<Record<keyof typeof DIAGRAM_PALETTE_VARIABLES, string>>;

/** The palette from any reader of CSS variables: the computed style at export, or a theme's variables in a test. */
export function paletteOf(read: (variable: string) => string | undefined): DiagramPalette {
  const entries = Object.entries(DIAGRAM_PALETTE_VARIABLES).map(([name, variable]) => [
    name,
    (read(variable) ?? "").trim(),
  ]);
  return Object.fromEntries(entries) as Record<keyof typeof DIAGRAM_PALETTE_VARIABLES, string>;
}

/** The theme the app is showing right now, read from the variables `applyAppearance` wrote. */
export function readPalette(root: HTMLElement = document.documentElement): DiagramPalette {
  const style = getComputedStyle(root);
  return paletteOf((variable) => style.getPropertyValue(variable));
}

export interface DiagramImage {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
}

export interface DiagramSvgInput {
  readonly graph: DiagramGraph;
  readonly positions: Positions;
  readonly sizes: Sizes;
  readonly mode: DiagramColumnMode;
  readonly metrics: Pick<DiagramMetrics, "rowHeight" | "padding" | "icon">;
  readonly palette: DiagramPalette;
}

function number(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function escaped(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function attributes(values: Readonly<Record<string, string | number>>): string {
  return Object.entries(values)
    .map(([name, value]) => `${name}="${typeof value === "number" ? number(value) : escaped(value)}"`)
    .join(" ");
}

function element(name: string, values: Readonly<Record<string, string | number>>, content?: string): string {
  return content === undefined
    ? `<${name} ${attributes(values)}/>`
    : `<${name} ${attributes(values)}>${content}</${name}>`;
}

/** The edge styles of `diagram.css`, spelled as attributes. */
const EDGE_DASHES: Readonly<Record<EdgeOrigin, Readonly<Record<string, string>>>> = {
  declared: {},
  inferred: { "stroke-dasharray": "6 4" },
  virtual: { "stroke-dasharray": "1.5 3", "stroke-linecap": "round" },
};

interface Placed {
  readonly table: DiagramTable;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function keyGlyph(x: number, cy: number, size: number, primary: boolean, palette: DiagramPalette): string {
  const colour = primary ? palette.keyIcon : palette.accent;
  const bow = element("circle", {
    cx: x + size * 0.3,
    cy,
    r: size * 0.2,
    fill: primary ? colour : "none",
    stroke: colour,
    "stroke-width": EDGE_STROKE_PX,
  });
  const blade = element("path", {
    d: `M ${number(x + size * 0.5)} ${number(cy)} H ${number(x + size * 0.95)} M ${number(x + size * 0.8)} ${number(cy)} V ${number(cy + size * 0.22)}`,
    fill: "none",
    stroke: colour,
    "stroke-width": EDGE_STROKE_PX,
  });
  return bow + blade;
}

function tableGlyph(x: number, cy: number, size: number, palette: DiagramPalette): string {
  const top = cy - size * 0.35;
  return (
    element("rect", {
      x: x + size * 0.1,
      y: top,
      width: size * 0.8,
      height: size * 0.7,
      fill: "none",
      stroke: palette.inkMuted,
    }) +
    element("path", {
      d: `M ${number(x + size * 0.1)} ${number(top + size * 0.25)} h ${number(size * 0.8)}`,
      stroke: palette.inkMuted,
    })
  );
}

function tableSvg(placed: Placed, index: number, input: DiagramSvgInput): string {
  const { table, x, y, width, height } = placed;
  const { rowHeight, padding, icon } = input.metrics;
  const { palette } = input;
  const radius = Number.parseFloat(palette.radius) || 0;
  const clip = `tc-table-${String(index)}`;
  const textX = x + padding + icon + padding;
  const header =
    element("rect", { x, y, width, height: rowHeight, fill: palette.raised }) +
    element("path", { d: `M ${number(x)} ${number(y + rowHeight - 0.5)} h ${number(width)}`, stroke: palette.border }) +
    tableGlyph(x + padding, y + rowHeight / 2, icon, palette) +
    element(
      "text",
      {
        x: textX,
        y: y + rowHeight / 2,
        fill: palette.ink,
        "font-family": palette.fontUi,
        "font-size": palette.fontUiSize,
        "font-weight": HEADER_WEIGHT,
        "dominant-baseline": "central",
      },
      escaped(table.name),
    );
  const types = showsTypes(input.mode);
  const rows = tableRows(table, input.mode)
    .map((column, row) => {
      const cy = y + rowHeight * (row + 1) + rowHeight / 2;
      const glyph =
        column.primaryKey || column.foreignKey ? keyGlyph(x + padding, cy, icon, column.primaryKey, palette) : "";
      const text = {
        y: cy,
        "font-family": palette.fontGrid,
        "font-size": palette.fontGridSize,
        "dominant-baseline": "central",
      };
      const name = element("text", { x: textX, fill: palette.ink, ...text }, escaped(column.name));
      const type = types
        ? element(
            "text",
            { x: x + width - padding, fill: palette.inkMuted, "text-anchor": "end", ...text },
            escaped(column.type),
          )
        : "";
      return glyph + name + type;
    })
    .join("");
  const outline = element("rect", {
    x: x + 0.5,
    y: y + 0.5,
    width: width - 1,
    height: height - 1,
    rx: radius,
    fill: "none",
    stroke: palette.border,
  });
  const body =
    element("clipPath", { id: clip }, element("rect", { x, y, width, height, rx: radius })) +
    element(
      "g",
      { "clip-path": `url(#${clip})` },
      element("rect", { x, y, width, height, fill: palette.panel }) + header + rows,
    ) +
    outline;
  const group: Record<string, string | number> = { "data-table": table.id };
  if (table.kind === "external") group.opacity = EXTERNAL_OPACITY;
  return element("g", group, body);
}

/**
 * The whole diagram as a standalone SVG (decision 18): every positioned table and the edges between them,
 * drawn with the geometry the canvas uses and the palette's literal colours, cropped to what is drawn.
 */
export function diagramSvg(input: DiagramSvgInput): DiagramImage {
  const { graph, positions, sizes, mode, metrics, palette } = input;
  const placed = new Map<string, Placed>();
  for (const table of graph.tables) {
    const at = positions[table.id];
    const size = sizes.get(table.id);
    if (at === undefined || size === undefined) continue;
    placed.set(table.id, { table, x: at.x, y: at.y, ...size });
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (const { x, y, width, height } of placed.values()) {
    xs.push(x, x + width);
    ys.push(y, y + height);
  }
  const edges = graph.edges.flatMap((edge) => {
    const source = placed.get(edge.source);
    const target = placed.get(edge.target);
    if (source === undefined || target === undefined) return [];
    const geometry = edgeGeometry(
      edge,
      {
        source: { table: source.table, at: source, size: source },
        target: { table: target.table, at: target, size: target },
      },
      mode,
      metrics.rowHeight,
    );
    const reach = DIAGRAM_EDGE_OFFSET_PX;
    for (const [x, side] of [
      [geometry.sourceX, geometry.sourceSide],
      [geometry.targetX, geometry.targetSide],
    ] as const)
      xs.push(side === "right" ? x + reach : x - reach);
    const markers = edgeMarkers(geometry, edge.optional);
    const stroke = edge.origin === "virtual" ? palette.accent : palette.inkMuted;
    const ring =
      markers.ring === null
        ? ""
        : element("circle", { cx: markers.ring.cx, cy: markers.ring.cy, r: markers.ring.r, fill: palette.canvas });
    return [
      element(
        "g",
        { "data-edge-origin": edge.origin, fill: "none", stroke, "stroke-width": EDGE_STROKE_PX },
        element("path", { d: geometry.path, ...EDGE_DASHES[edge.origin] }) +
          element("path", { d: markers.lines }) +
          ring,
      ),
    ];
  });
  const margin = DIAGRAM_EXPORT_MARGIN_PX;
  const left = (xs.length === 0 ? 0 : Math.min(...xs)) - margin;
  const top = (ys.length === 0 ? 0 : Math.min(...ys)) - margin;
  const width = Math.ceil((xs.length === 0 ? 0 : Math.max(...xs)) + margin - left);
  const height = Math.ceil((ys.length === 0 ? 0 : Math.max(...ys)) + margin - top);
  const tables = [...placed.values()].map((table, index) => tableSvg(table, index, input)).join("");
  const background = element("rect", { x: left, y: top, width, height, fill: palette.canvas });
  const svg = element(
    "svg",
    {
      xmlns: SVG_NAMESPACE,
      width,
      height,
      viewBox: `${number(left)} ${number(top)} ${String(width)} ${String(height)}`,
    },
    background + edges.join("") + tables,
  );
  return { svg, width, height };
}

/** The scale a PNG of this size is drawn at, and whether it had to drop below `DIAGRAM_PNG_SCALE`. */
export function pngScale(image: Pick<DiagramImage, "width" | "height">): {
  readonly scale: number;
  readonly reduced: boolean;
} {
  const longest = Math.max(image.width, image.height, 1);
  const scale = Math.min(DIAGRAM_PNG_SCALE, DIAGRAM_PNG_MAX_SIDE_PX / longest);
  return { scale, reduced: scale < DIAGRAM_PNG_SCALE };
}

/** Rasterises the SVG through an image into an offscreen canvas; the browser draws it, so the fonts are the app's. */
export async function diagramPng(
  image: DiagramImage,
): Promise<{ readonly data: Uint8Array; readonly scale: number; readonly reduced: boolean }> {
  const { scale, reduced } = pngScale(image);
  const picture = new Image();
  picture.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(image.svg)}`;
  await picture.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(image.width * scale));
  canvas.height = Math.max(1, Math.floor(image.height * scale));
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("The PNG could not be drawn: no canvas is available. Export as SVG instead.");
  context.scale(scale, scale);
  context.drawImage(picture, 0, 0, image.width, image.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (blob === null) throw new Error("The PNG could not be encoded. Export as SVG instead.");
  return { data: new Uint8Array(await blob.arrayBuffer()), scale, reduced };
}
