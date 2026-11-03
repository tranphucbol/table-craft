/**
 * Plan 145's live test: the notification bell under MCP Server Settings on the right stripe. A
 * fake home holds DataGrip's and TablePro's saved connections (plan 035's fixture), and
 * `TABLE_CRAFT_DEVELOPMENT_VERSION` makes a development run report a released version, so an
 * update notice can appear. The notice memory is seeded through the renderer's `localStorage`
 * between two launches of one profile. SQLite only, so it needs only a display and a fresh build:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/145 bun run test:smoke:headless test/e2e/notifications.smoke.test.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  ELEVATION,
  CLASSIC_POPOVER_RADIUS_PX,
  ISLANDS_POPOVER_RADIUS_PX,
} from "@table-craft/desktop/appearance/themes.js";
import { UPDATE_OVERRIDE_ENV } from "@table-craft/desktop/main/update/overrides.js";
import { NOTICES_STORAGE_KEY, type NoticeMemory } from "@table-craft/desktop/renderer/model/notices.js";
import { writeImportFixture } from "../support/import/fixtures.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  cornerRadius,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  SCENARIO_TIMEOUT_MS,
  seedSettings,
  setWindowSize,
  SMOKE_ENABLED,
  toolWindow,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("145");
const HOME_PREFIX = "table-craft-notices-home-";
const FIXTURE_PASSWORD = "unused";
/** Unreachable on purpose: the import is only read and saved, never connected. */
const NOWHERE = { host: "127.0.0.1", port: 1 } as const;
const PREVIOUS_VERSION = "1.8.0";
const CURRENT_VERSION = "1.9.0";
const RELEASE_TAG_URL = `https://github.com/tranphucbol/table-craft/releases/tag/v${CURRENT_VERSION}`;
const HALO_WAVES = "3";
/** Long enough for the launch scan to answer, after which a notice would have shown its dot. */
const SETTLE_MS = 2_000;
const THEMES = ["light", "dark", "highContrast"] as const;
const WINDOW_STYLES = ["islands", "classic"] as const;

/** The few DOM members the evaluations touch; the e2e program is compiled without the DOM lib. */
interface PseudoStyled {
  readonly ownerDocument: {
    readonly defaultView: {
      getComputedStyle(
        element: PseudoStyled,
        pseudo?: string,
      ): {
        readonly animationIterationCount: string;
        readonly animationPlayState: string;
        readonly animationName: string;
        readonly boxShadow: string;
        readonly backgroundColor: string;
      };
    };
  };
}
interface Animated {
  getAnimations(options: { readonly subtree: boolean }): readonly { readonly finished: Promise<unknown> }[];
}
interface StorageWindow {
  readonly localStorage: { setItem(key: string, value: string): void; getItem(key: string): string | null };
}

function emptyHome(): string {
  return mkdtempSync(join(tmpdir(), HOME_PREFIX));
}

function importHome(): string {
  const home = emptyHome();
  writeImportFixture(home, {
    mysql: NOWHERE,
    postgres: NOWHERE,
    passwords: "keepass",
    platform: process.platform,
    password: FIXTURE_PASSWORD,
  });
  return home;
}

function bell(page: Page): Locator {
  return page.getByTestId("notification-bell");
}

function dot(page: Page): Locator {
  return page.getByTestId("notification-dot");
}

function popover(page: Page): Locator {
  return page.getByTestId("notices-popover");
}

function notice(page: Page, id: string): Locator {
  return popover(page).getByTestId(`notice-${id}`);
}

function importDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Import Data Sources" });
}

async function halo(
  element: Locator,
): Promise<{ readonly name: string; readonly waves: string; readonly state: string }> {
  return element.evaluate((node: PseudoStyled) => {
    const style = node.ownerDocument.defaultView.getComputedStyle(node, "::before");
    return { name: style.animationName, waves: style.animationIterationCount, state: style.animationPlayState };
  });
}

async function surface(element: Locator): Promise<{ readonly shadow: string; readonly background: string }> {
  return element.evaluate((node: PseudoStyled) => {
    const style = node.ownerDocument.defaultView.getComputedStyle(node);
    return { shadow: style.boxShadow, background: style.backgroundColor };
  });
}

/** Waits for the entry motion of `element` so a capture shows it at rest, not mid-fade. */
async function settled(element: Locator): Promise<void> {
  await element.evaluate((node: Animated) =>
    Promise.all(node.getAnimations({ subtree: true }).map((animation) => animation.finished)),
  );
}

function titled(name: string): string {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/** The black layers of an `ELEVATION` shadow as Chromium computes them, `rgb(0 0 0 / a)` to `rgba(0, 0, 0, a)`. */
function computedLayers(shadow: string): string[] {
  return [...shadow.matchAll(/rgb\(0 0 0 \/ ([\d.]+)\)/g)].map(([, alpha]) => `rgba(0, 0, 0, ${String(alpha)})`);
}

describe.runIf(SMOKE_ENABLED)("notification bell live test", () => {
  let running: RunningApp | null = null;

  afterEach(() => closeRunning(), CLOSE_HOOK_TIMEOUT_MS);

  async function launch(
    options: {
      readonly home?: string;
      readonly version?: string;
      readonly userDataDir?: string;
      readonly appearance?: object;
    } = {},
  ): Promise<Page> {
    const userDataDir = options.userDataDir ?? newProfile();
    if (options.appearance !== undefined) seedSettings(userDataDir, { version: 1, appearance: options.appearance });
    const env: Record<string, string> = { HOME: options.home ?? emptyHome() };
    if (options.version !== undefined) env[UPDATE_OVERRIDE_ENV.developmentVersion] = options.version;
    running = await launchApp(null, { userDataDir, env });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await toolWindow(running.page, "Database").waitFor();
    await bell(running.page).waitFor();
    return running.page;
  }

  async function closeRunning(): Promise<void> {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }

  /** Lets a first launch write its memory, rewrites it with `change`, then relaunches the profile. */
  async function relaunchWith(
    change: (stored: NoticeMemory) => NoticeMemory,
    options: { readonly version?: string; readonly appearance?: object } = {},
  ): Promise<{ readonly page: Page; readonly userDataDir: string }> {
    const userDataDir = newProfile();
    const first = await launch({ userDataDir, ...options });
    const read = () =>
      first.evaluate((key) => (globalThis as unknown as StorageWindow).localStorage.getItem(key), NOTICES_STORAGE_KEY);
    await expect.poll(read).not.toBeNull();
    const stored = JSON.parse((await read()) ?? "null") as NoticeMemory;
    await first.evaluate(([key, value]) => (globalThis as unknown as StorageWindow).localStorage.setItem(key, value), [
      NOTICES_STORAGE_KEY,
      JSON.stringify(change(stored)),
    ] as const);
    await closeRunning();
    return { page: await launch({ userDataDir, ...options }), userDataDir };
  }

  async function openBell(page: Page): Promise<Locator> {
    await bell(page).click();
    await popover(page).waitFor();
    await settled(popover(page));
    return popover(page);
  }

  it(
    "givenDataGripFixture_whenLaunch_thenDotAndImportNotice",
    async () => {
      const page = await launch({ home: importHome(), appearance: { theme: "dark" } });

      await dot(page).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await halo(dot(page))).toEqual({ name: "tc-halo", waves: HALO_WAVES, state: "running" });
      expect(await bell(page).getAttribute("aria-label")).toMatch(/^Notifications, \d+ new$/);
      expect(await popover(page).count()).toBe(0);
      await captureWindow(page, "01-dot");

      await openBell(page);
      await notice(page, "import:datagrip").waitFor();
      expect(await notice(page, "import:datagrip").textContent()).toMatch(/connections? found in DataGrip/);
      await expect.poll(() => dot(page).count()).toBe(0);
      expect(await bell(page).getAttribute("aria-label")).toBe("Notifications");
      await captureWindow(page, "01-import");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenImportNotice_whenImport_thenDialogOnDataGripPreviewAndNoticeResolved",
    async () => {
      const page = await launch({ home: importHome(), appearance: { theme: "dark" } });
      await openBell(page);

      await notice(page, "import:datagrip").getByTestId("notice-action").click();

      await importDialog(page).getByTestId("import-rows").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await importDialog(page).getByTestId("import-sources").count()).toBe(0);
      await settled(importDialog(page));
      await captureWindow(page, "02-preview");
      await importDialog(page).getByRole("button", { name: "Import", exact: true }).click();
      await importDialog(page).getByTestId("import-summary").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await importDialog(page).getByRole("button", { name: "Done" }).click();

      await openBell(page);
      await expect.poll(() => notice(page, "import:datagrip").count()).toBe(0);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenOlderStoredVersion_whenOpenBell_thenUpdatedNoticeAndReleaseNotesOpenTheTag",
    async () => {
      const { page } = await relaunchWith((stored) => ({ ...stored, version: PREVIOUS_VERSION }), {
        version: CURRENT_VERSION,
        appearance: { theme: "dark" },
      });
      const app = running?.app;
      if (app === undefined) throw new Error("the app is not running");
      await app.evaluate(({ shell }) => {
        const opened: string[] = [];
        (globalThis as { openedUrls?: string[] }).openedUrls = opened;
        shell.openExternal = (url: string) => {
          opened.push(url);
          return Promise.resolve();
        };
      });
      await dot(page).waitFor();

      await openBell(page);
      const updated = notice(page, `update:${CURRENT_VERSION}`);
      expect(await updated.textContent()).toContain(`Updated to TableCraft ${CURRENT_VERSION}`);
      await expect.poll(() => dot(page).count()).toBe(0);
      await captureWindow(page, "03-updated");
      await updated.getByTestId("notice-action").click();

      await expect
        .poll(() => app.evaluate(() => (globalThis as { openedUrls?: string[] }).openedUrls ?? []))
        .toEqual([RELEASE_TAG_URL]);
      await openBell(page);
      expect(await notice(page, `update:${CURRENT_VERSION}`).count()).toBe(0);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenUnseenFeature_whenOpenSettings_thenSettingsOnAdvanced",
    async () => {
      const { page } = await relaunchWith(
        (stored) => ({ ...stored, features: stored.features.filter((id) => id !== "beta-channel") }),
        { appearance: { theme: "dark" } },
      );

      await openBell(page);
      const feature = notice(page, "feature:beta-channel");
      await feature.waitFor();
      await captureWindow(page, "04-feature-notice");
      await feature.getByTestId("notice-action").click();

      const settings = page.getByRole("dialog", { name: "Settings" });
      await settings.waitFor();
      expect(await settings.getByRole("tab", { name: "Advanced", exact: true }).getAttribute("aria-selected")).toBe(
        "true",
      );
      await settled(settings);
      await captureWindow(page, "04-feature");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenNotices_whenDismissAll_thenEmptyStateAndNoDotAfterRelaunch",
    async () => {
      const options = { version: CURRENT_VERSION, appearance: { theme: "dark" } };
      const relaunched = await relaunchWith(
        (stored) => ({ ...stored, version: PREVIOUS_VERSION, features: [] }),
        options,
      );
      let page = relaunched.page;

      await openBell(page);
      expect(await popover(page).locator("[data-kind]").count()).toBeGreaterThanOrEqual(2);
      await popover(page).getByTestId("notices-dismiss-all").click();

      await popover(page).getByTestId("notices-empty").waitFor();
      expect(await popover(page).getByTestId("notices-empty").textContent()).toContain("No notifications");
      await captureWindow(page, "05-empty");
      await closeRunning();
      page = await launch({ userDataDir: relaunched.userDataDir, ...options });
      await page.waitForTimeout(SETTLE_MS);
      expect(await dot(page).count()).toBe(0);
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it(
    "givenReducedMotion_whenNewNotice_thenHaloPaused",
    async () => {
      const page = await launch({ home: importHome(), appearance: { theme: "dark", motion: "reduced" } });

      await dot(page).waitFor({ timeout: LAUNCH_TIMEOUT_MS });

      expect(await halo(dot(page))).toMatchObject({ name: "tc-halo", state: "paused" });
    },
    SCENARIO_TIMEOUT_MS,
  );

  for (const theme of THEMES)
    for (const windowStyle of WINDOW_STYLES)
      it(
        `given${titled(theme)}${titled(windowStyle)}_whenOpenBell_thenPopoverElevation`,
        async () => {
          const page = await launch({ home: importHome(), appearance: { theme, windowStyle } });
          await dot(page).waitFor({ timeout: LAUNCH_TIMEOUT_MS });

          const opened = await openBell(page);
          await notice(page, "import:datagrip").waitFor();

          const radius = windowStyle === "islands" ? ISLANDS_POPOVER_RADIUS_PX : CLASSIC_POPOVER_RADIUS_PX;
          expect(await cornerRadius(opened)).toBe(`${String(radius)}px`);
          const cast = (await surface(opened)).shadow;
          for (const layer of computedLayers(ELEVATION[theme === "light" ? "light" : "dark"].popover))
            expect(cast).toContain(layer);
          const action = notice(page, "import:datagrip").getByTestId("notice-action");
          const before = (await surface(action)).background;
          await action.hover();
          await expect.poll(async () => (await surface(action)).background).not.toBe(before);
          await captureWindow(page, `06-${theme}-${windowStyle}`);
        },
        SCENARIO_TIMEOUT_MS,
      );
});
