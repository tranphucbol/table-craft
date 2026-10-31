/**
 * Plan 026's live test: editing a console result against PostgreSQL, MySQL and SQLite, from the
 * `test/db/compose.yml` databases and a seeded SQLite file. Gated, because it needs a display, a
 * fresh build and the containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/026 bun run test:smoke:db
 *
 * The containers are shared with `test:db` and the other suites, so every scenario that writes
 * puts `orders` back as the fixture seeds it.
 */
import type { Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DatasourcePlugin } from "@table-craft/plugin-api";
import mysql from "@table-craft/plugin-mysql";
import postgres from "@table-craft/plugin-postgres";
import { MYSQL_CONFIG, POSTGRES_CONFIG, WITHOUT_POSTGRES } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  columnSnapshot,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  pressChord,
  rollbackButton,
  runAllButton,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  sqlEditor,
  waitUntilReady,
  type Datasource,
  type RunningApp,
  chooseOption,
  optionValue,
} from "./harness.js";

const captureWindow = evidenceFor("026");

const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };
const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };

function sqlite(): Datasource {
  return { id: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } };
}

const ORDERS = "SELECT * FROM orders ORDER BY id";

const RESET_STATEMENTS = [
  "DELETE FROM orders WHERE id > 0",
  "INSERT INTO orders (id, customer_id, total, placed_at) VALUES (1, 1, 19.99, '2024-02-29 09:00:00'), (2, 1, 5.00, '2024-03-01 10:30:00'), (3, 2, 120.50, '2024-03-02 16:45:00')",
] as const;

async function asOwner(plugin: DatasourcePlugin, config: unknown, statements: readonly string[]): Promise<void> {
  const session = await plugin.connect(config, { readOnly: false });
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

async function resetFixtures(): Promise<void> {
  if (!WITHOUT_POSTGRES) await asOwner(postgres, POSTGRES_CONFIG, RESET_STATEMENTS);
  await asOwner(mysql, MYSQL_CONFIG, RESET_STATEMENTS);
}

function cell(page: Page, row: number, column: number) {
  return page.locator(`[role="gridcell"][data-row="${String(row)}"][data-col="${String(column)}"]`);
}

async function columnValues(page: Page, column: number): Promise<string[]> {
  return columnSnapshot(page.locator(`[role="gridcell"][data-col="${String(column)}"]`));
}

function readOnly(page: Page) {
  return page.getByTestId("result-read-only");
}

function pending(page: Page) {
  return page.getByTestId("pending-changes");
}

function editError(page: Page) {
  return page.getByTestId("result-edit-error");
}

function dialog(page: Page) {
  return page.getByRole("dialog");
}

function outputEntries(page: Page) {
  return page.getByRole("log", { name: "Output" }).locator("[data-tone]");
}

function resultTab(page: Page, title: string) {
  return page
    .getByRole("tablist", { name: "Results" })
    .getByRole("tab")
    .filter({ hasText: new RegExp(`^${title}$`) });
}

function editField(page: Page) {
  return page.locator("[data-editing] input");
}

async function query(page: Page, sql: string): Promise<void> {
  await sqlEditor(page).fill(sql);
  // Closes the completion popup typing opened, which would cover the grid in the evidence.
  await sqlEditor(page).press("Escape");
  await runAllButton(page).click();
  await waitUntilReady(page);
  await page.getByRole("columnheader").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
}

/** Waits until the engine has answered whether the result is editable. */
async function editableResult(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Add Row", exact: true }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
}

async function editCell(page: Page, row: number, column: number, text: string): Promise<void> {
  await cell(page, row, column).click();
  await page.keyboard.press("Enter");
  await editField(page).waitFor();
  await editField(page).fill(text);
  await editField(page).press("Enter");
  await expect.poll(() => editField(page).count()).toBe(0);
}

async function chooseTransactionMode(page: Page, mode: "auto" | "manual"): Promise<void> {
  const select = page.getByLabel("Transaction mode", { exact: true });
  await expect.poll(() => select.isEnabled()).toBe(true);
  await chooseOption(select, mode);
  await expect.poll(() => optionValue(select)).toBe(mode);
}

describe.runIf(DATABASES_ENABLED)("editable console results live test", () => {
  let running: RunningApp | null = null;

  beforeAll(resetFixtures);
  afterAll(resetFixtures);

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
    await resetFixtures();
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource): Promise<Page> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running.page;
  }

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPostgresOrders_whenCellEditedPreviewedAndSubmitted_thenUpdateRunsAndTheQueryRunsAgain",
    async () => {
      const page = await launch(POSTGRES);
      await query(page, ORDERS);
      await editableResult(page);

      await editCell(page, 0, 2, "25.00");
      await expect.poll(() => pending(page).textContent()).toBe("1 pending change");
      expect(await cell(page, 0, 2).getAttribute("data-edit")).toBe("modified");
      await captureWindow(page, "pg-pending");

      await pressChord(page, "Shift+P");
      const statements = dialog(page).getByRole("list", { name: "Statements" }).getByRole("listitem");
      await expect.poll(() => statements.count()).toBe(1);
      await expect
        .poll(() => statements.first().textContent())
        .toContain(`UPDATE "public"."orders" SET "total" = '25.00' WHERE "id" = 1`);
      await captureWindow(page, "pg-preview");
      await dialog(page).getByRole("button", { name: "Submit", exact: true }).click();

      await expect.poll(() => pending(page).count()).toBe(0);
      await expect.poll(() => columnValues(page, 2)).toEqual(["25.00", "5.00", "120.50"]);
      expect(await page.locator("[data-edit]").count()).toBe(0);
      await resultTab(page, "Output").click();
      await expect
        .poll(() => outputEntries(page).allTextContents())
        .toContainEqual(expect.stringContaining("Submitted 1 statement"));
      await captureWindow(page, "pg-submitted");
    },
    SCENARIO_TIMEOUT_MS,
  );

  for (const [name, datasource] of [
    ["mysql", () => MYSQL],
    ["sqlite", sqlite],
  ] as const) {
    it(
      `givenOrdersOn_${name}_whenEditedAddedDeletedAndModEnter_thenSubmittedAndReadAgain`,
      async () => {
        const page = await launch(datasource());
        await query(page, ORDERS);
        await editableResult(page);

        await editCell(page, 0, 2, "25.00");
        await cell(page, 1, 0).click();
        await pressChord(page, "Backspace");
        await page.getByRole("button", { name: "Add Row", exact: true }).click();
        await editCell(page, 3, 0, "4");
        await editCell(page, 3, 1, "2");
        await editCell(page, 3, 2, "7.50");
        await editCell(page, 3, 3, "2024-03-03 08:00:00");
        await expect.poll(() => pending(page).textContent()).toBe("3 pending changes");
        await captureWindow(page, `${name}-pending`);

        // ⌘↵ in the grid with pending edits submits instead of running (decision 057).
        await cell(page, 0, 0).click();
        await pressChord(page, "Enter");

        await expect.poll(() => pending(page).count()).toBe(0);
        await expect.poll(() => columnValues(page, 0)).toEqual(["1", "3", "4"]);
        expect((await columnValues(page, 2)).map(Number)).toEqual([25, 120.5, 7.5]);
        await captureWindow(page, `${name}-submitted`);
      },
      SCENARIO_TIMEOUT_MS,
    );
  }

  it.skipIf(WITHOUT_POSTGRES)(
    "givenJoinAggregateAndKeylessTable_whenRun_thenReadOnlyWithTheReason",
    async () => {
      const page = await launch(POSTGRES);

      await query(page, "SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id");
      await expect
        .poll(() => readOnly(page).getAttribute("aria-label"))
        .toBe("Read-only: the result joins two or more tables");
      await cell(page, 0, 1).click();
      await page.keyboard.press("Enter");
      expect(await editField(page).count()).toBe(0);
      await captureWindow(page, "read-only-join");

      await query(page, "SELECT customer_id, count(*) FROM orders GROUP BY customer_id");
      await expect.poll(() => readOnly(page).getAttribute("aria-label")).toBe("Read-only: the result aggregates rows");
      await captureWindow(page, "read-only-aggregate");

      await query(page, "SELECT * FROM no_key_probe");
      await expect
        .poll(() => readOnly(page).getAttribute("aria-label"))
        .toBe("Read-only: the result has no primary key column");
      await captureWindow(page, "read-only-no-key");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenAliasedExpressionColumn_whenEdited_thenOnlyThatColumnRefuses",
    async () => {
      const page = await launch(POSTGRES);
      await query(page, "SELECT id, total * 2 AS doubled, total FROM orders ORDER BY id");
      await editableResult(page);

      await cell(page, 0, 1).click();
      await page.keyboard.press("Enter");
      expect(await editField(page).count()).toBe(0);
      await editCell(page, 0, 2, "20.00");

      await expect.poll(() => pending(page).textContent()).toBe("1 pending change");
      expect(await cell(page, 0, 1).getAttribute("data-edit")).toBeNull();
      expect(await page.locator('[data-column-name="doubled"]').getAttribute("data-read-only")).toBe("");
      expect(await page.locator('[data-column-name="total"]').getAttribute("data-read-only")).toBeNull();
      await captureWindow(page, "expression-read-only");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenManualConsole_whenSubmitted_thenTheEditsStayInTheOpenTransactionAndRollbackReverts",
    async () => {
      const page = await launch(POSTGRES);
      await chooseTransactionMode(page, "manual");
      await query(page, ORDERS);
      await editableResult(page);

      await editCell(page, 0, 2, "25.00");
      await page.getByRole("button", { name: "Submit", exact: true }).click();

      await expect.poll(() => columnValues(page, 2)).toEqual(["25.00", "5.00", "120.50"]);
      await expect.poll(() => page.getByText("transaction open", { exact: true }).count()).toBe(1);
      await captureWindow(page, "manual-submitted-open");
      await resultTab(page, "Output").click();
      await expect
        .poll(() => outputEntries(page).allTextContents())
        .toContainEqual(expect.stringContaining("they stay in the open transaction"));
      await captureWindow(page, "manual-output");

      await rollbackButton(page).click();
      await waitUntilReady(page);
      await query(page, ORDERS);
      await expect.poll(() => columnValues(page, 2)).toEqual(["19.99", "5.00", "120.50"]);
      await rollbackButton(page).click();
      await captureWindow(page, "manual-rolled-back");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenPendingEdits_whenRunAgain_thenAskedToSubmitOrDiscard",
    async () => {
      const page = await launch(MYSQL);
      await query(page, ORDERS);
      await editableResult(page);
      await editCell(page, 0, 2, "25.00");

      await runAllButton(page).click();

      await expect.poll(() => dialog(page).textContent()).toContain("This result has changes not yet submitted");
      await captureWindow(page, "rerun-asks");
      await dialog(page).getByRole("button", { name: "Discard", exact: true }).click();
      await waitUntilReady(page);
      await expect.poll(() => columnValues(page, 2)).toEqual(["19.99", "5.00", "120.50"]);
      expect(await pending(page).count()).toBe(0);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenLocalFilterOn_whenShownRowEdited_thenTheUpdateNamesTheStoredRow",
    async () => {
      const page = await launch(POSTGRES);
      await query(page, ORDERS);
      await editableResult(page);
      await cell(page, 0, 0).click();
      await pressChord(page, "F");
      await page.getByTestId("find-input").fill("120.50");
      await page
        .getByRole("search", { name: "Find in result" })
        .getByRole("button", { name: "Filter Rows", exact: true })
        .click();
      await expect.poll(() => columnValues(page, 0)).toEqual(["3"]);

      await editCell(page, 0, 2, "121.00");
      await pressChord(page, "Shift+P");
      const statements = dialog(page).getByRole("list", { name: "Statements" }).getByRole("listitem");
      await expect.poll(() => statements.count()).toBe(1);
      await expect.poll(() => statements.first().textContent()).toContain(`WHERE "id" = 3`);
      await captureWindow(page, "filtered-preview");
      await dialog(page).getByRole("button", { name: "Submit", exact: true }).click();

      await expect.poll(() => pending(page).count()).toBe(0);
      await asOwnerReads(page);
    },
    SCENARIO_TIMEOUT_MS,
  );

  /** The filtered submit landed on order 3 alone. */
  async function asOwnerReads(page: Page): Promise<void> {
    await page.getByRole("search", { name: "Find in result" }).getByRole("button", { name: "Close" }).click();
    await expect.poll(() => columnValues(page, 2)).toEqual(["19.99", "5.00", "121.00"]);
    await captureWindow(page, "filtered-submitted");
  }

  it.skipIf(WITHOUT_POSTGRES)(
    "givenRowDeletedElsewhere_whenSubmitted_thenEditRejectedAndTheEditsStay",
    async () => {
      const page = await launch(POSTGRES);
      await query(page, ORDERS);
      await editableResult(page);
      await editCell(page, 1, 2, "6.00");

      await asOwner(postgres, POSTGRES_CONFIG, ["DELETE FROM orders WHERE id = 2"]);
      await page.getByRole("button", { name: "Submit", exact: true }).click();

      await expect.poll(() => editError(page).textContent()).toContain("0 rows");
      expect(await pending(page).textContent()).toBe("1 pending change");
      await captureWindow(page, "conflict-rejected");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
