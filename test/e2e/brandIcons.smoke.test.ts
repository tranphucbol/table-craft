/**
 * Plan 118's live test: datasource rows drawing their database's logo in the Database explorer,
 * the Data Sources dialog and Services, the Brand Icons switch, and the brand a MySQL datasource
 * learns from the server it reaches. Gated, because it needs a display, a fresh build and the
 * containers:
 *
 *   TABLE_CRAFT_DATABASES=mysql,tidb,mariadb,postgres TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/118 \
 *     bun run test:smoke:db:headless test/e2e/brandIcons.smoke.test.ts
 */
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  databaseEnabled,
  MARIADB_CONFIG,
  MYSQL_CONFIG,
  POSTGRES_CONFIG,
  REDIS_CONFIG,
  tidbConfigFromEnv,
  WITHOUT_POSTGRES,
} from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  answerSecretPrompt,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  dataSourcesDialog,
  EVIDENCE_WINDOW,
  evidenceFor,
  findAction,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openConsoleOn,
  pressChord,
  readProfileFile,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  seedSettings,
  setWindowSize,
  testConnection,
  toolWindow,
  treeNode,
  type RunningApp,
  type SavedDatasource,
} from "./harness.js";

const captureNow = evidenceFor("118");
/**
 * Run in the page, where `document` exists: dialogs fade in, so a capture waits for every finite
 * animation; a spinner's runs forever.
 */
const ANIMATIONS_FINISHED =
  "Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished))";

async function captureWindow(page: Page, name: string): Promise<void> {
  await page.evaluate(ANIMATIONS_FINISHED);
  await captureNow(page, name);
}

const GENERIC = "generic";
const TOGGLE_BRAND_ICONS = "Toggle Brand Icons";
/** A pattern, because the field row's "Icons" label also names the checkbox. */
const BRAND_ICONS_CHECKBOX = /Show database logos on data sources/;
/** A port nothing listens on, so a connect fails at once. */
const CLOSED_PORT = 1;

type Config = Readonly<Record<string, string | number | boolean>>;

/** The config without its password, which `datasources.json` never holds (decision 020). */
function withoutPassword(config: Config & { readonly password: string }): Config {
  const { password: _password, ...plain } = config;
  return plain;
}

interface Row {
  readonly saved: SavedDatasource;
  /** The glyph the row draws with brand icons on. */
  readonly glyph: string;
  /** The product its trailing text names with brand icons off. */
  readonly product: string;
}

function mysqlLike(id: string, config: Config & { readonly password: string }, brand?: string): SavedDatasource {
  return {
    id,
    name: id,
    pluginId: "mysql",
    config: withoutPassword(config),
    secretModes: { password: "never" },
    ...(brand === undefined ? {} : { brand }),
  };
}

function everyBrand(): readonly Row[] {
  return [
    { saved: mysqlLike("orders", MYSQL_CONFIG), glyph: "mysql", product: "MySQL" },
    { saved: mysqlLike("ledger", MARIADB_CONFIG, "mariadb"), glyph: "mariadb", product: "MariaDB" },
    { saved: mysqlLike("warehouse", tidbConfigFromEnv(), "tidb"), glyph: "tidb", product: "TiDB" },
    {
      saved: {
        id: "analytics",
        name: "analytics",
        pluginId: "postgres",
        config: withoutPassword(POSTGRES_CONFIG),
        secretModes: { password: "never" },
      },
      glyph: "postgresql",
      product: "PostgreSQL",
    },
    {
      saved: { id: "local", name: "local", pluginId: "sqlite", config: { path: seededSqliteFile() } },
      glyph: "sqlite",
      product: "SQLite",
    },
    {
      saved: {
        id: "cache",
        name: "cache",
        pluginId: "redis",
        config: withoutPassword(REDIS_CONFIG),
        secretModes: { password: "never" },
      },
      glyph: "redis",
      product: "Redis",
    },
  ];
}

function glyphOf(page: Page, name: string): Promise<string | null> {
  return treeNode(page, name).locator("[data-glyph]").first().getAttribute("data-glyph");
}

function productOf(page: Page, name: string) {
  return treeNode(page, name).getByTestId("datasource-product");
}

function settingsDialog(page: Page) {
  return page.getByRole("dialog", { name: "Settings" });
}

function brandIconsCheckbox(page: Page) {
  return settingsDialog(page).getByRole("checkbox", { name: BRAND_ICONS_CHECKBOX });
}

/**
 * Flips the switch in Settings › Appearance and closes the dialog: while it is open, the modal
 * hides the Database tree from role queries.
 */
async function setBrandIconsInSettings(page: Page, on: boolean): Promise<void> {
  await pressChord(page, ",");
  await settingsDialog(page).getByRole("tab", { name: "Appearance", exact: true }).click();
  await expect.poll(() => brandIconsCheckbox(page).isChecked()).toBe(!on);
  await brandIconsCheckbox(page).setChecked(on);
  await expect.poll(() => brandIconsCheckbox(page).isChecked()).toBe(on);
  if (on) await captureWindow(page, "03-logos-on-settings");
  await page.keyboard.press("Escape");
  await settingsDialog(page).waitFor({ state: "detached" });
}

async function expectLogos(page: Page, rows: readonly Row[]): Promise<void> {
  for (const row of rows) {
    await expect.poll(() => glyphOf(page, row.saved.name), { timeout: LAUNCH_TIMEOUT_MS }).toBe(row.glyph);
    await expect.poll(() => productOf(page, row.saved.name).count()).toBe(0);
  }
}

async function expectGenericWithProducts(page: Page, rows: readonly Row[]): Promise<void> {
  for (const row of rows) {
    await expect.poll(() => glyphOf(page, row.saved.name)).toBe(GENERIC);
    await expect.poll(() => productOf(page, row.saved.name).textContent()).toBe(row.product);
  }
}

/** Expands the row, which connects, and answers the password prompt. */
async function connect(page: Page, name: string, password: string): Promise<void> {
  await treeNode(page, name).click();
  await page.keyboard.press("ArrowRight");
  await answerSecretPrompt(page, name, password);
}

describe.runIf(DATABASES_ENABLED)("datasource brand icons live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    await closeApp(running?.app);
    running = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(profile: string): Promise<Page> {
    running = await launchApp(null, { userDataDir: profile });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await toolWindow(running.page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    return running.page;
  }

  function seeded(rows: readonly Row[]): string {
    const profile = newProfile();
    seedDatasources(
      profile,
      rows.map((row) => row.saved),
    );
    return profile;
  }

  it(
    "givenEveryBrandSaved_whenLaunched_thenEachRowDrawsItsLogoAndNoProductTail",
    async () => {
      const rows = everyBrand();
      const page = await launch(seeded(rows));

      await expectLogos(page, rows);
      await captureWindow(page, "01-logos-on");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenBrandIconsOn_whenToggledFromThePaletteAndSettings_thenGlyphAndBrandTailComeAndGo",
    async () => {
      const rows = everyBrand();
      const profile = seeded(rows);
      let page = await launch(profile);
      await expectLogos(page, rows);

      await findAction(page, TOGGLE_BRAND_ICONS);
      await expectGenericWithProducts(page, rows);
      await captureWindow(page, "02-logos-off-palette");

      await setBrandIconsInSettings(page, true);
      await expectLogos(page, rows);
      await setBrandIconsInSettings(page, false);
      await expectGenericWithProducts(page, rows);

      await closeApp(running?.app);
      page = await launch(profile);
      await expectGenericWithProducts(page, rows);
      expect(JSON.parse(readProfileFile(profile, "settings.json") ?? "{}")).toMatchObject({
        appearance: { brandIcons: false },
      });
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it(
    "givenMysqlDatasourceOnTidb_whenConnected_thenTidbLogoRememberedAfterRelaunch",
    async () => {
      const tidb = tidbConfigFromEnv();
      const row: Row = { saved: mysqlLike("warehouse", tidb), glyph: "tidb", product: "TiDB" };
      const profile = seeded([row]);
      let page = await launch(profile);
      await expect.poll(() => glyphOf(page, "warehouse"), { timeout: LAUNCH_TIMEOUT_MS }).toBe("mysql");

      await connect(page, "warehouse", tidb.password);
      await expect.poll(() => glyphOf(page, "warehouse"), { timeout: LAUNCH_TIMEOUT_MS }).toBe("tidb");
      await expect.poll(() => treeNode(page, "warehouse").getAttribute("aria-description")).toBe("TiDB");
      await captureWindow(page, "04-tidb-detected");
      await expect
        .poll((): unknown => JSON.parse(readProfileFile(profile, "datasources.json") ?? "{}"))
        .toMatchObject({ datasources: [{ id: "warehouse", brand: "tidb" }] });

      await closeApp(running?.app);
      page = await launch(profile);
      await expectLogos(page, [row]);
      await findAction(page, TOGGLE_BRAND_ICONS);
      await expectGenericWithProducts(page, [row]);
      await captureWindow(page, "05-tidb-remembered-off");
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it.skipIf(!databaseEnabled("mariadb"))(
    "givenMysqlDatasourceOnMariadb_whenConnected_thenMariadbLogo",
    async () => {
      const page = await launch(seeded([{ saved: mysqlLike("ledger", MARIADB_CONFIG), glyph: "", product: "" }]));
      await expect.poll(() => glyphOf(page, "ledger"), { timeout: LAUNCH_TIMEOUT_MS }).toBe("mysql");

      await connect(page, "ledger", MARIADB_CONFIG.password);
      await expect.poll(() => glyphOf(page, "ledger"), { timeout: LAUNCH_TIMEOUT_MS }).toBe("mariadb");
      await captureWindow(page, "06-mariadb-detected");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenPicker_whenTidbPicked_thenDraftNamedTidbWithItsLogo",
    async () => {
      const page = await launch(newProfile());
      await toolWindow(page, "Database").getByRole("button", { name: "New Data Source…", exact: true }).click();
      const dialog = dataSourcesDialog(page);
      const kinds = dialog.getByRole("list", { name: "Database kinds" });
      await kinds.waitFor();
      const brands = await kinds
        .locator("button[data-brand]")
        .evaluateAll((buttons) =>
          buttons.map((button) =>
            (button as unknown as { getAttribute(name: string): string | null }).getAttribute("data-brand"),
          ),
        );
      expect(brands).toEqual(expect.arrayContaining(["mysql", "mariadb", "tidb", "postgresql", "redis", "sqlite"]));
      await captureWindow(page, "07-picker");

      await kinds.locator('button[data-brand="tidb"]').click();
      await expect.poll(() => dialog.getByLabel("Name", { exact: true }).inputValue()).toBe("TiDB");
      await expect.poll(() => dialog.getByTestId("draft-product").textContent()).toBe("TiDB");
      await expect
        .poll(() => dialog.getByRole("option", { name: /TiDB/ }).locator("[data-glyph]").getAttribute("data-glyph"))
        .toBe("tidb");
      await captureWindow(page, "08-picked-tidb");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlDraftOnTidb_whenTestConnection_thenDraftBecomesTidb",
    async () => {
      const tidb = tidbConfigFromEnv();
      const page = await launch(newProfile());
      await toolWindow(page, "Database").getByRole("button", { name: "New Data Source…", exact: true }).click();
      const dialog = dataSourcesDialog(page);
      await dialog.getByRole("list", { name: "Database kinds" }).locator('button[data-brand="mysql"]').click();
      await expect.poll(() => dialog.getByTestId("draft-product").textContent()).toBe("MySQL");
      const fields = { Host: tidb.host, Port: String(tidb.port), Database: tidb.database, User: tidb.user };
      for (const [label, value] of Object.entries(fields)) await dialog.getByLabel(label, { exact: true }).fill(value);
      await dialog.getByLabel("Password", { exact: true }).fill(tidb.password);

      const result = await testConnection(page);
      expect(result.ok).toBe(true);
      expect(result.text).toContain("TiDB");
      await expect.poll(() => dialog.getByTestId("draft-product").textContent()).toBe("TiDB");
      await captureWindow(page, "09-test-connection-tidb");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenConsolesOpen_whenServicesAndDataSourcesShown_thenTheirRowsDrawLogos",
    async () => {
      const rows = everyBrand();
      const page = await launch(seeded(rows));
      const opened = [
        { name: "orders", password: MYSQL_CONFIG.password, glyph: "mysql" },
        { name: "warehouse", password: tidbConfigFromEnv().password, glyph: "tidb" },
        ...(WITHOUT_POSTGRES ? [] : [{ name: "analytics", password: POSTGRES_CONFIG.password, glyph: "postgresql" }]),
        { name: "local", password: null, glyph: "sqlite" },
      ];
      for (const { name, password } of opened) {
        await openConsoleOn(page, name);
        if (password !== null) await answerSecretPrompt(page, name, password);
      }

      const services = toolWindow(page, "Services");
      if ((await services.count()) === 0) await pressChord(page, "8");
      await services.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      for (const { name, glyph } of opened) {
        const line = services
          .locator('[role="treeitem"][data-kind="datasource"]')
          .filter({ has: page.getByText(name, { exact: true }) });
        await expect
          .poll(() => line.locator("[data-glyph]").first().getAttribute("data-glyph"), { timeout: LAUNCH_TIMEOUT_MS })
          .toBe(glyph);
      }
      await captureWindow(page, "10-services");

      await toolWindow(page, "Database").getByRole("button", { name: "New Data Source…", exact: true }).click();
      const list = dataSourcesDialog(page).getByRole("listbox", { name: "Data sources" });
      for (const row of rows) {
        const option = list.getByRole("option").filter({ has: page.getByText(row.saved.name, { exact: true }) });
        await expect.poll(() => option.locator("[data-glyph]").getAttribute("data-glyph")).toBe(row.glyph);
      }
      await captureWindow(page, "11-dialog");
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it(
    "givenUnreachableMysql_whenConnectFails_thenLogoTurnsRed",
    async () => {
      const broken = mysqlLike("orders", { ...MYSQL_CONFIG, port: CLOSED_PORT });
      const page = await launch(seeded([{ saved: broken, glyph: "mysql", product: "MySQL" }]));

      await connect(page, "orders", MYSQL_CONFIG.password);
      const glyph = treeNode(page, "orders").locator("[data-glyph]").first();
      await expect.poll(() => glyph.getAttribute("class"), { timeout: LAUNCH_TIMEOUT_MS }).toContain("text-danger");
      expect(await glyph.getAttribute("data-glyph")).toBe("mysql");
      await captureWindow(page, "12-failed");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenLightTheme_whenLaunched_thenLogosTakeTheThemeInk",
    async () => {
      const rows = everyBrand();
      const profile = seeded(rows);
      seedSettings(profile, { version: 1, appearance: { theme: "light" } });
      const page = await launch(profile);

      await expectLogos(page, rows);
      await captureWindow(page, "13-light-theme");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
