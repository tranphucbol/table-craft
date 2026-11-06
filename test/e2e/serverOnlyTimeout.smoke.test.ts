/**
 * Plan 156's live test: a data source whose plugin cannot cancel but whose database stops a
 * statement itself (decision 159) still offers a statement timeout, in the console's Run Settings
 * and in the Data Sources form, where the database's part is ticked and locked. The plugin is the
 * built MySQL one under another id with `cancel` taken away, as a plugin reaching MySQL through a
 * proxy that cannot kill a query would declare itself. Gated, because it needs a display, a fresh
 * build and, for the console, the `test/db/compose.yml` MySQL:
 *
 *   TABLE_CRAFT_DATABASES=mysql TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/156 \
 *     bun run test:smoke:db:headless test/e2e/serverOnlyTimeout.smoke.test.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MANIFEST_FILE } from "@table-craft/plugin-api";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { mysqlSlowRead } from "../db/mysqlFamily.js";
import { databaseEnabled, MYSQL_CONFIG } from "../support/databases.js";
import {
  answerSecretPrompt,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  consoleAlert,
  consoleToolbar,
  DATABASES_ENABLED,
  dataSourcesDialog,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openConsoleOn,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  seedPlugin,
  seedSettings,
  setWindowSize,
  SMOKE_ENABLED,
  toolWindow,
  waitUntilReady,
  type RunningApp,
  type SavedDatasource,
} from "./harness.js";

const captureWindow = evidenceFor("156");
const BUILT_MYSQL = resolve(import.meta.dirname, "../../packages/desktop/dist/resources/plugins/mysql");
const ENTRY_FILE = "index.js";
const BASE_ENTRY_FILE = "base.js";
const NO_CANCEL = { id: "mysql-no-cancel", name: "MySQL (no cancel)" } as const;
const TIMEOUT_SECONDS = 4;
const SLOW_READ_SECONDS = 12;
const SERVER_NOTE = "the database stops SELECTs at the limit with max_execution_time";
const { password: _mysqlPassword, ...MYSQL_PLAIN } = MYSQL_CONFIG;
const SAVED_NO_CANCEL: SavedDatasource = {
  id: "no-cancel",
  name: "no-cancel",
  pluginId: NO_CANCEL.id,
  config: MYSQL_PLAIN,
  secretModes: { password: "untilRestart" },
};
const SAVED_MYSQL: SavedDatasource = { ...SAVED_NO_CANCEL, id: "cancels", name: "cancels", pluginId: "mysql" };

/**
 * The built MySQL plugin without `cancel`: the manifest and export drop the capability, and each
 * session hides its `cancel` service, so the loader and the engine see a plugin that cannot cancel.
 */
const NO_CANCEL_ENTRY = `import base from "./${BASE_ENTRY_FILE}";
function withoutCancel(session) {
  const { cancel: _cancel, ...services } = session.services;
  return new Proxy(session, {
    get(target, key) {
      if (key === "services") return services;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
export default Object.assign(Object.create(base), {
  id: "${NO_CANCEL.id}",
  capabilities: base.capabilities.filter((capability) => capability !== "cancel"),
  async connect(config, options) {
    return withoutCancel(await base.connect(config, options));
  },
});
`;

function seedNoCancelPlugin(userDataDir: string): void {
  const manifest = JSON.parse(readFileSync(join(BUILT_MYSQL, MANIFEST_FILE), "utf8")) as {
    readonly capabilities: readonly string[];
    readonly brands: readonly Record<string, unknown>[];
  };
  const assets = Object.fromEntries(
    readdirSync(BUILT_MYSQL)
      .filter((file) => file !== MANIFEST_FILE && file !== ENTRY_FILE && !file.endsWith(".map"))
      .map((file) => [file, readFileSync(join(BUILT_MYSQL, file), "utf8")]),
  );
  seedPlugin(userDataDir, NO_CANCEL.id, {
    ...assets,
    [MANIFEST_FILE]: JSON.stringify({
      ...manifest,
      ...NO_CANCEL,
      capabilities: manifest.capabilities.filter((capability) => capability !== "cancel"),
      brands: [{ ...manifest.brands[0], name: NO_CANCEL.name }],
    }),
    [BASE_ENTRY_FILE]: readFileSync(join(BUILT_MYSQL, ENTRY_FILE), "utf8"),
    [ENTRY_FILE]: NO_CANCEL_ENTRY,
  });
}

function gear(page: Page) {
  return consoleToolbar(page).getByRole("button", { name: /^Run Settings…/ });
}

function popover(page: Page) {
  return page.getByTestId("run-settings");
}

function timeoutField(page: Page) {
  return dataSourcesDialog(page).getByRole("textbox", { name: "Statement timeout (s)" });
}

async function closePopover(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await popover(page).waitFor({ state: "detached" });
}

describe.runIf(SMOKE_ENABLED)("statement timeout without cancel", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(saved: readonly SavedDatasource[] = []): Promise<Page> {
    const userDataDir = newProfile();
    seedSettings(userDataDir, { version: 1, appearance: { motion: "off", theme: "light" } });
    seedNoCancelPlugin(userDataDir);
    seedDatasources(userDataDir, saved);
    running = await launchApp(null, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    return running.page;
  }

  async function openForm(page: Page, kind: string): Promise<void> {
    const dialog = dataSourcesDialog(page);
    if (!(await dialog.isVisible())) {
      await toolWindow(page, "Database").getByRole("button", { name: "New Data Source…", exact: true }).first().click();
    } else {
      await dialog.getByRole("button", { name: "Add data source" }).click();
    }
    await dialog.getByRole("list", { name: "Database kinds" }).getByRole("button", { name: kind, exact: true }).click();
    await timeoutField(page).scrollIntoViewIfNeeded();
  }

  it(
    "givenPluginWithoutCancel_whenNewDataSource_thenTimeoutFieldWithDatabaseStopLocked",
    async () => {
      const page = await launch();
      await toolWindow(page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      const dialog = dataSourcesDialog(page);
      const enforce = dialog.getByTestId("enforce-timeout-on-server");

      await openForm(page, NO_CANCEL.name);
      expect(await timeoutField(page).isVisible()).toBe(true);
      expect(await enforce.isChecked()).toBe(true);
      expect(await enforce.isDisabled()).toBe(true);
      await captureWindow(page, "01-form-without-cancel");

      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await openForm(page, "MySQL");
      expect(await enforce.isChecked()).toBe(false);
      expect(await enforce.isDisabled()).toBe(false);
      await captureWindow(page, "02-form-mysql-unchanged");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(DATABASES_ENABLED && databaseEnabled("mysql"))(
    "givenPluginWithoutCancel_whenConsoleTimeoutPassed_thenDatabaseStopsTheRead",
    async () => {
      const page = await launch([SAVED_NO_CANCEL]);
      await toolWindow(page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await openConsoleOn(page, SAVED_NO_CANCEL.id);
      await answerSecretPrompt(page, SAVED_NO_CANCEL.id, MYSQL_CONFIG.password);
      await waitUntilReady(page);

      await gear(page).click();
      await expect.poll(() => popover(page).isVisible()).toBe(true);
      const timeout = popover(page).getByRole("group", { name: "Statement timeout" });
      for (const choice of ["Default", "Custom", "None"]) {
        expect(await timeout.getByRole("radio", { name: choice }).count()).toBe(1);
      }
      await closePopover(page);
      await runStatement(page, "SELECT 1");
      await gear(page).click();
      await expect.poll(() => page.getByTestId("run-settings-server-note").textContent()).toContain(SERVER_NOTE);
      await timeout.locator("label", { hasText: "Custom" }).click();
      await popover(page).getByLabel("Seconds").fill(String(TIMEOUT_SECONDS));
      await captureWindow(page, "03-run-settings-without-cancel");
      await closePopover(page);

      const started = Date.now();
      await runStatement(page, mysqlSlowRead(SLOW_READ_SECONDS));
      await expect
        .poll(() => consoleAlert(page).first().textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("raise it in Run Settings");
      expect(Date.now() - started).toBeLessThan(SLOW_READ_SECONDS * 1000);
      await page.keyboard.press("Escape");
      await captureWindow(page, "04-stopped-by-database");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(DATABASES_ENABLED && databaseEnabled("mysql"))(
    "givenPluginThatCancels_whenRunSettingsOpened_thenNoServerOnlyNote",
    async () => {
      const page = await launch([SAVED_MYSQL]);
      await toolWindow(page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await openConsoleOn(page, SAVED_MYSQL.id);
      await answerSecretPrompt(page, SAVED_MYSQL.id, MYSQL_CONFIG.password);
      await waitUntilReady(page);
      await runStatement(page, "SELECT 1");

      await gear(page).click();
      const timeout = popover(page).getByRole("group", { name: "Statement timeout" });
      await timeout.locator("label", { hasText: "Custom" }).click();
      expect(await page.getByTestId("run-settings-server-note").count()).toBe(0);
      await captureWindow(page, "05-run-settings-mysql-unchanged");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
