import { fillShades, shadeColor } from "@table-craft/desktop/appearance/press.js";
import {
  EDITOR_TOOLTIP_RADIUS_PX,
  TRAFFIC_LIGHT_INSET_PX,
  type Appearance,
  type ColorScheme,
} from "@table-craft/desktop/renderer/appearance/tokens.js";

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** The CSS variables `app.css` maps onto Tailwind's theme. */
export function appearanceVariables(appearance: Appearance): Readonly<Record<string, string>> {
  const { colors, fonts, density, motion, frame, windowStyle } = appearance;
  const accentShades = fillShades(colors.accent, colors.accentInk);
  const dangerShades = fillShades(colors.danger, colors.accentInk);
  const islands = windowStyle === "islands";
  return {
    "--tc-canvas": colors.canvas,
    "--tc-frame": frame.frame,
    "--tc-frame-raised": frame.frameRaised,
    "--tc-island-edge": frame.islandEdge,
    "--tc-editor-tooltip-radius": `${EDITOR_TOOLTIP_RADIUS_PX}px`,
    "--tc-panel": colors.panel,
    "--tc-raised": colors.raised,
    "--tc-border": colors.border,
    "--tc-ink": colors.ink,
    "--tc-ink-muted": colors.inkMuted,
    "--tc-accent": colors.accent,
    "--tc-accent-ink": colors.accentInk,
    "--tc-danger": colors.danger,
    "--tc-success": colors.success,
    "--tc-grid-stripe": colors.gridStripe,
    "--tc-grid-selection": colors.gridSelection,
    "--tc-grid-null": colors.gridNull,
    "--tc-edit-modified": colors.editModified,
    "--tc-edit-inserted": colors.editInserted,
    "--tc-edit-deleted": colors.editDeleted,
    "--tc-selection": colors.selection,
    "--tc-search-match": colors.searchMatch,
    "--tc-key-icon": colors.keyIcon,
    "--tc-warning": colors.warning,
    "--tc-statement-flash": colors.statementFlash,
    "--tc-plan-bar": colors.planBar,
    "--tc-analysed-banner": colors.analysedBanner,
    ...Object.fromEntries(Object.entries(colors.datasource).map(([name, value]) => [`--tc-ds-${name}`, value])),
    ...Object.fromEntries(Object.entries(colors.syntax).map(([name, value]) => [`--tc-syntax-${kebab(name)}`, value])),
    "--tc-font-ui": fonts.ui.family,
    "--tc-font-ui-size": `${fonts.ui.sizePx}px`,
    "--tc-font-editor": fonts.editor.family,
    "--tc-font-editor-size": `${fonts.editor.sizePx}px`,
    "--tc-font-grid": fonts.grid.family,
    "--tc-font-grid-size": `${fonts.grid.sizePx}px`,
    "--tc-row-height": `${density.rowHeightPx}px`,
    "--tc-cell-padding": `${density.cellPaddingPx}px`,
    "--tc-gap": `${density.gapPx}px`,
    "--tc-grid-column-max-width": `${density.gridColumnMaxWidthPx}px`,
    "--tc-value-panel-width": `${density.valuePanelWidthPx}px`,
    "--tc-console-height": `${density.consoleHeightPx}px`,
    "--tc-stripe-width": `${density.stripeWidthPx}px`,
    "--tc-tab-height": `${density.tabHeightPx}px`,
    "--tc-title-bar-height": `${density.titleBarHeightPx}px`,
    "--tc-traffic-light-inset": `${TRAFFIC_LIGHT_INSET_PX}px`,
    "--tc-status-bar-height": `${density.statusBarHeightPx}px`,
    "--tc-icon": `${density.iconPx}px`,
    "--tc-palette-width": `${density.paletteWidthPx}px`,
    "--tc-dialog-width": `${density.dialogWidthPx}px`,
    "--tc-dialog-height": `${density.dialogHeightPx}px`,
    "--tc-dialog-list-width": `${density.dialogListWidthPx}px`,
    "--tc-dialog-label-max": `${density.dialogLabelMaxPx}px`,
    "--tc-popover-width": `${density.popoverWidthPx}px`,
    "--tc-popover-height": `${density.popoverHeightPx}px`,
    "--tc-generator-width": `${density.generatorWidthPx}px`,
    "--tc-picker-width": `${density.pickerWidthPx}px`,
    "--tc-picker-list-height": `${density.pickerListHeightPx}px`,
    "--tc-plan-details-width": `${density.planDetailsWidthPx}px`,
    "--tc-plan-bar-height": `${density.planBarHeightPx}px`,
    "--tc-island-gap": `${density.islandGapPx}px`,
    "--tc-island-radius": `${islands ? density.islandRadiusPx : 0}px`,
    "--tc-pane-inset": `${islands ? density.islandRadiusPx : density.gapPx}px`,
    "--tc-tool-header-height": `${islands ? density.tabHeightPx : density.rowHeightPx}px`,
    "--tc-motion-fast": `${motion.fastMs}ms`,
    "--tc-motion-base": `${motion.baseMs}ms`,
    "--tc-motion-slow": `${motion.slowMs}ms`,
    "--tc-motion-flash": `${motion.flashMs}ms`,
    "--tc-motion-shift": `${motion.shiftPx}px`,
    "--tc-motion-enter-scale": String(motion.enterScale),
    "--tc-motion-press-scale": String(motion.pressScale),
    "--tc-motion-press-scale-text": String(motion.pressScaleText),
    "--tc-motion-progress": motion.progress,
    "--tc-motion-ambient": motion.ambient,
    "--tc-fill-hover-shade": shadeColor(accentShades.hover),
    "--tc-fill-press-shade": shadeColor(accentShades.press),
    "--tc-danger-hover-shade": shadeColor(dangerShades.hover),
    "--tc-danger-press-shade": shadeColor(dangerShades.press),
  };
}

/** Writes every variable, and `color-scheme` so native controls match the theme; `app.css` colours the scrollbars. */
export function applyAppearance(
  appearance: Appearance,
  colorScheme: ColorScheme,
  root: HTMLElement = document.documentElement,
): void {
  for (const [name, value] of Object.entries(appearanceVariables(appearance))) root.style.setProperty(name, value);
  root.style.setProperty("color-scheme", colorScheme);
}
