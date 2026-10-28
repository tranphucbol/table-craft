/**
 * The motion ladder (plan 109): every duration, travel and loop state the renderer animates with,
 * per level. Pure and shared like `themes.ts`; `renderer/appearance/apply.ts` writes it as the
 * `--tc-motion-*` variables `app.css` reads.
 */

export const MOTION_CHOICES = ["system", "full", "reduced", "off"] as const;
export type MotionChoice = (typeof MOTION_CHOICES)[number];
export type MotionLevel = Exclude<MotionChoice, "system">;

export type LoopState = "running" | "paused";

export interface MotionTokens {
  /** Context menus and tooltips. */
  readonly fastMs: number;
  /** Popovers, the palette and dialog overlays. */
  readonly baseMs: number;
  /** Dialogs. */
  readonly slowMs: number;
  /** The run statement's highlight fading out of the editor. */
  readonly flashMs: number;
  /** How far an opening surface travels from the side it opens on. */
  readonly shiftPx: number;
  /** The scale a dialog grows from. */
  readonly enterScale: number;
  /** The scale an icon button shrinks to while held. */
  readonly pressScale: number;
  /** The scale a text button shrinks to while held. */
  readonly pressScaleText: number;
  /** Spinners, which carry status. */
  readonly progress: LoopState;
  /** The connecting pulse, which is decoration. */
  readonly ambient: LoopState;
}

const FULL_MOTION: MotionTokens = {
  fastMs: 100,
  baseMs: 150,
  slowMs: 200,
  flashMs: 600,
  shiftPx: 4,
  enterScale: 0.98,
  pressScale: 0.92,
  pressScaleText: 0.97,
  progress: "running",
  ambient: "running",
};

export const MOTION: Readonly<Record<MotionLevel, MotionTokens>> = {
  full: FULL_MOTION,
  reduced: {
    ...FULL_MOTION,
    shiftPx: 0,
    enterScale: 1,
    pressScale: 1,
    pressScaleText: 1,
    ambient: "paused",
  },
  off: {
    fastMs: 0,
    baseMs: 0,
    slowMs: 0,
    flashMs: 0,
    shiftPx: 0,
    enterScale: 1,
    pressScale: 1,
    pressScaleText: 1,
    progress: "paused",
    ambient: "paused",
  },
};

export function isMotionChoice(value: unknown): value is MotionChoice {
  return MOTION_CHOICES.includes(value as MotionChoice);
}

/** An explicit choice beats the OS; `system` follows `prefers-reduced-motion`. */
export function resolveMotion(choice: MotionChoice, prefersReducedMotion: boolean): MotionLevel {
  if (choice !== "system") return choice;
  return prefersReducedMotion ? "reduced" : "full";
}
