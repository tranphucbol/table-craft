/**
 * Plan 040's live test: Export Data Sources from a folder holding a SQLite and a MySQL data source,
 * with and without an encrypted password, then import the file into fresh profiles through the
 * Import Data Sources dialog, and copy and paste a data source between two profiles.
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/040 bun run test:smoke:db:headless test/e2e/datasourceExport.smoke.test.ts
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { MYSQL_CONFIG } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  answerSecretPrompt,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  dataSourcesDialog,
  EVIDENCE_WINDOW,
  evidenceFor,
  evidenceTextFor,
  fillNewDatasource,
  findAction,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  pressChord,
  SCENARIO_TIMEOUT_MS,
  secretPrompt,
  seedDatasources,
  setWindowSize,
  toolWindow,
  treeNode,
  type RunningApp,
} from "./harness.js";
import { stubSaveDialog } from "./workflows.js";

const captureNow = evidenceFor("040");
/** Run in the page: dialogs fade in, so a capture waits for every finite animation. */
const ANIMATIONS_FINISHED =
  "Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished))";
const writeEvidence = evidenceTextFor("040");

const FOLDER = "Team";
const MYSQL_NAME = "orders";
const SQLITE_NAME = "notes";
const PASSPHRASE = "share with the team";

async function captureWindow(page: Page, name: string): Promise<void> {
  await page.evaluate(ANIMATIONS_FINISHED);
  await captureNow(page, name);
}

function exportDialog(page: Page) {
  return page.getByRole("dialog", { name: "Export Data Sources" });
}

function importDialog(page: Page) {
  return page.getByRole("dialog", { name: "Import Data Sources" });
}

function importRow(page: Page, name: string) {
  return importDialog(page)
    .getByTestId("import-row")
    .filter({ has: page.getByText(name, { exact: true }) });
}

function exportDirectory(): string {
  return mkdtempSync(join(tmpdir(), "table-craft-export-"));
}

describe.runIf(DATABASES_ENABLED)("data source export and import live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    await closeApp(running?.app);
    running = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(userDataDir = newProfile()) {
    await closeApp(running?.app);
    running = await launchApp(null, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await toolWindow(running.page, "Database").waitFor();
    return running;
  }

  /** Profile A: a SQLite data source and a MySQL one with a Forever password, both in `Team`. */
  async function launchWithTeam() {
    const userDataDir = newProfile();
    seedDatasources(userDataDir, [
      { id: "notes", name: SQLITE_NAME, pluginId: "sqlite", folder: FOLDER, config: { path: seededSqliteFile() } },
    ]);
    const { page, app } = await launch(userDataDir);
    await fillNewDatasource(page, {
      kind: "MySQL",
      name: MYSQL_NAME,
      folder: FOLDER,
      fields: {
        Host: MYSQL_CONFIG.host,
        Port: String(MYSQL_CONFIG.port),
        Database: MYSQL_CONFIG.database,
        User: MYSQL_CONFIG.user,
      },
      password: MYSQL_CONFIG.password,
    });
    await dataSourcesDialog(page).getByRole("button", { name: "OK", exact: true }).click();
    await treeNode(page, MYSQL_NAME).waitFor();
    return { page, app };
  }

  async function exportFolder(app: ElectronApplication, page: Page, path: string, passphrase: string | null) {
    await stubSaveDialog(app, path);
    await treeNode(page, FOLDER).click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Export Data Sources/ }).click();
    const dialog = exportDialog(page);
    await dialog.waitFor();
    await expect.poll(() => dialog.getByTestId("export-scope-selected").isChecked()).toBe(true);
    if (passphrase !== null) {
      await dialog.getByRole("checkbox", { name: "Include passwords" }).check();
      await dialog.getByTestId("export-passphrase").fill(passphrase);
      await dialog.getByTestId("export-passphrase-confirm").fill(passphrase);
    }
    return dialog;
  }

  async function finishExport(page: Page) {
    const dialog = exportDialog(page);
    await dialog.getByRole("button", { name: "Export…", exact: true }).click();
    await dialog.getByTestId("export-datasources-done").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  }

  async function readFile(page: Page, path: string) {
    await findAction(page, "Import Data Sources");
    const dialog = importDialog(page);
    await dialog.getByTestId("import-datasources-file").fill(path);
    await dialog.getByRole("button", { name: "Read", exact: true }).click();
    return dialog;
  }

  async function importAndFinish(page: Page, summary: string) {
    const dialog = importDialog(page);
    await dialog.getByRole("button", { name: "Import", exact: true }).click();
    await dialog.getByTestId("import-summary").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await expect.poll(() => dialog.getByTestId("import-summary").textContent()).toContain(summary);
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
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

  async function sealedExport(): Promise<string> {
    const { app, page } = await launchWithTeam();
    const sealed = join(exportDirectory(), "tablecraft-datasources.json");
    await exportFolder(app, page, sealed, PASSPHRASE);
    await finishExport(page);
    return sealed;
  }

  it(
    "givenFolder_whenExportedWithAndWithoutPasswords_thenFreshProfileImportsAndConnects",
    async () => {
      const { app, page } = await launchWithTeam();
      const directory = exportDirectory();
      const plain = join(directory, "plain.json");
      const sealed = join(directory, "sealed.json");

      const dialog = await exportFolder(app, page, plain, PASSPHRASE);
      await expect.poll(() => dialog.textContent()).toContain("The selection: 2 data sources");
      await expect.poll(() => dialog.getByTestId("export-note").textContent()).toContain("passphrase");
      await captureWindow(page, "01-export-dialog");

      await dialog.getByRole("checkbox", { name: "Include passwords" }).uncheck();
      await finishExport(page);
      const plainText = readFileSync(plain, "utf8");
      const plainFile = JSON.parse(plainText) as { datasources: { name: string }[]; folders: string[] };
      expect(plainFile).not.toHaveProperty("secrets");
      expect(plainFile.folders).toEqual([FOLDER]);
      expect(plainFile.datasources.map((datasource) => datasource.name).sort()).toEqual(
        [SQLITE_NAME, MYSQL_NAME].sort(),
      );
      writeEvidence("02-file-plain.json", plainText);
      await captureWindow(page, "02-file-plain");
      await exportDialog(page).getByRole("button", { name: "Done", exact: true }).click();

      await exportFolder(app, page, sealed, PASSPHRASE);
      await finishExport(page);
      const sealedFile = JSON.parse(readFileSync(sealed, "utf8")) as { secrets?: { kdf: string } };
      expect(sealedFile.secrets?.kdf).toBe("scrypt");

      const fresh = await launch();
      const reading = await readFile(fresh.page, sealed);
      await reading.getByTestId("import-passphrase").fill(PASSPHRASE);
      await reading.getByRole("button", { name: "Unlock", exact: true }).click();
      await reading.getByTestId("import-rows").waitFor();
      await expect
        .poll(() => importRow(fresh.page, MYSQL_NAME).getByTestId("import-password").textContent())
        .toBe("In file");
      await importAndFinish(fresh.page, "Imported 2, with passwords 1");
      for (const folder of ["TableCraft", FOLDER]) await treeNode(fresh.page, folder).waitFor();
      await connect(fresh.page, MYSQL_NAME);
      await connected(fresh.page, MYSQL_NAME);
      await expect.poll(() => secretPrompt(fresh.page, MYSQL_NAME).count()).toBe(0);
      await captureWindow(fresh.page, "03-import-connects");

      const again = await readFile(fresh.page, sealed);
      await again.getByTestId("import-skip-passwords").click();
      await again.getByTestId("import-rows").waitFor();
      for (const name of [MYSQL_NAME, SQLITE_NAME]) {
        await expect.poll(() => importRow(fresh.page, name).getAttribute("data-status")).toBe("duplicate");
        await expect.poll(() => importRow(fresh.page, name).getByRole("checkbox").isChecked()).toBe(false);
      }
      await captureWindow(fresh.page, "04-duplicates");
    },
    SCENARIO_TIMEOUT_MS * 3,
  );

  it(
    "givenWrongPassphrase_whenImportedWithoutPasswords_thenConnectAsks",
    async () => {
      const sealed = await sealedExport();
      const { page } = await launch();

      const dialog = await readFile(page, sealed);
      await dialog.getByTestId("import-passphrase").fill("not the passphrase");
      await dialog.getByRole("button", { name: "Unlock", exact: true }).click();
      await expect.poll(() => dialog.getByTestId("import-passphrase-note").textContent()).toMatch(/passphrase/i);
      await expect.poll(() => dialog.getByTestId("import-passphrase").getAttribute("aria-invalid")).toBe("true");
      await dialog.getByTestId("import-skip-passwords").click();
      await dialog.getByTestId("import-rows").waitFor();
      await expect.poll(() => importRow(page, MYSQL_NAME).getByTestId("import-password").textContent()).toMatch(/ask/i);
      await importAndFinish(page, "with passwords 0");

      await connect(page, MYSQL_NAME);
      await secretPrompt(page, MYSQL_NAME).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "05-skip-passwords");
      await answerSecretPrompt(page, MYSQL_NAME, MYSQL_CONFIG.password);
      await connected(page, MYSQL_NAME);
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it(
    "givenCopiedDataSource_whenPastedInAnotherProfile_thenImported",
    async () => {
      const source = newProfile();
      seedDatasources(source, [
        { id: "notes", name: SQLITE_NAME, pluginId: "sqlite", folder: FOLDER, config: { path: seededSqliteFile() } },
      ]);
      const first = await launch(source);
      await first.app.evaluate(({ clipboard }) => clipboard.clear());
      await treeNode(first.page, SQLITE_NAME).click();
      await pressChord(first.page, "C");
      await expect
        .poll(() => first.app.evaluate(({ clipboard }) => clipboard.readText()))
        .toContain('"format": "table-craft-datasources"');
      const copied = await first.app.evaluate(({ clipboard }) => clipboard.readText());
      expect(copied).not.toContain("secrets");

      const second = await launch();
      await second.app.evaluate(({ clipboard }, text) => clipboard.writeText(text), copied);
      await toolWindow(second.page, "Database").click();
      await pressChord(second.page, "V");
      await importDialog(second.page).getByTestId("import-rows").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expect.poll(() => importRow(second.page, SQLITE_NAME).getAttribute("data-status")).toBe("ready");
      await captureWindow(second.page, "06-copy-paste");
      await importAndFinish(second.page, "Imported 1");
      await treeNode(second.page, SQLITE_NAME).waitFor();
      await connect(second.page, SQLITE_NAME);
      await connected(second.page, SQLITE_NAME);
    },
    SCENARIO_TIMEOUT_MS * 2,
  );
});
