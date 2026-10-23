/**
 * Plan 019's live test: Reformat Code and query parameters against PostgreSQL, MySQL and SQLite,
 * from the `test/db/compose.yml` databases and a seeded SQLite file. Gated, because it needs a
 * display, a fresh build and the containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/019 bun run test:smoke:db
 *
 * Nothing here writes: the injection scenario proves its value lands as data, and `customers` is
 * counted afterwards.
 */
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import type { DatasourcePlugin } from "@table-craft/plugin-api";
import mysql from "@table-craft/plugin-mysql";
import postgres from "@table-craft/plugin-postgres";
import sqlitePlugin from "@table-craft/plugin-sqlite";
import { MYSQL_CONFIG, POSTGRES_CONFIG } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  gridText,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  pressChord,
  runAllButton,
  SCENARIO_TIMEOUT_MS,
  seedSettings,
  setWindowSize,
  sqlEditor,
  type Datasource,
  type RunningApp,
  waitUntilReady,
} from "./harness.js";

const captureWindow = evidenceFor("019");

const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };
const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };

interface Dialect {
  readonly label: string;
  readonly plugin: DatasourcePlugin;
  readonly datasource: () => Datasource;
  /** The dialect's positional or numbered placeholder, and the name the dialog gives it. */
  readonly placeholder: string;
  readonly placeholderName: string;
}

const DIALECTS: readonly Dialect[] = [
  { label: "pg", plugin: postgres, datasource: () => POSTGRES, placeholder: "$1", placeholderName: "$1" },
  { label: "mysql", plugin: mysql, datasource: () => MYSQL, placeholder: "?", placeholderName: "?1" },
  {
    label: "sqlite",
    plugin: sqlitePlugin,
    datasource: () => ({ id: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } }),
    placeholder: "?",
    placeholderName: "?1",
  },
];

const ONE_LINE = "select c.id, c.name from customers c where c.id = 1 -- the first\norder by c.name";
const INJECTION = "O'Brien'; DROP TABLE customers; --";
const CANCELLED = "Cancelled; nothing ran.";
const PARAMETERS_DIALOG = "Parameters";

function parameterQuery(dialect: Dialect): string {
  return `SELECT name, :tag AS tag FROM customers WHERE id = ${dialect.placeholder}`;
}

/** Counts `customers` outside the app, so a value that escaped its binding would show here. */
async function customerCount(plugin: DatasourcePlugin, config: unknown): Promise<string> {
  const session = await plugin.connect(config, { readOnly: true });
  try {
    const result = await session.execute("SELECT count(*) FROM customers");
    let value: unknown = null;
    for await (const row of result.rows) value ??= row[0];
    return String(value);
  } finally {
    await session.close();
  }
}

function editorText(page: Page): Promise<string> {
  return page
    .locator('[data-testid="sql-editor"] .cm-line')
    .allTextContents()
    .then((lines) => lines.join("\n"));
}

async function typeStatement(page: Page, sql: string): Promise<void> {
  await sqlEditor(page).fill(sql);
  await expect.poll(() => editorText(page)).toBe(sql);
}

function parametersDialog(page: Page) {
  return page.getByRole("dialog", { name: PARAMETERS_DIALOG });
}

function outputEntries(page: Page) {
  return page.getByRole("log", { name: "Output" }).locator("[data-tone]");
}

describe.runIf(DATABASES_ENABLED)("Reformat Code and query parameters live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource, userDataDir?: string): Promise<Page> {
    running = await launchApp(datasource, userDataDir === undefined ? {} : { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running.page;
  }

  for (const dialect of DIALECTS) {
    it(
      `givenOneLineQuery_on_${dialect.label}_whenModAltL_thenOneClausePerLineAndOneUndoRestores`,
      async () => {
        const page = await launch(dialect.datasource());
        await typeStatement(page, ONE_LINE);

        await pressChord(page, "Alt+L");

        await expect.poll(() => editorText(page)).toMatch(/^SELECT c\.id,\n/);
        const formatted = await editorText(page);
        expect(formatted.split("\n")).toContain("FROM customers c");
        expect(formatted).toContain("-- the first");
        await captureWindow(page, `reformat-${dialect.label}`);

        await pressChord(page, "Z");
        await expect.poll(() => editorText(page)).toBe(ONE_LINE);
      },
      SCENARIO_TIMEOUT_MS,
    );

    it(
      `givenNamedAndDialectPlaceholders_on_${dialect.label}_whenRun_thenDialogAsksAndValuesAreBound`,
      async () => {
        const plugin = dialect.plugin;
        const datasource = dialect.datasource();
        const page = await launch(datasource);
        await typeStatement(page, parameterQuery(dialect));

        await runAllButton(page).click();
        const dialog = parametersDialog(page);
        await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
        expect(await dialog.locator("label[for]").allTextContents()).toEqual([":tag", dialect.placeholderName]);
        expect(await dialog.getByRole("list", { name: "Statements" }).locator("mark").allTextContents()).toEqual([
          ":tag",
          dialect.placeholder,
        ]);
        await dialog.getByLabel("Value of :tag", { exact: true }).fill(INJECTION);
        await dialog.getByLabel(`Value of ${dialect.placeholderName}`, { exact: true }).fill("2");
        await captureWindow(page, `parameters-dialog-${dialect.label}`);
        await page.keyboard.press("Enter");

        await page.getByRole("columnheader").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
        await waitUntilReady(page);
        expect(await gridText(page)).toEqual({ headers: ["name", "tag"], cells: ["Grace Hopper", INJECTION] });
        await captureWindow(page, `parameters-result-${dialect.label}`);
        expect(await customerCount(plugin, datasource.config)).toBe("2");
      },
      SCENARIO_TIMEOUT_MS,
    );
  }

  it(
    "givenParameters_onPostgres_whenDialogCancelled_thenNothingRuns",
    async () => {
      const page = await launch(POSTGRES);
      await typeStatement(page, parameterQuery(DIALECTS[0] as Dialect));

      await runAllButton(page).click();
      await parametersDialog(page).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await page.keyboard.press("Escape");

      await expect.poll(() => outputEntries(page).last().textContent()).toContain(CANCELLED);
      expect(await page.getByRole("columnheader").count()).toBe(0);
      await waitUntilReady(page);
      await captureWindow(page, "parameters-cancelled-pg");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenNullTicked_onPostgres_whenRun_thenBindsNull",
    async () => {
      const page = await launch(POSTGRES);
      await typeStatement(page, "SELECT coalesce(:v, 'was null') AS v");

      await runAllButton(page).click();
      const dialog = parametersDialog(page);
      await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await dialog.getByLabel(":v is NULL", { exact: true }).check();
      await page.keyboard.press("Enter");

      await page.getByRole("columnheader").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await waitUntilReady(page);
      expect(await gridText(page)).toEqual({ headers: ["v"], cells: ["was null"] });
      await captureWindow(page, "parameters-null-pg");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenCastsLiteralsAndComments_onPostgres_whenRun_thenNoDialog",
    async () => {
      const page = await launch(POSTGRES);
      await typeStatement(page, "SELECT '1'::int AS one, ':not' AS s /* :nor */ -- :this\n");

      await runAllButton(page).click();

      await page.getByRole("columnheader").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await waitUntilReady(page);
      expect(await parametersDialog(page).count()).toBe(0);
      expect(await gridText(page)).toEqual({ headers: ["one", "s"], cells: ["1", ":not"] });
      await captureWindow(page, "no-parameters-pg");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSelectionAndLowerKeywordCase_onPostgres_whenModAltL_thenOnlySelectionFormattedInLowerCase",
    async () => {
      const profile = newProfile();
      seedSettings(profile, {
        version: 1,
        editor: { format: { style: "standard", keywordCase: "lower", indentWidth: 4 } },
      });
      const page = await launch(POSTGRES, profile);
      const first = "SELECT 1 AS untouched;";
      await typeStatement(page, `${first}\nSELECT id, name FROM customers WHERE id = 1;`);

      await page.keyboard.press("Shift+Home");
      await pressChord(page, "Alt+L");

      await expect
        .poll(() => editorText(page))
        .toBe(`${first}\nselect\n    id,\n    name\nfrom\n    customers\nwhere\n    id = 1;`);
      await captureWindow(page, "reformat-selection-pg");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
