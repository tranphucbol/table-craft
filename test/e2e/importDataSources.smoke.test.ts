/**
 * Plan 035's live test: the Import Data Sources dialog reading a fake home that holds a DataGrip
 * config directory and project, TablePro's `connections.json` and two `.tablepro` exports, then
 * connecting what it imported to the `test/db/compose.yml` databases. The fake home is the app's
 * `HOME`, so nothing outside it is read; the Secret Service scenario needs `secret-tool` and runs in
 * the headless box only.
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/035 bun run test:smoke:db:headless test/e2e/importDataSources.smoke.test.ts
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { MYSQL_CONFIG, POSTGRES_CONFIG, WITHOUT_POSTGRES } from "../support/databases.js";
import {
  DATAGRIP_IDS,
  dataGripService,
  FOREIGN_DIALECT_SOURCES,
  writeImportFixture,
  type ImportFixture,
} from "../support/import/fixtures.js";
import {
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
  SCENARIO_TIMEOUT_MS,
  secretPrompt,
  setWindowSize,
  toolWindow,
  treeNode,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("035");
const captureFoundation = evidenceFor("053");

const PASSWORD = MYSQL_CONFIG.password;
const HOME_PREFIX = "table-craft-import-home-";
const SECRET_TOOL = "secret-tool";
const SECRET_SERVICE_READY = process.platform === "linux" && spawnSync(SECRET_TOOL, ["--version"]).error === undefined;

function fixture(passwords: "keepass" | "native", options: { oracleAndSqlServer?: boolean } = {}): ImportFixture {
  return writeImportFixture(mkdtempSync(join(tmpdir(), HOME_PREFIX)), {
    mysql: { host: MYSQL_CONFIG.host, port: MYSQL_CONFIG.port },
    postgres: { host: POSTGRES_CONFIG.host, port: POSTGRES_CONFIG.port },
    passwords,
    platform: process.platform,
    password: PASSWORD,
    oracleAndSqlServer: options.oracleAndSqlServer,
  });
}

function importDialog(page: Page) {
  return page.getByRole("dialog", { name: "Import Data Sources" });
}

function importRow(page: Page, name: string) {
  return importDialog(page)
    .getByTestId("import-row")
    .filter({ has: page.getByText(name, { exact: true }) });
}

describe.runIf(DATABASES_ENABLED)("import data sources live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    await closeApp(running?.app);
    running = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(home: string, userDataDir = newProfile()) {
    running = await launchApp(null, { userDataDir, env: { HOME: home } });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await toolWindow(running.page, "Database").waitFor();
    return running;
  }

  async function openImport(page: Page) {
    await findAction(page, "Import Data Sources");
    await importDialog(page).getByTestId("import-sources").getByRole("button").first().waitFor();
  }

  async function previewDataGrip(page: Page) {
    await openImport(page);
    await importDialog(page).getByTestId("import-source-datagrip").click();
    await importDialog(page).getByTestId("import-rows").waitFor();
  }

  async function importAndFinish(page: Page) {
    const dialog = importDialog(page);
    await dialog.getByRole("button", { name: "Import", exact: true }).click();
    await dialog.getByTestId("import-summary").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  }

  async function connect(page: Page, name: string) {
    await treeNode(page, name).click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Connect/ }).click();
  }

  async function connected(page: Page, name: string) {
    await expect
      .poll(() => treeNode(page, name).getAttribute("data-state"), { timeout: LAUNCH_TIMEOUT_MS })
      .toBe("connected");
  }

  it(
    "givenDataGripWithKeePass_whenImported_thenFoldersAndConnectsWithoutAsking",
    async () => {
      const home = fixture("keepass");
      const { page } = await launch(home.home);

      await openImport(page);
      const datagrip = importDialog(page).getByTestId("import-source-datagrip");
      await expect.poll(() => datagrip.isEnabled()).toBe(true);
      await expect.poll(() => datagrip.textContent()).toContain("7 connections");
      await captureWindow(page, "import-sources");

      await datagrip.click();
      await importDialog(page).getByTestId("import-rows").waitFor();
      await expect.poll(() => importRow(page, "Shop MySQL").getByTestId("import-password").textContent()).toBe("Found");
      await expect.poll(() => importRow(page, "Analytics TiDB").textContent()).toContain("MySQL");
      await expect.poll(() => importRow(page, "Events").getAttribute("data-status")).toBe("unsupported");
      await expect.poll(() => importRow(page, "Events").getByRole("checkbox").isDisabled()).toBe(true);
      await expect.poll(() => importRow(page, "Prod via bastion").getAttribute("data-status")).toBe("sshTunnel");
      await expect.poll(() => importRow(page, "Prod via bastion").getByRole("checkbox").isChecked()).toBe(false);
      await expect.poll(() => importRow(page, "Prod via bastion").textContent()).toContain("bastion.example:22");
      await captureWindow(page, "import-datagrip-preview");

      await importAndFinish(page);
      await expect
        .poll(() => importDialog(page).getByTestId("import-summary").textContent())
        .toContain("Imported 5, with passwords 3");
      await importDialog(page).getByRole("button", { name: "Done", exact: true }).click();
      await importDialog(page).waitFor({ state: "detached" });

      for (const folder of ["DataGrip", "Docker"]) await treeNode(page, folder).waitFor();
      for (const name of WITHOUT_POSTGRES ? ["Shop MySQL"] : ["Shop MySQL", "Shop PG"]) {
        await connect(page, name);
        await connected(page, name);
      }
      await expect.poll(() => secretPrompt(page, "Shop MySQL").count()).toBe(0);
      await captureWindow(page, "import-datagrip-done");

      await previewDataGrip(page);
      const again = importRow(page, "Shop MySQL");
      await expect.poll(() => again.getAttribute("data-status")).toBe("duplicate");
      await expect.poll(() => again.textContent()).toContain("Already in TableCraft");
      await expect.poll(() => again.getByRole("checkbox").isChecked()).toBe(false);
      await captureWindow(page, "import-duplicates");
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it(
    "givenDataGripOracleAndSqlServer_whenPreviewed_thenOracleMapsAndSqlServerIsUnsupportedByName",
    async () => {
      const home = fixture("native", { oracleAndSqlServer: true });
      const { page } = await launch(home.home);

      await previewDataGrip(page);
      const oracle = importRow(page, FOREIGN_DIALECT_SOURCES.oracle);
      await expect.poll(() => oracle.getAttribute("data-status")).toBe("ready");
      await expect.poll(() => oracle.textContent()).toContain("Oracle");
      const sqlServer = importRow(page, FOREIGN_DIALECT_SOURCES.sqlServer);
      await expect.poll(() => sqlServer.getAttribute("data-status")).toBe("unsupported");
      await expect.poll(() => sqlServer.getByRole("checkbox").isDisabled()).toBe(true);
      await expect.poll(() => sqlServer.textContent()).toContain("No installed plugin reads sqlserver: URLs.");
      await sqlServer.scrollIntoViewIfNeeded();
      await captureFoundation(page, "04-import-unsupported");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenEncryptedTableProExport_whenUnlocked_thenImportsWithPasswordsAndConnects",
    async () => {
      const home = fixture("keepass");
      const { page } = await launch(home.home);
      await openImport(page);
      const dialog = importDialog(page);

      await dialog.getByTestId("import-datasources-file").fill(home.encryptedBundle);
      await dialog.getByRole("button", { name: "Read", exact: true }).click();
      await dialog.getByTestId("import-passphrase").fill("not the passphrase");
      await dialog.getByRole("button", { name: "Unlock", exact: true }).click();
      await expect.poll(() => dialog.getByTestId("import-passphrase-note").textContent()).toMatch(/passphrase/i);
      await expect.poll(() => dialog.getByTestId("import-passphrase").getAttribute("aria-invalid")).toBe("true");
      await captureWindow(page, "import-tablepro-passphrase");

      await dialog.getByTestId("import-passphrase").fill(home.bundlePassphrase);
      await dialog.getByRole("button", { name: "Unlock", exact: true }).click();
      await dialog.getByTestId("import-rows").waitFor();
      await expect
        .poll(() => importRow(page, "Orders MySQL").getByTestId("import-password").textContent())
        .toBe("In file");
      await importAndFinish(page);
      await expect
        .poll(() => dialog.getByTestId("import-summary").textContent())
        .toContain("Imported 3, with passwords 2");
      await dialog.getByRole("button", { name: "Done", exact: true }).click();

      for (const folder of ["TablePro", "Work", "Shop"]) await treeNode(page, folder).waitFor();
      await connect(page, "Orders MySQL");
      await connected(page, "Orders MySQL");
      await captureWindow(page, "import-tablepro-done");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(SECRET_SERVICE_READY)(
    "givenDataGripPasswordInSecretService_whenImported_thenConnectsWithoutAsking",
    async () => {
      const home = fixture("native");
      const stored = spawnSync(
        SECRET_TOOL,
        ["store", "--label=DataGrip", "service", dataGripService(DATAGRIP_IDS.shopMysql), "account", "table_craft"],
        { input: `${MYSQL_CONFIG.user}@${PASSWORD}` },
      );
      expect(stored.status).toBe(0);
      const { page } = await launch(home.home);

      await previewDataGrip(page);
      await expect
        .poll(() => importRow(page, "Shop MySQL").getByTestId("import-password").textContent())
        .toBe("Keychain — will ask");
      await importAndFinish(page);
      await expect
        .poll(() => importDialog(page).getByTestId("import-summary").textContent())
        .toContain("with passwords 1");
      await importDialog(page).getByRole("button", { name: "Done", exact: true }).click();

      await connect(page, "Shop MySQL");
      await connected(page, "Shop MySQL");
      await captureWindow(page, "import-secret-service");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPasswordsNotImported_whenConnecting_thenAsksForThePassword",
    async () => {
      const home = fixture("native");
      const { page } = await launch(home.home);

      await previewDataGrip(page);
      await importDialog(page).getByRole("checkbox", { name: "Import passwords" }).uncheck();
      await importAndFinish(page);
      await expect
        .poll(() => importDialog(page).getByTestId("import-summary").textContent())
        .toContain("with passwords 0");
      await importDialog(page).getByRole("button", { name: "Done", exact: true }).click();

      await connect(page, "Shop PG");
      await secretPrompt(page, "Shop PG").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "import-ask-on-connect");
      await answerSecretPrompt(page, "Shop PG", POSTGRES_CONFIG.password);
      await connected(page, "Shop PG");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
