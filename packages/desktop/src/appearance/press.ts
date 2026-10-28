/**
 * The shade a filled button darkens by (plan 114). Pure and shared like `motion.ts`;
 * `renderer/appearance/apply.ts` writes it as the `--tc-*-shade` variables `app.css` reads.
 */
import { contrastRatio, isHexColor, requiredContrast } from "./contrast.js";

/** Black laid over a filled button while hovered and while held (plan 114). */
export const FILL_HOVER_SHADE = 0.08;
export const FILL_PRESS_SHADE = 0.16;

const HEX_RADIX = 16;
const PERCENT = 100;
/** Steps of 1 % from `FILL_PRESS_SHADE` down, when the full shade would cost the label AA. */
const SHADE_STEPS = Math.round(FILL_PRESS_SHADE * PERCENT);

/** The sRGB colour `shade` black laid over `hex` composites to, as an inset shadow paints it. */
export function shadeOver(hex: string, shade: number): string {
  if (!isHexColor(hex)) throw new Error(`${hex} is not a #rgb, #rrggbb or #rrggbbaa colour.`);
  const digits = hex.length === 4 ? [...hex.slice(1)].map((digit) => digit + digit).join("") : hex.slice(1, 7);
  const shaded = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(digits.slice(offset, offset + 2), HEX_RADIX);
    return Math.round(channel * (1 - shade))
      .toString(HEX_RADIX)
      .padStart(2, "0");
  });
  return `#${shaded.join("")}`;
}

export interface FillShades {
  readonly hover: number;
  readonly press: number;
}

/**
 * The shades for a `fill` carrying a `label`: `FILL_PRESS_SHADE`, or the deepest 1 % step below it
 * that keeps the label at AA while held, since darkening a light fill under a dark label (most
 * dark themes) costs contrast. Hover keeps its proportion to the press, so the steps stay ordered.
 */
export function fillShades(fill: string, label: string): FillShades {
  const floor = requiredContrast("aa", "text");
  let steps = SHADE_STEPS;
  while (steps > 0 && contrastRatio(label, shadeOver(fill, steps / PERCENT)) < floor) steps -= 1;
  const press = steps / PERCENT;
  return { hover: (press * FILL_HOVER_SHADE) / FILL_PRESS_SHADE, press };
}

/** `shade` as the black CSS colour an inset shadow paints, e.g. `rgb(0 0 0 / 16%)`. */
export function shadeColor(shade: number): string {
  return `rgb(0 0 0 / ${String(Number((shade * PERCENT).toFixed(1)))}%)`;
}
