// Whole class names, so Tailwind finds them when it scans the source.

/**
 * The toolbar, stripes and status bar sit on the frame, so their `panel` and their buttons' `raised`
 * hover read as the frame's colours (decision 141); their descendants inherit the remap.
 */
export const FRAME_SURFACE = "[--tc-panel:var(--tc-frame)] [--tc-raised:var(--tc-frame-raised)]";

/** The status bar's items line up with the islands' content: past the stripe, the gap, and the island's `pane-inset`. */
export const STATUS_BAR_ISLAND_INSET = "px-[calc(var(--tc-stripe-width)+var(--tc-island-gap)+var(--tc-pane-inset))]";

/**
 * Where a row of controls starts so the first glyph sits at `pane-inset`, under the tool window's
 * title: the inset less the control's own padding. A text tab row comes to 0 in Classic, as before.
 */
export const ICON_BUTTON_ROW_INSET = "px-[calc(var(--tc-pane-inset)-(var(--tc-tab-height)-var(--tc-icon))/2)]";
export const TEXT_TAB_ROW_INSET = "px-[calc(var(--tc-pane-inset)-var(--tc-gap))]";

/** The tab strip's corner buttons keep `pane-inset` from the island's rounded corner. */
export const CORNER_ISLAND_INSET = "pl-1 pr-[calc(var(--tc-pane-inset)-var(--spacing))]";

/**
 * An island shares the editor's surface: what draws on `panel` inside it draws on `canvas` (decision 141).
 * It clips its content to its corners, so focus outlines inside it draw inward or the edge would cut them.
 */
export const ISLAND_SURFACE =
  "h-full min-h-0 overflow-hidden rounded-island border border-island-edge bg-canvas [--tc-panel:var(--tc-canvas)] [&_:focus-visible]:-outline-offset-2";
