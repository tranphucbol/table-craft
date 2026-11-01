/**
 * Plan 141's live test: the console toolbar's Run Settings gear sets one console's page size, has
 * it read every row, gives it its own statement timeout, and resets to Settings. The rows run on
 * in-memory SQLite; the timeout needs a plugin that can cancel, so it runs on MySQL. Gated, because
 * it needs a display, a fresh build and, for MySQL, the `test/db/compose.yml` containers:
 *
 *   TABLE_CRAFT_DATABASES=mysql TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/141 \
 *     bun run test:smoke:db:headless test/e2e/runSettings.smoke.test.ts
 */
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { databaseEnabled, MYSQL_CONFIG } from "../support/databases.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  consoleAlert,
  consoleToolbar,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  SCRATCH,
  seedSettings,
  setWindowSize,
  SMOKE_ENABLED,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("141");
const ROWS = 1000;
const NUMBERS = `WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < ${String(ROWS)}) SELECT n FROM g`;
/** Evaluated in the page, where the DOM exists; the popover, not its first radio, takes focus on open. */
const FOCUSED_TEST_ID = "document.activeElement?.getAttribute('data-testid') ?? null";
const CUSTOM_ROWS = 20;
const INVALID_ROWS = 5;
const TIMEOUT_SECONDS = 1;
const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };

function gear(page: Page) {
  return consoleToolbar(page).getByRole("button", { name: /^Run Settings…/ });
}

function popover(page: Page) {
  return page.getByTestId("run-settings");
}

function resultState(page: Page) {
  return page.getByTestId("result-state");
}

async function pick(page: Page, group: string, choice: string): Promise<void> {
  await popover(page).getByRole("group", { name: group }).locator("label", { hasText: choice }).click();
}

async function closePopover(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await popover(page).waitFor({ state: "detached" });
}

describe.runIf(SMOKE_ENABLED)("console run settings", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource, theme: "light" | "dark" = "light"): Promise<Page> {
    const userDataDir = newProfile();
    seedSettings(userDataDir, { version: 1, appearance: { motion: "off", theme } });
    running = await launchApp(datasource, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running.page;
  }

  it(
    "givenRunSettings_whenRowsCustomThenAllThenReset_thenEachRunReadsThatMany",
    async () => {
      const page = await launch(SCRATCH);

      await gear(page).click();
      await expect.poll(() => popover(page).isVisible()).toBe(true);
      expect(await popover(page).getByRole("radio", { name: "Default" }).isChecked()).toBe(true);
      expect(await gear(page).getAttribute("aria-expanded")).toBe("true");
      expect(await page.evaluate(FOCUSED_TEST_ID)).toBe("run-settings");
      expect(await popover(page).textContent()).toContain("cannot cancel a statement, so it has no timeout");
      await captureWindow(page, "01-popover-default");

      await pick(page, "Rows", "Custom");
      await popover(page).getByLabel("Page size").fill(String(CUSTOM_ROWS));
      await captureWindow(page, "02-custom-rows-popover");
      await popover(page).getByLabel("Page size").fill(String(INVALID_ROWS));
      await expect
        .poll(() => popover(page).getByRole("alert").textContent())
        .toContain(`Runs keep ${String(CUSTOM_ROWS)} until it is fixed.`);
      await captureWindow(page, "10-invalid-page-size");
      await popover(page).getByLabel("Page size").fill(String(CUSTOM_ROWS));
      await closePopover(page);
      await runStatement(page, NUMBERS);
      await expect
        .poll(() => resultState(page).textContent())
        .toBe(`${String(CUSTOM_ROWS)}+ rows · page size from Run Settings`);
      expect(await page.getByTestId("run-settings-dot").isVisible()).toBe(true);
      expect(await gear(page).getAttribute("aria-label")).toBe(`Run Settings… (Page size ${String(CUSTOM_ROWS)})`);
      await page.keyboard.press("Escape");
      await captureWindow(page, "03-custom-rows-result");

      await gear(page).click();
      await pick(page, "Rows", "All");
      await captureWindow(page, "04-all-rows-popover");
      await closePopover(page);
      await runStatement(page, NUMBERS);
      await expect
        .poll(() => resultState(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toBe(`${ROWS.toLocaleString("en-US")} rows`);
      await captureWindow(page, "05-all-rows-result");

      await gear(page).click();
      await popover(page).getByRole("button", { name: "Restore Defaults" }).click();
      expect(await popover(page).getByRole("button", { name: "Restore Defaults" }).isDisabled()).toBe(true);
      await closePopover(page);
      await runStatement(page, NUMBERS);
      await expect.poll(() => resultState(page).textContent()).toBe("500+ rows");
      expect(await page.getByTestId("run-settings-dot").count()).toBe(0);
      await captureWindow(page, "06-reset-default-rows");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(DATABASES_ENABLED && databaseEnabled("mysql"))(
    "givenConsoleTimeout_whenStatementOverruns_thenCancelledAtTheConsoleLimit",
    async () => {
      const page = await launch(MYSQL, "dark");

      await gear(page).click();
      await pick(page, "Statement timeout", "Custom");
      await popover(page).getByLabel("Seconds").fill(String(TIMEOUT_SECONDS));
      await captureWindow(page, "07-custom-timeout-popover");
      await closePopover(page);
      await gear(page).hover();
      await expect
        .poll(() => page.getByRole("tooltip").first().textContent())
        .toContain(`Timeout ${String(TIMEOUT_SECONDS)} s`);
      await captureWindow(page, "08-gear-tooltip");

      await runStatement(page, "SELECT SLEEP(10)");
      await expect
        .poll(() => consoleAlert(page).first().textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain(`timed out after ${String(TIMEOUT_SECONDS)} s`);
      expect(await consoleAlert(page).first().textContent()).toContain("raise it in Run Settings");
      await captureWindow(page, "09-timed-out");

      await consoleAlert(page).first().getByRole("button", { name: "Run Settings…" }).click();
      await expect.poll(() => popover(page).isVisible()).toBe(true);
      expect(await popover(page).getByLabel("Seconds").inputValue()).toBe(String(TIMEOUT_SECONDS));
      await captureWindow(page, "11-run-settings-from-error");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
