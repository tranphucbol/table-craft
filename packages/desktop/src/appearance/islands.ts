/**
 * The Islands window style (decision 141): the editor and each tool window a rounded card on a
 * window frame. The frame's colours are derived from the theme, so every bundled, ported and user
 * theme gets one without a new token. Pure and shared by main and the renderer.
 */
import { contrastRatio, hexChannels, requiredContrast, type ContrastLevel } from "./contrast.js";
import type { ColorScheme, ColorTokens } from "./themes.js";

export const WINDOW_STYLES = ["islands", "classic"] as const;

export type WindowStyle = (typeof WINDOW_STYLES)[number];

export function isWindowStyle(value: unknown): value is WindowStyle {
  return (WINDOW_STYLES as readonly unknown[]).includes(value);
}

/** JetBrains' floor for the frame against an island: https://plugins.jetbrains.com/docs/intellij/supporting-islands-theme.html */
export const ISLAND_MIN_CONTRAST = 1.2;

export interface FrameColors {
  /** Behind the islands, the main toolbar, the stripes and the status bar. */
  readonly frame: string;
  /** A hovered or pressed button on the frame. */
  readonly frameRaised: string;
}

const WHITE = "#ffffff";
const BLACK = "#000000";
const MIX_STEPS = 100;
const HEX_RADIX = 16;

/** What a frame is derived from: a theme, or anything shaped like one. */
export interface FrameSource {
  readonly colors: ColorTokens;
  readonly colorScheme: ColorScheme;
  readonly contrast: ContrastLevel;
}

function mix(from: string, to: string, amount: number): string {
  const start = hexChannels(from);
  const end = hexChannels(to);
  const mixed = start.map((channel, index) =>
    Math.round(channel + ((end[index] ?? channel) - channel) * amount)
      .toString(HEX_RADIX)
      .padStart(2, "0"),
  );
  return `#${mixed.join("")}`;
}

/**
 * The first 1 % step from `start` toward `toward` that holds `ratio` against `against`, or the
 * last step the theme's text still reads on, whichever comes first.
 */
function stepAway(
  start: string,
  against: string,
  toward: string,
  ratio: number,
  readable: (surface: string) => boolean,
): string {
  let reached = start;
  for (let step = 0; step <= MIX_STEPS; step += 1) {
    const candidate = mix(start, toward, step / MIX_STEPS);
    if (step > 0 && !readable(candidate)) return reached;
    reached = candidate;
    if (contrastRatio(candidate, against) >= ratio) return candidate;
  }
  return reached;
}

/**
 * `panel`, stepped lighter in a dark scheme and darker in a light one, as JetBrains' frames are,
 * until it holds `ISLAND_MIN_CONTRAST` against `canvas`; the hover steps on until it stands out
 * from the frame as much as `raised` does from `panel`. Neither steps past where `ink` and
 * `inkMuted` stop meeting the theme's contrast, which many ported palettes reach first.
 */
export function frameColors({ colors, colorScheme, contrast }: FrameSource): FrameColors {
  const toward = colorScheme === "dark" ? WHITE : BLACK;
  const readable = (surface: string) =>
    contrastRatio(colors.ink, surface) >= requiredContrast(contrast, "ink") &&
    contrastRatio(colors.inkMuted, surface) >= requiredContrast(contrast, "text");
  const frame = stepAway(colors.panel, colors.canvas, toward, ISLAND_MIN_CONTRAST, readable);
  const frameRaised = stepAway(frame, frame, toward, contrastRatio(colors.raised, colors.panel), readable);
  return { frame, frameRaised };
}

/** What the window paints before and behind the renderer. */
export function windowBackground(theme: FrameSource, style: WindowStyle): string {
  return style === "islands" ? frameColors(theme).frame : theme.colors.canvas;
}

/** The colour the window's title bar is drawn in: the main toolbar's. */
export function titleBarColor(theme: FrameSource, style: WindowStyle): string {
  return style === "islands" ? frameColors(theme).frame : theme.colors.panel;
}
