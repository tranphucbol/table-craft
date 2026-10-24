/**
 * Plan 029's live test: `USE ` and `SET search_path TO ` complete namespaces, and the console
 * toolbar's namespace label is a dropdown that switches the console. Gated, because it needs a
 * display, a fresh build and the `test/db/compose.yml` containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/029 bun run test:smoke:db
 *
 * The shared databases are only read, except one throwaway MySQL database and one TiDB database
 * this suite creates and drops itself.
 */
import { createRequire } from "node:module";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  MYSQL_CONFIG,
  POSTGRES_CONFIG,
  TIDB_CONFIG,
  TIDB_DATABASE,
  tidbScratchDatabase,
} from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  cancelButton,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  consoleAlert,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  pressChord,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  SMOKE_ENABLED,
  sqlEditor,
  startStatement,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("029");

const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };
const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };
const TIDB: Datasource = { id: "tidb", pluginId: "mysql", config: TIDB_CONFIG };

const BASIC_COMPLETION = "Control+Space";
const FROM = "SELECT * FROM ";
const LONG_QUERY = "SELECT SLEEP(30)";
/** Past Radix's open delay (`OPEN_DELAY_MS` in renderer/ui/Tooltip.tsx). */
const TOOLTIP_WAIT_MS = 2_000;
const RUNNING_REASON = "A statement is running; wait for it or cancel it.";
/** The image's root, which may create databases; the suite's user may not (test/db/compose.yml). */
const MYSQL_ROOT = { ...MYSQL_CONFIG, user: "root", password: "table_craft" };
const GONE_DATABASE = "plan_029_gone";
/** Wide enough for the TiDB scenario's whole database name beside the console toolbar's buttons. */
const WIDE_WINDOW = { width: 1700, height: EVIDENCE_WINDOW.height };
/** Plan 029: near MySQL's 64-character limit for a database name. */
const LONG_DATABASE_LENGTH = 62;
const LONG_DATABASE = tidbScratchDatabase(
  "a_database_whose_name_runs_long_enough_to_test_labels",
  LONG_DATABASE_LENGTH,
);

/** CodeMirror's `interactionDelay`, in which Enter does not accept. */
const INTERACTION_DELAY_MS = 75;
/** Strings, because the root program has no DOM lib. */
const LABEL_UNCLIPPED = `(() => {
  const label = document.querySelector('[data-testid="console-namespace"]');
  return label !== null && label.scrollWidth <= label.clientWidth;
})()`;
/**
 * True once Enter would accept the selected option: CodeMirror ignores it within its interaction
 * delay after the popup opens (test/e2e/completion.smoke.test.ts reads the same).
 */
const ACCEPTABLE = `(() => {
  const popup = document.querySelector('.cm-tooltip-autocomplete');
  if (popup === null || popup.classList.contains('cm-tooltip-autocomplete-disabled')) return false;
  const seen = (window.__popupSeen ??= new WeakMap());
  if (!seen.has(popup)) seen.set(popup, performance.now());
  return performance.now() - seen.get(popup) >= ${String(INTERACTION_DELAY_MS)} && popup.querySelector('[aria-selected]') !== null;
})()`;

interface AdminConnection {
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

/** The plugin's own copy of mysql2, which the root workspace does not depend on. */
const mysql = createRequire(new URL("../../plugins/mysql/package.json", import.meta.url))("mysql2/promise") as {
  createConnection(options: object): Promise<AdminConnection>;
};

async function admin(config: object, statements: readonly string[]): Promise<void> {
  const connection = await mysql.createConnection(config);
  try {
    for (const statement of statements) await connection.query(statement);
  } finally {
    await connection.end();
  }
}

function namespaceLabel(page: Page) {
  return page.getByTestId("console-namespace");
}

async function labelText(page: Page): Promise<string | null> {
  return (await namespaceLabel(page).count()) === 0 ? null : namespaceLabel(page).textContent();
}

/** Whether the label sits inside the toolbar's datasource span, rather than cut off past it. */
async function labelInsideToolbar(page: Page): Promise<boolean> {
  const label = await namespaceLabel(page).boundingBox();
  const owner = await page.getByTestId("console-datasource").boundingBox();
  if (label === null || owner === null) return false;
  return label.width > 0 && label.x >= owner.x && label.x + label.width <= owner.x + owner.width + 1;
}

/** Hovers the switcher afresh and says whether its tooltip gives the running reason. */
async function tooltipAfterHover(page: Page): Promise<boolean> {
  await page.mouse.move(0, 0);
  await switcher(page).hover();
  const reason = page.getByText(RUNNING_REASON).filter({ visible: true });
  return reason.waitFor({ timeout: TOOLTIP_WAIT_MS }).then(
    () => true,
    () => false,
  );
}

function switcher(page: Page) {
  return page.getByTestId("console-namespace-switcher");
}

function dropdown(page: Page) {
  return page.getByTestId("namespace-switcher");
}

function options(page: Page) {
  return page.getByTestId("namespace-switcher-option");
}

function outputLog(page: Page) {
  return page.getByRole("log", { name: "Output" });
}

function popup(page: Page) {
  return page.locator(".cm-tooltip-autocomplete");
}

async function editorText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="sql-editor"] .cm-line').allTextContents()).join("\n");
}

/** Replaces the console's text with `sql` and asks for completion at its end. */
async function completeAtEnd(page: Page, sql: string): Promise<string[]> {
  await sqlEditor(page).fill(sql);
  await expect.poll(() => editorText(page)).toBe(sql);
  await page.keyboard.press("Escape");
  await pressChord(page, "End");
  await page.keyboard.press(BASIC_COMPLETION);
  await popup(page).getByRole("option").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  return popup(page).locator(".cm-completionLabel").allTextContents();
}

async function openDropdown(page: Page): Promise<string[]> {
  await switcher(page).click();
  await options(page).first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  return options(page).allTextContents();
}

describe.runIf(DATABASES_ENABLED)("namespace switcher and USE completion live test", () => {
  let running: RunningApp | null = null;
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
    for (const step of cleanup.splice(0)) await step();
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource, label: string): Promise<Page> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    await expect.poll(() => labelText(running!.page), { timeout: LAUNCH_TIMEOUT_MS }).toBe(label);
    return running.page;
  }

  it(
    "givenMysqlUse_whenCompleting_thenDatabasesSystemLast",
    async () => {
      const page = await launch(MYSQL, "table_craft");

      const labels = await completeAtEnd(page, "USE ");

      expect(labels.slice(0, 2).sort()).toEqual(["archive", "table_craft"]);
      expect(labels).toContain("information_schema");
      expect(labels.indexOf("information_schema")).toBeGreaterThan(labels.indexOf("archive"));
      expect(labels).not.toContain("SELECT");
      await captureWindow(page, "01-mysql-use-completes-databases");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlUsePrefix_whenAcceptedAndRun_thenLabelIsIt",
    async () => {
      const page = await launch(MYSQL, "table_craft");

      expect(await completeAtEnd(page, "USE arc")).toEqual(["archive"]);
      await expect.poll(() => page.evaluate<boolean>(ACCEPTABLE), { timeout: LAUNCH_TIMEOUT_MS }).toBe(true);
      await page.keyboard.press("Enter");
      await expect.poll(() => editorText(page)).toBe("USE archive");
      await startStatement(page, await editorText(page));

      await expect.poll(() => labelText(page), { timeout: LAUNCH_TIMEOUT_MS }).toBe("archive");
      await captureWindow(page, "02-mysql-use-accepted-and-run");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenCaretInsideUseTarget_whenTabThenEnter_thenTabReplacesEnterInserts",
    async () => {
      const page = await launch(MYSQL, "table_craft");
      const typed = "USE arcxyz";
      const caretBack = "xyz".length;

      for (const [key, expected] of [
        ["Tab", "USE archive"],
        ["Enter", "USE archivexyz"],
      ] as const) {
        await sqlEditor(page).fill(typed);
        await expect.poll(() => editorText(page)).toBe(typed);
        await page.keyboard.press("Escape");
        await pressChord(page, "End");
        for (let step = 0; step < caretBack; step += 1) await page.keyboard.press("ArrowLeft");
        await page.keyboard.press(BASIC_COMPLETION);
        await popup(page).getByRole("option").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
        expect(await popup(page).locator(".cm-completionLabel").allTextContents()).toEqual(["archive"]);
        await expect.poll(() => page.evaluate<boolean>(ACCEPTABLE), { timeout: LAUNCH_TIMEOUT_MS }).toBe(true);
        await page.keyboard.press(key);
        await expect.poll(() => editorText(page)).toBe(expected);
      }
      await captureWindow(page, "02b-mysql-use-tab-replaces-enter-inserts");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenPostgresSearchPath_whenCompleting_thenSchemasNoKeywords",
    async () => {
      const page = await launch(POSTGRES, "public");

      const labels = await completeAtEnd(page, "SET search_path TO ");

      expect(labels).toContain("archive");
      expect(labels).toContain("public");
      expect(labels).not.toContain("DEFAULT");
      expect(labels).not.toContain("SELECT");
      await captureWindow(page, "03-postgres-search-path-completes-schemas");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlConsole_whenLabelClicked_thenDropdownWithCurrentChecked",
    async () => {
      const page = await launch(MYSQL, "table_craft");

      const listed = await openDropdown(page);

      expect(listed).toEqual(expect.arrayContaining(["archive", "table_craft", "information_schema"]));
      const current = options(page).filter({ hasText: "table_craft" });
      expect(await current.getAttribute("aria-current")).toBe("true");
      await captureWindow(page, "04-mysql-dropdown-open");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlDropdown_whenFilteredAndPicked_thenSwitchesAndCompletesThere",
    async () => {
      const page = await launch(MYSQL, "table_craft");
      await openDropdown(page);

      // Typed, not filled: the filter has the focus once the dropdown opens.
      await page.keyboard.type("arch");
      await expect.poll(() => options(page).allTextContents()).toEqual(["archive"]);
      await captureWindow(page, "05a-mysql-dropdown-filtered");
      await page.keyboard.press("Enter");

      await expect.poll(() => labelText(page), { timeout: LAUNCH_TIMEOUT_MS }).toBe("archive");
      await expect(dropdown(page).count()).resolves.toBe(0);
      await page.getByRole("tablist", { name: "Results" }).getByRole("tab", { name: "Output", exact: true }).click();
      await expect.poll(() => outputLog(page).textContent()).toContain("USE `archive`");
      await captureWindow(page, "05b-mysql-switched-output");
      const labels = await completeAtEnd(page, FROM);
      expect(labels).toContain("old_orders");
      expect(labels).not.toContain("customers");
      await captureWindow(page, "05c-mysql-switched-completes-there");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenPostgresDropdown_whenSchemaPicked_thenSearchPathSetAndLabelIsIt",
    async () => {
      const page = await launch(POSTGRES, "public");
      await openDropdown(page);

      await options(page).filter({ hasText: "archive" }).click();

      await expect.poll(() => labelText(page), { timeout: LAUNCH_TIMEOUT_MS }).toBe("archive");
      await page.getByRole("tablist", { name: "Results" }).getByRole("tab", { name: "Output", exact: true }).click();
      await expect.poll(() => outputLog(page).textContent()).toContain('SET search_path TO "archive"');
      const labels = await completeAtEnd(page, FROM);
      expect(labels).toContain("old_orders");
      await captureWindow(page, "10-postgres-switched-schema");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlLongQuery_whenRunning_thenSwitcherDisabledWithReason",
    async () => {
      const page = await launch(MYSQL, "table_craft");

      await startStatement(page, LONG_QUERY);
      await expect.poll(() => switcher(page).getAttribute("aria-disabled")).toBe("true");
      await expect.poll(() => tooltipAfterHover(page), { timeout: LAUNCH_TIMEOUT_MS }).toBe(true);
      await captureWindow(page, "06-mysql-running-switcher-disabled");
      // Forced: Playwright waits for an `aria-disabled` element to enable, which is the point here.
      await switcher(page).click({ force: true });
      expect(await dropdown(page).count()).toBe(0);
      await cancelButton(page).click();
      await waitUntilReady(page);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlDatabaseDroppedAfterListing_whenPicked_thenErrorLabelUnchanged",
    async () => {
      await admin(MYSQL_ROOT, [
        `CREATE DATABASE IF NOT EXISTS ${GONE_DATABASE}`,
        `GRANT ALL PRIVILEGES ON ${GONE_DATABASE}.* TO 'table_craft'@'%'`,
      ]);
      cleanup.push(() =>
        admin(MYSQL_ROOT, [
          `DROP DATABASE IF EXISTS ${GONE_DATABASE}`,
          `REVOKE ALL PRIVILEGES ON ${GONE_DATABASE}.* FROM 'table_craft'@'%'`,
        ]),
      );
      const page = await launch(MYSQL, "table_craft");
      await openDropdown(page);
      await page.getByTestId("namespace-switcher-refresh").click();
      await options(page).filter({ hasText: GONE_DATABASE }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });

      await admin(MYSQL_ROOT, [`DROP DATABASE ${GONE_DATABASE}`]);
      await options(page).filter({ hasText: GONE_DATABASE }).click();

      await expect.poll(() => consoleAlert(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toMatch(GONE_DATABASE);
      expect(await labelText(page)).toBe("table_craft");
      await captureWindow(page, "07-mysql-dropped-database-error");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenTidbLongNamedDatabase_whenSwitched_thenLabelInsideToolbarAndWholeWhenWide",
    async () => {
      await admin(TIDB_CONFIG, [`CREATE DATABASE IF NOT EXISTS ${LONG_DATABASE}`]);
      cleanup.push(() => admin(TIDB_CONFIG, [`DROP DATABASE IF EXISTS ${LONG_DATABASE}`]));
      const page = await launch(TIDB, TIDB_DATABASE);
      await openDropdown(page);
      await page.getByTestId("namespace-switcher-refresh").click();

      await options(page).filter({ hasText: LONG_DATABASE }).click();

      await expect.poll(() => labelText(page), { timeout: LAUNCH_TIMEOUT_MS }).toBe(LONG_DATABASE);
      expect(await namespaceLabel(page).getAttribute("title")).toBe(LONG_DATABASE);
      await captureWindow(page, "08a-tidb-long-database-label-narrow");
      expect(await labelInsideToolbar(page)).toBe(true);
      await setWindowSize(running!.app, WIDE_WINDOW);
      await expect.poll(() => page.evaluate<boolean>(LABEL_UNCLIPPED)).toBe(true);
      expect(await labelInsideToolbar(page)).toBe(true);
      await captureWindow(page, "08b-tidb-long-database-label-wide");
    },
    SCENARIO_TIMEOUT_MS,
  );
});

describe.runIf(SMOKE_ENABLED)("namespace switcher on SQLite live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  it(
    "givenSqlite_whenConsoleOpen_thenNoSwitcher",
    async () => {
      running = await launchApp({ id: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } });
      await setWindowSize(running.app, EVIDENCE_WINDOW);
      await waitUntilReady(running.page);

      expect(await switcher(running.page).count()).toBe(0);
      expect(await namespaceLabel(running.page).count()).toBe(0);
      await captureWindow(running.page, "09-sqlite-no-switcher");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
