// Whole class names, so Tailwind finds them when it scans the source.

/**
 * The toolbar, stripes and status bar sit on the frame, so their `panel` and their buttons' `raised`
 * hover read as the frame's colours (decision 141); their descendants inherit the remap.
 */
export const FRAME_SURFACE = "[--tc-panel:var(--tc-frame)] [--tc-raised:var(--tc-frame-raised)]";

/** An island shares the editor's surface: what draws on `panel` inside it draws on `canvas` (decision 141). */
export const ISLAND_SURFACE = "h-full min-h-0 overflow-hidden rounded-island bg-canvas [--tc-panel:var(--tc-canvas)]";
