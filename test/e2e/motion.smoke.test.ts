/**
 * Plan 109's live test: surfaces animate in from the motion tokens, close in the same frame so
 * focus returns at once, and `appearance.motion` turns the motion down live. SQLite in memory, so
 * it needs only a display and a fresh build:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/109 bun run test:smoke:headless test/e2e/motion.smoke.test.ts
 *
 * An entrance lasts 100-200 ms, shorter than a screenshot takes, so a capture pauses the surface's
 * animations halfway first.
 */
import type { Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeApp,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  mainToolbar,
  newProfile,
  pressChord,
  runAllButton,
  SCENARIO_TIMEOUT_MS,
  seedSettings,
  SMOKE_ENABLED,
  setWindowSize,
  sqlEditor,
  startStatement,
  waitUntilReady,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("109");

/** Counts far enough that SQLite is still busy when the spinner is checked. */
const LONG_QUERY =
  "WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 500000000) SELECT count(*) FROM g";
const TYPED_AFTER_ESCAPE = "x";

interface Frozen {
  readonly names: readonly string[];
  readonly opacity: number;
  readonly transform: string;
}

/** The few DOM members the evaluations touch; the e2e program is compiled without the DOM lib. */
interface Animated {
  getAnimations(): readonly {
    pause(): void;
    currentTime: number | null;
    readonly animationName?: string;
    readonly effect: { getTiming(): { readonly duration?: unknown } } | null;
  }[];
  readonly ownerDocument: {
    readonly defaultView: {
      getComputedStyle(element: Animated): {
        readonly opacity: string;
        readonly transform: string;
        readonly animationName: string;
        readonly animationPlayState: string;
        getPropertyValue(name: string): string;
      };
    };
  };
}

/** Pauses every animation on the surface halfway and reports what is drawn at that instant. */
async function freezeHalfway(surface: Locator): Promise<Frozen> {
  return surface.evaluate((element: Animated) => {
    const animations = element.getAnimations();
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = Number(animation.effect?.getTiming().duration ?? 0) / 2;
    }
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    return {
      names: animations.map((animation) => animation.animationName ?? ""),
      opacity: Number(style.opacity),
      transform: style.transform,
    };
  });
}

/** The translation a computed `transform` draws, `[0, 0]` for `none`. */
function travelOf(transform: string): readonly [number, number] {
  const values = /^matrix\((.+)\)$/.exec(transform)?.[1]?.split(",").map(Number);
  return values === undefined ? [0, 0] : [values[4] ?? 0, values[5] ?? 0];
}

async function rootVariable(page: Page, name: string): Promise<string> {
  return page
    .locator("html")
    .evaluate(
      (element: Animated, variable) =>
        element.ownerDocument.defaultView.getComputedStyle(element).getPropertyValue(variable).trim(),
      name,
    );
}

function palette(page: Page) {
  return page.getByRole("dialog", { name: "Find Action", exact: true });
}

function datasourceList(page: Page) {
  return page.getByRole("dialog", { name: "Switch data source", exact: true });
}

function settingsDialog(page: Page) {
  return page.getByRole("dialog", { name: "Settings" });
}

function motionChoice(page: Page, label: string) {
  return settingsDialog(page)
    .getByRole("radiogroup", { name: "Motion", exact: true })
    .getByRole("radio", { name: label, exact: true });
}

describe.runIf(SMOKE_ENABLED)("motion live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  });

  async function launch(motion?: string): Promise<RunningApp> {
    const userDataDir = newProfile();
    if (motion !== undefined) seedSettings(userDataDir, { version: 1, appearance: { motion } });
    running = await launchApp(undefined, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running;
  }

  it(
    "givenFullMotion_whenPaletteOpens_thenContentRunsSurfaceIn",
    async () => {
      const { page } = await launch("full");
      await pressChord(page, "Shift+A");
      await palette(page).waitFor();

      const frame = await freezeHalfway(palette(page));
      expect(frame.names).toContain("tc-surface-in");
      expect(frame.opacity).toBeGreaterThan(0);
      expect(frame.opacity).toBeLessThan(1);
      expect(travelOf(frame.transform)[1]).toBeLessThan(0);
      await captureWindow(page, "01-palette-in");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenFullMotion_whenGridHeaderMenuOpens_thenMenuFadesIn",
    async () => {
      const { page } = await launch("full");
      await sqlEditor(page).fill("SELECT 1 AS one, 'two' AS two");
      await sqlEditor(page).press("Escape");
      await runAllButton(page).click();
      await waitUntilReady(page);
      const header = page.getByRole("columnheader").first();
      await header.waitFor({ timeout: LAUNCH_TIMEOUT_MS });

      await header.click({ button: "right" });
      const menu = page.getByRole("menu").first();
      await menu.waitFor();
      const frame = await freezeHalfway(menu);
      expect(frame.names).toContain("tc-surface-in");
      expect(frame.opacity).toBeLessThan(1);
      await captureWindow(page, "02-menu-in");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenFullMotion_whenPaletteClosedWithEscape_thenUnmountsInSameFrameAndFocusReturns",
    async () => {
      const { page } = await launch("full");
      await sqlEditor(page).click();
      await pressChord(page, "Shift+A");
      await palette(page).waitFor();

      await page.keyboard.press("Escape");
      expect(await palette(page).count()).toBe(0);
      await page.keyboard.type(TYPED_AFTER_ESCAPE);
      await expect.poll(() => sqlEditor(page).textContent()).toContain(TYPED_AFTER_ESCAPE);
      await captureWindow(page, "06-focus");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSystemMotionAndReducedMedia_whenPopoverOpens_thenNoTravel",
    async () => {
      const { page } = await launch();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect.poll(() => rootVariable(page, "--tc-motion-shift")).toBe("0px");

      await mainToolbar(page).getByRole("button", { name: "Data source", exact: true }).click();
      await datasourceList(page).waitFor();
      const frame = await freezeHalfway(datasourceList(page));
      expect(frame.names).toContain("tc-surface-in");
      expect(frame.opacity).toBeLessThan(1);
      expect(travelOf(frame.transform)).toEqual([0, 0]);
      await captureWindow(page, "04-reduced");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenOffMotion_whenQueryRuns_thenSpinnerPaused",
    async () => {
      const { page } = await launch("off");
      await startStatement(page, LONG_QUERY);
      const spinner = page.getByTestId("status-running").locator("svg");
      await spinner.waitFor({ timeout: LAUNCH_TIMEOUT_MS });

      const style = await spinner.evaluate((element: Animated) => {
        const computed = element.ownerDocument.defaultView.getComputedStyle(element);
        return { name: computed.animationName, state: computed.animationPlayState };
      });
      expect(style).toEqual({ name: "spin", state: "paused" });
      await captureWindow(page, "05-off-spinner");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMotionChangedInSettings_whenApplied_thenNoRestartNeeded",
    async () => {
      const { page } = await launch();
      await pressChord(page, ",");
      await settingsDialog(page).waitFor();
      await settingsDialog(page).getByRole("tab", { name: "Appearance", exact: true }).click();
      await expect.poll(() => motionChoice(page, "System").isChecked()).toBe(true);
      await expect.poll(() => rootVariable(page, "--tc-motion-base")).toBe("150ms");

      await motionChoice(page, "Off").check();
      await expect.poll(() => rootVariable(page, "--tc-motion-base")).toBe("0ms");
      await motionChoice(page, "Reduced").check();
      await expect.poll(() => rootVariable(page, "--tc-motion-shift")).toBe("0px");
      await expect.poll(() => rootVariable(page, "--tc-motion-base")).toBe("150ms");
      await motionChoice(page, "Full").check();
      await expect.poll(() => rootVariable(page, "--tc-motion-shift")).toBe("4px");
      await motionChoice(page, "System").check();
      await captureWindow(page, "03-settings");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
