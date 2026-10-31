/**
 * Plan 003's live test against the `test/db/compose.yml` databases: the shell, its shortcuts, the
 * palette, per-console sessions and tabs. Gated, because it needs a display, a fresh build and the
 * containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/003 bun run test:smoke:db
 */
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { MYSQL_CONFIG, POSTGRES_CONFIG, withWrongPassword, WITHOUT_POSTGRES } from "../support/databases.js";
import {
  activeEditorTab,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  datasourceStatus,
  editorTabs,
  evidenceFor,
  findAction,
  gridText,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  paletteInput,
  paletteRows,
  pressChord,
  pressDoubleShift,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  toolWindow,
  waitUntilReady,
  type Datasource,
  type RunningApp,
  showServices,
} from "./harness.js";

const captureWindow = evidenceFor("003");

const POSTGRES: Datasource = { id: "postgres", pluginId: "postgres", config: POSTGRES_CONFIG };
const MYSQL_WRONG_PASSWORD: Datasource = { id: "mysql", pluginId: "mysql", config: withWrongPassword(MYSQL_CONFIG) };
const CUSTOMERS_SQL = "SELECT * FROM customers ORDER BY id";
const ONE_SQL = "SELECT 1";
/** A page expression, because this program has no DOM lib. */
const FOCUSED_LABEL = "document.activeElement?.getAttribute('aria-label') ?? null";

/** The session rows of the Services tree (plan 011). */
function serviceSessions(page: Page) {
  return toolWindow(page, "Services").locator('[role="treeitem"][data-kind="session"]');
}

describe.runIf(DATABASES_ENABLED)("shell live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    await closeApp(running?.app);
    running = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launchPostgres() {
    running = await launchApp(POSTGRES);
    await waitUntilReady(running.page);
    return running.page;
  }

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPostgres_whenLaunched_thenShellShowsDatasourceConsoleAndServices",
    async () => {
      const page = await launchPostgres();

      await expect.poll(() => datasourceStatus(page).textContent()).toMatch(/^postgres · connected · PostgreSQL \d/);
      const node = toolWindow(page, "Database").locator('[role="treeitem"][data-kind="datasource"]');
      expect(await node.getAttribute("data-state")).toBe("connected");
      expect(await editorTabs(page).allTextContents()).toEqual(["console [postgres]"]);
      await showServices(page);
      expect(await serviceSessions(page).count()).toBe(1);
      await captureWindow(page, "shell-default");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPostgres_whenToolWindowShortcutsPressed_thenEachTogglesOnce",
    async () => {
      const page = await launchPostgres();
      const database = toolWindow(page, "Database");
      const services = await showServices(page);

      await pressChord(page, "1");
      await expect.poll(() => database.count()).toBe(0);
      expect(await services.count()).toBe(1);
      await pressChord(page, "1");
      await expect.poll(() => database.count()).toBe(1);

      await pressChord(page, "8");
      await expect.poll(() => services.count()).toBe(0);
      expect(await database.count()).toBe(1);
      await pressChord(page, "8");
      await expect.poll(() => services.count()).toBe(1);

      await pressChord(page, "Shift+F12");
      await expect.poll(async () => (await database.count()) + (await services.count())).toBe(0);
      await pressChord(page, "1");
      await expect.poll(() => database.count()).toBe(1);
      expect(await services.count()).toBe(0);
      await captureWindow(page, "shell-tool-windows");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPostgres_whenFindActionNewCon_thenSecondConsoleOpensActive",
    async () => {
      const page = await launchPostgres();

      await findAction(page, "new con");

      await expect
        .poll(() => editorTabs(page).allTextContents())
        .toEqual(["console [postgres]", "console_1 [postgres]"]);
      expect(await activeEditorTab(page).textContent()).toBe("console_1 [postgres]");
      await waitUntilReady(page);
      await expect.poll(() => page.evaluate(FOCUSED_LABEL)).toBe("SQL console");
      await captureWindow(page, "find-action");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPostgres_whenShiftShiftPressed_thenSearchEverywhereListsActionsWithShortcuts",
    async () => {
      const page = await launchPostgres();

      await pressDoubleShift(page);

      await expect.poll(() => paletteInput(page, "Search Everywhere").isVisible()).toBe(true);
      const scope = page.getByRole("tablist", { name: "Search scope" });
      expect(await scope.getByRole("tab", { selected: true }).textContent()).toBe("All");
      await scope.getByRole("tab", { name: "Actions" }).click();
      expect(await scope.getByRole("tab", { selected: true }).textContent()).toBe("Actions");
      const rows = paletteRows(page);
      expect(await rows.count()).toBeGreaterThan(5);
      expect(await rows.filter({ hasText: "Find Action…" }).locator("kbd").count()).toBe(1);
      expect(await rows.and(page.locator("[aria-disabled=true]")).count()).toBeGreaterThan(0);
      await captureWindow(page, "search-everywhere");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenTwoPostgresConsoles_whenEachRuns_thenEachKeepsItsOwnResult",
    async () => {
      const page = await launchPostgres();
      await runStatement(page, ONE_SQL);
      await pressChord(page, "Shift+L");
      await expect.poll(() => editorTabs(page).count()).toBe(2);
      await waitUntilReady(page);
      await runStatement(page, CUSTOMERS_SQL);
      const customers = await gridText(page);
      expect(customers.headers).toContain("email");

      await editorTabs(page)
        .filter({ hasText: /^console \[postgres\]$/ })
        .click();
      await expect.poll(async () => (await gridText(page)).cells).toEqual(["1"]);
      await editorTabs(page).filter({ hasText: "console_1 " }).click();
      await expect.poll(() => gridText(page)).toEqual(customers);

      await showServices(page);
      const consoles = serviceSessions(page);
      expect(await consoles.count()).toBe(2);
      for (const text of await consoles.allTextContents()) expect(text).toMatch(/idle.*\d+ ms|idle.*\d+(\.\d+)? s/);
      await captureWindow(page, "two-consoles");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenThreePostgresConsoles_whenCycledClosedAndClosedOthers_thenLastCloseShowsEmptyState",
    async () => {
      const page = await launchPostgres();
      await pressChord(page, "Shift+L");
      await pressChord(page, "Shift+L");
      await expect
        .poll(() => editorTabs(page).allTextContents())
        .toEqual(["console [postgres]", "console_1 [postgres]", "console_2 [postgres]"]);
      expect(await activeEditorTab(page).textContent()).toBe("console_2 [postgres]");

      await pressChord(page, "Shift+BracketRight");
      await expect.poll(() => activeEditorTab(page).textContent()).toBe("console [postgres]");
      await pressChord(page, "Shift+BracketLeft");
      await expect.poll(() => activeEditorTab(page).textContent()).toBe("console_2 [postgres]");
      await pressChord(page, "w");
      await expect
        .poll(() => editorTabs(page).allTextContents())
        .toEqual(["console [postgres]", "console_1 [postgres]"]);
      expect(await activeEditorTab(page).textContent()).toBe("console_1 [postgres]");

      await editorTabs(page)
        .filter({ hasText: /^console \[postgres\]$/ })
        .click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Close Other Tabs/ }).click();
      await expect.poll(() => editorTabs(page).allTextContents()).toEqual(["console [postgres]"]);

      await pressChord(page, "w");
      await expect.poll(() => editorTabs(page).count()).toBe(0);
      expect(await page.getByText("No open consoles.").first().isVisible()).toBe(true);
      await captureWindow(page, "tabs");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlWrongPassword_whenLaunched_thenShellShowsTheConnectFailure",
    async () => {
      running = await launchApp(MYSQL_WRONG_PASSWORD);
      const { page } = running;
      const node = toolWindow(page, "Database").getByRole("treeitem");
      await expect.poll(() => node.getAttribute("data-state"), { timeout: LAUNCH_TIMEOUT_MS }).toBe("failed");
      expect(await datasourceStatus(page).textContent()).toMatch(/Could not connect/);

      await pressChord(page, "Shift+A");
      await paletteInput(page, "Find Action").fill("disconnect");
      const disconnect = paletteRows(page)
        .filter({ hasText: /^Disconnect/ })
        .first();
      expect(await disconnect.getAttribute("aria-disabled")).toBe("true");
      await captureWindow(page, "connect-failed-shell");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
