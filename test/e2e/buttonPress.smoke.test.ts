/**
 * Plan 114's live test: filled buttons (Settings Close, a danger confirm) shade on hover and
 * darken and shrink on the first frame of a press; bordered text buttons and the Run icon (plan
 * 127) tint and shrink; Reduced motion keeps the shade but not the shrink; a disabled Run shows
 * nothing. SQLite in memory:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/114 bun run test:smoke:headless test/e2e/buttonPress.smoke.test.ts
 *
 * Each capture lays crops of the button at rest, hovered and held side by side over the window,
 * since a single window screenshot can show only one state.
 */
import type { ElectronApplication, Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { fillShades } from "@table-craft/desktop/appearance/press.js";
import { BUNDLED_THEMES, type BundledThemeId } from "@table-craft/desktop/appearance/themes.js";
import {
  closeApp,
  CLOSE_HOOK_TIMEOUT_MS,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  pressChord,
  runButton,
  SCENARIO_TIMEOUT_MS,
  SCRATCH,
  seedSettings,
  SMOKE_ENABLED,
  setWindowSize,
  startStatement,
  waitUntilReady,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("114");

const TEXT_PRESS_SCALE = "0.97";
const NO_SCALE = ["1", "none"];
/** Past the 100 ms release fade, so the button is back at rest. */
const RELEASE_SETTLE_MS = 250;
const DESTRUCTIVE = "DELETE FROM probe";
const LONG_QUERY =
  "WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 500000000) SELECT count(*) FROM g";
/** The black shade's alpha in a computed `box-shadow`, e.g. `rgba(0, 0, 0, 0.16) 0px 0px 0px 1200px inset`. */
const BLACK_SHADE = /rgba\(0, 0, 0, ([\d.]+)\)/;
const CROP_PADDING_PX = 10;
const CROP_ZOOM = 4;

/** The DOM members these scenarios read; the e2e program has no DOM lib. */
interface Styled {
  readonly ownerDocument: {
    readonly defaultView: {
      getComputedStyle(element: Styled): { readonly boxShadow: string; readonly scale: string };
    };
  };
}

interface Overlay {
  readonly ownerDocument: {
    readonly body: { append(node: Overlay): void };
    createElement(tag: string): Overlay;
  };
  id: string;
  textContent: string | null;
  src: string;
  readonly style: { cssText: string };
  append(...nodes: Overlay[]): void;
}

interface PressStyle {
  readonly shadow: string;
  readonly scale: string;
}

interface Crop {
  readonly label: string;
  readonly png: string;
}

function pressStyle(button: Locator): Promise<PressStyle> {
  return button.evaluate((element: Styled) => {
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    return { shadow: style.boxShadow, scale: style.scale };
  });
}

function shadeAlpha(shadow: string): number {
  const match = BLACK_SHADE.exec(shadow);
  return match === null ? 0 : Number(match[1]);
}

async function centre(button: Locator): Promise<{ x: number; y: number }> {
  const box = await button.boundingBox();
  if (box === null) throw new Error("The button is not shown.");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * The button and a margin around it, as a PNG data URL. Electron's own capture, since a clipped
 * Playwright screenshot restarts the button's transitions and catches the shade part-way.
 */
async function crop(app: ElectronApplication, button: Locator, label: string): Promise<Crop> {
  const box = await button.boundingBox();
  if (box === null) throw new Error("The button is not shown.");
  const rect = {
    x: Math.floor(box.x - CROP_PADDING_PX),
    y: Math.floor(box.y - CROP_PADDING_PX),
    width: Math.ceil(box.width + CROP_PADDING_PX * 2),
    height: Math.ceil(box.height + CROP_PADDING_PX * 2),
  };
  const png = await app.evaluate(async ({ BrowserWindow }, area) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("The window is not open.");
    return (await window.webContents.capturePage(area)).toPNG().toString("base64");
  }, rect);
  return { label, png: `data:image/png;base64,${png}` };
}

/** Lays `crops` side by side, zoomed, over the window and captures it; the overlay is the evidence's own. */
async function captureStates(page: Page, name: string, anchor: Locator, crops: readonly Crop[]): Promise<void> {
  await anchor.evaluate(
    (element: Overlay, { crops: shown, zoom }: { crops: readonly Crop[]; zoom: number }) => {
      const document = element.ownerDocument;
      const panel = document.createElement("div");
      panel.id = "press-evidence";
      panel.style.cssText =
        "position:fixed;left:50%;top:50%;translate:-50% -50%;z-index:9999;display:flex;gap:24px;padding:16px;background:#808080;border-radius:8px;font:600 14px sans-serif;color:#000";
      for (const { label, png } of shown) {
        const figure = document.createElement("figure");
        figure.style.cssText = "margin:0;display:flex;flex-direction:column;align-items:center;gap:8px";
        const image = document.createElement("img");
        image.src = png;
        image.style.cssText = `zoom:${String(zoom)};image-rendering:pixelated`;
        const caption = document.createElement("figcaption");
        caption.textContent = label;
        figure.append(image, caption);
        panel.append(figure);
      }
      document.body.append(panel);
    },
    { crops, zoom: CROP_ZOOM },
  );
  await page.locator("#press-evidence img").last().waitFor();
  await captureWindow(page, name);
  await page.locator("#press-evidence").evaluate((element: Overlay & { remove(): void }) => element.remove());
}

describe.runIf(SMOKE_ENABLED)("tactile button press live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(appearance: { theme?: BundledThemeId; motion?: string } = {}): Promise<Page> {
    const userDataDir = newProfile();
    seedSettings(userDataDir, { version: 1, appearance: { theme: "dark", ...appearance } });
    running = await launchApp(SCRATCH, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running.page;
  }

  function accentShades(theme: BundledThemeId) {
    const { colors } = BUNDLED_THEMES[theme];
    return fillShades(colors.accent, colors.accentInk);
  }

  /** Rest, hover and held for `button`, released off it so nothing is clicked; returns the held style. */
  async function pressThrough(page: Page, button: Locator, evidence: string): Promise<PressStyle> {
    if (running === null) throw new Error("The app is not running.");
    const { app } = running;
    await page.mouse.move(0, 0);
    await page.waitForTimeout(RELEASE_SETTLE_MS);
    const rest = await crop(app, button, "rest");
    const { x, y } = await centre(button);
    await page.mouse.move(x, y);
    await page.waitForTimeout(RELEASE_SETTLE_MS);
    const hovered = await crop(app, button, "hovered");
    await page.mouse.down();
    const held = await pressStyle(button);
    const heldCrop = await crop(app, button, "held");
    await page.mouse.move(0, 0);
    await page.mouse.up();
    await captureStates(page, evidence, button, [rest, hovered, heldCrop]);
    return held;
  }

  /** The Settings dialog's Close, the filled button every theme shows without running anything. */
  async function settingsClose(page: Page): Promise<Locator> {
    await pressChord(page, ",");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    return settings.getByRole("button", { name: "Close", exact: true });
  }

  it(
    "givenFilledButton_whenMouseDown_thenFullShadeOnTheFirstFrame",
    async () => {
      const page = await launch();
      const close = await settingsClose(page);
      const { x, y } = await centre(close);
      await page.mouse.move(x, y);

      await page.mouse.down();
      const first = await pressStyle(close);
      await page.mouse.move(0, 0);
      await page.mouse.up();

      expect(shadeAlpha(first.shadow)).toBeCloseTo(accentShades("dark").press, 2);
      expect(first.scale).toBe(TEXT_PRESS_SCALE);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenFilledButton_whenHovered_thenHoverShade",
    async () => {
      const page = await launch();
      const close = await settingsClose(page);
      const { x, y } = await centre(close);

      await page.mouse.move(x, y);

      await expect
        .poll(async () => shadeAlpha((await pressStyle(close)).shadow))
        .toBeCloseTo(accentShades("dark").hover, 2);
      expect((await pressStyle(close)).scale).toBe("none");
    },
    SCENARIO_TIMEOUT_MS,
  );

  for (const [theme, evidence] of [
    ["dark", "01-filled-dark"],
    ["light", "02-filled-light"],
    ["highContrast", "03-filled-hc"],
  ] as const) {
    it(
      `givenFilledButton_whenHeld_thenDarkerAndShrunkUntilReleased (${theme})`,
      async () => {
        const page = await launch({ theme });
        const close = await settingsClose(page);

        const held = await pressThrough(page, close, evidence);
        await page.waitForTimeout(RELEASE_SETTLE_MS);
        const released = await pressStyle(close);

        expect(shadeAlpha(held.shadow)).toBeCloseTo(accentShades(theme).press, 2);
        expect(held.scale).toBe(TEXT_PRESS_SCALE);
        expect(released).toEqual({ shadow: "none", scale: "none" });
        expect(await page.getByRole("dialog", { name: "Settings" }).isVisible()).toBe(true);
      },
      SCENARIO_TIMEOUT_MS,
    );
  }

  it(
    "givenRunIcon_whenHeld_thenInkTintAndShrunk",
    async () => {
      const page = await launch();
      const run = runButton(page);

      const held = await pressThrough(page, run, "04-run-icon");

      expect(held.shadow).toContain("inset");
      expect(shadeAlpha(held.shadow)).toBe(0);
      expect(NO_SCALE).not.toContain(held.scale);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenDangerConfirm_whenHeld_thenDarkerByItsCappedShadeAndShrunk",
    async () => {
      const page = await launch();
      await startStatement(page, DESTRUCTIVE);
      const dialog = page.getByRole("dialog", { name: "Run a destructive statement?" });
      await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      const execute = dialog.getByRole("button", { name: "Execute", exact: true });
      const { colors } = BUNDLED_THEMES.dark;

      const held = await pressThrough(page, execute, "05-danger");

      expect(shadeAlpha(held.shadow)).toBeCloseTo(fillShades(colors.danger, colors.accentInk).press, 2);
      expect(shadeAlpha(held.shadow)).toBeGreaterThan(0);
      expect(held.scale).toBe(TEXT_PRESS_SCALE);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenDialogCancel_whenHeld_thenInkTintAndShrunk",
    async () => {
      const page = await launch();
      await startStatement(page, DESTRUCTIVE);
      const dialog = page.getByRole("dialog", { name: "Run a destructive statement?" });
      await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
      const { x, y } = await centre(cancel);
      await page.mouse.move(x, y);

      await page.mouse.down();
      const held = await pressStyle(cancel);
      await page.mouse.move(0, 0);
      await page.mouse.up();

      expect(held.shadow).toContain("inset");
      expect(shadeAlpha(held.shadow)).toBe(0);
      expect(held.scale).toBe(TEXT_PRESS_SCALE);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenReducedMotion_whenFilledHeld_thenShadedButNotShrunk",
    async () => {
      const page = await launch({ motion: "reduced" });
      const close = await settingsClose(page);

      const held = await pressThrough(page, close, "06-reduced");

      expect(shadeAlpha(held.shadow)).toBeCloseTo(accentShades("dark").press, 2);
      expect(NO_SCALE).toContain(held.scale);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenRunDisabled_whenHeld_thenNoShade",
    async () => {
      const page = await launch();
      const run = runButton(page);
      await startStatement(page, LONG_QUERY);
      await expect.poll(() => run.isEnabled(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(false);
      const { x, y } = await centre(run);
      await page.mouse.move(x, y);

      await page.mouse.down();
      const held = await pressStyle(run);
      await page.mouse.up();

      expect(held).toEqual({ shadow: "none", scale: "none" });
    },
    SCENARIO_TIMEOUT_MS,
  );
});
