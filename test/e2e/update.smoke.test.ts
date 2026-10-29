/**
 * Plan 020's development-build half: the update check against a local server and a throwaway key,
 * through the overrides an unpackaged build honours. A development run reports 0.0.0 and cannot
 * replace itself, so a newer release shows the button with the reason instead of a download; the
 * download, the swap and the relaunch run against packaged builds in the plan's live test.
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/020 bun run test:smoke
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/124 bun run test:smoke:headless test/e2e/update.smoke.test.ts
 */
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
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
  SMOKE_ENABLED,
  waitUntilReady,
  type RunningApp,
} from "./harness.js";
import {
  FIRST_CHECK_MS,
  loggedUpdate,
  BETA_MANIFEST_PATH,
  MANIFEST_PATH,
  OTHER_KEYS,
  overrides,
  rightGroupNames,
  serve,
  updateButton,
  type LocalServer,
} from "./updateServer.js";

const captureWindow = evidenceFor("020");
const captureChannel = evidenceFor("124");
const UNPACKAGED_FOUND = "update found; this install cannot update itself";
const ASSET = Buffer.from("not a real zip; a development build never downloads it");

interface Release {
  readonly version: string;
  readonly signedBy?: typeof OTHER_KEYS;
  readonly beta?: string;
}

function settingsDialog(page: Page) {
  return page.getByRole("dialog", { name: "Settings" });
}

describe.runIf(SMOKE_ENABLED)("in-app update (development build)", () => {
  let running: RunningApp | null = null;
  let local: LocalServer | null = null;

  async function open(release: Release, settings?: object): Promise<RunningApp & { readonly local: LocalServer }> {
    local = await serve({ ...release, asset: ASSET });
    const userDataDir = newProfile();
    if (settings !== undefined) seedSettings(userDataDir, settings);
    running = await launchApp(undefined, { userDataDir, env: overrides(local, userDataDir) });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    return { ...running, local };
  }

  afterEach(async () => {
    await closeApp(running?.app);
    running = null;
    local?.server.close();
    local = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  it(
    "givenNoNewerRelease_whenCheckedAutomaticallyAndFromHelp_thenNoButtonAndUpToDate",
    async () => {
      const { page, userDataDir } = await open({ version: "0.0.0" });
      await waitUntilReady(page);

      expect(await loggedUpdate(userDataDir, "up to date")).toMatchObject({ trigger: "automatic", target: "0.0.0" });
      expect(await updateButton(page).count()).toBe(0);

      await findAction(page, "Check for Updates");
      const notice = page.getByRole("dialog", { name: "You're up to date" });
      await notice.waitFor();
      await expect.poll(() => notice.textContent()).toContain("0.0.0");
      await captureWindow(page, "01-up-to-date");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenNewerRelease_whenCheckedAutomatically_thenTheButtonSitsBeforeSettingsAndExplainsADevelopmentRun",
    async () => {
      const { page, userDataDir, local } = await open({ version: "9.0.0" });
      await waitUntilReady(page);

      await updateButton(page).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await rightGroupNames(page)).toEqual(["Search Everywhere", "Update", "Settings…"]);
      expect(await updateButton(page).getAttribute("data-phase")).toBe("ineligible");
      expect(await loggedUpdate(userDataDir, "update found; this install cannot update itself")).toMatchObject({
        reason: "unpackaged",
        target: "9.0.0",
      });
      await captureWindow(page, "02-button-before-settings");

      await updateButton(page).click();
      const popover = page.getByTestId("update-popover");
      await popover.waitFor();
      expect(await popover.getByTestId("update-versions").textContent()).toContain("0.0.0 → 9.0.0");
      expect(await popover.getByTestId("update-message").textContent()).toContain("development");
      expect(await popover.getByRole("button", { name: "Download" }).count()).toBe(0);
      expect(local.requests).not.toContain(local.assetPath);
      await captureWindow(page, "07-development-run-explains");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenStableAndBetaReleases_whenBetaVersionsTurnedOn_thenCheckOffersTheBeta",
    async () => {
      const { page, userDataDir, local } = await open({ version: "9.0.0", beta: "9.1.0-beta.1" });
      await waitUntilReady(page);

      expect(await loggedUpdate(userDataDir, UNPACKAGED_FOUND)).toMatchObject({
        target: "9.0.0",
        targetChannel: "stable",
      });
      expect(local.requests).not.toContain(BETA_MANIFEST_PATH);

      await pressChord(page, ",");
      await settingsDialog(page)
        .getByRole("tablist", { name: "Settings pages" })
        .getByRole("tab", { name: "Advanced", exact: true })
        .click();
      const box = settingsDialog(page).getByTestId("settings-beta-channel");
      expect(await box.isChecked()).toBe(false);
      await box.click();
      await expect.poll(() => box.isChecked()).toBe(true);
      await captureChannel(page, "01-beta-versions-checked");
      await settingsDialog(page).getByRole("button", { name: "Close", exact: true }).click();

      await findAction(page, "Check for Updates");
      expect(await loggedUpdate(userDataDir, UNPACKAGED_FOUND, 2)).toMatchObject({
        target: "9.1.0-beta.1",
        targetChannel: "beta",
      });
      expect(local.requests).toContain(BETA_MANIFEST_PATH);
      const popover = page.getByTestId("update-popover");
      await popover.waitFor();
      await expect.poll(() => popover.getByTestId("update-versions").textContent()).toContain("0.0.0 → 9.1.0-beta.1");
      await captureChannel(page, "02-beta-offered");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenManifestSignedWithAnotherKey_whenChecked_thenUpdateFailedAndNothingDownloaded",
    async () => {
      const { page, userDataDir, local } = await open({ version: "9.0.0", signedBy: OTHER_KEYS });
      await waitUntilReady(page);

      expect(await loggedUpdate(userDataDir, "update manifest rejected")).toMatchObject({
        level: "error",
        reason: "signature",
      });
      await updateButton(page).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await updateButton(page).textContent()).toContain("Update failed");
      await updateButton(page).click();
      await page.getByTestId("update-popover").waitFor();
      expect(local.requests).not.toContain(local.assetPath);
      await captureWindow(page, "05-tampered-signature");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenAutomaticChecksOff_whenLaunched_thenNoRequestUntilCheckedFromHelp",
    async () => {
      const { page, local } = await open({ version: "9.0.0" }, { version: 1, updates: { checkAutomatically: false } });
      await waitUntilReady(page);
      await page.waitForTimeout(FIRST_CHECK_MS * 5);
      expect(local.requests).toEqual([]);

      await findAction(page, "Check for Updates");
      await updateButton(page).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(local.requests).toContain(MANIFEST_PATH);
    },
    SCENARIO_TIMEOUT_MS,
  );
});
