import type { DatasourceColor } from "@table-craft/desktop/preload/bridge.js";

// Whole class names, so Tailwind finds them when it scans the source.

/** The swatch beside a datasource in the tree, the dialog and the colour picker. */
export const TINT_SWATCH: Readonly<Record<DatasourceColor, string>> = {
  red: "bg-ds-red",
  orange: "bg-ds-orange",
  yellow: "bg-ds-yellow",
  green: "bg-ds-green",
  blue: "bg-ds-blue",
  violet: "bg-ds-violet",
};

/** A console tab of a coloured datasource (decision 011). */
export const TINT_TAB: Readonly<Record<DatasourceColor, string>> = {
  red: "bg-ds-red/25",
  orange: "bg-ds-orange/25",
  yellow: "bg-ds-yellow/25",
  green: "bg-ds-green/25",
  blue: "bg-ds-blue/25",
  violet: "bg-ds-violet/25",
};

const TINT_BORDER: Readonly<Record<DatasourceColor, string>> = {
  red: "border-ds-red",
  orange: "border-ds-orange",
  yellow: "border-ds-yellow",
  green: "border-ds-green",
  blue: "border-ds-blue",
  violet: "border-ds-violet",
};

/**
 * The frame around a coloured datasource's console or view. It always meets the bottom of the
 * editor's island, so it rounds there to the island's radius, which is zero in classic (decision 141).
 */
export function tintFrame(color: DatasourceColor | null): string | null {
  return color === null ? null : `border-2 rounded-b-island ${TINT_BORDER[color]}`;
}
