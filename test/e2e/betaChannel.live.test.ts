/**
 * Plan 124's live test on a packaged beta: a test build (`TABLE_CRAFT_UPDATE_TEST_BUILD=1`, so its
 * profile and keychain item are its own) versioned `9.1.0-beta.1` from a local, never pushed tag,
 * checking a local server with a throwaway key. Gated by `TABLE_CRAFT_BETA_LIVE`, the path of that
 * build's executable; macOS only.
 *
 *   git tag v9.1.0-beta.1 && TABLE_CRAFT_UPDATE_TEST_BUILD=1 bun run desktop:package:dir; git tag -d v9.1.0-beta.1
 *   TABLE_CRAFT_SMOKE=1 TABLE_CRAFT_BETA_LIVE="$(bun packages/desktop/scripts/packaged-executable.ts)" \
 *     TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/124 bunx vitest run test/e2e/betaChannel.live.test.ts
 */
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  computedOpacity,
  EVIDENCE_WINDOW,
  evidenceFor,
  findAction,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  pressChord,
  SCENARIO_TIMEOUT_MS,
  seedSettings,
  setWindowSize,
  waitUntilReady,
  type RunningApp,
} from "./harness.js";
import {
  BETA_MANIFEST_PATH,
  loggedUpdate,
  logLines,
  overrides,
  serve,
  updateButton,
  type LocalServer,
  type Release,
} from "./updateServer.js";

const EXECUTABLE = process.env["TABLE_CRAFT_BETA_LIVE"] ?? "";
const LIVE = EXECUTABLE !== "" && process.platform === "darwin";
const BETA = "9.1.0-beta.1";
const NEXT_BETA = "9.1.0-beta.2";
const STABLE = "9.0.0";
const ASSET = Buffer.from("never downloaded: no scenario presses Download");

const captureWindow = evidenceFor("124");

function settingsDialog(page: Page) {
  return page.getByRole("dialog", { name: "Settings" });
}

async function betaBox(page: Page) {
  await pressChord(page, ",");
  await settingsDialog(page)
    .getByRole("tablist", { name: "Settings pages" })
    .getByRole("tab", { name: "Advanced", exact: true })
    .click();
  return settingsDialog(page).getByTestId("settings-beta-channel");
}

describe.runIf(LIVE)("beta channel (packaged beta test build, live)", () => {
  let running: RunningApp | null = null;
  let local: LocalServer | null = null;

  async function open(release: Release, settings?: object): Promise<RunningApp & { readonly local: LocalServer }> {
    local = await serve(release);
    const userDataDir = newProfile();
    if (settings !== undefined) seedSettings(userDataDir, settings);
    running = await launchApp(undefined, {
      userDataDir,
      executable: EXECUTABLE,
      env: overrides(local, userDataDir),
      systemKeychain: false,
    });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    const startedAs = logLines(userDataDir).find((line) => line.msg === "TableCraft started")?.["version"];
    expect(startedAs).toBe(BETA);
    return { ...running, local };
  }

  afterEach(async () => {
    await closeApp(running?.app);
    running = null;
    local?.server.close();
    local = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  it(
    "givenBetaBuildWithNoChannelSetting_whenStarted_thenBetaVersionsCheckedAndTheNextBetaOffered",
    async () => {
      const { page, local } = await open({ version: STABLE, beta: NEXT_BETA, asset: ASSET });

      await updateButton(page).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(local.requests).toContain(BETA_MANIFEST_PATH);
      await updateButton(page).click();
      const popover = page.getByTestId("update-popover");
      await popover.waitFor();
      await expect.poll(() => popover.getByTestId("update-versions").textContent()).toContain(`${BETA} → ${NEXT_BETA}`);
      await captureWindow(page, "04-beta-build-offered-next-beta");
      await page.keyboard.press("Escape");

      const box = await betaBox(page);
      await expect.poll(() => box.isChecked()).toBe(true);
      await captureWindow(page, "05-beta-build-box-checked");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenBetaBuildOnStableChannel_whenCheckedFromHelp_thenUpToDateAndNoBetaManifestAsked",
    async () => {
      const { page, userDataDir, local } = await open(
        { version: STABLE, beta: NEXT_BETA, asset: ASSET },
        { version: 1, updates: { channel: "stable" } },
      );

      expect(await loggedUpdate(userDataDir, "up to date")).toMatchObject({ trigger: "automatic", target: STABLE });
      await findAction(page, "Check for Updates");
      const notice = page.getByRole("dialog", { name: "You're up to date" });
      await notice.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expect.poll(() => notice.textContent()).toContain(BETA);
      expect(await updateButton(page).count()).toBe(0);
      expect(local.requests).not.toContain(BETA_MANIFEST_PATH);
      await expect.poll(() => computedOpacity(notice)).toBe("1");
      await captureWindow(page, "06-beta-build-stable-channel-up-to-date");
      await notice.getByRole("button").first().click();

      const box = await betaBox(page);
      await expect.poll(() => box.isChecked()).toBe(false);
    },
    SCENARIO_TIMEOUT_MS,
  );
});
