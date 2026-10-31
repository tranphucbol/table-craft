/**
 * Plan 130's live test: the UI fixes from the taste review, on the seeded TiDB and a fresh
 * profile. Gated, because it needs a display, a fresh build and the TiDB of `test:smoke:db`:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/130 bun run test:smoke:db:headless test/e2e/tasteFixes.smoke.test.ts
 *
 * It creates `customers` and `orders` in the run's TiDB database and drops them afterwards, and
 * its explorer lists only that database.
 */
import type { Locator, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import mysql from "@table-craft/plugin-mysql";
import { ETCD_CONFIG, TIDB_CONFIG } from "../support/databases.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  answerSecretPrompt,
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
  openConsoleOn,
  paletteInput,
  paletteRows,
  pressChord,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  seedSettings,
  setWindowSize,
  sqlEditor,
  startStatement,
  toolWindow,
  treeNode,
  type SavedDatasource,
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
const TREE_LOADING = "loading…";
const TIDB_NAME = "tidb";
const { password: TIDB_PASSWORD, ...TIDB_PLAIN } = TIDB_CONFIG;
/**
 * Saved rather than ephemeral so it can list only the run's own database: the TiDB is shared, and
 * the evidence must not show anyone else's.
 */
const TIDB: SavedDatasource = {
  id: TIDB_NAME,
  name: TIDB_NAME,
  pluginId: "mysql",
  config: TIDB_PLAIN,
  shownNamespaces: [TIDB_CONFIG.database],
  ...(TIDB_PASSWORD === "" ? {} : { secretModes: { password: "untilRestart" } }),
};
const { password: _etcdPassword, ...ETCD_PLAIN } = ETCD_CONFIG;
/** Saved and never connected: the logo comes from the plugin's manifest, so no etcd server is needed. */
const ETCD: SavedDatasource = {
  id: "config",
  name: "config",
  pluginId: "etcd",
  config: ETCD_PLAIN,
  secretModes: { password: "never" },
};
const ETCD_GLYPH = "etcd";
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

const COMPLETION_POPUP = ".cm-tooltip-autocomplete";

/** Shuts the completion popup, which lists every database on the shared TiDB, not only the shown one. */
async function hideCompletion(page: Page): Promise<void> {
  const popup = page.locator(COMPLETION_POPUP);
  if ((await popup.count()) > 0) await page.keyboard.press("Escape");
  await expect.poll(() => popup.count()).toBe(0);
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

  async function launch(userDataDir?: string): Promise<Page> {
    running = await launchApp(null, userDataDir === undefined ? {} : { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    return running.page;
  }

  /** Launches on the saved TiDB and opens a console on it, typing the password when it has one. */
  async function launchOnTidb(userDataDir = newProfile()): Promise<Page> {
    seedDatasources(userDataDir, [TIDB]);
    const page = await launch(userDataDir);
    await openConsoleOn(page, TIDB_NAME);
    if (TIDB_PASSWORD !== "") await answerSecretPrompt(page, TIDB_NAME, TIDB_PASSWORD);
    await waitUntilReady(page);
    await treeNode(page, TIDB_CONFIG.database).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    const loading = toolWindow(page, "Database").getByText(TREE_LOADING, { exact: true });
    await expect.poll(() => loading.count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(0);
    return page;
  }

  it(
    "givenFreshProfile_whenLaunched_thenServicesClosedNoRunAndNewDataSourceOnTheCanvas",
    async () => {
      const page = await launch();

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
      const page = await launchOnTidb();

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
      const page = await launchOnTidb();

      await runStatement(page, "SELECT * FROM orders");
      await hideCompletion(page);
      expect(await treeNode(page, TIDB_NAME).textContent()).not.toContain("connected");
      expect(await page.locator(".bg-grid-stripe").count()).toBe(0);
      await captureWindow(page, "04-tree");
      await captureWindow(page, "05-grid");

      await runStatement(page, SYNTAX_ERROR_SQL);
      await hideCompletion(page);
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
      const page = await launch();

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
    "givenSavedEtcd_whenLaunched_thenTheTreeAndTheDialogDrawTheEtcdLogo",
    async () => {
      const profile = newProfile();
      seedDatasources(profile, [ETCD]);
      const page = await launch(profile);

      const glyph = treeNode(page, ETCD.name).locator("[data-glyph]").first();
      await expect.poll(() => glyph.getAttribute("data-glyph"), { timeout: LAUNCH_TIMEOUT_MS }).toBe(ETCD_GLYPH);
      await captureWindow(page, "15-etcd-tree");

      await toolWindow(page, "Database").getByRole("button", { name: "New Data Source…", exact: true }).click();
      const dialog = dataSourcesDialog(page);
      const option = dialog
        .getByRole("listbox", { name: "Data sources" })
        .getByRole("option")
        .filter({ has: page.getByText(ETCD.name, { exact: true }) });
      await expect.poll(() => option.locator("[data-glyph]").getAttribute("data-glyph")).toBe(ETCD_GLYPH);
      const kind = dialog.getByRole("list", { name: "Database kinds" }).getByRole("button", { name: /^etcd/ });
      await expect.poll(() => kind.locator("[data-glyph]").getAttribute("data-glyph")).toBe(ETCD_GLYPH);
      await expect.poll(() => computed(dialog, "opacity")).toBe("1");
      await captureWindow(page, "16-etcd-dialog");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSettings_whenDataEditorShown_thenToolsInSentenceCaseGroupedNumbersAndAWatchSection",
    async () => {
      const page = await launchOnTidb();

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
      const page = await launchOnTidb(userDataDir);

      await runStatement(page, "SELECT * FROM customers");
      await hideCompletion(page);
      await captureWindow(page, "12-dark");

      if (running === null) throw new Error("The app is not running.");
      await setWindowSize(running.app, NARROW_WINDOW);
      await runStatement(page, "SELECT * FROM orders");
      await hideCompletion(page);
      await captureWindow(page, "13-narrow");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
