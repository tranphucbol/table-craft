/**
 * Plan 054's live test: the Oracle plugin, downloaded from the loopback registry, against the
 * `test/db/compose.yml` Oracle 23ai Free. Gated, because it needs a display, a fresh build and the
 * container:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/054 bun run test:smoke:db:headless:oracle test/e2e/oracle.smoke.test.ts
 *
 * It creates `oracle_live_lock` for the lock wait and drops it afterwards, and puts back the
 * `edit_probe` row it edits.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Session } from "@table-craft/plugin-api";
import oracle from "@table-craft/plugin-oracle";
import { MYSQL_CONFIG, ORACLE_CONFIG, POSTGRES_CONFIG, WITHOUT_ORACLE } from "../support/databases.js";
import { FOREIGN_DIALECT_SOURCES, writeImportFixture } from "../support/import/fixtures.js";
import { pluginPackageName, startRegistry, type LoopbackRegistry } from "../support/pluginRegistry.js";
import {
  activeEditorTab,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  columnSnapshot,
  DATABASES_ENABLED,
  dataSourcesDialog,
  EVIDENCE_WINDOW,
  evidenceFor,
  findAction,
  gridText,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  pressChord,
  runAllButton,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  seedSettings,
  setWindowSize,
  sqlEditor,
  startStatement,
  testConnection,
  toolWindow,
  treeNode,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";
import { builtRelease } from "./pluginFixtures.js";

const captureEvidence = evidenceFor("054");

const ORACLE: Datasource = { id: "ora", pluginId: "oracle", config: ORACLE_CONFIG };
const NO_OPTIONAL_ROOT = { TABLE_CRAFT_DEVELOPMENT_PLUGINS: "0" };
const HOME_PREFIX = "table-craft-oracle-home-";

/** Basic Completion, CodeMirror's `Ctrl-Space` on every platform. */
const BASIC_COMPLETION = "Control+Space";
/** CodeMirror ignores Enter for its default `interactionDelay` after the popup opens. */
const INTERACTION_DELAY_MS = 75;

const LOCK_TABLE = "oracle_live_lock";
const HOLDING_UPDATE = `UPDATE ${LOCK_TABLE} SET n = n + 1 WHERE id = 1`;
const BLOCKED_UPDATE = `UPDATE ${LOCK_TABLE} SET n = n + 10 WHERE id = 1`;
const RESTORE_EDIT_PROBE = "UPDATE edit_probe SET label = 'first' WHERE id = 1";
const EDITED_LABEL = "edited live";

const TYPE_PROBE_QUERY = "SELECT id, exact_decimal, doc, payload, day, moment FROM type_probe ORDER BY id";
const JOIN_SQL =
  "SELECT c.name, o.total FROM customers c JOIN orders o ON o.customer_id = c.id WHERE o.placed_at > DATE '2020-01-01'";
const OUTPUT_BLOCK = [
  "BEGIN",
  "  DBMS_OUTPUT.PUT_LINE('settling ' || TO_CHAR(SYSDATE, 'YYYY'));",
  "  DBMS_OUTPUT.PUT_LINE('done');",
  "END;",
].join("\n");
const ERROR_TOKEN = "nope";
/** How the plugin writes a DATE (decision 102). */
const TREE_SCROLL = '[data-testid="database-tree-scroll"]';
const SECONDS_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const SETTLE_ORDER = "SETTLE_ORDER (ORDER_ID NUMBER, TOTAL OUT NUMBER, NOTE IN OUT VARCHAR2)";
const CUSTOMER_ORDERS = "CUSTOMER_ORDERS (CUSTOMER NUMBER)";
const BILLING_CALC_FEE = "BILLING.CALC_FEE (AMOUNT NUMBER, RATE NUMBER)";

async function run(session: Session, sql: string): Promise<void> {
  for await (const _row of (await session.execute(sql)).rows) {
    // Drained so the statement completes before the next.
  }
}

/** Runs `statements` on the Oracle fixture through the plugin, outside the app. */
async function onOracle(statements: readonly string[]): Promise<void> {
  const session = await oracle.connect(ORACLE_CONFIG, { readOnly: false });
  try {
    for (const sql of statements) await run(session, sql);
  } finally {
    await session.close();
  }
}

function explorer(page: Page) {
  return toolWindow(page, "Database");
}

function treeRow(page: Page, name: string | RegExp) {
  return explorer(page).getByRole("treeitem", { name, exact: typeof name === "string" });
}

async function expandRow(page: Page, row: Locator): Promise<void> {
  await row.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  if ((await row.getAttribute("aria-expanded")) === "true") return;
  await row.click();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => row.getAttribute("aria-expanded")).toBe("true");
}

async function editorText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="sql-editor"] .cm-line').allTextContents()).join("\n");
}

async function typeStatement(page: Page, sql: string): Promise<void> {
  await sqlEditor(page).fill(sql);
  await expect.poll(() => editorText(page)).toBe(sql);
}

function outputEntries(page: Page) {
  return page.getByRole("log", { name: "Output" }).locator("[data-tone]");
}

function resultTab(page: Page, title: string) {
  return page
    .getByRole("tablist", { name: "Results" })
    .getByRole("tab")
    .filter({ hasText: new RegExp(`^${title.replace(/[()]/g, "\\$&")}$`) });
}

function planRows(page: Page) {
  return page.getByRole("treegrid").locator("tbody").getByRole("row");
}

async function planShown(page: Page, title: string): Promise<void> {
  await resultTab(page, title).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await planRows(page).first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await waitUntilReady(page);
}

async function planColumns(page: Page): Promise<Record<string, string[]>> {
  const headers = await page.getByRole("treegrid").locator("thead th").allTextContents();
  const columns: Record<string, string[]> = {};
  for (const [index, header] of headers.entries()) {
    columns[header] = await planRows(page)
      .locator(`td:nth-child(${String(index + 1)})`)
      .allTextContents();
  }
  return columns;
}

function tableEditor(page: Page) {
  return page.getByTestId("table-editor");
}

function editorCell(page: Page, row: number, column: number) {
  return tableEditor(page).locator(`[role="gridcell"][data-row="${String(row)}"][data-col="${String(column)}"]`);
}

function routineDialog(page: Page) {
  return page.getByRole("dialog").filter({ has: page.getByTestId("routine-sql") });
}

async function executeRoutine(page: Page, routine: string): Promise<Locator> {
  await expandRow(page, treeRow(page, /^routines \d+$/).first());
  await treeRow(page, routine).click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Execute Routine/ }).click();
  const dialog = routineDialog(page);
  await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  return dialog;
}

async function routineSql(dialog: Locator): Promise<string> {
  return (await dialog.getByTestId("routine-sql").locator(".cm-line").allTextContents()).join("\n");
}

async function runRoutine(dialog: Locator): Promise<void> {
  const target = dialog.getByRole("button", { name: "Run", exact: true });
  await expect.poll(() => target.isEnabled()).toBe(true);
  await target.click();
  await dialog.waitFor({ state: "detached" });
}

async function cellsShown(page: Page, expected: readonly string[]): Promise<void> {
  await expect
    .poll(async () => (await gridText(page)).cells, { timeout: LAUNCH_TIMEOUT_MS })
    .toEqual(expect.arrayContaining([...expected]));
  await waitUntilReady(page);
}

function sessionRows(page: Page) {
  return page.getByTestId("sessions-grid").locator("tbody tr");
}

async function sessionCell(page: Page, row: Locator, column: string): Promise<string> {
  const headers = await page.getByTestId("sessions-grid").locator("thead th").allTextContents();
  return (await row.locator("td").nth(headers.indexOf(column)).textContent()) ?? "";
}

/** The DOM element as far as `revealBlockedBy` needs it; this program has no DOM lib. */
interface Scrollable {
  scrollIntoView(options: { inline: "center" }): void;
}

/** The DOM element as far as `captureWindow` needs it; this program has no DOM lib. */
interface Sideways {
  scrollTo(options: { readonly left: number }): void;
}

/**
 * Captures with the tree scrolled back to its left edge: Playwright scrolls a clicked row wider
 * than the pane into view, which slides the tree sideways to the end of its longest label.
 */
async function captureWindow(page: Page, name: string): Promise<void> {
  const scroller = page.locator(TREE_SCROLL);
  if ((await scroller.count()) === 1) {
    await scroller.evaluate((element: Sideways) => element.scrollTo({ left: 0 }));
  }
  await captureEvidence(page, name);
}

/** Closes the completion popup a typed statement may have left open. */
async function closeCompletion(page: Page): Promise<void> {
  if ((await popup(page).count()) === 0) return;
  await sqlEditor(page).press("Escape");
  await expect.poll(() => popup(page).count()).toBe(0);
}

/** True once Enter would accept `label`; see `functionCompletion.smoke.test.ts`, which this mirrors. */
function acceptable(label: string): string {
  return `(() => {
    const popup = document.querySelector('.cm-tooltip-autocomplete');
    if (popup === null) return false;
    const seen = (window.__popupSeen ??= new WeakMap());
    if (!seen.has(popup)) seen.set(popup, performance.now());
    if (performance.now() - seen.get(popup) < ${String(INTERACTION_DELAY_MS)}) return false;
    if (popup.classList.contains('cm-tooltip-autocomplete-disabled')) return false;
    return popup.querySelector('[aria-selected] .cm-completionLabel')?.textContent === ${JSON.stringify(label)};
  })()`;
}

function popup(page: Page) {
  return page.locator(".cm-tooltip-autocomplete");
}

function option(page: Page, label: string) {
  return popup(page)
    .getByRole("option")
    .filter({ has: page.locator(".cm-completionLabel", { hasText: new RegExp(`^${label}$`) }) });
}

function activeParameter(page: Page) {
  return page.locator(".tc-signature-hint .tc-signature-active").first();
}

/** Replaces the console's text with `sql` and puts the caret at `at` (default: the end). */
async function typeAt(page: Page, sql: string, at = sql.length): Promise<void> {
  await typeStatement(page, sql);
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+End");
  for (let step = sql.length; step > at; step--) await page.keyboard.press("ArrowLeft");
}

async function completeAt(page: Page, sql: string, at = sql.length): Promise<void> {
  await typeAt(page, sql, at);
  await page.keyboard.press(BASIC_COMPLETION);
  await popup(page).getByRole("option").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
}

async function hintAt(page: Page, sql: string, at: number, parameter: string): Promise<void> {
  await typeAt(page, sql, at);
  await pressChord(page, "P");
  await expect.poll(() => activeParameter(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(parameter);
}

describe.runIf(DATABASES_ENABLED)("oracle live test", () => {
  let running: RunningApp | null = null;
  let registry: LoopbackRegistry | null = null;
  let holder: Session | null = null;

  beforeAll(async () => {
    if (WITHOUT_ORACLE) return;
    await onOracle([
      `DROP TABLE IF EXISTS ${LOCK_TABLE} PURGE`,
      `CREATE TABLE ${LOCK_TABLE} (id NUMBER(10) PRIMARY KEY, n NUMBER(10) NOT NULL)`,
      `INSERT INTO ${LOCK_TABLE} VALUES (1, 0)`,
      RESTORE_EDIT_PROBE,
    ]);
  }, SCENARIO_TIMEOUT_MS);

  afterAll(async () => {
    if (WITHOUT_ORACLE) return;
    await onOracle([`DROP TABLE IF EXISTS ${LOCK_TABLE} PURGE`, RESTORE_EDIT_PROBE]);
  }, SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
    await registry?.close();
    registry = null;
    await holder?.close().catch(() => undefined);
    holder = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource | null, options: Parameters<typeof launchApp>[1] = {}): Promise<Page> {
    running = await launchApp(datasource, options);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    if (datasource === null) return running.page;
    await waitUntilReady(running.page);
    await treeRow(running.page, /^tables \d+$/)
      .first()
      .waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    return running.page;
  }

  it.skipIf(WITHOUT_ORACLE)(
    "givenRegistryFixture_whenOracleDownloadedAndUrlPasted_thenFieldsFilledAndConnectionTested",
    async () => {
      registry = await startRegistry({ [pluginPackageName("oracle")]: [builtRelease("oracle", "1.0.0")] });
      const userDataDir = newProfile();
      seedSettings(userDataDir, { version: 1, plugins: { registryUrl: registry.url } });
      const page = await launch(null, { userDataDir, env: NO_OPTIONAL_ROOT });

      await explorer(page).getByRole("button", { name: "New Data Source…", exact: true }).click();
      const form = dataSourcesDialog(page);
      await form.locator('button[data-download="oracle"]').click();
      await form.getByLabel("Service", { exact: true }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });

      const url = `oracle://${ORACLE_CONFIG.user}@${ORACLE_CONFIG.host}:${String(ORACLE_CONFIG.port)}/${ORACLE_CONFIG.service}`;
      await form.getByLabel("URL", { exact: true }).fill(url);
      await form.getByLabel("URL", { exact: true }).press("Enter");
      await expect.poll(() => form.getByLabel("Host", { exact: true }).inputValue()).toBe(ORACLE_CONFIG.host);
      expect(await form.getByLabel("Port", { exact: true }).inputValue()).toBe(String(ORACLE_CONFIG.port));
      expect(await form.getByLabel("Service", { exact: true }).inputValue()).toBe(ORACLE_CONFIG.service);
      expect(await form.getByLabel("User", { exact: true }).inputValue()).toBe(ORACLE_CONFIG.user);
      await form.getByLabel("Password", { exact: true }).fill(ORACLE_CONFIG.password);

      const tested = await testConnection(page);
      expect(tested.ok).toBe(true);
      expect(tested.text).toMatch(/23\.\d+/);
      await captureWindow(page, "01-url-connected");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_ORACLE)(
    "givenOracle_whenConnected_thenSchemasAndPackageMembersInTheTree",
    async () => {
      const page = await launch(ORACLE);

      await treeRow(page, /^ARCHIVE/)
        .first()
        .waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expandRow(page, treeRow(page, /^routines \d+$/).first());
      await treeRow(page, BILLING_CALC_FEE).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await treeRow(page, "BILLING.CALC_FEE (AMOUNT NUMBER, CURRENCY VARCHAR2, RATE NUMBER)").count()).toBe(1);
      expect(await treeRow(page, SETTLE_ORDER).count()).toBe(1);
      await expandRow(page, treeRow(page, /^tables \d+$/).first());
      await treeRow(page, /^TYPE_PROBE/)
        .first()
        .waitFor();
      await captureWindow(page, "02-tree");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_ORACLE)(
    "givenTypeProbe_whenQueried_thenNumbersClobBlobAndDatesInTheGrid",
    async () => {
      const page = await launch(ORACLE);

      await runStatement(page, TYPE_PROBE_QUERY);

      await cellsShown(page, ["1234567890123456.7890", "2024-02-29 00:00:00"]);
      const { headers, cells } = await gridText(page);
      expect(headers).toEqual(expect.arrayContaining(["ID", "EXACT_DECIMAL", "DOC", "PAYLOAD", "DAY", "MOMENT"]));
      expect(cells.join("\n")).toContain("2024-02-29 13:45:30");
      expect(cells.join("\n")).toMatch(/deadbeef/i);
      expect(cells.join("\n")).toContain('"a"');
      await closeCompletion(page);
      await captureWindow(page, "03-type-probe-grid");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_ORACLE)(
    "givenEditProbe_whenCellEditedAndSubmitted_thenRowReread",
    async () => {
      const page = await launch(ORACLE);
      await expandRow(page, treeRow(page, /^tables \d+$/).first());
      await treeRow(page, /^EDIT_PROBE/)
        .first()
        .click();
      await page.keyboard.press("F4");
      await expect.poll(() => activeEditorTab(page).textContent()).toContain("EDIT_PROBE");
      await editorCell(page, 0, 1).waitFor({ timeout: LAUNCH_TIMEOUT_MS });

      await editorCell(page, 0, 1).click();
      await page.keyboard.press("Enter");
      const field = tableEditor(page).locator("[data-editing] input");
      await field.waitFor();
      await field.fill(EDITED_LABEL);
      await field.press("Enter");
      await expect.poll(() => tableEditor(page).getByTestId("pending-changes").textContent()).toBe("1 pending change");
      await tableEditor(page).getByRole("button", { name: "Submit", exact: true }).click();

      await expect
        .poll(() => tableEditor(page).getByTestId("table-notice").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toBe("Submitted 1 statement");
      await expect
        .poll(() => columnSnapshot(tableEditor(page).locator('[role="gridcell"][data-col="1"]')))
        .toContain(EDITED_LABEL);
      await captureWindow(page, "04-edit-submitted");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_ORACLE)(
    "givenJoin_whenExplainAndExplainAnalyse_thenPlanTreesWithActuals",
    async () => {
      const page = await launch(ORACLE);
      await typeStatement(page, JOIN_SQL);

      await page.getByRole("button", { name: "Explain Plan", exact: true }).click();
      await planShown(page, "Plan");
      const plan = await planColumns(page);
      expect(plan["Operation"]?.length).toBeGreaterThan(1);
      expect(plan["Operation"]?.[0]).toMatch(/SELECT STATEMENT/);
      expect(plan["Operation"]?.join("\n")).toMatch(/ORDERS/);
      await captureWindow(page, "05-explain");

      await page.getByRole("button", { name: "Explain Analyse", exact: true }).click();
      await planShown(page, "Plan (analysed)");
      const analysed = await planColumns(page);
      expect(Object.keys(analysed)).toEqual(expect.arrayContaining(["Actual Rows", "Loops"]));
      expect(analysed["Actual Rows"]?.[0]).toBe("3");
      await captureWindow(page, "06-explain-analyse");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_ORACLE)(
    "givenPutLineBlock_whenRun_thenOutputShowsDbmsOutput",
    async () => {
      const page = await launch(ORACLE);
      await typeStatement(page, OUTPUT_BLOCK);

      await runAllButton(page).click();
      await waitUntilReady(page);
      await resultTab(page, "Output").click();
      await expect
        .poll(() => outputEntries(page).allTextContents(), { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual(expect.arrayContaining([expect.stringMatching(/settling \d{4}/), expect.stringContaining("done")]));
      await sqlEditor(page).press("Escape");
      await captureWindow(page, "07-dbms-output");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_ORACLE)(
    "givenUnknownColumn_whenRun_thenUnderlinedAtTheOraOffset",
    async () => {
      const page = await launch(ORACLE);

      await runStatement(page, `SELECT id, ${ERROR_TOKEN} FROM customers`);

      await closeCompletion(page);
      const marks = sqlEditor(page).locator(".tc-error-mark");
      await expect.poll(() => marks.allTextContents(), { timeout: LAUNCH_TIMEOUT_MS }).toEqual([ERROR_TOKEN]);
      await marks.first().hover();
      const tooltip = page.locator(".tc-error-tooltip");
      await tooltip.waitFor();
      expect(await tooltip.textContent()).toContain("ORA-00904");
      await captureWindow(page, "08-error-underlined");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_ORACLE)(
    "givenLockWait_whenShowSessions_thenBlockedRowNamesTheHolder",
    async () => {
      holder = await oracle.connect(ORACLE_CONFIG, { readOnly: false });
      await run(holder, "SET TRANSACTION READ WRITE");
      await run(holder, HOLDING_UPDATE);
      const holderId = holder.serverSessionId ?? "";
      const page = await launch(ORACLE);
      await startStatement(page, BLOCKED_UPDATE);

      await treeNode(page, ORACLE.id).click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Show Sessions…/ }).click();
      await expect.poll(() => activeEditorTab(page).textContent()).toBe(`Sessions · ${ORACLE.id}`);
      const blocked = sessionRows(page).filter({ hasText: BLOCKED_UPDATE });
      await expect
        .poll(
          async () => {
            if ((await blocked.count()) > 0 && (await sessionCell(page, blocked, "State")) === "blocked") return true;
            await page
              .getByTestId("sessions-view")
              .getByRole("button", { name: "Refresh Sessions", exact: true })
              .click();
            return false;
          },
          { timeout: LAUNCH_TIMEOUT_MS },
        )
        .toBe(true);
      expect(await sessionCell(page, blocked, "Blocked by")).toBe(holderId);
      await blocked.click();
      await page
        .getByTestId("sessions-grid")
        .locator("thead th", { hasText: "Blocked by" })
        .evaluate((header: Scrollable) => header.scrollIntoView({ inline: "center" }));
      await captureWindow(page, "09-sessions-blocked");

      await holder.transactions?.rollback();
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_ORACLE)(
    "givenProcedureWithOutAndRefCursor_whenExecuteRoutine_thenOutValuesAndCursorRows",
    async () => {
      const page = await launch(ORACLE);

      let dialog = await executeRoutine(page, SETTLE_ORDER);
      await dialog.getByLabel("Value of ORDER_ID", { exact: true }).fill("3");
      await dialog.getByLabel("Value of NOTE", { exact: true }).fill("paid");
      await expect.poll(() => routineSql(dialog), { timeout: LAUNCH_TIMEOUT_MS }).toMatch(/SETTLE_ORDER\(/);
      await captureWindow(page, "10-routine-out-dialog");
      await runRoutine(dialog);
      await cellsShown(page, ["120.5", "paid settled"]);
      await captureWindow(page, "11-routine-out-result");

      dialog = await executeRoutine(page, CUSTOMER_ORDERS);
      await dialog.getByLabel("Value of CUSTOMER", { exact: true }).fill("1");
      await runRoutine(dialog);
      await expect
        .poll(async () => (await gridText(page)).headers, { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual(expect.arrayContaining(["ID", "TOTAL"]));
      await waitUntilReady(page);
      await captureWindow(page, "12-routine-ref-cursor");

      dialog = await executeRoutine(page, BILLING_CALC_FEE);
      await dialog.getByLabel("Value of AMOUNT", { exact: true }).fill("100");
      await expect.poll(() => routineSql(dialog), { timeout: LAUNCH_TIMEOUT_MS }).toMatch(/BILLING\.CALC_FEE\(/);
      await runRoutine(dialog);
      await cellsShown(page, ["1.5"]);
      await captureWindow(page, "13-routine-package-member");
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it.skipIf(WITHOUT_ORACLE)(
    "givenFunctionPrefix_whenCompleted_thenSignatureThenParameterHint",
    async () => {
      const page = await launch(ORACLE);

      await completeAt(page, "SELECT to_cha FROM customers", "SELECT to_cha".length);
      await option(page, "to_char").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await option(page, "to_char").locator(".cm-completionDetail").textContent()).toMatch(/→ string/);
      await captureWindow(page, "14-completion-signature");

      await hintAt(page, "SELECT substr(name, ) FROM customers", "SELECT substr(name, ".length, "position");
      await captureWindow(page, "15-parameter-hint");

      await completeAt(page, "SELECT sysd");
      await expect.poll(() => page.evaluate<boolean>(acceptable("sysdate")), { timeout: LAUNCH_TIMEOUT_MS }).toBe(true);
      await page.keyboard.press("Enter");
      await expect.poll(() => editorText(page)).toBe("SELECT sysdate");
      await page.keyboard.type(" AS now FROM DUAL");
      await runStatement(page, "SELECT sysdate AS now FROM DUAL");
      await expect
        .poll(async () => (await gridText(page)).headers, { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual(expect.arrayContaining(["NOW"]));
      expect((await gridText(page)).cells.some((cell) => SECONDS_TIME.test(cell))).toBe(true);
      await sqlEditor(page).press("Escape");
      await captureWindow(page, "16-sysdate-bare");

      await hintAt(page, "SELECT extract(YEAR FROM ) FROM orders", "SELECT extract(YEAR FROM ".length, "datetime");
      await captureWindow(page, "17-extract-hint");
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it.skipIf(WITHOUT_ORACLE)(
    "givenDbmsOutputDot_whenCompleted_thenMembersThenPutLineHint",
    async () => {
      const page = await launch(ORACLE);

      await completeAt(page, "BEGIN dbms_output.");
      await option(page, "put_line").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "18-dbms-output-members");

      await hintAt(page, "BEGIN dbms_output.put_line(); END;", "BEGIN dbms_output.put_line(".length, "line");
      await captureWindow(page, "19-put-line-hint");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_ORACLE)(
    "givenDataGripOracleSource_whenImported_thenOpensInTheOraclePlugin",
    async () => {
      const home = writeImportFixture(mkdtempSync(join(tmpdir(), HOME_PREFIX)), {
        mysql: { host: MYSQL_CONFIG.host, port: MYSQL_CONFIG.port },
        postgres: { host: POSTGRES_CONFIG.host, port: POSTGRES_CONFIG.port },
        oracle: { host: ORACLE_CONFIG.host, port: ORACLE_CONFIG.port },
        passwords: "keepass",
        platform: process.platform,
        password: ORACLE_CONFIG.password,
        oracleAndSqlServer: true,
      });
      const page = await launch(null, { userDataDir: newProfile(), env: { HOME: home.home } });
      await explorer(page).waitFor();

      await findAction(page, "Import Data Sources");
      const dialog = page.getByRole("dialog", { name: "Import Data Sources" });
      await dialog.getByTestId("import-source-datagrip").click();
      await dialog.getByTestId("import-rows").waitFor();
      const row = dialog
        .getByTestId("import-row")
        .filter({ has: page.getByText(FOREIGN_DIALECT_SOURCES.oracle, { exact: true }) });
      await expect.poll(() => row.getAttribute("data-status")).toBe("ready");
      await expect.poll(() => row.textContent()).toContain("Oracle");
      await row.scrollIntoViewIfNeeded();
      await captureWindow(page, "20-import-preview");

      await dialog.getByRole("button", { name: "Import", exact: true }).click();
      await dialog.getByTestId("import-summary").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await dialog.getByRole("button", { name: "Done", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      await treeNode(page, FOREIGN_DIALECT_SOURCES.oracle).click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Connect/ }).click();
      await expect
        .poll(() => treeNode(page, FOREIGN_DIALECT_SOURCES.oracle).getAttribute("data-state"), {
          timeout: LAUNCH_TIMEOUT_MS,
        })
        .toBe("connected");
      await treeRow(page, /^TABLE_CRAFT/)
        .first()
        .waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await treeRow(page, /^tables \d+$/)
        .first()
        .waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "21-import-connected");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
