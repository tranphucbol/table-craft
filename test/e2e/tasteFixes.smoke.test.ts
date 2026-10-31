/**
 * Plan 130's live test: the UI fixes from the taste review, on the seeded TiDB and a fresh
 * profile. Gated, because it needs a display, a fresh build and the TiDB of `test:smoke:db`:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/130 bun run test:smoke:db:headless test/e2e/tasteFixes.smoke.test.ts
 *
 * It creates `customers` and `orders` in the run's TiDB database and drops them afterwards.
 */
import type { Locator, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import mysql from "@table-craft/plugin-mysql";
import { TIDB_CONFIG } from "../support/databases.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  consoleAlert,
  DATABASES_ENABLED,
  dataSourcesDialog,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  mainToolbar,
  newProfile,
  paletteInput,
  paletteRows,
  pressChord,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  seedSettings,
  setWindowSize,
  sqlEditor,
  startStatement,
  toolWindow,
  treeNode,
  type Datasource,
  type RunningApp,
  waitUntilReady,
} from "./harness.js";

const captureWindow = evidenceFor("130");
const NARROW_WINDOW = { width: 1024, height: 680 } as const;
const SLOW_SQL = "SELECT SLEEP(30)";
/** A syntax error, since TiDB names a position only for those, and Go to Error needs one. */
const SYNTAX_ERROR_SQL = "SELECT id FROM orders ORDER BYE id";
const ELAPSED = /^(\d+ ms|\d+\.\d{3} s|\d+:\d{2}\.\d{3})$/;
const SPINNER = ".animate-spin";
const TIDB_NAME = "tidb";
const TIDB: Datasource = { id: TIDB_NAME, pluginId: "mysql", config: TIDB_CONFIG };
const SEED = [
  "DROP TABLE IF EXISTS orders",
  "DROP TABLE IF EXISTS customers",
  "CREATE TABLE customers (id INT PRIMARY KEY, name VARCHAR(255) NOT NULL, email VARCHAR(255) NOT NULL)",
  "CREATE TABLE orders (id INT PRIMARY KEY, customer_id INT NOT NULL, total DECIMAL(12, 2) NOT NULL, placed_at DATETIME NOT NULL, KEY orders_customer (customer_id))",
  "INSERT INTO customers VALUES (1, 'Ada Lovelace', 'ada@shop.test'), (2, 'Grace Hopper', 'grace@shop.test'), (3, 'Alan Turing', 'alan@shop.test'), (4, 'Edsger Dijkstra', 'edsger@shop.test')",
  "INSERT INTO orders VALUES (1, 1, 120.50, '2026-01-04 09:12:00'), (2, 2, 19.99, '2026-01-05 14:30:00'), (3, 1, 5.00, '2026-01-07 18:02:00'), (4, 3, 342.10, '2026-02-11 08:45:00'), (5, 4, 88.00, '2026-02-14 12:00:00'), (6, 2, 61.25, '2026-03-02 16:20:00')",
];
const UNSEED = ["DROP TABLE IF EXISTS orders", "DROP TABLE IF EXISTS customers"];

/** Runs `statements` on TiDB straight through the plugin, outside the app. */
async function onTidb(statements: readonly string[]): Promise<void> {
  const session = await mysql.connect(TIDB_CONFIG, { readOnly: false });
  try {
    for (const sql of statements) {
      for await (const _row of (await session.execute(sql)).rows) {
        // Drained so the statement completes before the next.
      }
    }
  } finally {
    await session.close();
  }
}

type StyleProperty = "display" | "opacity" | "textTransform";

/** The DOM members `computed` touches; the e2e program has no DOM lib. */
interface StyledElement {
  readonly ownerDocument: {
    readonly defaultView: {
      getComputedStyle(element: StyledElement): Readonly<Record<StyleProperty, string>>;
    };
  };
}

async function computed(element: Locator, property: StyleProperty): Promise<string> {
  return element.evaluate(
    (node: StyledElement, name) => node.ownerDocument.defaultView.getComputedStyle(node)[name],
    property,
  );
}

function settingsDialog(page: Page) {
  return page.getByRole("dialog", { name: "Settings" });
}

describe.runIf(DATABASES_ENABLED)("plan 130 UI fixes live test", () => {
  let running: RunningApp | null = null;

  beforeAll(() => onTidb(SEED), SCENARIO_TIMEOUT_MS);
  afterAll(() => onTidb(UNSEED), SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource | null, userDataDir?: string): Promise<Page> {
    running = await launchApp(datasource, userDataDir === undefined ? {} : { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    if (datasource !== null) await waitUntilReady(running.page);
    return running.page;
  }

  it(
    "givenFreshProfile_whenLaunched_thenServicesClosedNoRunAndNewDataSourceOnTheCanvas",
    async () => {
      const page = await launch(null);

      const canvas = page.getByTestId("empty-editor");
      await canvas.waitFor();
      expect(await toolWindow(page, "Services").count()).toBe(0);
      expect(await mainToolbar(page).getByRole("button", { name: "Run", exact: true }).count()).toBe(0);
      expect(await canvas.getByRole("button", { name: /^New Data Source/ }).count()).toBe(1);
      await captureWindow(page, "02-first-run");
      await captureWindow(page, "03-title-bar");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenLongStatement_whenRunning_thenOneSpinnerAndAMillisecondTimer",
    async () => {
      const page = await launch(TIDB);

      await startStatement(page, SLOW_SQL);
      const capsule = page.getByTestId("activity-capsule");
      await capsule.waitFor();
      const time = capsule.getByRole("status", { name: "Running" });
      await expect.poll(() => time.textContent()).toMatch(ELAPSED);
      await expect.poll(() => mainToolbar(page).locator(SPINNER).count()).toBe(1);
      expect(await capsule.locator(SPINNER).count()).toBe(0);
      await captureWindow(page, "01-capsule");
      await capsule.getByRole("button", { name: /^Cancel/ }).click();
      await capsule.waitFor({ state: "hidden", timeout: LAUNCH_TIMEOUT_MS });
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenConnectedTidb_whenQueriedAndFailed_thenNoConnectedWordNoStripesAndTheErrorBlock",
    async () => {
      const page = await launch(TIDB);

      await runStatement(page, "SELECT * FROM orders");
      expect(await treeNode(page, TIDB_NAME).textContent()).not.toContain("connected");
      expect(await page.locator(".bg-grid-stripe").count()).toBe(0);
      await captureWindow(page, "04-tree");
      await captureWindow(page, "05-grid");

      await runStatement(page, SYNTAX_ERROR_SQL);
      const block = page.getByTestId("run-error");
      await block.waitFor();
      expect(await consoleAlert(page).count()).toBe(1);
      for (const name of ["Go to Error", "Show in Log", "Run Again"]) {
        await expect.poll(() => block.getByRole("button", { name, exact: true }).count()).toBe(1);
      }
      await captureWindow(page, "06-run-error");

      await sqlEditor(page).fill("SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id");
      await pressChord(page, "Shift+E");
      const plan = page
        .getByRole("treegrid")
        .or(page.getByRole("tree", { name: /plan/i }))
        .first();
      await plan.waitFor();
      await captureWindow(page, "07-plan");

      await pressChord(page, "Shift+A");
      await paletteInput(page, "Find Action").fill("export");
      await expect.poll(() => paletteRows(page).count()).toBeGreaterThan(0);
      expect(await paletteRows(page).first().getAttribute("aria-disabled")).not.toBe("true");
      await captureWindow(page, "08-palette");
      await page.keyboard.press("Escape");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenDataSourcesDialog_whenKindPickedAndTunnelTicked_thenGridCloseButtonAndSshRowsOnlyWhenTicked",
    async () => {
      const page = await launch(null);

      await toolWindow(page, "Database").getByRole("button", { name: "New Data Source…", exact: true }).click();
      const dialog = dataSourcesDialog(page);
      const kinds = dialog.getByRole("list", { name: "Database kinds" });
      await kinds.waitFor();
      expect(await computed(kinds, "display")).toBe("grid");
      expect(await dialog.getByRole("button", { name: "Close Data Sources", exact: true }).count()).toBe(1);
      expect(await dialog.getByRole("button", { name: "Test Connection" }).count()).toBe(0);
      await expect.poll(() => computed(dialog, "opacity")).toBe("1");
      await captureWindow(page, "09-kinds");

      await kinds.getByRole("button", { name: "MySQL" }).first().click();
      expect(await dialog.getByLabel("SSH host", { exact: true }).count()).toBe(0);
      await dialog.getByLabel("Use SSH tunnel", { exact: true }).check();
      await dialog.getByLabel("SSH host", { exact: true }).waitFor();
      await dialog.getByLabel("SSH user", { exact: true }).scrollIntoViewIfNeeded();
      await captureWindow(page, "10-mysql-form");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSettings_whenDataEditorShown_thenToolsInSentenceCaseGroupedNumbersAndAWatchSection",
    async () => {
      const page = await launch(TIDB);

      await pressChord(page, ",");
      const dialog = settingsDialog(page);
      await dialog.waitFor();
      const pages = dialog.getByRole("tablist", { name: "Settings pages" });
      const tools = pages.getByText("Tools", { exact: true });
      expect(await computed(tools, "textTransform")).toBe("none");
      expect(await dialog.getByRole("button", { name: "Close Settings", exact: true }).count()).toBe(1);
      await pages.getByRole("tab", { name: "Data Editor", exact: true }).click();
      expect(await dialog.getByRole("heading", { name: "Watch", exact: true }).count()).toBe(1);
      expect(await dialog.getByLabel("Events retained per watch", { exact: true }).inputValue()).toBe("10,000");
      await captureWindow(page, "11-settings");

      await pages.getByRole("tab", { name: "Advanced", exact: true }).click();
      await captureWindow(page, "14-settings-advanced");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenDarkTheme_whenStatementRuns_thenQuietFlashAndNeutralStripeButton",
    async () => {
      const userDataDir = newProfile();
      seedSettings(userDataDir, { version: 1, appearance: { theme: "dark" } });
      const page = await launch(TIDB, userDataDir);

      await runStatement(page, "SELECT * FROM customers");
      await captureWindow(page, "12-dark");

      if (running === null) throw new Error("The app is not running.");
      await setWindowSize(running.app, NARROW_WINDOW);
      await runStatement(page, "SELECT * FROM orders");
      await captureWindow(page, "13-narrow");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
