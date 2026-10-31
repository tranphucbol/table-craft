import {
  DEFAULT_FONTS,
  DENSITIES,
  frameColors,
  type Appearance,
  type FontToken,
  type Theme,
} from "@table-craft/desktop/appearance/themes.js";
import { MOTION, resolveMotion } from "@table-craft/desktop/appearance/motion.js";
import type { FontSetting, Settings } from "@table-craft/desktop/settings/settings.js";

export * from "@table-craft/desktop/appearance/themes.js";

function quoteFamily(family: string): string {
  return `"${family.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A chosen family goes ahead of the built-in stack, so a font that is gone falls back to it. */
export function fontStack(family: string | null, builtIn: string): string {
  return family === null ? builtIn : `${quoteFamily(family)}, ${builtIn}`;
}

function fontOf(setting: FontSetting, builtIn: FontToken): FontToken {
  return { family: fontStack(setting.family, builtIn.family), sizePx: setting.sizePx };
}

/** The tokens the settings, the resolved theme and the OS's motion preference draw with. */
export function appearanceOf(
  settings: Settings,
  theme: Theme,
  system: { readonly prefersReducedMotion: boolean },
): Appearance {
  const { fonts, density, motion, windowStyle } = settings.appearance;
  return {
    colors: theme.colors,
    windowStyle,
    frame: frameColors(theme),
    fonts: {
      ui: fontOf(fonts.ui, DEFAULT_FONTS.ui),
      editor: fontOf(fonts.editor, DEFAULT_FONTS.editor),
      grid: fontOf(fonts.grid, DEFAULT_FONTS.grid),
    },
    density: DENSITIES[density],
    motion: MOTION[resolveMotion(motion, system.prefersReducedMotion)],
  };
}
