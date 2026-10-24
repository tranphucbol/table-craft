/**
 * The colour maths the theme generator solves with and the theme audit measures with (decision
 * 064). Pure, so `test/appearance/` runs the same code over what the generator wrote. Ported from
 * preman's `packages/desktop/scripts/audit.ts`.
 */

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface Rgba extends Rgb {
  /** 0 to 1; only eight-digit hex carries anything but 1. */
  readonly a: number;
}

const SHORT_HEX_LENGTH = 3;
const HEX_LENGTH = 6;
const HEX_WITH_ALPHA_LENGTH = 8;
const HEX_RADIX = 16;
const HEX_PAIR = 2;
const CHANNEL_MAX = 255;
const OPAQUE = 1;
const HALF = 2;
const SOLVER_STEPS = 40;
/** WCAG 2.1 sRGB transfer: https://www.w3.org/TR/WCAG21/#dfn-relative-luminance */
const LINEAR_KNEE = 0.04045;
const LINEAR_SLOPE = 12.92;
const LINEAR_OFFSET = 0.055;
const LINEAR_SCALE = 1.055;
const LINEAR_EXPONENT = 2.4;
const LUMINANCE_R = 0.2126;
const LUMINANCE_G = 0.7152;
const LUMINANCE_B = 0.0722;
const FLARE = 0.05;

export const BLACK: Rgb = { r: 0, g: 0, b: 0 };
export const WHITE: Rgb = { r: CHANNEL_MAX, g: CHANNEL_MAX, b: CHANNEL_MAX };

function clampChannel(value: number): number {
  return Math.min(CHANNEL_MAX, Math.max(0, Math.round(value)));
}

/** `#rgb`, `#rrggbb` and `#rrggbbaa`; openchamber writes the last for its overlay colours. */
export function parseColor(value: string): Rgba {
  const body = value.startsWith("#") ? value.slice(1) : value;
  const expanded =
    body.length === SHORT_HEX_LENGTH ? [...body].map((character) => `${character}${character}`).join("") : body;
  if (expanded.length !== HEX_LENGTH && expanded.length !== HEX_WITH_ALPHA_LENGTH) {
    throw new Error(`${value} is not a #rgb, #rrggbb or #rrggbbaa colour.`);
  }
  const channel = (index: number): number => parseInt(expanded.slice(index, index + HEX_PAIR), HEX_RADIX);
  const alpha = expanded.length === HEX_WITH_ALPHA_LENGTH ? channel(HEX_LENGTH) / CHANNEL_MAX : OPAQUE;
  return { r: channel(0), g: channel(HEX_PAIR), b: channel(HEX_PAIR * HALF), a: alpha };
}

export function toHex(colour: Rgb): string {
  const pair = (value: number): string => clampChannel(value).toString(HEX_RADIX).padStart(HEX_PAIR, "0");
  return `#${pair(colour.r)}${pair(colour.g)}${pair(colour.b)}`;
}

/** An overlay drawn over an opaque base, as the one opaque colour it shows. */
export function flatten(overlay: Rgba, base: Rgb): Rgb {
  return mix(base, overlay, overlay.a);
}

function toLinear(channel: number): number {
  const scaled = channel / CHANNEL_MAX;
  return scaled <= LINEAR_KNEE
    ? scaled / LINEAR_SLOPE
    : Math.pow((scaled + LINEAR_OFFSET) / LINEAR_SCALE, LINEAR_EXPONENT);
}

export function luminance(colour: Rgb): number {
  return LUMINANCE_R * toLinear(colour.r) + LUMINANCE_G * toLinear(colour.g) + LUMINANCE_B * toLinear(colour.b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + FLARE) / (Math.min(first, second) + FLARE);
}

export function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  return {
    r: from.r + (to.r - from.r) * amount,
    g: from.g + (to.g - from.g) * amount,
    b: from.b + (to.b - from.b) * amount,
  };
}

/** Rounds to the eight-bit cube, so what is measured is what is written. */
export function quantise(colour: Rgb): Rgb {
  return { r: clampChannel(colour.r), g: clampChannel(colour.g), b: clampChannel(colour.b) };
}

/**
 * The largest `amount` in [0, 1] for which `accept(mix(from, to, amount))` holds, assuming it holds
 * at 0 and, once it fails, keeps failing. Every solver in the generator is this bisection.
 */
export function furthest(from: Rgb, to: Rgb, accept: (colour: Rgb) => boolean): Rgb {
  if (accept(quantise(to))) return quantise(to);
  let low = 0;
  let high = OPAQUE;
  for (let step = 0; step < SOLVER_STEPS; step += 1) {
    const middle = (low + high) / HALF;
    if (accept(quantise(mix(from, to, middle)))) low = middle;
    else high = middle;
  }
  return quantise(mix(from, to, low));
}

/** The nearest colour on the way from `from` to `to` for which `accept` holds; `to` when none is. */
export function nearest(from: Rgb, to: Rgb, accept: (colour: Rgb) => boolean): Rgb {
  if (accept(quantise(from))) return quantise(from);
  let low = 0;
  let high = OPAQUE;
  for (let step = 0; step < SOLVER_STEPS; step += 1) {
    const middle = (low + high) / HALF;
    if (accept(quantise(mix(from, to, middle)))) high = middle;
    else low = middle;
  }
  return quantise(mix(from, to, high));
}

const OKLAB_M1 = [
  [0.4122214708, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883024619, 0.2817188376, 0.6299787005],
] as const;
const OKLAB_M2 = [
  [0.2104542553, 0.793617785, -0.0040720468],
  [1.9779984951, -2.428592205, 0.4505937099],
  [0.0259040371, 0.7827717662, -0.808675766],
] as const;
const OKLAB_INVERSE_CONE = [
  [OPAQUE, 0.3963377774, 0.2158037573],
  [OPAQUE, -0.1055613458, -0.0638541728],
  [OPAQUE, -0.0894841775, -1.291485548],
] as const;
const OKLAB_INVERSE_LINEAR = [
  [4.0767416621, -3.3077115913, 0.2309699292],
  [-1.2684380046, 2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, 1.707614701],
] as const;
const CUBE = 3;

type Vector = readonly [number, number, number];

function times(matrix: readonly (readonly [number, number, number])[], vector: Vector): Vector {
  const row = (index: number): number => {
    const [a, b, c] = matrix[index] ?? [0, 0, 0];
    return a * vector[0] + b * vector[1] + c * vector[2];
  };
  return [row(0), row(1), row(2)];
}

/**
 * OKLab (https://bottosson.github.io/posts/oklab/), for what WCAG contrast cannot answer: are two
 * colours of the same luminance still two colours a reader can tell apart.
 */
export function oklab(colour: Rgb): Vector {
  const cone = times(OKLAB_M1, [toLinear(colour.r), toLinear(colour.g), toLinear(colour.b)]);
  return times(OKLAB_M2, [Math.cbrt(cone[0]), Math.cbrt(cone[1]), Math.cbrt(cone[2])]);
}

function fromLinear(channel: number): number {
  const encoded =
    channel <= LINEAR_KNEE / LINEAR_SLOPE
      ? channel * LINEAR_SLOPE
      : LINEAR_SCALE * Math.pow(channel, OPAQUE / LINEAR_EXPONENT) - LINEAR_OFFSET;
  return clampChannel(encoded * CHANNEL_MAX);
}

export function fromOklab(lab: Vector): Rgb {
  const cone = times(OKLAB_INVERSE_CONE, lab);
  const linear = times(OKLAB_INVERSE_LINEAR, [cone[0] ** CUBE, cone[1] ** CUBE, cone[2] ** CUBE]);
  return { r: fromLinear(linear[0]), g: fromLinear(linear[1]), b: fromLinear(linear[2]) };
}

/** Polar OKLab: lightness, chroma, and a hue in radians. */
export interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

export function oklch(colour: Rgb): Oklch {
  const [l, a, b] = oklab(colour);
  return { l, c: Math.hypot(a, b), h: Math.atan2(b, a) };
}

export function fromOklch(polar: Oklch): Rgb {
  return fromOklab([polar.l, polar.c * Math.cos(polar.h), polar.c * Math.sin(polar.h)]);
}

export function perceptualDistance(a: Rgb, b: Rgb): number {
  const [l1, a1, b1] = oklab(a);
  const [l2, a2, b2] = oklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}
