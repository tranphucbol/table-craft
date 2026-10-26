/** Points `tc-surface-in`'s travel away from the anchor; no side (the palette) travels down. */
const SIDE_TRAVEL =
  "data-[side=top]:[--tc-motion-dy:1] data-[side=left]:[--tc-motion-dx:1] data-[side=left]:[--tc-motion-dy:0] data-[side=right]:[--tc-motion-dx:-1] data-[side=right]:[--tc-motion-dy:0]";

/** Popovers and the command palette. */
export const SURFACE_MOTION = `data-[state=open]:animate-surface-in ${SIDE_TRAVEL}`;
export const MENU_MOTION = `data-[state=open]:animate-menu-in ${SIDE_TRAVEL}`;
/** Moving between tooltips is `instant-open` and stays still. */
export const TOOLTIP_MOTION = "data-[state=delayed-open]:animate-tooltip-in";
export const DIALOG_MOTION = "data-[state=open]:animate-dialog-in";
export const OVERLAY_MOTION = "data-[state=open]:animate-overlay-in";
