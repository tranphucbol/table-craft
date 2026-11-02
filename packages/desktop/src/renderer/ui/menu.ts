import { MENU_MOTION } from "@table-craft/desktop/renderer/ui/motion.js";

// Whole class names, so Tailwind finds them when it scans the source. Every menu and every list
// that floats draws from these, so a row is as tall, as inset and as highlighted wherever it opens.

/** A context menu's surface: a 4 px inset, so a `rounded` row nests in `rounded-popover`. */
export const MENU_CONTENT = `z-50 min-w-48 rounded-popover border border-line bg-raised surface-raised p-1 text-ui text-ink shadow-lg ${MENU_MOTION}`;
/** The explorer's, the Services pane's and the editor's context menus, whose titles run longer. */
export const WIDE_MENU_CONTENT = `z-50 min-w-56 rounded-popover border border-line bg-raised surface-raised p-1 text-ui text-ink shadow-lg ${MENU_MOTION}`;
/** A Radix menu item: its title, then its shortcut pushed to the right edge. */
export const MENU_ITEM =
  "flex h-row cursor-default items-center justify-between gap-gap rounded px-gap whitespace-nowrap outline-none data-[disabled]:text-ink-muted data-[highlighted]:bg-selection";
/** A menu row drawn as a plain button, in a popover that is not a Radix menu. */
export const MENU_BUTTON_ITEM =
  "flex h-row w-full cursor-default items-center gap-cell rounded px-gap text-left whitespace-nowrap outline-none hover:bg-selection focus-visible:bg-selection disabled:text-ink-muted disabled:hover:bg-transparent";
export const MENU_SEPARATOR = "my-1 h-px bg-line";
export const MENU_SHORTCUT = "text-ink-muted";
/** The inset of a list inside a `Popover`, matching a menu's. */
export const POPOVER_LIST = "p-1";
