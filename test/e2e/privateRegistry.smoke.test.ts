/**
 * Plan 154's live test: a company's plugin from its own npm registry. The loopback registry stands
 * in for a GitLab one (a path prefix, a bearer token, no `tableCraft` or `integrity` in the
 * packument), and every name is a placeholder: the scope `@acme`, the package
 * `@acme/tablecraft-plugin-example` (the built PostgreSQL plugin under the id `example`).
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/154 bun run test:smoke:headless test/e2e/privateRegistry.smoke.test.ts
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/154 bun run test:smoke:db:headless:postgres test/e2e/privateRegistry.smoke.test.ts
 */
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { POSTGRES_CONFIG, WITHOUT_POSTGRES } from "../support/databases.js";
import { EXAMPLE_PACKAGE, EXAMPLE_PLUGIN_ID, startRegistry, type LoopbackRegistry } from "../support/pluginRegistry.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  dataSourcesDialog,
  EVIDENCE_WINDOW,
  evidenceFor,
  evidenceTextFor,
  gridText,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openConsoleOn,
  pressChord,
  readProfileFile,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  seedSettings,
  setWindowSize,
  SMOKE_ENABLED,
  testConnection,
  toolWindow,
  waitUntilReady,
  type RunningApp,
} from "./harness.js";
import { builtExampleRelease, pluginLines, UNREACHABLE_REGISTRY } from "./pluginFixtures.js";

const captureWindow = evidenceFor("154");
const writeEvidence = evidenceTextFor("154");
const REGISTRY_NAME = "Company registry";
const SCOPE = "@acme";
const PREFIX = "/api/v4/packages/npm";
const TOKEN = "test-registry-token";
const WRONG_TOKEN = "revoked-registry-token";
const FIRST_UPDATE_CHECK_MS = "1000";
const NO_OPTIONAL_ROOT = { TABLE_CRAFT_DEVELOPMENT_PLUGINS: "0" };
const EXAMPLE_BRAND = "Example DB";
const { password: PASSWORD } = POSTGRES_CONFIG;

interface Asked {
  readonly message: string;
  readonly detail: string;
}

function settingsDialog(page: Page) {
  return page.getByRole("dialog", { name: "Settings" });
}

function pluginRow(page: Page, id: string) {
  return settingsDialog(page).locator(`[data-plugin-row="${id}"]`);
}

function card(page: Page, name: string) {
  return settingsDialog(page).getByRole("region", { name, exact: true });
}

async function openPluginsPage(page: Page): Promise<void> {
  await pressChord(page, ",");
  await settingsDialog(page).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await settingsDialog(page).getByRole("tab", { name: "Plugins", exact: true }).click();
}

async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await settingsDialog(page).waitFor({ state: "detached" });
}

/** Answers every native message box with its first button and records what it said. */
async function answerDialogs(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const asked: { message: string; detail: string }[] = [];
    (globalThis as { asked?: typeof asked }).asked = asked;
    dialog.showMessageBox = (...args: unknown[]) => {
      const options = args.at(-1) as { message: string; detail?: string };
      asked.push({ message: options.message, detail: options.detail ?? "" });
      return Promise.resolve({ response: 0, checkboxChecked: false });
    };
  });
}

async function askedDialogs(app: ElectronApplication): Promise<readonly Asked[]> {
  return app.evaluate(() => (globalThis as { asked?: Asked[] }).asked ?? []);
}

async function loggedPlugin(userDataDir: string, msg: string, nth = 1) {
  const matching = () => pluginLines(userDataDir).filter((line) => line.msg === msg);
  await expect.poll(() => matching().length, { timeout: LAUNCH_TIMEOUT_MS }).toBeGreaterThanOrEqual(nth);
  return matching()[nth - 1];
}

function currentVersion(userDataDir: string): unknown {
  const text = readProfileFile(userDataDir, join("managed-plugins", EXAMPLE_PLUGIN_ID, "current.json"));
  return text === null ? null : JSON.parse(text);
}

function savedRegistries(userDataDir: string): unknown {
  const text = readProfileFile(userDataDir, "settings.json") ?? "{}";
  return (JSON.parse(text) as { plugins?: { registries?: unknown } }).plugins?.registries;
}

/** Fills Settings → Plugins → + Add registry with the company registry and saves it. */
async function addRegistry(page: Page, registry: LoopbackRegistry, capture: boolean): Promise<void> {
  const dialog = settingsDialog(page);
  await dialog.getByRole("button", { name: "+ Add registry", exact: true }).click();
  const form = card(page, "New registry");
  await form.getByLabel("Name", { exact: true }).fill(REGISTRY_NAME);
  await form.getByLabel("URL", { exact: true }).fill(registry.url);
  await form.getByLabel("Scopes", { exact: true }).fill(SCOPE);
  await form.getByLabel("Scopes", { exact: true }).press("Enter");
  await form.getByLabel("Token", { exact: true }).fill(TOKEN);
  await form.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect
    .poll(
      async () =>
        `${(await form.textContent()) ?? ""} ${String(
          await form
            .locator("[title]")
            .first()
            .getAttribute("title")
            .catch(() => ""),
        )}`,
      { timeout: LAUNCH_TIMEOUT_MS },
    )
    .toContain("● Reached");
  await form.scrollIntoViewIfNeeded();
  if (capture) await captureWindow(page, "01-add-registry-tested");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(() => card(page, REGISTRY_NAME).textContent(), { timeout: LAUNCH_TIMEOUT_MS })
    .toContain("Stored, encrypted");
}

async function installByName(page: Page): Promise<void> {
  const input = settingsDialog(page).getByPlaceholder("@scope/package-name");
  await input.fill(EXAMPLE_PACKAGE);
  await settingsDialog(page).getByRole("button", { name: "Install…", exact: true }).click();
}

describe.runIf(SMOKE_ENABLED)("private plugin registries", () => {
  let running: RunningApp | null = null;
  let registry: LoopbackRegistry | null = null;

  async function serve(...versions: readonly string[]): Promise<LoopbackRegistry> {
    registry = await startRegistry(
      { [EXAMPLE_PACKAGE]: versions.map((version) => builtExampleRelease(version)) },
      { prefix: PREFIX, token: TOKEN, gitlab: true },
    );
    return registry;
  }

  async function launch(userDataDir: string, env: Record<string, string> = {}): Promise<RunningApp> {
    running = await launchApp(null, { userDataDir, env: { ...NO_OPTIONAL_ROOT, ...env } });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await toolWindow(running.page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await answerDialogs(running.app);
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
  }, CLOSE_HOOK_TIMEOUT_MS);

  it(
    "givenCompanyRegistry_whenPackageInstalledByName_thenConfirmedOnceUpdatedSilentlyAndRefusedTokenShown",
    async () => {
      const local = await serve("1.0.0");
      const userDataDir = newProfile();
      seedSettings(userDataDir, { version: 1, plugins: { registryUrl: UNREACHABLE_REGISTRY } });
      const { app, page } = await launch(userDataDir);
      await openPluginsPage(page);
      await addRegistry(page, local, true);

      const input = settingsDialog(page).getByPlaceholder("@scope/package-name");
      await input.fill(EXAMPLE_PACKAGE);
      await expect.poll(() => settingsDialog(page).textContent()).toContain(`From ${REGISTRY_NAME} (scope ${SCOPE})`);
      await input.scrollIntoViewIfNeeded();
      await captureWindow(page, "02-package-name-routed");

      await installByName(page);
      await expect
        .poll(() => pluginRow(page, EXAMPLE_PLUGIN_ID).textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain(REGISTRY_NAME);
      const asked = await askedDialogs(app);
      expect(asked).toHaveLength(1);
      expect(asked[0]?.message).toBe(
        `Install Example (${EXAMPLE_PACKAGE}) from ${REGISTRY_NAME}? It runs with TableCraft's access to your files and network.`,
      );
      expect(asked[0]?.detail).toContain("Version: 1.0.0 (newest that fits)");
      expect(asked[0]?.detail).toContain("You're asked once per package.");
      writeEvidence("03-confirmation.txt", `${asked[0]?.message ?? ""}\n\n${asked[0]?.detail ?? ""}\n`);
      expect(await pluginRow(page, EXAMPLE_PLUGIN_ID).textContent()).toContain("1.0.0");
      await pluginRow(page, EXAMPLE_PLUGIN_ID).scrollIntoViewIfNeeded();
      await captureWindow(page, "03-installed-from-company-registry");
      await card(page, REGISTRY_NAME).scrollIntoViewIfNeeded();
      expect(await card(page, REGISTRY_NAME).textContent()).toContain("checked with SHA-1");
      expect(await card(page, REGISTRY_NAME).textContent()).toContain("Reached");
      await captureWindow(page, "04-registry-card-after-install");

      expect(currentVersion(userDataDir)).toEqual({
        version: "1.0.0",
        packageName: EXAMPLE_PACKAGE,
        source: "registry",
        registry: "company-registry",
      });
      expect(savedRegistries(userDataDir)).toEqual([
        {
          id: "company-registry",
          name: REGISTRY_NAME,
          url: local.url,
          scopes: [SCOPE],
          packages: [EXAMPLE_PACKAGE],
        },
      ]);
      expect(readProfileFile(userDataDir, "settings.json")).not.toContain(TOKEN);
      expect(local.received.filter((request) => request.authorization === `Bearer ${TOKEN}`).length).toBeGreaterThan(0);
      await closeRunning();

      local.publish(EXAMPLE_PACKAGE, [builtExampleRelease("1.0.0"), builtExampleRelease("1.0.1")]);
      const updated = await launch(userDataDir, { TABLE_CRAFT_PLUGIN_CHECK_MS: FIRST_UPDATE_CHECK_MS });
      expect(await loggedPlugin(userDataDir, "plugin updated")).toMatchObject({
        pluginId: EXAMPLE_PLUGIN_ID,
        from: "1.0.0",
        to: "1.0.1",
      });
      expect(await askedDialogs(updated.app)).toEqual([]);
      await closeRunning();

      const { page: next } = await launch(userDataDir);
      await openPluginsPage(next);
      await expect.poll(() => pluginRow(next, EXAMPLE_PLUGIN_ID).textContent()).toContain("1.0.1");
      await pluginRow(next, EXAMPLE_PLUGIN_ID).scrollIntoViewIfNeeded();
      await captureWindow(next, "05-updated-without-asking");

      const company = card(next, REGISTRY_NAME);
      await company.getByRole("button", { name: "Forget", exact: true }).click();
      await expect.poll(() => company.textContent()).not.toContain("Stored, encrypted");
      await pluginRow(next, EXAMPLE_PLUGIN_ID).getByRole("button", { name: "Update", exact: true }).click();
      await expect
        .poll(() => pluginRow(next, EXAMPLE_PLUGIN_ID).textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("Update failed: the registry has no token.");
      expect(await company.textContent()).not.toContain("Reached");
      await pluginRow(next, EXAMPLE_PLUGIN_ID).scrollIntoViewIfNeeded();
      await captureWindow(next, "06a-no-token-update-failed");

      await company.getByLabel("Token", { exact: true }).fill(WRONG_TOKEN);
      await company.getByRole("button", { name: "Replace", exact: true }).click();
      await company.getByRole("button", { name: "Test", exact: true }).click();
      await expect
        .poll(() => company.getByRole("alert").first().textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("Token refused (401)");
      await pluginRow(next, EXAMPLE_PLUGIN_ID).getByRole("button", { name: "Update", exact: true }).click();
      await expect
        .poll(() => pluginRow(next, EXAMPLE_PLUGIN_ID).textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("Update failed: the registry refused the token.");
      expect(await pluginRow(next, EXAMPLE_PLUGIN_ID).textContent()).toContain("1.0.1");
      await pluginRow(next, EXAMPLE_PLUGIN_ID).scrollIntoViewIfNeeded();
      await captureWindow(next, "06-refused-token-update-failed");
      await company.scrollIntoViewIfNeeded();
      await captureWindow(next, "07-refused-token-card");

      const excerpt = pluginLines(userDataDir)
        .filter((line) => line["pluginId"] === EXAMPLE_PLUGIN_ID || line["packageName"] === EXAMPLE_PACKAGE)
        .map((line) => JSON.stringify(line));
      expect(excerpt.join("\n")).not.toContain(TOKEN);
      writeEvidence("plugin-log.txt", `${excerpt.join("\n")}\n`);
    },
    SCENARIO_TIMEOUT_MS * 4,
  );

  it(
    "givenUnconfiguredScope_whenPackageTyped_thenInstallDisabledAndNothingRequested",
    async () => {
      const local = await serve("1.0.0");
      const userDataDir = newProfile();
      seedSettings(userDataDir, { version: 1, plugins: { registryUrl: UNREACHABLE_REGISTRY } });
      const { page } = await launch(userDataDir);
      await openPluginsPage(page);

      await settingsDialog(page).getByPlaceholder("@scope/package-name").fill(EXAMPLE_PACKAGE);
      await expect
        .poll(() => settingsDialog(page).textContent())
        .toContain("Add a registry below for the package’s scope first.");
      expect(await settingsDialog(page).getByRole("button", { name: "Install…", exact: true }).isDisabled()).toBe(true);
      await captureWindow(page, "08-scope-without-registry");
      expect(local.requests).toEqual([]);
      await closeSettings(page);
    },
    SCENARIO_TIMEOUT_MS,
  );
});

describe.runIf(DATABASES_ENABLED)("private plugin registries against PostgreSQL", () => {
  let running: RunningApp | null = null;
  let registry: LoopbackRegistry | null = null;

  afterEach(async () => {
    await closeApp(running?.app);
    running = null;
    await registry?.close();
    registry = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPluginFromCompanyRegistry_whenConnected_thenAQueryRuns",
    async () => {
      registry = await startRegistry(
        { [EXAMPLE_PACKAGE]: [builtExampleRelease("1.0.0")] },
        { prefix: PREFIX, token: TOKEN, gitlab: true },
      );
      const userDataDir = newProfile();
      seedSettings(userDataDir, { version: 1, plugins: { registryUrl: UNREACHABLE_REGISTRY } });
      running = await launchApp(null, { userDataDir, env: NO_OPTIONAL_ROOT });
      const { app, page } = running;
      await setWindowSize(app, EVIDENCE_WINDOW);
      await toolWindow(page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await answerDialogs(app);
      await openPluginsPage(page);
      await addRegistry(page, registry, false);
      await installByName(page);
      await expect
        .poll(() => pluginRow(page, EXAMPLE_PLUGIN_ID).textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain(REGISTRY_NAME);
      await closeSettings(page);

      await toolWindow(page, "Database").getByRole("button", { name: "New Data Source…", exact: true }).first().click();
      const dialog = dataSourcesDialog(page);
      await dialog.getByRole("list", { name: "Database kinds" }).getByRole("button", { name: EXAMPLE_BRAND }).click();
      await dialog.getByLabel("Host", { exact: true }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await dialog.getByLabel("Name", { exact: true }).fill("company-db");
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

      await openConsoleOn(page, "company-db");
      await waitUntilReady(page);
      await runStatement(page, "SELECT current_user AS who");
      expect(await gridText(page)).toEqual({ headers: ["who"], cells: [POSTGRES_CONFIG.user] });
      await captureWindow(page, "09-company-plugin-runs-a-query");
    },
    SCENARIO_TIMEOUT_MS * 2,
  );
});
