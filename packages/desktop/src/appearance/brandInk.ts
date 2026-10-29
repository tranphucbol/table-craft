/**
 * The colour a datasource logo draws in (decision 128): its brand's own, moved toward the theme's
 * ink just far enough to read on every surface a row sits on. Pure and shared like `press.ts`.
 */
import { contrastRatio, isHexColor, requiredContrast } from "./contrast.js";
import type { ColorTokens } from "./themes.js";

const HEX_RADIX = 16;
const CHANNEL_MAX = 255;
/** Steps of 5 % toward ink; 20 reach the ink itself, which every theme already holds at AA. */
const MIX_STEPS = 20;

/** The surfaces a logo sits on: the tree, dialogs and popups, and a hovered or selected row. */
export type BrandSurfaces = Pick<ColorTokens, "canvas" | "panel" | "raised" | "selection" | "ink">;

function rgb(hex: string): readonly number[] {
  const digits = hex.length === 4 ? [...hex.slice(1)].map((digit) => digit + digit).join("") : hex.slice(1, 7);
  return [0, 2, 4].map((offset) => Number.parseInt(digits.slice(offset, offset + 2), HEX_RADIX));
}

/** `from` with `amount` (0 to 1) of `to` mixed in, in sRGB. */
function mix(from: string, to: string, amount: number): string {
  const target = rgb(to);
  const channels = rgb(from).map((channel, index) =>
    Math.min(CHANNEL_MAX, Math.round(channel + ((target[index] ?? channel) - channel) * amount))
      .toString(HEX_RADIX)
      .padStart(2, "0"),
  );
  return `#${channels.join("")}`;
}

/**
 * `brandHex` (`#rrggbb`), or the nearest 5 % step toward `colors.ink` that holds WCAG non-text
 * contrast on every surface: MariaDB's and SQLite's dark navy vanish on a dark panel otherwise.
 * A colour that is not hex falls back to the ink.
 */
export function brandInk(brandHex: string, colors: BrandSurfaces): string {
  const surfaces = [colors.canvas, colors.panel, colors.raised, colors.selection];
  if (![brandHex, colors.ink, ...surfaces].every(isHexColor)) return colors.ink;
  const floor = requiredContrast("aa", "nonText");
  for (let step = 0; step <= MIX_STEPS; step += 1) {
    const candidate = mix(brandHex, colors.ink, step / MIX_STEPS);
    if (surfaces.every((surface) => contrastRatio(candidate, surface) >= floor)) return candidate;
  }
  return colors.ink;
}
