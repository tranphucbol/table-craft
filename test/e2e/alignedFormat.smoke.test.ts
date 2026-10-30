/**
 * Plan 030's live test: Reformat Code in the aligned style against MySQL, PostgreSQL and SQLite,
 * from the `test/db/compose.yml` databases. Gated, because it needs a display, a fresh build and the
 * containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/030 bun run test:smoke:db
 *
 * The MySQL scenarios create the empty table the reference query explains and drop it afterwards.
 */
import type { Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DatasourcePlugin, FormatOptions, SqlLanguage } from "@table-craft/plugin-api";
import mysql from "@table-craft/plugin-mysql";
import postgres from "@table-craft/plugin-postgres";
import sqlitePlugin from "@table-craft/plugin-sqlite";
import { GOLDEN, GOLDEN_ONE_LINE, GOLDEN_TABLE, GOLDEN_TABLE_DDL } from "../support/alignedGolden.js";
import { MYSQL_CONFIG, POSTGRES_CONFIG, WITHOUT_POSTGRES } from "../support/databases.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  consoleAlert,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  gridText,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  pressChord,
  SCENARIO_TIMEOUT_MS,
  SCRATCH,
  setWindowSize,
  sqlEditor,
  type Datasource,
  type RunningApp,
  waitUntilReady,
  chooseOption,
} from "./harness.js";

const captureWindow = evidenceFor("030");

const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };
const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };
/** Wide and tall enough to show the whole reference query from its first column. */
const GOLDEN_WINDOW = { width: 1800, height: 1000 } as const;
const DEFAULTS: FormatOptions = {
  style: "aligned",
  keywordCase: "upper",
  indentWidth: 2,
  linesBetweenStatements: 1,
  alignAliases: true,
};

const PG_CTE =
  "with recent as (select o.customer_id, sum(o.total)::numeric(10,2) as spent from orders o " +
  "where o.created_at > now() - interval '30 days' and o.total > 0 group by o.customer_id) " +
  "select c.id, c.name as customer, r.spent, case when r.spent > 1000 then 'gold' when r.spent > 100 then 'silver' else 'bronze' end as tier " +
  "from customers c join recent r on r.customer_id = c.id left join orders o on o.customer_id = c.id and o.total > 0 " +
  "where c.id in (select customer_id from orders where total > $1) order by r.spent desc";
const MIXED_SCRIPT =
  "create table probe (id integer primary key, name varchar(20)); update probe set name = 'x', id = 2 where id = 1 and name is null;";
const ALIASES = "select c.id as id, c.name as customer_name from customers c";
const SELECTION_FIRST = "SELECT 1 AS untouched;";
const SELECTION_SECOND = "select id, name from customers where id = 1 and name like 'G%';";

function languageOf(plugin: DatasourcePlugin): SqlLanguage {
  if (plugin.language === undefined) throw new Error(`the plugin has no language`);
  return plugin.language;
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

async function reformat(page: Page, expected: string): Promise<void> {
  await pressChord(page, "Alt+L");
  await expect.poll(() => editorText(page)).toBe(expected);
}

function settingsDialog(page: Page) {
  return page.getByRole("dialog", { name: "Settings" });
}

async function openEditorSettings(page: Page): Promise<void> {
  await pressChord(page, ",");
  await settingsDialog(page).waitFor();
  const tab = settingsDialog(page)
    .getByRole("tablist", { name: "Settings pages" })
    .getByRole("tab", { name: "Editor", exact: true });
  await tab.click();
  await expect.poll(() => tab.getAttribute("aria-selected")).toBe("true");
}

async function closeSettings(page: Page): Promise<void> {
  await settingsDialog(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(() => settingsDialog(page).count()).toBe(0);
}

async function withSession<T>(
  plugin: DatasourcePlugin,
  config: unknown,
  work: (sql: (text: string) => Promise<void>) => Promise<T>,
): Promise<T> {
  const session = await plugin.connect(config, { readOnly: false });
  try {
    return await work(async (text) => {
      const result = await session.execute(text);
      for await (const _row of result.rows) void _row;
    });
  } finally {
    await session.close();
  }
}

describe.runIf(DATABASES_ENABLED)("Aligned Reformat Code live test", () => {
  let running: RunningApp | null = null;

  beforeAll(async () => {
    await withSession(mysql, MYSQL_CONFIG, (sql) => sql(GOLDEN_TABLE_DDL));
  });

  afterAll(async () => {
    await withSession(mysql, MYSQL_CONFIG, (sql) => sql(`DROP TABLE IF EXISTS ${GOLDEN_TABLE}`));
  });

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(
    datasource: Datasource,
    size: { width: number; height: number } = EVIDENCE_WINDOW,
  ): Promise<Page> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, size);
    await waitUntilReady(running.page);
    return running.page;
  }

  it(
    "givenTheReferenceQueryOnOneLine_onMysql_whenModAltL_thenTheGoldenTextExactly",
    async () => {
      const page = await launch(MYSQL, GOLDEN_WINDOW);
      await typeStatement(page, GOLDEN_ONE_LINE);

      await reformat(page, GOLDEN);
      await pressChord(page, "Home");
      await captureWindow(page, "aligned-mysql-golden");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenTheFormattedReferenceQuery_onMysql_whenModEnter_thenTheExplainResultShows",
    async () => {
      const page = await launch(MYSQL, GOLDEN_WINDOW);
      await typeStatement(page, GOLDEN_ONE_LINE);
      await reformat(page, GOLDEN);
      await pressChord(page, "Home");

      await pressChord(page, "Enter");

      await page.getByRole("columnheader").or(consoleAlert(page)).first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await waitUntilReady(page);
      expect(await consoleAlert(page).count()).toBe(0);
      const grid = await gridText(page);
      expect(grid.headers).toContain("select_type");
      expect(grid.cells).toContain(GOLDEN_TABLE);
      await captureWindow(page, "aligned-mysql-explain");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenACteWithJoinsSubqueryCaseAndCasts_onPostgres_whenModAltL_thenAlignedAndOneUndoRestores",
    async () => {
      const page = await launch(POSTGRES, GOLDEN_WINDOW);
      await typeStatement(page, PG_CTE);
      const expected = languageOf(postgres).format(PG_CTE, DEFAULTS);
      expect(expected).toContain("WITH recent AS (SELECT o.customer_id,");
      expect(expected).toContain("     JOIN recent r ON r.customer_id = c.id");
      expect(expected).toContain("WHERE c.id IN (SELECT customer_id");

      await reformat(page, expected);
      await pressChord(page, "Home");
      await captureWindow(page, "aligned-pg-cte");

      await pressChord(page, "Z");
      await expect.poll(() => editorText(page)).toBe(PG_CTE);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenCreateTableAndUpdate_onSqlite_whenModAltL_thenDdlStandardAndUpdateAligned",
    async () => {
      const page = await launch(SCRATCH);
      await typeStatement(page, MIXED_SCRIPT);
      const ddl = languageOf(sqlitePlugin).format("create table probe (id integer primary key, name varchar(20))", {
        ...DEFAULTS,
        style: "standard",
      });

      await reformat(page, `${ddl};\n\nUPDATE probe\nSET name = 'x',\n    id   = 2\nWHERE id = 1\n  AND name IS NULL;`);
      await captureWindow(page, "aligned-mixed-script");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenStyleStandardThenAlignAliasesOff_onPostgres_whenModAltL_thenTodaysLayoutThenNoPadding",
    async () => {
      const page = await launch(POSTGRES);
      await typeStatement(page, ALIASES);
      await reformat(page, "SELECT c.id   AS id,\n       c.name AS customer_name\nFROM customers c");
      await pressChord(page, "Z");
      await expect.poll(() => editorText(page)).toBe(ALIASES);

      await openEditorSettings(page);
      await chooseOption(settingsDialog(page).getByLabel("Style", { exact: true }), "standard");
      await expect.poll(() => settingsDialog(page).getByLabel("Align aliases").isDisabled()).toBe(true);
      await closeSettings(page);
      await reformat(page, languageOf(postgres).format(ALIASES, { ...DEFAULTS, style: "standard" }));
      expect(await editorText(page)).toMatch(/^SELECT\n {2}c\.id AS id,\n/);
      await captureWindow(page, "aligned-settings-standard");
      await pressChord(page, "Z");
      await expect.poll(() => editorText(page)).toBe(ALIASES);

      await openEditorSettings(page);
      await chooseOption(settingsDialog(page).getByLabel("Style", { exact: true }), "aligned");
      await settingsDialog(page).getByLabel("Align aliases").uncheck();
      await captureWindow(page, "aligned-settings");
      await closeSettings(page);
      await reformat(page, "SELECT c.id AS id,\n       c.name AS customer_name\nFROM customers c");
      await captureWindow(page, "aligned-settings-no-padding");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenASelectionInsideALargerConsole_onPostgres_whenModAltL_thenOnlyTheSelectionIsReformatted",
    async () => {
      const page = await launch(POSTGRES);
      await typeStatement(page, `${SELECTION_FIRST}\n${SELECTION_SECOND}`);

      await page.keyboard.press("Shift+Home");
      await reformat(
        page,
        `${SELECTION_FIRST}\nSELECT id,\n       name\nFROM customers\nWHERE id = 1\n  AND name LIKE 'G%';`,
      );
      await captureWindow(page, "aligned-selection");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
