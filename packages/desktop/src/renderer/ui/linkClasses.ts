import { TEXT_PRESS } from "@table-craft/desktop/renderer/ui/pressClasses.js";

/** A link inside running text: underlined on hover, so the sentence keeps its shape. */
export const INLINE_LINK = "text-accent hover:underline";
/** A link standing alone as a button, as Restore Defaults: a hover fill like any other button. */
export const LINK_BUTTON = `${TEXT_PRESS} flex h-row shrink-0 items-center rounded px-1 whitespace-nowrap text-accent enabled:hover:bg-hover disabled:text-ink-muted`;
/** A secondary link button beside a {@link LINK_BUTTON}, as a notice's Dismiss: muted until hovered. */
export const MUTED_LINK_BUTTON = `${TEXT_PRESS} flex h-row shrink-0 items-center rounded px-1 whitespace-nowrap text-ink-muted enabled:hover:bg-hover enabled:hover:text-ink`;
