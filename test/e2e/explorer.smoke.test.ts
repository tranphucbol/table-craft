/**
 * Plan 005's live test: the Database pane browsing every schema of PostgreSQL, MySQL and SQLite,
 * against the `test/db/compose.yml` databases. Gated, because it needs a display, a fresh build and
 * the containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/005 bun run test:smoke:db
 */
import type { Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import postgres from "@table-craft/plugin-postgres";
import { MYSQL_CONFIG, POSTGRES_CONFIG, WITHOUT_POSTGRES } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  activeEditorTab,
  answerSecretPrompt,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  findAction,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  paletteInput,
  paletteRows,
  pressChord,
  pressDoubleShift,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  setWindowSize,
  sqlEditor,
  toolWindow,
  treeNode,
  waitUntilReady,
  type Datasource,
  type RunningApp,
  type SavedDatasource,
} from "./harness.js";

const captureWindow = evidenceFor("005");

const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };
const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };

const LIMITED_ROLE = "explorer_limited";
const RESTRICTED_SCHEMA = "explorer_restricted";
const WIDE_SCHEMA = "explorer_wide";
const WIDE_TABLES = 500;
const WIDE_COLUMNS = 10;
const WIDE_DESCRIBE_BUDGET_MS = 2_000;
const NEW_TABLE = "explorer_new";
const DATABASE_PANE_WIDENING_PX = 160;
/** Not `mysql`, which the server's own system database is also called. */
const SHARED_MYSQL = "Shared MySQL";
const SHOWN_OF_TOTAL = /^(\d+) of (\d+)$/;
/** `placed_at` is about 60 px wide in the UI font; a squeezed name measures far less. */
const MIN_NAME_WIDTH_PX = 40;

function sqlite(): Datasource {
  return { id: "sqlite", pluginId: "sqlite", config: { path: seededSqliteFile() } };
}

/** Runs setup statements as the fixture's owner, outside the app, one statement at a time. */
async function asOwner(statements: readonly string[]): Promise<void> {
  const session = await postgres.connect(POSTGRES_CONFIG, { readOnly: false });
  try {
    for (const sql of statements) {
      const result = await session.execute(sql);
      for await (const _row of result.rows) {
        // Drained so the statement completes before the next.
      }
    }
  } finally {
    await session.close();
  }
}

function explorer(page: Page) {
  return toolWindow(page, "Database");
}

/** A tree row by its accessible name, e.g. `tables 3` or `id integer, primary key, not null`. */
function row(page: Page, name: string | RegExp) {
  return explorer(page).getByRole("treeitem", { name, exact: typeof name === "string" });
}

async function expand(page: Page, name: string | RegExp): Promise<void> {
  const target = row(page, name);
  await target.click();
  if ((await target.getAttribute("aria-expanded")) !== "true") await page.keyboard.press("ArrowRight");
  await expect.poll(() => target.getAttribute("aria-expanded")).toBe("true");
}

/** A namespace row whatever its state: `public`, `public, loading`, `public, failed`. */
function namespaceName(name: string): RegExp {
  return new RegExp(`^${name}(, (loading|failed))?$`);
}

/** The tree's rows that are fully inside its scroll viewport, against how many fit there. */
const VIEWPORT_ROWS = `(() => {
  const tree = document.querySelector('[aria-label="Database"] [role="tree"]');
  const viewport = tree?.parentElement?.getBoundingClientRect();
  if (!tree || !viewport) return null;
  const rows = [...tree.querySelectorAll('[role="treeitem"]')].map((item) => item.getBoundingClientRect());
  const inside = rows.filter((box) => box.top >= viewport.top - 1 && box.bottom <= viewport.bottom + 1);
  const height = rows[0]?.height ?? 1;
  return { inside: inside.length, fit: Math.floor(viewport.height / height) };
})()`;

/** `38 ms` or `1.4 s` from the sync status, in milliseconds. */
function syncElapsedMs(status: string | null): number {
  const found = /\((\d+(?:\.\d+)?) (ms|s)\)/.exec(status ?? "");
  if (found === null) return Number.NaN;
  return Number(found[1]) * (found[2] === "s" ? 1_000 : 1);
}

/** Drags the Database pane's right edge, so column types and error hints fit beside the names. */
async function widenDatabasePane(page: Page): Promise<void> {
  const box = await explorer(page).boundingBox();
  if (box === null) throw new Error("The Database tool window is not shown.");
  const edge = box.x + box.width;
  const middle = box.y + box.height / 2;
  await page.mouse.move(edge, middle);
  await page.mouse.down();
  await page.mouse.move(edge + DATABASE_PANE_WIDENING_PX, middle, { steps: 5 });
  await page.mouse.up();
}

function syncStatus(page: Page) {
  return page.getByTestId("status-sync");
}

async function clipboardText(running: RunningApp): Promise<string> {
  return running.app.evaluate(({ clipboard }) => clipboard.readText());
}

describe.runIf(DATABASES_ENABLED)("database explorer live test", () => {
  let running: RunningApp | null = null;

  beforeAll(async () => {
    if (WITHOUT_POSTGRES) return;
    await asOwner([
      `DROP SCHEMA IF EXISTS ${RESTRICTED_SCHEMA} CASCADE`,
      `DROP SCHEMA IF EXISTS ${WIDE_SCHEMA} CASCADE`,
      `DROP TABLE IF EXISTS public.${NEW_TABLE}`,
    ]);
  });

  afterAll(async () => {
    if (WITHOUT_POSTGRES) return;
    await asOwner([
      `DROP SCHEMA IF EXISTS ${RESTRICTED_SCHEMA} CASCADE`,
      `DROP SCHEMA IF EXISTS ${WIDE_SCHEMA} CASCADE`,
      `DROP TABLE IF EXISTS public.${NEW_TABLE}`,
    ]);
  });

  afterEach(async () => {
    await closeApp(running?.app);
    running = null;
    // Every scenario expects the fixture's three tables in public.
    if (!WITHOUT_POSTGRES) await asOwner([`DROP TABLE IF EXISTS public.${NEW_TABLE}`]);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource): Promise<Page> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    await widenDatabasePane(running.page);
    return running.page;
  }

  /** Launches on `datasource` and waits for the tree to open on its current namespace. */
  async function launchExplored(datasource: Datasource, tables = "tables 6"): Promise<Page> {
    const page = await launch(datasource);
    await row(page, tables).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    return page;
  }

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPostgres_whenConnected_thenPublicIsDescribedAndExpanded",
    async () => {
      const page = await launchExplored(POSTGRES);

      await expect.poll(() => row(page, "public").getAttribute("aria-expanded")).toBe("true");
      await expect.poll(() => row(page, "views 1").count()).toBe(1);
      await expect.poll(() => syncStatus(page).textContent()).toMatch(/^public synchronized \(\d+ ms\) · just now$/);
      await captureWindow(page, "postgres-auto-expanded");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPostgresOrders_whenExpanded_thenGroupsAndColumnMarkersShow",
    async () => {
      const page = await launchExplored(POSTGRES);

      await expand(page, "tables 6");
      await expand(page, "orders");
      await expand(page, "columns 4");

      await expect.poll(() => row(page, "keys 1").count()).toBe(1);
      await expect.poll(() => row(page, "foreign keys 1").count()).toBe(1);
      await expect.poll(() => row(page, /^indexes \d+$/).count()).toBe(1);
      await expect.poll(() => row(page, "id integer, primary key, not null").count()).toBe(1);
      await expect.poll(() => row(page, "customer_id integer, foreign key, not null").count()).toBe(1);
      // A long type gives way to the name, never the other way round.
      const name = row(page, /^placed_at timestamp/).getByText("placed_at", { exact: true });
      const nameBox = await name.boundingBox();
      expect(nameBox?.width ?? 0).toBeGreaterThan(MIN_NAME_WIDTH_PX);
      await captureWindow(page, "postgres-orders-expanded");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysql_whenConnected_thenTableCraftShowsTheSameTree",
    async () => {
      const page = await launchExplored(MYSQL);

      await expand(page, "tables 6");
      await expand(page, "orders");

      await expect.poll(() => row(page, "table_craft").getAttribute("aria-expanded")).toBe("true");
      await expect.poll(() => row(page, "views 1").count()).toBe(1);
      await expect.poll(() => row(page, "foreign keys 1").count()).toBe(1);
      await captureWindow(page, "mysql-tree");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSqlite_whenConnected_thenMainShowsTheSameTree",
    async () => {
      const page = await launchExplored(sqlite());

      await expand(page, "tables 6");
      await expand(page, "orders");

      await expect.poll(() => row(page, "main").getAttribute("aria-expanded")).toBe("true");
      await expect.poll(() => row(page, "views 1").count()).toBe(1);
      await expect.poll(() => row(page, "foreign keys 1").count()).toBe(1);
      await captureWindow(page, "sqlite-tree");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenSystemSchemasHidden_whenToggled_thenPgCatalogAndInformationSchemaComeAndGo",
    async () => {
      const page = await launchExplored(POSTGRES);
      await expect.poll(() => row(page, "pg_catalog").count()).toBe(0);

      await findAction(page, "Show System Schemas");
      await expect.poll(() => row(page, "pg_catalog").count()).toBe(1);
      await expect.poll(() => row(page, "information_schema").count()).toBe(1);
      await captureWindow(page, "system-schemas");

      await findAction(page, "Show System Schemas");
      await expect.poll(() => row(page, "pg_catalog").count()).toBe(0);
      await expect.poll(() => row(page, "information_schema").count()).toBe(0);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSavedMysql_whenManageShownSchemasHidesTableCraft_thenItsNodeGoesAndTheRowSaysNOfM",
    async () => {
      const profile = newProfile();
      const { password, ...plain } = MYSQL_CONFIG;
      const saved: SavedDatasource = {
        id: "shared-mysql",
        name: SHARED_MYSQL,
        pluginId: "mysql",
        config: plain,
        secretModes: { password: "never" },
      };
      seedDatasources(profile, [saved]);
      running = await launchApp(null, { userDataDir: profile });
      const { page } = running;
      await setWindowSize(running.app, EVIDENCE_WINDOW);
      await widenDatabasePane(page);
      await treeNode(page, SHARED_MYSQL).click();
      await page.keyboard.press("ArrowRight");
      await answerSecretPrompt(page, SHARED_MYSQL, password);
      await row(page, "table_craft").waitFor({ timeout: LAUNCH_TIMEOUT_MS });

      await findAction(page, "Manage Shown Schemas");
      const dialog = page.getByRole("dialog", { name: `Manage Shown Schemas — ${SHARED_MYSQL}` });
      await dialog.getByRole("checkbox", { name: "All schemas", exact: true }).uncheck();
      await dialog.getByRole("checkbox", { name: "table_craft", exact: true }).uncheck();
      await captureWindow(page, "manage-shown-schemas");
      await dialog.getByRole("button", { name: "OK", exact: true }).click();
      await dialog.waitFor({ state: "detached" });

      await expect.poll(() => row(page, "table_craft").count()).toBe(0);
      const shown = treeNode(page, SHARED_MYSQL).getByTestId("shown-namespaces");
      await expect.poll(() => shown.textContent()).toMatch(SHOWN_OF_TOTAL);
      const [, count, total] = SHOWN_OF_TOTAL.exec((await shown.textContent()) ?? "") ?? [];
      expect(Number(count)).toBe(Number(total) - 1);
      await captureWindow(page, "shown-schemas-filtered");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenLoadedTree_whenTypingCust_thenSpeedSearchHighlightsAndArrowMovesToTheNextMatch",
    async () => {
      const page = await launchExplored(POSTGRES);
      await expand(page, "tables 6");
      await expand(page, "views 1");
      await row(page, "public").click();

      await page.keyboard.type("cust");

      const field = explorer(page).getByRole("status", { name: "Speed search" });
      await expect.poll(() => field.textContent()).toContain("cust");
      await expect.poll(() => field.getAttribute("data-state")).toBe("match");
      await expect.poll(() => row(page, "customers").getAttribute("aria-selected")).toBe("true");
      await expect.poll(() => explorer(page).locator("mark[data-match]").allTextContents()).toEqual(["cust", "cust"]);

      await page.keyboard.press("ArrowDown");
      await expect.poll(() => row(page, "customer_totals").getAttribute("aria-selected")).toBe("true");
      await captureWindow(page, "speed-search");

      await page.keyboard.press("Escape");
      await expect.poll(() => field.count()).toBe(0);
      await expect.poll(() => row(page, "customer_totals").getAttribute("aria-selected")).toBe("true");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlTablesLoaded_whenSearchEverywhereTablesTabChoosesOrders_thenItsDataOpens",
    async () => {
      const page = await launchExplored(MYSQL);
      await expect.poll(() => row(page, "orders").count()).toBe(0);

      await pressDoubleShift(page);
      await page.getByRole("tab", { name: "Tables" }).click();
      await paletteInput(page, "Search Everywhere").fill("ord");
      await expect.poll(() => paletteRows(page).first().textContent()).toContain("mysql › table_craft");
      await captureWindow(page, "search-everywhere-tables");
      // Plan 008: the Tables tab opens a table's data, as DataGrip's does.
      await page.keyboard.press("Enter");

      await expect.poll(() => activeEditorTab(page).textContent()).toContain("orders");
      await expect.poll(() => page.getByTestId("table-editor").count()).toBe(1);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenTableCreatedOutsideTheApp_whenSynchronized_thenItAppearsAndStatusShowsTheNewSync",
    async () => {
      const page = await launchExplored(POSTGRES);
      await expand(page, "tables 6");
      const before = await syncStatus(page).textContent();

      // Outside the app, because DDL run in a console refreshes the tree by itself (plan 006).
      await asOwner([`CREATE TABLE public.${NEW_TABLE} (id integer PRIMARY KEY, note text)`]);
      await expect.poll(() => row(page, NEW_TABLE).count()).toBe(0);
      await pressChord(page, "Alt+Y");

      await expect.poll(() => row(page, "tables 7").count()).toBe(1);
      await expect.poll(() => row(page, NEW_TABLE).count()).toBe(1);
      await expect.poll(() => syncStatus(page).textContent()).toMatch(/^public synchronized \(\d+ ms\) · just now$/);
      expect(before).toMatch(/^public synchronized/);
      await captureWindow(page, "synchronized");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenUserWithoutAccessToOneSchema_whenExpanded_thenThatSchemaFailsAndOthersLoad",
    async () => {
      await asOwner([
        `DO $$ BEGIN
           IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${LIMITED_ROLE}') THEN
             CREATE ROLE ${LIMITED_ROLE} LOGIN PASSWORD '${LIMITED_ROLE}';
           END IF;
         END $$`,
        `GRANT CONNECT ON DATABASE ${POSTGRES_CONFIG.database} TO ${LIMITED_ROLE}`,
        `CREATE SCHEMA ${RESTRICTED_SCHEMA}`,
        `CREATE TABLE ${RESTRICTED_SCHEMA}.secrets (id integer)`,
        `REVOKE ALL ON SCHEMA ${RESTRICTED_SCHEMA} FROM PUBLIC`,
      ]);
      const page = await launchExplored({
        id: "limited",
        pluginId: "postgres",
        config: { ...POSTGRES_CONFIG, user: LIMITED_ROLE, password: LIMITED_ROLE },
      });

      await expand(page, namespaceName(RESTRICTED_SCHEMA));
      const failed = row(page, `${RESTRICTED_SCHEMA}, failed`);
      await failed.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expect.poll(() => failed.getAttribute("title")).toMatch(/permission denied.*Synchronize/s);
      await expect.poll(() => row(page, `permission denied for schema ${RESTRICTED_SCHEMA}`).count()).toBe(1);
      await expect
        .poll(() => syncStatus(page).textContent())
        .toMatch(new RegExp(`^${RESTRICTED_SCHEMA} failed: permission denied for schema ${RESTRICTED_SCHEMA} Check`));
      await expect.poll(() => row(page, "tables 6").count()).toBe(1);
      await captureWindow(page, "introspection-failed");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenWideSchema_whenExpanded_thenDescribedWithinBudgetAndScrollsToTheEnd",
    async () => {
      const columns = Array.from({ length: WIDE_COLUMNS }, (_, index) => `c${String(index + 1)} integer`).join(", ");
      await asOwner([
        `CREATE SCHEMA ${WIDE_SCHEMA}`,
        `DO $$ BEGIN
           FOR i IN 1..${String(WIDE_TABLES)} LOOP
             EXECUTE format('CREATE TABLE ${WIDE_SCHEMA}.t%s (${columns})', lpad(i::text, 3, '0'));
           END LOOP;
         END $$`,
      ]);
      const page = await launchExplored(POSTGRES);

      await row(page, "public").click();
      await page.keyboard.press("ArrowLeft");
      await expand(page, namespaceName(WIDE_SCHEMA));
      await expand(page, `tables ${String(WIDE_TABLES)}`);
      await expect.poll(() => syncStatus(page).textContent()).toMatch(new RegExp(`^${WIDE_SCHEMA} synchronized`));
      expect(syncElapsedMs(await syncStatus(page).textContent())).toBeLessThan(WIDE_DESCRIBE_BUDGET_MS);

      await page.keyboard.press("End");
      await expect.poll(() => row(page, "public").getAttribute("aria-selected")).toBe("true");
      await page.keyboard.press("ArrowUp");
      const last = row(page, `t${String(WIDE_TABLES)}`);
      await expect.poll(() => last.getAttribute("aria-selected")).toBe("true");
      await expect.poll(() => last.isVisible()).toBe(true);
      const toolbar = await explorer(page).getByRole("toolbar", { name: "Database toolbar" }).boundingBox();
      const pane = await explorer(page).boundingBox();
      expect(toolbar?.y ?? -1).toBeGreaterThanOrEqual(pane?.y ?? 0);
      expect(await explorer(page).locator('[role="treeitem"]').count()).toBeLessThan(WIDE_TABLES);
      const viewport = await page.evaluate<{ inside: number; fit: number } | null>(VIEWPORT_ROWS);
      expect(viewport).not.toBeNull();
      expect(viewport?.inside).toBeGreaterThanOrEqual((viewport?.fit ?? 0) - 1);
      await captureWindow(page, "wide-schema");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlTree_whenDisconnectedAndExpandedAgain_thenItReconnectsAndReloads",
    async () => {
      const page = await launchExplored(MYSQL);
      await row(page, /^mysql, connected/).click();

      await pressChord(page, "F2");
      await expect.poll(() => row(page, "table_craft").count()).toBe(0);
      await expect.poll(() => row(page, /^mysql, /).getAttribute("aria-expanded")).toBe("false");

      await expand(page, /^mysql, /);
      await expect.poll(() => row(page, "tables 6").count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(1);
      await expect.poll(() => row(page, /^mysql, connected/).count()).toBe(1);
      await captureWindow(page, "reconnect-reload");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenOrdersOnEachDatabase_whenCopyQualifiedName_thenClipboardHoldsThePluginQuoting",
    async () => {
      const expected: readonly [Datasource, string][] = [
        [POSTGRES, '"public"."orders"'],
        [MYSQL, "`table_craft`.`orders`"],
        [sqlite(), '"main"."orders"'],
      ];
      for (const [datasource, qualified] of expected) {
        const page = await launchExplored(datasource);
        await expand(page, "tables 6");
        await row(page, "orders").click();

        await pressChord(page, "Alt+Shift+C");

        await expect.poll(() => clipboardText(running as RunningApp)).toBe(qualified);
        if (datasource.pluginId === "sqlite") {
          const editor = sqlEditor(page);
          await editor.click();
          await pressChord(page, "A");
          await pressChord(page, "V");
          await expect.poll(() => editor.textContent()).toBe(qualified);
          await captureWindow(page, "copy-name");
        }
        await closeApp(running?.app);
        running = null;
      }
    },
    SCENARIO_TIMEOUT_MS * 3,
  );
});
