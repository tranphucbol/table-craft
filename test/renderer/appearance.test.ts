import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_THEMES,
  COMPACT_DENSITY,
  ELEVATION,
  frameColors,
  type Appearance,
  type DensityId,
  type Theme,
  type WindowStyle,
} from "@table-craft/desktop/appearance/themes.js";
import { appearanceVariables } from "@table-craft/desktop/renderer/appearance/apply.js";
import { appearanceOf } from "@table-craft/desktop/renderer/appearance/tokens.js";
import { createSettingsStore } from "@table-craft/desktop/renderer/state/settings.js";
import { installAppearance } from "@table-craft/desktop/renderer/state/wiring.js";
import { DEFAULT_SETTINGS, type Settings } from "@table-craft/desktop/settings/settings.js";
import type { MotionChoice } from "@table-craft/desktop/appearance/motion.js";

const RENDERER = resolve(import.meta.dirname, "../../packages/desktop/src/renderer");
/** The one renderer module allowed to spell an animation (plan 109 decision 2). */
const MOTION_CLASSES = join("ui", "motion.ts");
const SOURCE = /\.tsx?$/;
const MOTION_LITERAL = /duration-\[|animate-\[|\b\d+(?:\.\d+)?m?s\b/;
const NO_PREFERENCE = { prefersReducedMotion: false };

function withMotion(motion: MotionChoice): Settings {
  return { ...DEFAULT_SETTINGS, appearance: { ...DEFAULT_SETTINGS.appearance, motion } };
}

function fakeMedia(matches: boolean) {
  const listeners = new Set<() => void>();
  return {
    matches,
    addEventListener: (_type: string, listener: () => void) => void listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => void listeners.delete(listener),
    flip(next: boolean) {
      this.matches = next;
      for (const listener of listeners) listener();
    },
  };
}

function installed(settings: Settings) {
  const store = createSettingsStore({
    bridge: () => {
      throw new Error("no bridge in this test");
    },
    log: () => undefined,
  });
  store.setState({ settings });
  const reducedMotion = fakeMedia(false);
  const other = fakeMedia(false);
  const applied: Appearance[] = [];
  const stop = installAppearance(store, {
    matchMedia: (query) => (query.includes("reduced-motion") ? reducedMotion : other),
    apply: (appearance) => void applied.push(appearance),
  });
  return { reducedMotion, applied, stop };
}

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return SOURCE.test(entry.name) ? [path] : [];
  });
}

describe("motion variables", () => {
  it("givenOffMotion_whenVariablesBuilt_thenMotionDurationsAreZeroMs", () => {
    const variables = appearanceVariables(appearanceOf(withMotion("off"), BUILT_IN_THEMES.dark, NO_PREFERENCE));

    expect(variables).toMatchObject({
      "--tc-motion-fast": "0ms",
      "--tc-motion-base": "0ms",
      "--tc-motion-slow": "0ms",
      "--tc-motion-flash": "0ms",
      "--tc-motion-shift": "0px",
      "--tc-motion-enter-scale": "1",
      "--tc-motion-press-scale": "1",
      "--tc-motion-press-scale-text": "1",
      "--tc-motion-progress": "paused",
      "--tc-motion-ambient": "paused",
      "--tc-fill-hover-shade": "rgb(0 0 0 / 8%)",
      "--tc-fill-press-shade": "rgb(0 0 0 / 16%)",
    });
  });

  it("givenReducedMotionQueryChanges_whenChoiceIsSystem_thenVariablesReapplied", () => {
    const { reducedMotion, applied, stop } = installed(withMotion("system"));

    reducedMotion.flip(true);
    reducedMotion.flip(false);
    stop();

    expect(applied.map((appearance) => appearanceVariables(appearance)["--tc-motion-shift"])).toEqual([
      "4px",
      "0px",
      "4px",
    ]);
  });

  it("givenReducedMotionQueryChanges_whenChoiceIsFull_thenVariablesUnchanged", () => {
    const { reducedMotion, applied, stop } = installed(withMotion("full"));

    reducedMotion.flip(true);
    stop();

    const variables = applied.map((appearance) => appearanceVariables(appearance));
    expect(variables.length).toBeGreaterThan(0);
    for (const each of variables) {
      expect(each).toMatchObject({ "--tc-motion-shift": "4px", "--tc-motion-ambient": "running" });
    }
  });

  it("givenRendererSources_whenScanned_thenNoMotionLiterals", () => {
    const offenders = sources(RENDERER)
      .map((path) => relative(RENDERER, path))
      .filter((path) => path !== MOTION_CLASSES)
      .filter((path) => MOTION_LITERAL.test(readFileSync(join(RENDERER, path), "utf8")));

    expect(offenders).toEqual([]);
  });
});

function withWindowStyle(windowStyle: WindowStyle, density: DensityId = "comfortable"): Settings {
  return { ...DEFAULT_SETTINGS, appearance: { ...DEFAULT_SETTINGS.appearance, windowStyle, density } };
}

describe("island variables", () => {
  it("givenIslands_whenVariablesBuilt_thenFrameGapAndRadiusAreSet", () => {
    const theme = BUILT_IN_THEMES.light;
    const frame = frameColors(theme);

    expect(appearanceVariables(appearanceOf(withWindowStyle("islands"), theme, NO_PREFERENCE))).toMatchObject({
      "--tc-frame": frame.frame,
      "--tc-frame-raised": frame.frameRaised,
      "--tc-island-edge": frame.islandEdge,
      "--tc-island-gap": "5px",
      "--tc-island-radius": "10px",
    });
    expect(
      appearanceVariables(appearanceOf(withWindowStyle("islands", "compact"), theme, NO_PREFERENCE)),
    ).toMatchObject({ "--tc-island-gap": "4px", "--tc-island-radius": "8px" });
  });

  it("givenClassic_whenVariablesBuilt_thenIslandRadiusIsZero", () => {
    const variables = appearanceVariables(
      appearanceOf(withWindowStyle("classic"), BUILT_IN_THEMES.dark, NO_PREFERENCE),
    );

    expect(variables["--tc-island-radius"]).toBe("0px");
  });

  it("givenIslands_whenVariablesBuilt_thenPanesInsetByTheRadiusUnderATabHighHeader", () => {
    const variables = (density: DensityId) =>
      appearanceVariables(appearanceOf(withWindowStyle("islands", density), BUILT_IN_THEMES.dark, NO_PREFERENCE));

    expect(variables("comfortable")).toMatchObject({ "--tc-pane-inset": "10px", "--tc-tool-header-height": "32px" });
    expect(variables("compact")).toMatchObject({
      "--tc-pane-inset": "8px",
      "--tc-tool-header-height": `${String(COMPACT_DENSITY.tabHeightPx)}px`,
    });
  });

  it("givenClassic_whenVariablesBuilt_thenPanesKeepTheGapAndARowHighHeader", () => {
    const variables = (density: DensityId) =>
      appearanceVariables(appearanceOf(withWindowStyle("classic", density), BUILT_IN_THEMES.dark, NO_PREFERENCE));

    expect(variables("comfortable")).toMatchObject({ "--tc-pane-inset": "8px", "--tc-tool-header-height": "24px" });
    expect(variables("compact")).toMatchObject({
      "--tc-pane-inset": `${String(COMPACT_DENSITY.gapPx)}px`,
      "--tc-tool-header-height": `${String(COMPACT_DENSITY.rowHeightPx)}px`,
    });
  });
});

const DENSITY_IDS: readonly DensityId[] = ["comfortable", "compact"];
const WINDOW_STYLES: readonly WindowStyle[] = ["islands", "classic"];

function radiiOf(windowStyle: WindowStyle, density: DensityId) {
  const variables = appearanceVariables(
    appearanceOf(withWindowStyle(windowStyle, density), BUILT_IN_THEMES.dark, NO_PREFERENCE),
  );
  const px = (name: string) => Number.parseFloat(variables[name] ?? "");
  return {
    dialog: px("--tc-dialog-radius"),
    popover: px("--tc-popover-radius"),
    tooltip: px("--tc-tooltip-radius"),
  };
}

describe("floating surface radii", () => {
  it("givenIslands_whenVariablesBuilt_thenDialogRadiusIsTheIslandRadius", () => {
    expect(radiiOf("islands", "comfortable").dialog).toBe(10);
    expect(radiiOf("islands", "compact").dialog).toBe(8);
  });

  it("givenClassic_whenVariablesBuilt_thenDialogRadiusStaysEight", () => {
    for (const density of DENSITY_IDS) expect(radiiOf("classic", density).dialog).toBe(8);
  });

  it("givenIslands_whenVariablesBuilt_thenPopoverRadiusIsEightAndTooltipFour", () => {
    for (const density of DENSITY_IDS) {
      expect(radiiOf("islands", density)).toMatchObject({ popover: 8, tooltip: 4 });
    }
  });

  it("givenClassic_whenVariablesBuilt_thenPopoverAndTooltipRadiiStayFour", () => {
    for (const density of DENSITY_IDS) {
      expect(radiiOf("classic", density)).toMatchObject({ popover: 4, tooltip: 4 });
    }
  });

  it("givenEveryDensityAndWindowStyle_whenVariablesBuilt_thenDialogNeverRoundsLessThanPopoverOrPopoverLessThanTooltip", () => {
    for (const windowStyle of WINDOW_STYLES) {
      for (const density of DENSITY_IDS) {
        const { dialog, popover, tooltip } = radiiOf(windowStyle, density);
        expect(dialog).toBeGreaterThanOrEqual(popover);
        expect(popover).toBeGreaterThanOrEqual(tooltip);
      }
    }
  });
});

function shadowsOf(theme: Theme) {
  const variables = appearanceVariables(appearanceOf(DEFAULT_SETTINGS, theme, NO_PREFERENCE));
  return { popover: variables["--tc-popover-shadow"], dialog: variables["--tc-dialog-shadow"] };
}

/** The darkest layer's alpha: what decides whether the shadow shows on the canvas. */
function peakAlpha(shadow: string | undefined): number {
  return Math.max(...[...(shadow ?? "").matchAll(/\/ ([\d.]+)\)/g)].map(([, alpha]) => Number(alpha)));
}

describe("floating surface shadows", () => {
  it("givenEachScheme_whenVariablesBuilt_thenShadowsAreThatSchemesElevation", () => {
    expect(shadowsOf(BUILT_IN_THEMES.light)).toEqual(ELEVATION.light);
    expect(shadowsOf(BUILT_IN_THEMES.dark)).toEqual(ELEVATION.dark);
    expect(shadowsOf(BUILT_IN_THEMES.highContrast)).toEqual(ELEVATION.dark);
  });

  it("givenDarkAndLight_whenVariablesBuilt_thenDarkCastsTheDarkerShadow", () => {
    const dark = shadowsOf(BUILT_IN_THEMES.dark);
    const light = shadowsOf(BUILT_IN_THEMES.light);

    expect(peakAlpha(dark.popover)).toBeGreaterThan(peakAlpha(light.popover));
    expect(peakAlpha(dark.dialog)).toBeGreaterThan(peakAlpha(light.dialog));
  });

  it("givenEachScheme_whenVariablesBuilt_thenADialogCastsDarkerThanAPopover", () => {
    for (const theme of [BUILT_IN_THEMES.light, BUILT_IN_THEMES.dark]) {
      const { popover, dialog } = shadowsOf(theme);
      expect(peakAlpha(dialog)).toBeGreaterThan(peakAlpha(popover));
    }
  });
});
