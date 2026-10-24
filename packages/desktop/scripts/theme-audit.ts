/**
 * What every bundled theme has to be (decision 064): each pair in `CONTRAST_PAIRS` at the contrast
 * its level asks for, and six datasource tints a reader can tell apart. The generator refuses to
 * write a theme this finds fault with, and `test/appearance/themes.test.ts` runs it over what the
 * generator wrote, so a hand edit to a generated module fails `bun run test`.
 */
import {
  CONTRAST_PAIRS,
  contrastRatio,
  requiredContrast,
  type ContrastLevel,
} from "@table-craft/desktop/appearance/contrast.js";
import type { ColorTokens, DatasourceTint } from "@table-craft/desktop/appearance/themes.js";
import { contrast, parseColor, perceptualDistance } from "./colour.js";

/**
 * How far apart two datasource tints have to be in OKLab. The same calibration as preman's method
 * column (its decision 020): its closest pair that readers had to separate measured 0.0847.
 */
export const TINT_MIN_DISTANCE = 0.08;
/** WCAG 1.4.11: a tint is a swatch, tab stripe and console border on `panel`, never text. */
export const TINT_MIN_CONTRAST = 3;

export const DATASOURCE_TINTS = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "violet",
] as const satisfies readonly DatasourceTint[];

const RATIO_DIGITS = 2;
const DISTANCE_DIGITS = 4;

export interface AuditedTheme {
  readonly id: string;
  readonly contrast: ContrastLevel;
  readonly colors: ColorTokens;
}

/** Every contrast pair that falls short, as one line each, so one run reports them all. */
export function contrastViolations(theme: AuditedTheme): string[] {
  return CONTRAST_PAIRS.flatMap((pair) => {
    const [foreground, background] = pair.pick(theme.colors);
    const ratio = contrastRatio(foreground, background);
    const required = requiredContrast(theme.contrast, pair.kind);
    return ratio >= required
      ? []
      : [
          `${theme.id}: ${pair.foreground} on ${pair.background} is ${ratio.toFixed(RATIO_DIGITS)}:1, below ${String(required)}:1`,
        ];
  });
}

/**
 * The tints that sit too close together, and, when `onPanel` is set, those that fall below
 * `TINT_MIN_CONTRAST` on `panel`. TableCraft's own Light predates that floor (its yellow is about
 * 2:1), so it is held to separation only.
 */
export function tintViolations(theme: AuditedTheme, options: { onPanel: boolean }): string[] {
  const violations: string[] = [];
  const tints = theme.colors.datasource;
  DATASOURCE_TINTS.forEach((first, index) => {
    for (const second of DATASOURCE_TINTS.slice(index + 1)) {
      const distance = perceptualDistance(parseColor(tints[first]), parseColor(tints[second]));
      if (distance < TINT_MIN_DISTANCE) {
        violations.push(
          `${theme.id}: datasource ${first} and ${second} are ${distance.toFixed(DISTANCE_DIGITS)} apart in OKLab, below ${String(TINT_MIN_DISTANCE)}`,
        );
      }
    }
    if (!options.onPanel) return;
    const ratio = contrast(parseColor(tints[first]), parseColor(theme.colors.panel));
    if (ratio < TINT_MIN_CONTRAST) {
      violations.push(
        `${theme.id}: datasource ${first} on panel is ${ratio.toFixed(RATIO_DIGITS)}:1, below ${String(TINT_MIN_CONTRAST)}:1`,
      );
    }
  });
  return violations;
}
