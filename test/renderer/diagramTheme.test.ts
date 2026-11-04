import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_THEMES,
  BUNDLED_THEME_IDS,
  BUNDLED_THEMES,
  type Theme,
} from "@table-craft/desktop/appearance/themes.js";
import { DEFAULT_DIAGRAM_STATE } from "@table-craft/desktop/diagrams/state.js";
import { appearanceVariables } from "@table-craft/desktop/renderer/appearance/apply.js";
import { appearanceOf } from "@table-craft/desktop/renderer/appearance/tokens.js";
import {
  DIAGRAM_EXPORT_MARGIN_PX,
  DIAGRAM_PNG_MAX_SIDE_PX,
  DIAGRAM_PNG_SCALE,
  diagramSvg,
  paletteOf,
  pngScale,
  type DiagramPalette,
} from "@table-craft/desktop/renderer/diagram/exportDiagram.js";
import { diagramGraph } from "@table-craft/desktop/renderer/model/diagram.js";
import { tableSizes, type DiagramMetrics } from "@table-craft/desktop/renderer/model/diagramLayout.js";
import { DEFAULT_SETTINGS } from "@table-craft/desktop/settings/settings.js";
import { PUBLIC_CATALOG } from "./catalogFixtures.js";

const DIAGRAM_DIR = join(import.meta.dirname, "../../packages/desktop/src/renderer/diagram");
const NO_PREFERENCE = { prefersReducedMotion: false };
const METRICS: DiagramMetrics = { rowHeight: 20, padding: 4, icon: 16, measure: (text) => text.length * 7 };
const POSITIONS = { customers: { x: 0, y: 0 }, orders: { x: 400, y: 100 } };

/** Hex, rgb()/hsl()/oklch() and the CSS named colours a component might reach for instead of a token. */
const COLOUR_LITERAL =
  /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\(|(?<![\w-])(?:white|black|red|green|blue|gray|grey|silver|orange|yellow)(?![\w-])/i;

function diagramSources(): readonly string[] {
  return readdirSync(DIAGRAM_DIR).filter((name) => /\.(?:tsx?|css)$/.test(name));
}

function variablesOf(theme: Theme): Readonly<Record<string, string>> {
  return appearanceVariables(appearanceOf(DEFAULT_SETTINGS, theme, NO_PREFERENCE));
}

function paletteFor(theme: Theme): DiagramPalette {
  const variables = variablesOf(theme);
  return paletteOf((variable) => variables[variable]);
}

function exported(palette: DiagramPalette): string {
  const graph = diagramGraph({ catalog: PUBLIC_CATALOG, inferred: [], state: DEFAULT_DIAGRAM_STATE });
  return diagramSvg({
    graph,
    positions: POSITIONS,
    sizes: tableSizes(graph.tables, "all", METRICS),
    mode: "all",
    metrics: METRICS,
    palette,
  }).svg;
}

function attributeValues(svg: string, name: string): ReadonlySet<string> {
  return new Set([...svg.matchAll(new RegExp(` ${name}="([^"]*)"`, "g"))].map((match) => match[1] ?? ""));
}

describe("diagram theme", () => {
  it("givenDiagramSources_whenScanned_thenNoColourLiterals", () => {
    const found = diagramSources().flatMap((name) =>
      readFileSync(join(DIAGRAM_DIR, name), "utf8")
        .split("\n")
        .flatMap((line, index) => (COLOUR_LITERAL.test(line) ? [`${name}:${String(index + 1)}: ${line.trim()}`] : [])),
    );

    expect(diagramSources().length).toBeGreaterThan(0);
    expect(found).toEqual([]);
  });

  it("givenEveryBuiltInTheme_whenPaletteResolved_thenEveryDiagramVariableHasAValue", () => {
    const css = readFileSync(join(DIAGRAM_DIR, "diagram.css"), "utf8");
    const used = new Set([...css.matchAll(/var\((--tc-[\w-]+)\)/g)].map((match) => match[1] ?? ""));

    const missing = BUNDLED_THEME_IDS.flatMap((id) => {
      const variables = variablesOf(BUNDLED_THEMES[id]);
      const palette = paletteOf((variable) => variables[variable]);
      const empty = Object.entries(palette).flatMap(([name, value]) => (value === "" ? [`${id}: ${name}`] : []));
      const unset = [...used].flatMap((variable) => (variables[variable] === undefined ? [`${id}: ${variable}`] : []));
      return [...empty, ...unset];
    });

    expect(used.size).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it("givenLightAndDarkPalettes_whenSvgExported_thenFillsAreThatThemesColours", () => {
    const light = paletteFor(BUILT_IN_THEMES.light);
    const dark = paletteFor(BUILT_IN_THEMES.dark);

    const fills = { light: attributeValues(exported(light), "fill"), dark: attributeValues(exported(dark), "fill") };

    for (const [palette, own, other] of [
      [light, fills.light, fills.dark],
      [dark, fills.dark, fills.light],
    ] as const) {
      expect(own).toContain(palette.canvas);
      expect(own).toContain(palette.panel);
      expect(own).toContain(palette.raised);
      expect(own).toContain(palette.ink);
      expect(other).not.toContain(palette.panel);
    }
    expect([...fills.light].filter((fill) => fill !== "none" && !Object.values(light).includes(fill))).toEqual([]);
  });

  it("givenHighContrastTheme_whenSvgExported_thenEdgesUseItsInk", () => {
    const palette = paletteFor(BUILT_IN_THEMES.highContrast);

    const svg = exported(palette);
    const edges = [...svg.matchAll(/<g data-edge-origin="(\w+)"[^>]* stroke="([^"]*)"/g)];

    expect(edges.map((edge) => [edge[1], edge[2]])).toEqual([["declared", palette.inkMuted]]);
    expect(svg).toContain(`font-family="${palette.fontGrid.replace(/"/g, "&quot;")}"`);
  });

  it("givenPlacedTables_whenSvgExported_thenCroppedToTheirBoundsPlusMargin", () => {
    const graph = diagramGraph({ catalog: PUBLIC_CATALOG, inferred: [], state: DEFAULT_DIAGRAM_STATE });
    const sizes = tableSizes(graph.tables, "all", METRICS);
    const orders = sizes.get("orders");

    const image = diagramSvg({
      graph,
      positions: { orders: POSITIONS.orders },
      sizes,
      mode: "all",
      metrics: METRICS,
      palette: paletteFor(BUILT_IN_THEMES.dark),
    });

    expect(image.width).toBe(Math.ceil((orders?.width ?? 0) + 2 * DIAGRAM_EXPORT_MARGIN_PX));
    expect(image.height).toBe(Math.ceil((orders?.height ?? 0) + 2 * DIAGRAM_EXPORT_MARGIN_PX));
    expect(image.svg).toContain(
      `viewBox="${String(400 - DIAGRAM_EXPORT_MARGIN_PX)} ${String(100 - DIAGRAM_EXPORT_MARGIN_PX)} `,
    );
    expect(image.svg).not.toContain('data-table="customers"');
    expect(image.svg).not.toContain("data-edge-origin");
  });

  it("givenDiagramPastTheCanvasLimit_whenPngScaled_thenScaleDropsAndSaysSo", () => {
    expect(pngScale({ width: 1000, height: 600 })).toEqual({ scale: DIAGRAM_PNG_SCALE, reduced: false });

    const big = pngScale({ width: DIAGRAM_PNG_MAX_SIDE_PX, height: 600 });

    expect(big).toEqual({ scale: 1, reduced: true });
    expect(DIAGRAM_PNG_MAX_SIDE_PX * big.scale).toBeLessThanOrEqual(DIAGRAM_PNG_MAX_SIDE_PX);
  });
});
