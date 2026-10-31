/**
 * WCAG contrast and the pairs every bundled theme is audited on. Pure and free of the theme list,
 * so `scripts/generate-themes.ts` can audit what it writes before the list exists (decision 064).
 */
import type { ColorTokens } from "./themes.js";

/** How much contrast a theme promises: `aaa` holds body text to WCAG 1.4.6. */
export type ContrastLevel = "aa" | "aaa";

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value);
}

/** Expands `#rgb` and drops the alpha of `#rrggbbaa`; contrast is measured on the opaque colour. */
export function hexChannels(color: string): readonly [number, number, number] {
  if (!isHexColor(color)) throw new Error(`${color} is not a #rgb, #rrggbb or #rrggbbaa colour.`);
  const hex = color.length === 4 ? [...color.slice(1)].map((digit) => digit + digit).join("") : color.slice(1, 7);
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as unknown as readonly [
    number,
    number,
    number,
  ];
}

/** WCAG 2.1 relative luminance: https://www.w3.org/TR/WCAG21/#dfn-relative-luminance */
function luminance(color: string): number {
  const [red, green, blue] = hexChannels(color).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as unknown as readonly [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** WCAG 2.1 contrast ratio, 1 to 21: https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio */
export function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

/** `ink` is body text; `text` any other text; `nonText` a glyph or bar that carries meaning. */
export type ContrastKind = "ink" | "text" | "nonText";

export interface ContrastPair {
  readonly foreground: string;
  readonly background: string;
  readonly kind: ContrastKind;
  readonly pick: (colors: ColorTokens) => readonly [foreground: string, background: string];
}

const SURFACES = ["canvas", "panel", "raised"] as const;
const SYNTAX_TEXT = ["keyword", "string", "number", "comment", "identifier", "operator", "variable"] as const;

/** The pairs every bundled theme is measured on (plan 013 decision 9, decision 064). */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  ...(["ink", "inkMuted", "accent"] as const).flatMap((foreground) =>
    SURFACES.map((background): ContrastPair => ({
      foreground,
      background,
      kind: foreground === "ink" ? "ink" : "text",
      pick: (colors) => [colors[foreground], colors[background]],
    })),
  ),
  { foreground: "accentInk", background: "accent", kind: "text", pick: (colors) => [colors.accentInk, colors.accent] },
  ...(["danger", "success", "warning"] as const).map((foreground): ContrastPair => ({
    foreground,
    background: "panel",
    kind: "text",
    pick: (colors) => [colors[foreground], colors.panel],
  })),
  ...SYNTAX_TEXT.map((name): ContrastPair => ({
    foreground: `syntax.${name}`,
    background: "canvas",
    kind: "text",
    pick: (colors) => [colors.syntax[name], colors.canvas],
  })),
  {
    foreground: "ink",
    background: "syntax.bracketMatch",
    kind: "ink",
    pick: (colors) => [colors.ink, colors.syntax.bracketMatch],
  },
  { foreground: "gridNull", background: "canvas", kind: "text", pick: (colors) => [colors.gridNull, colors.canvas] },
  { foreground: "ink", background: "gridSelection", kind: "ink", pick: (colors) => [colors.ink, colors.gridSelection] },
  { foreground: "keyIcon", background: "panel", kind: "nonText", pick: (colors) => [colors.keyIcon, colors.panel] },
  { foreground: "planBar", background: "canvas", kind: "nonText", pick: (colors) => [colors.planBar, colors.canvas] },
];

const WCAG_TEXT = 4.5;
const WCAG_NON_TEXT = 3;
const WCAG_ENHANCED_TEXT = 7;

/** WCAG AA (1.4.3, 1.4.11) for every theme; AAA (1.4.6) for ink in an `aaa` one (High contrast). */
export function requiredContrast(level: ContrastLevel, kind: ContrastKind): number {
  if (level === "aaa") return kind === "ink" ? WCAG_ENHANCED_TEXT : WCAG_TEXT;
  return kind === "nonText" ? WCAG_NON_TEXT : WCAG_TEXT;
}
