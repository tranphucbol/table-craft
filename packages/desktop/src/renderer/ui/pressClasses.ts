/** A filled button: shades on hover, darkens and shrinks a little while held (plan 114). */
export const FILLED_PRESS = "press-fill press-text";
/** A danger-filled button: the same, with the shades capped for the danger fill. */
export const FILLED_DANGER_PRESS = `${FILLED_PRESS} press-fill-danger`;
/** A bordered text button: the base ink tint, and a small shrink while held. */
export const TEXT_PRESS = "press-text";
/**
 * A toggle while on. The selection fill alone is about 1.3:1 on the Light canvas, so the accent
 * edge and ink carry the state (WCAG 1.4.11 asks 3:1 of it).
 */
export const PRESSED_TOGGLE =
  "aria-pressed:bg-selection aria-pressed:text-accent aria-pressed:inset-ring aria-pressed:inset-ring-accent";
