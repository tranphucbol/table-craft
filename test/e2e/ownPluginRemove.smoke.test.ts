/**
 * Remove on a plugin of your own: its folder in `<userData>/plugins/` goes to the Trash, even when
 * a downloaded copy of the same id shadows it and a data source uses that id.
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/own-plugins bun run test:smoke:headless test/e2e/ownPluginRemove.smoke.test.ts
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MANIFEST_FILE } from "@table-craft/plugin-api";
import type { Page } from "playwright-core";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  pressChord,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  seedSettings,
  setWindowSize,
  SMOKE_ENABLED,
  toolWindow,
  type RunningApp,
  type SavedDatasource,
} from "./harness.js";
import { pluginLines, seedManagedPlugin, UNREACHABLE_REGISTRY } from "./pluginFixtures.js";

const captureWindow = evidenceFor("own-plugins");
const POSTGRES = "postgres";
const OWN_FOLDER = "my-postgres";
const OPTIONAL_PLUGINS = resolve(import.meta.dirname, "../../packages/desktop/dist/optional-plugins");
const NO_OPTIONAL_ROOT = { TABLE_CRAFT_DEVELOPMENT_PLUGINS: "0" };
const SAVED_POSTGRES: SavedDatasource = {
  id: "shop-pg",
  name: "shop-pg",
  pluginId: POSTGRES,
  config: { host: "127.0.0.1", port: 5432, user: "table_craft", database: "table_craft", sslMode: "disable" },
  secretModes: { password: "never" },
};

/** The one DOM member the fade wait touches; the e2e program is compiled without the DOM lib. */
interface AnimatedElement {
  getAnimations(options: { readonly subtree: boolean }): readonly { readonly finished: Promise<unknown> }[];
}

function settingsDialog(page: Page) {
  return page.getByRole("dialog", { name: "Settings" });
}

function ownRow(page: Page) {
  return settingsDialog(page).locator(`[data-plugin-row="${POSTGRES}"]`).filter({ hasText: "Your plugin" });
}

function seedOwnPlugin(userDataDir: string): string {
  const directory = join(userDataDir, "plugins", OWN_FOLDER);
  mkdirSync(directory, { recursive: true });
  for (const file of [MANIFEST_FILE, "index.js"]) cpSync(join(OPTIONAL_PLUGINS, POSTGRES, file), join(directory, file));
  return directory;
}

describe.runIf(SMOKE_ENABLED)("removing a plugin of your own", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    await closeApp(running?.app);
    running = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  it(
    "givenOwnCopyShadowedByADownload_whenRemoved_thenItsFolderGoesToTheTrashAndTheDownloadStays",
    async () => {
      const userDataDir = newProfile();
      seedManagedPlugin(userDataDir, POSTGRES, "1.0.0");
      const directory = seedOwnPlugin(userDataDir);
      seedSettings(userDataDir, { version: 1, plugins: { registryUrl: UNREACHABLE_REGISTRY } });
      seedDatasources(userDataDir, [SAVED_POSTGRES]);
      running = await launchApp(null, { userDataDir, env: NO_OPTIONAL_ROOT });
      const page = running.page;
      await setWindowSize(running.app, EVIDENCE_WINDOW);
      await toolWindow(page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });

      await pressChord(page, ",");
      await settingsDialog(page).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await settingsDialog(page).getByRole("tab", { name: "Plugins", exact: true }).click();
      await ownRow(page).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await ownRow(page).textContent()).toContain("Duplicate plugin id");
      await captureWindow(page, "01-own-copy-with-remove");

      await ownRow(page).getByRole("button", { name: "Remove", exact: true }).click();
      const confirm = page.getByRole("dialog", { name: "Remove Plugin" });
      await confirm.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await confirm.evaluate((element: AnimatedElement) =>
        Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)),
      );
      expect(await confirm.textContent()).toContain("moves to the Trash");
      await captureWindow(page, "02-remove-confirmation");
      await confirm.getByRole("button", { name: "Remove" }).click();

      await expect.poll(() => ownRow(page).count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(0);
      const downloaded = settingsDialog(page).locator(`[data-plugin-row="${POSTGRES}"]`);
      await expect.poll(() => downloaded.textContent()).toContain("Downloaded");
      expect(existsSync(directory)).toBe(false);
      expect(pluginLines(userDataDir).find((line) => line.msg === "plugin removed")).toBeDefined();
      await captureWindow(page, "03-own-copy-removed");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
