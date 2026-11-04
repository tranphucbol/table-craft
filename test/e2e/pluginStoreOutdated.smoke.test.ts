/**
 * Plan 151's live test, rows 6 and 7: a profile an older TableCraft left, holding PostgreSQL built
 * for plugin API 1.x, updates it at launch (decision 155). The seeded plugin is the development
 * build with its manifest's `apiVersion` set to 1.10.0: the loader refuses it from the manifest
 * alone, so its code never runs. The loopback registry serves the 2.0 build; nothing reaches
 * registry.npmjs.org.
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/151 bun run test:smoke:db:headless:postgres test/e2e/pluginStoreOutdated.smoke.test.ts
 */
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { POSTGRES_CONFIG, WITHOUT_POSTGRES } from "../support/databases.js";
import { pluginPackageName, startRegistry, type LoopbackRegistry } from "../support/pluginRegistry.js";
import {
  answerSecretPrompt,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  EVIDENCE_WINDOW,
  evidenceFor,
  gridText,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openConsoleOn,
  pressChord,
  readProfileFile,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  seedSettings,
  setWindowSize,
  SMOKE_ENABLED,
  toolWindow,
  treeNode,
  waitUntilReady,
  type RunningApp,
  type SavedDatasource,
} from "./harness.js";
import { builtRelease, pluginLines, seedManagedPlugin, UNREACHABLE_REGISTRY } from "./pluginFixtures.js";

const captureWindow = evidenceFor("151");
const POSTGRES = "postgres";
const PACKAGE = pluginPackageName(POSTGRES);
const OLD_VERSION = "1.27.0";
const OLD_API_VERSION = "1.10.0";
const NEW_VERSION = "2.0.0";
/** Long enough to photograph the update in progress, short against the launch timeout. */
const SLOW_REGISTRY_MS = 2_500;
const NO_OPTIONAL_ROOT = { TABLE_CRAFT_DEVELOPMENT_PLUGINS: "0" };
const { password: PASSWORD, ...POSTGRES_PLAIN } = POSTGRES_CONFIG;

const SAVED_POSTGRES: SavedDatasource = {
  id: "shop-pg",
  name: "shop-pg",
  pluginId: POSTGRES,
  config: { ...POSTGRES_PLAIN, sslMode: "disable" },
  secretModes: { password: "never" },
};

function missingMarker(page: Page) {
  return treeNode(page, SAVED_POSTGRES.name).locator(`[data-missing-plugin="${POSTGRES}"]`);
}

function settingsDialog(page: Page) {
  return page.getByRole("dialog", { name: "Settings" });
}

async function loggedPlugin(userDataDir: string, msg: string) {
  const matching = () => pluginLines(userDataDir).filter((line) => line.msg === msg);
  await expect.poll(() => matching().length, { timeout: LAUNCH_TIMEOUT_MS }).toBeGreaterThanOrEqual(1);
  return matching()[0];
}

function currentVersion(userDataDir: string): unknown {
  const text = readProfileFile(userDataDir, join("managed-plugins", POSTGRES, "current.json"));
  return text === null ? null : JSON.parse(text);
}

describe.runIf(SMOKE_ENABLED)("outdated plugins after an app update", () => {
  let running: RunningApp | null = null;
  let registry: LoopbackRegistry | null = null;

  /** A profile holding postgres downloaded for plugin API 1.x and a data source on it. */
  async function launchOlderProfile(registryUrl: string): Promise<RunningApp> {
    const userDataDir = newProfile();
    seedManagedPlugin(userDataDir, POSTGRES, OLD_VERSION, { apiVersion: OLD_API_VERSION, source: "registry" });
    seedSettings(userDataDir, { version: 1, plugins: { registryUrl } });
    seedDatasources(userDataDir, [SAVED_POSTGRES]);
    running = await launchApp(null, { userDataDir, env: NO_OPTIONAL_ROOT });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await toolWindow(running.page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    return running;
  }

  afterEach(async () => {
    await closeApp(running?.app);
    running = null;
    await registry?.close();
    registry = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  it.skipIf(WITHOUT_POSTGRES)(
    "givenProfileWithPostgres1x_whenAppLaunches_thenPostgres2InstalledAndDatasourceConnects",
    async () => {
      registry = await startRegistry({ [PACKAGE]: [builtRelease(POSTGRES, NEW_VERSION)] });
      registry.slowDown(SLOW_REGISTRY_MS);
      const { page, userDataDir } = await launchOlderProfile(registry.url);

      await expect.poll(() => missingMarker(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toContain("Updating…");
      await captureWindow(page, "06-outdated-updating");

      await missingMarker(page).waitFor({ state: "detached", timeout: LAUNCH_TIMEOUT_MS });
      expect(await loggedPlugin(userDataDir, "plugin outdated; updating")).toMatchObject({
        pluginId: POSTGRES,
        usedBy: [SAVED_POSTGRES.name],
      });
      expect(await loggedPlugin(userDataDir, "plugin installed")).toMatchObject({
        pluginId: POSTGRES,
        version: NEW_VERSION,
      });
      expect(currentVersion(userDataDir)).toMatchObject({ version: NEW_VERSION, source: "registry" });

      await openConsoleOn(page, SAVED_POSTGRES.name);
      await answerSecretPrompt(page, SAVED_POSTGRES.name, PASSWORD);
      await waitUntilReady(page);
      await runStatement(page, "SELECT 1 AS one");
      expect(await gridText(page)).toEqual({ headers: ["one"], cells: ["1"] });
      await captureWindow(page, "06-outdated-updated");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenProfileWithPostgres1xAndRegistryUnreachable_whenConnected_thenUpdateFailedAndMustBeUpdated",
    async () => {
      const { page, userDataDir } = await launchOlderProfile(UNREACHABLE_REGISTRY);

      await loggedPlugin(userDataDir, "plugin install failed");
      const failure = missingMarker(page).getByRole("alert");
      await expect.poll(() => failure.textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toBe("Update failed");
      await missingMarker(page).getByRole("button", { name: "Retry", exact: true }).waitFor();

      await treeNode(page, SAVED_POSTGRES.name).click();
      await page.keyboard.press("ArrowRight");
      const node = treeNode(page, SAVED_POSTGRES.name);
      await expect
        .poll(() => node.getAttribute("title"), { timeout: LAUNCH_TIMEOUT_MS })
        .toMatch(/^The PostgreSQL plugin must be updated for this TableCraft: /);
      expect(await node.getAttribute("aria-label")).toBe(`${SAVED_POSTGRES.name}, failed`);
      await captureWindow(page, "07-update-failed");

      await pressChord(page, ",");
      await settingsDialog(page).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await settingsDialog(page).getByRole("tab", { name: "Plugins", exact: true }).click();
      const row = settingsDialog(page).locator(`[data-plugin-row="${POSTGRES}"]`);
      await expect.poll(() => row.textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toContain("Update failed: ");
      await captureWindow(page, "07-update-failed-plugins-page");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
