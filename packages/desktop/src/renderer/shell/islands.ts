// Whole class names, so Tailwind finds them when it scans the source.

/**
 * The toolbar, stripes and status bar sit on the frame, so their `panel` and their buttons' `raised`
 * hover read as the frame's colours (decision 141); their descendants inherit the remap.
 */
export const FRAME_SURFACE = "[--tc-panel:var(--tc-frame)] [--tc-raised:var(--tc-frame-raised)]";

/** The status bar's items line up with the islands' content: past the stripe, the gap, and the island's own padding. */
export const STATUS_BAR_ISLAND_INSET = "px-[calc(var(--tc-stripe-width)+var(--tc-island-gap)+var(--tc-gap))]";

/**
 * An island shares the editor's surface: what draws on `panel` inside it draws on `canvas` (decision 141).
 * It clips its content to its corners, so focus outlines inside it draw inward or the edge would cut them.
 */
export const ISLAND_SURFACE =
  "h-full min-h-0 overflow-hidden rounded-island border border-island-edge bg-canvas [--tc-panel:var(--tc-canvas)] [&_:focus-visible]:-outline-offset-2";
