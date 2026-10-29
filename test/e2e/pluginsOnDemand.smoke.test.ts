/**
 * Plan 057's live test: PostgreSQL as a plugin TableCraft downloads. Every launch hides the
 * development build's optional-plugin root, as a packaged app has none, and points
 * `plugins.registryUrl` at the loopback registry fixture, so nothing reaches registry.npmjs.org.
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/057 bun run test:smoke:headless test/e2e/pluginsOnDemand.smoke.test.ts
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/057 bun run test:smoke:db:headless:postgres test/e2e/pluginsOnDemand.smoke.test.ts
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/124 bun run test:smoke:headless test/e2e/pluginsOnDemand.smoke.test.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { POSTGRES_CONFIG, WITHOUT_POSTGRES } from "../support/databases.js";
import { pluginPackageName, sha512, startRegistry, type LoopbackRegistry } from "../support/pluginRegistry.js";
import {
  answerSecretPrompt,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  dataSourcesDialog,
  EVIDENCE_WINDOW,
  evidenceFor,
  evidenceTextFor,
  findAction,
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
  testConnection,
  toolWindow,
  treeNode,
  waitUntilReady,
  type RunningApp,
  type SavedDatasource,
} from "./harness.js";
import { builtRelease, managedListing, pluginLines, UNREACHABLE_REGISTRY } from "./pluginFixtures.js";

const captureWindow = evidenceFor("057");
const writeEvidence = evidenceTextFor("057");
const captureChannel = evidenceFor("124");
const POSTGRES = "postgres";
const PACKAGE = pluginPackageName(POSTGRES);
/** Long enough to photograph the progress state, short against the launch timeout. */
const SLOW_REGISTRY_MS = 2_500;
const FIRST_UPDATE_CHECK_MS = "1000";
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

function kinds(page: Page) {
  return dataSourcesDialog(page).getByRole("list", { name: "Database kinds" });
}

function downloadButton(page: Page) {
  return kinds(page).locator(`button[data-download="${POSTGRES}"]`);
}

function settingsDialog(page: Page) {
  return page.getByRole("dialog", { name: "Settings" });
}

function pluginRow(page: Page, id: string) {
  return settingsDialog(page).locator(`[data-plugin-row="${id}"]`);
}

async function openPluginsPage(page: Page): Promise<void> {
  await pressChord(page, ",");
  await settingsDialog(page).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await settingsDialog(page).getByRole("tab", { name: "Plugins", exact: true }).click();
}

async function loggedPlugin(userDataDir: string, msg: string, nth = 1) {
  const matching = () => pluginLines(userDataDir).filter((line) => line.msg === msg);
  await expect.poll(() => matching().length, { timeout: LAUNCH_TIMEOUT_MS }).toBeGreaterThanOrEqual(nth);
  return matching()[nth - 1];
}

function currentVersion(userDataDir: string): unknown {
  const text = readProfileFile(userDataDir, join("managed-plugins", POSTGRES, "current.json"));
  return text === null ? null : JSON.parse(text);
}

async function openNewDatasource(page: Page): Promise<void> {
  await toolWindow(page, "Database").getByRole("button", { name: "New Data Source…", exact: true }).click();
  await kinds(page).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
}

describe.runIf(SMOKE_ENABLED)("plugins on demand", () => {
  let running: RunningApp | null = null;
  let registry: LoopbackRegistry | null = null;
  const scratch: string[] = [];

  async function serve(...versions: readonly string[]): Promise<LoopbackRegistry> {
    registry = await startRegistry({ [PACKAGE]: versions.map((version) => builtRelease(POSTGRES, version)) });
    return registry;
  }

  async function launch(
    registryUrl: string,
    options: {
      datasources?: readonly SavedDatasource[];
      userDataDir?: string;
      env?: Record<string, string>;
      settings?: object;
    } = {},
  ): Promise<RunningApp> {
    const userDataDir = options.userDataDir ?? newProfile();
    seedSettings(userDataDir, { version: 1, plugins: { registryUrl }, ...options.settings });
    if (options.datasources !== undefined) seedDatasources(userDataDir, options.datasources);
    running = await launchApp(null, { userDataDir, env: { ...NO_OPTIONAL_ROOT, ...options.env } });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await toolWindow(running.page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    return running;
  }

  async function closeRunning(): Promise<void> {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }

  afterEach(async () => {
    await closeRunning();
    await registry?.close();
    registry = null;
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
  }, CLOSE_HOOK_TIMEOUT_MS);

  it(
    "givenNoOptionalPlugins_whenPostgresDownloadedFromThePicker_thenProgressThenTheForm",
    async () => {
      const local = await serve("1.0.0");
      const { page, userDataDir } = await launch(local.url);
      await openNewDatasource(page);

      const installed = kinds(page).locator("button:not([data-download])");
      await expect.poll(() => installed.allTextContents()).toEqual(["MariaDB", "MySQL", "SQLite", "TiDB"]);
      await expect.poll(() => downloadButton(page).textContent()).toMatch(/PostgreSQL.*Download \(about .+\)/);
      await captureWindow(page, "01-picker-offers-postgres-download");

      local.slowDown(SLOW_REGISTRY_MS);
      await downloadButton(page).click();
      const progress = kinds(page).getByRole("status");
      await expect
        .poll(() => progress.textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("Installing PostgreSQL…");
      await captureWindow(page, "02-picker-downloading");

      await dataSourcesDialog(page).getByLabel("Host", { exact: true }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "03-form-after-download");
      expect(currentVersion(userDataDir)).toEqual({ version: "1.0.0", packageName: PACKAGE, source: "registry" });
      expect(await loggedPlugin(userDataDir, "plugin installed")).toMatchObject({
        pluginId: POSTGRES,
        version: "1.0.0",
      });
      expect(local.requests).toEqual([
        `/${PACKAGE.replace("/", "%2f")}`,
        `/tarballs/tablecraft-app-plugin-postgres-1.0.0.tgz`,
      ]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSavedPostgresDatasourceAndNoPlugin_whenStarted_thenInstalledAutomatically",
    async () => {
      const local = await serve("1.0.0");
      local.slowDown(SLOW_REGISTRY_MS);
      const { page, userDataDir } = await launch(local.url, { datasources: [SAVED_POSTGRES] });

      await expect
        .poll(() => missingMarker(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("Installing…");
      await captureWindow(page, "04-auto-install-in-progress");

      await missingMarker(page).waitFor({ state: "detached", timeout: LAUNCH_TIMEOUT_MS });
      expect(await loggedPlugin(userDataDir, "plugin missing; installing")).toMatchObject({
        pluginId: POSTGRES,
        usedBy: [SAVED_POSTGRES.name],
      });
      await loggedPlugin(userDataDir, "plugin installed");
      await treeNode(page, SAVED_POSTGRES.name).click();
      await captureWindow(page, "05-auto-installed");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenRegistryUnreachable_whenStarted_thenGreyedWithInstallAndInstallFromFileWorks",
    async () => {
      const folder = mkdtempSync(join(tmpdir(), "table-craft-plugin-file-"));
      scratch.push(folder);
      const file = join(folder, "tablecraft-app-plugin-postgres-1.0.0.tgz");
      writeFileSync(file, builtRelease(POSTGRES, "1.0.0").bytes);
      const { app, page, userDataDir } = await launch(UNREACHABLE_REGISTRY, { datasources: [SAVED_POSTGRES] });

      await loggedPlugin(userDataDir, "plugin install failed");
      const failure = missingMarker(page).getByRole("alert");
      await expect
        .poll(() => failure.getAttribute("title"), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("The plugin registry could not be reached");
      expect(await failure.textContent()).toBe("Install failed");
      expect(await failure.getAttribute("title")).toContain("Install from File");
      await captureWindow(page, "06-offline-datasource-greyed");

      await missingMarker(page).getByRole("button", { name: "Retry", exact: true }).click();
      await loggedPlugin(userDataDir, "plugin install failed", 2);
      await missingMarker(page)
        .getByRole("button", { name: "Retry", exact: true })
        .waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "07-offline-retry-failed");

      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
        dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
      }, file);
      await findAction(page, "Install Plugin from File");
      const notice = page.getByRole("dialog", { name: "Plugin installed" });
      await notice.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expect.poll(() => notice.textContent()).toContain("PostgreSQL 1.0.0 is installed.");
      await missingMarker(page).waitFor({ state: "detached", timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "08-installed-from-file");
      expect(currentVersion(userDataDir)).toMatchObject({ version: "1.0.0", source: "file" });
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenTamperedTarball_whenDownloaded_thenRefusedWithTheIntegrityMessageAndNothingKept",
    async () => {
      registry = await startRegistry({
        [PACKAGE]: [builtRelease(POSTGRES, "1.0.0", sha512(Buffer.from("what the registry signed")))],
      });
      const { page, userDataDir } = await launch(registry.url);
      await openNewDatasource(page);

      await downloadButton(page).click();
      const alert = kinds(page).getByRole("alert");
      await alert.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expect
        .poll(() => alert.textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("does not match the registry's sha512 checksum");
      await captureWindow(page, "09-tampered-tarball-refused");

      const listing = managedListing(userDataDir);
      writeEvidence("tampered-listing.txt", `$ ls -R <userData>/managed-plugins\n${listing}`);
      expect(listing).toBe("managed-plugins/ does not exist\n");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenPostgresDownloadedAndUsed_whenSettingsPluginsOpened_thenBuiltInsLockedAndRemoveRefused",
    async () => {
      const local = await serve("1.0.0");
      const { page, userDataDir } = await launch(local.url, { datasources: [SAVED_POSTGRES] });
      await loggedPlugin(userDataDir, "plugin installed");
      await openPluginsPage(page);

      for (const id of ["mysql", "sqlite"]) {
        await expect.poll(() => pluginRow(page, id).textContent()).toContain("Built in");
        expect(await pluginRow(page, id).getByRole("button").count()).toBe(0);
      }
      await expect.poll(() => pluginRow(page, POSTGRES).textContent()).toContain("1.0.0");
      expect(await pluginRow(page, POSTGRES).textContent()).toContain("Downloaded");
      await captureWindow(page, "10-settings-plugins");

      await pluginRow(page, POSTGRES).getByRole("button", { name: "Remove", exact: true }).click();
      await page.getByRole("dialog", { name: "Remove Plugin" }).getByRole("button", { name: "Remove" }).click();
      const refused = page.getByRole("dialog", { name: "Could not remove PostgreSQL" });
      await refused.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expect.poll(() => refused.textContent()).toContain(`The plugin is used by "${SAVED_POSTGRES.name}".`);
      await captureWindow(page, "11-remove-refused-while-used");
      expect(currentVersion(userDataDir)).toMatchObject({ version: "1.0.0" });
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenNewerCompatibleVersion_whenBackgroundCheckRuns_thenUpdatedAndTheNextSessionUsesIt",
    async () => {
      const local = await serve("1.0.0");
      const userDataDir = newProfile();
      await launch(local.url, { userDataDir, datasources: [SAVED_POSTGRES] });
      await loggedPlugin(userDataDir, "plugin installed");
      await closeRunning();

      local.publish(PACKAGE, [builtRelease(POSTGRES, "1.0.0"), builtRelease(POSTGRES, "1.0.1")]);
      await launch(local.url, { userDataDir, env: { TABLE_CRAFT_PLUGIN_CHECK_MS: FIRST_UPDATE_CHECK_MS } });
      expect(await loggedPlugin(userDataDir, "plugin updated")).toMatchObject({
        pluginId: POSTGRES,
        from: "1.0.0",
        to: "1.0.1",
      });
      await closeRunning();

      const { page } = await launch(local.url, { userDataDir });
      await loggedPlugin(userDataDir, "plugin version pruned");
      const found = pluginLines(userDataDir).filter((line) => line.msg === "plugin found" && line["id"] === POSTGRES);
      expect(found.map((line) => line["version"])).toEqual(["1.0.0", "1.0.1"]);
      await openPluginsPage(page);
      await expect.poll(() => pluginRow(page, POSTGRES).textContent()).toContain("1.0.1");
      await captureWindow(page, "12-updated-in-the-next-session");

      const excerpt = pluginLines(userDataDir)
        .filter((line) => line["id"] === POSTGRES || line["pluginId"] === POSTGRES || line.msg.includes("pruned"))
        .map((line) => JSON.stringify(line));
      writeEvidence("background-update-log.txt", `${excerpt.join("\n")}\n`);
    },
    SCENARIO_TIMEOUT_MS * 3,
  );

  it(
    "givenBetaChannelAndBetaPlugin_whenBackgroundCheckRuns_thenTheBetaInstallsAndShows",
    async () => {
      const local = await serve("1.0.0");
      const userDataDir = newProfile();
      const beta = { updates: { channel: "beta" } };
      await launch(local.url, { userDataDir, datasources: [SAVED_POSTGRES], settings: beta });
      await loggedPlugin(userDataDir, "plugin installed");
      await closeRunning();

      local.publish(PACKAGE, [builtRelease(POSTGRES, "1.0.0"), builtRelease(POSTGRES, "1.1.0-beta.1")]);
      const env = { TABLE_CRAFT_PLUGIN_CHECK_MS: FIRST_UPDATE_CHECK_MS };
      await launch(local.url, { userDataDir, env, settings: beta });
      expect(await loggedPlugin(userDataDir, "plugin updated")).toMatchObject({
        pluginId: POSTGRES,
        from: "1.0.0",
        to: "1.1.0-beta.1",
      });
      await closeRunning();

      const { page } = await launch(local.url, { userDataDir, settings: beta });
      await openPluginsPage(page);
      await expect.poll(() => pluginRow(page, POSTGRES).textContent()).toContain("1.1.0-beta.1");
      await captureChannel(page, "03-beta-plugin-installed");
    },
    SCENARIO_TIMEOUT_MS * 3,
  );
});

describe.runIf(DATABASES_ENABLED)("plugins on demand against PostgreSQL", () => {
  let running: RunningApp | null = null;
  let registry: LoopbackRegistry | null = null;

  async function launch(datasources: readonly SavedDatasource[]): Promise<RunningApp> {
    registry = await startRegistry({ [PACKAGE]: [builtRelease(POSTGRES, "1.0.0")] });
    const userDataDir = newProfile();
    seedSettings(userDataDir, { version: 1, plugins: { registryUrl: registry.url } });
    seedDatasources(userDataDir, datasources);
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
    "givenPostgresDownloadedFromThePicker_whenConnected_thenAQueryRuns",
    async () => {
      const { page } = await launch([]);
      await openNewDatasource(page);
      await downloadButton(page).click();
      const dialog = dataSourcesDialog(page);
      await dialog.getByLabel("Host", { exact: true }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await dialog.getByLabel("Name", { exact: true }).fill("downloaded-pg");
      const fields = {
        Host: POSTGRES_CONFIG.host,
        Port: String(POSTGRES_CONFIG.port),
        Database: POSTGRES_CONFIG.database,
        User: POSTGRES_CONFIG.user,
        Password: PASSWORD,
      };
      for (const [label, value] of Object.entries(fields)) await dialog.getByLabel(label, { exact: true }).fill(value);
      expect((await testConnection(page)).ok).toBe(true);
      await dialog.getByRole("button", { name: "OK", exact: true }).click();
      await dialog.waitFor({ state: "detached" });

      await openConsoleOn(page, "downloaded-pg");
      await waitUntilReady(page);
      await runStatement(page, "SELECT current_user AS who");
      expect(await gridText(page)).toEqual({ headers: ["who"], cells: [POSTGRES_CONFIG.user] });
      await captureWindow(page, "13-downloaded-postgres-runs-a-query");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenSavedPostgresDatasourceAndNoPlugin_whenAutoInstalled_thenItConnects",
    async () => {
      const { page, userDataDir } = await launch([SAVED_POSTGRES]);
      await loggedPlugin(userDataDir, "plugin installed");
      await missingMarker(page).waitFor({ state: "detached", timeout: LAUNCH_TIMEOUT_MS });

      await openConsoleOn(page, SAVED_POSTGRES.name);
      await answerSecretPrompt(page, SAVED_POSTGRES.name, PASSWORD);
      await waitUntilReady(page);
      await runStatement(page, "SELECT 1 AS one");
      expect(await gridText(page)).toEqual({ headers: ["one"], cells: ["1"] });
      await captureWindow(page, "14-auto-installed-postgres-connects");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
