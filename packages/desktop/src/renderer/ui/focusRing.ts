// Whole class names, so Tailwind finds them when it scans the source.

/**
 * A tab whose focusable part is a child, or which focuses itself, ringed only for the keyboard. The
 * ring draws inward, since a tab strip's edge or an island's corner would cut an outer one.
 */
export const TAB_FOCUS_RING =
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-accent";
