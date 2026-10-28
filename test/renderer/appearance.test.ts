import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILT_IN_THEMES, type Appearance } from "@table-craft/desktop/appearance/themes.js";
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
