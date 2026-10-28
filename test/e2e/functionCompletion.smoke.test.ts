/**
 * Plan 052's live test: built-in function completion with signatures and the parameter hint, on
 * MySQL 8.4 from `test/db/compose.yml`, the run's TiDB, and PostgreSQL and SQLite for the shared
 * names; plan 115's keyword-led parameters (`EXTRACT(unit FROM date)`, `CAST(expr AS type)`) on
 * MySQL. Gated, because it needs a display, a fresh build and the databases:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/052 bun run test:smoke:db:headless test/e2e/functionCompletion.smoke.test.ts
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/115 bun run test:smoke:db:headless test/e2e/functionCompletion.smoke.test.ts
 *
 * Nothing here writes to the databases.
 */
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { MYSQL_CONFIG, POSTGRES_CONFIG, TIDB_CONFIG, serverSkipped } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  pressChord,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  sqlEditor,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("052");
const captureCallShapes = evidenceFor("115");

const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };
const TIDB: Datasource = { id: "tidb", pluginId: "mysql", config: TIDB_CONFIG };
const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };
const SQLITE: Datasource = { id: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } };

/** Basic Completion, CodeMirror's `Ctrl-Space` on every platform. */
const BASIC_COMPLETION = "Control+Space";
/** CodeMirror ignores Enter for its default `interactionDelay` after the popup opens. */
const INTERACTION_DELAY_MS = 75;

/** True once Enter would accept `label`; see `completion.smoke.test.ts`, which this mirrors. */
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

const CARET_OFFSET = `(() => {
  const selection = document.getSelection();
  const line = document.querySelector('[data-testid="sql-editor"] .cm-line');
  if (!selection || !line || selection.anchorNode === null) return -1;
  const range = document.createRange();
  range.setStart(line, 0);
  range.setEnd(selection.anchorNode, selection.anchorOffset);
  return range.toString().length;
})()`;

function popup(page: Page) {
  return page.locator(".cm-tooltip-autocomplete");
}

async function optionLabels(page: Page): Promise<string[]> {
  return popup(page).locator(".cm-completionLabel").allTextContents();
}

function option(page: Page, label: string) {
  return popup(page)
    .getByRole("option")
    .filter({ has: page.locator(".cm-completionLabel", { hasText: new RegExp(`^${label}$`) }) });
}

function hint(page: Page) {
  return page.locator(".tc-signature-hint");
}

function activeParameter(page: Page) {
  return hint(page).locator(".tc-signature-active");
}

async function editorText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="sql-editor"] .cm-line').allTextContents()).join("\n");
}

async function caret(page: Page): Promise<number> {
  return page.evaluate<number>(CARET_OFFSET);
}

/** Replaces the console's text with `sql` and puts the caret at `at` (default: the end). */
async function typeAt(page: Page, sql: string, at = sql.length): Promise<void> {
  await sqlEditor(page).fill(sql);
  await expect.poll(() => editorText(page)).toBe(sql);
  await page.keyboard.press("Escape");
  await page.keyboard.press("End");
  for (let step = sql.length; step > at; step--) await page.keyboard.press("ArrowLeft");
  await expect.poll(() => caret(page)).toBe(at);
}

async function completeAt(page: Page, sql: string, at = sql.length): Promise<void> {
  await typeAt(page, sql, at);
  await page.keyboard.press(BASIC_COMPLETION);
  await popup(page).getByRole("option").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
}

async function acceptCompletion(page: Page, label: string): Promise<void> {
  await expect.poll(() => page.evaluate<boolean>(acceptable(label)), { timeout: LAUNCH_TIMEOUT_MS }).toBe(true);
  await page.keyboard.press("Enter");
}

/**
 * Waits for the popup typing `label` opens and closes it, leaving the hint, which Escape closes
 * second. Waiting first matters: an Escape sent before the delayed popup shows closes the hint.
 */
async function closePopup(page: Page, label: string): Promise<void> {
  await option(page, label).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await page.keyboard.press("Escape");
  await expect.poll(() => popup(page).count()).toBe(0);
}

describe.runIf(DATABASES_ENABLED)("function completion live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource): Promise<Page> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running.page;
  }

  it(
    "givenMysqlDateF_whenBasicCompletion_thenDateFormatWithSignatureAndDocs",
    async () => {
      const page = await launch(MYSQL);

      await completeAt(page, "SELECT date_f FROM orders", "SELECT date_f".length);

      await option(page, "date_format").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await option(page, "date_format").locator(".cm-completionDetail").textContent()).toBe(
        "(date, format) → string",
      );
      await expect
        .poll(() => page.locator(".cm-completionInfo").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("pattern of % codes");
      await captureWindow(page, "052-mysql-popup");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenDateFormatAccepted_whenTypingTheFirstArgument_thenCaretInsideAndFormatBold",
    async () => {
      const page = await launch(MYSQL);
      await completeAt(page, "SELECT date_f FROM orders", "SELECT date_f".length);

      await acceptCompletion(page, "date_format");

      await expect.poll(() => editorText(page)).toBe("SELECT date_format() FROM orders");
      expect(await caret(page)).toBe("SELECT date_format(".length);
      await page.keyboard.type("placed_at");
      await closePopup(page, "placed_at");
      await page.keyboard.type(", ");
      await expect.poll(() => activeParameter(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toBe("format");
      expect(await popup(page).count()).toBe(0);
      expect(await hint(page).textContent()).toContain("date_format(date, format) → string");
      await captureWindow(page, "052-mysql-param-hint");

      await page.keyboard.press("Escape");
      await expect.poll(() => hint(page).count()).toBe(0);
      await pressChord(page, "P");
      await expect.poll(() => activeParameter(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toBe("format");
      await page.keyboard.press("End");
      await expect.poll(() => hint(page).count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(0);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysql84_whenCompleting_thenRemovedFunctionsAbsentAndJsonTableOffered",
    async () => {
      const page = await launch(MYSQL);

      await completeAt(page, "SELECT pa");
      await option(page, "period_add").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await optionLabels(page)).not.toContain("password");

      await completeAt(page, "SELECT json_ta");
      await option(page, "json_table").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "052-mysql-version");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenTidb_whenCompletingTidbPrefix_thenItsOwnFunctions",
    async () => {
      const page = await launch(TIDB);

      await completeAt(page, "SELECT tidb_");

      await option(page, "tidb_parse_tso").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      const labels = await optionLabels(page);
      expect(labels).toEqual(expect.arrayContaining(["tidb_version", "tidb_parse_tso", "tidb_decode_plan"]));
      expect(await option(page, "tidb_parse_tso").locator(".cm-completionDetail").textContent()).toBe(
        "(tso) → datetime",
      );
      await captureWindow(page, "052-tidb-functions");

      await completeAt(page, "SELECT json_ta");
      await expect.poll(() => optionLabels(page)).not.toContain("json_table");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenTidb_whenInsideCalls_thenHintForTheInnermostCall",
    async () => {
      const page = await launch(TIDB);

      await typeAt(page, "SELECT tidb_parse_tso(");
      await pressChord(page, "P");
      await expect.poll(() => activeParameter(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toBe("tso");

      await typeAt(page, "SELECT upper(concat(a, ))", "SELECT upper(concat(a, ".length);
      await pressChord(page, "P");
      await expect
        .poll(() => hint(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("concat(str...) → string");
      expect(await activeParameter(page).textContent()).toBe("str...");
      await captureWindow(page, "052-tidb-param-hint");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlOrders_whenCompletingC_thenColumnsBeforeFunctions",
    async () => {
      const page = await launch(MYSQL);

      await completeAt(page, "SELECT c FROM orders", "SELECT c".length);

      await option(page, "customer_id").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      const labels = await optionLabels(page);
      expect(labels[0]).toBe("customer_id");
      expect(labels).toContain("ceil");
      await captureWindow(page, "052-ranking");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlExtr_whenBasicCompletion_thenExtractDetailWritesItsLead",
    async () => {
      const page = await launch(MYSQL);

      await completeAt(page, "SELECT extr FROM orders", "SELECT extr".length);

      await option(page, "extract").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await option(page, "extract").locator(".cm-completionDetail").textContent()).toBe(
        "(unit FROM date) → integer",
      );
      await expect
        .poll(() => page.locator(".cm-completionInfo").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("extract(unit FROM date) → integer");
      await captureCallShapes(page, "115-extract-popup");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenExtractYearFrom_whenParameterInfo_thenDateBold",
    async () => {
      const page = await launch(MYSQL);

      await typeAt(page, "SELECT extract() FROM orders", "SELECT extract(".length);
      await pressChord(page, "P");
      await expect.poll(() => activeParameter(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toBe("unit");

      const sql = "SELECT extract(YEAR FROM placed_at) FROM orders";
      await typeAt(page, sql, "SELECT extract(YEAR FROM ".length);
      await pressChord(page, "P");
      await expect.poll(() => activeParameter(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toBe("date");
      expect(await hint(page).textContent()).toContain("extract(unit FROM date) → integer");
      await captureCallShapes(page, "115-extract-hint");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenCastAs_whenParameterInfo_thenTypeBold",
    async () => {
      const page = await launch(MYSQL);

      await typeAt(page, "SELECT cast(total AS ) FROM orders", "SELECT cast(total AS ".length);
      await pressChord(page, "P");
      await expect.poll(() => activeParameter(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toBe("type");
      expect(await hint(page).textContent()).toContain("cast(expr AS type) → value");
      await captureCallShapes(page, "115-cast-hint");

      await typeAt(
        page,
        "SELECT cast(total AS DECIMAL(10, 2)) FROM orders",
        "SELECT cast(total AS DECIMAL(10, 2)".length,
      );
      await pressChord(page, "P");
      await expect.poll(() => activeParameter(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toBe("type");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.each(
    (
      [
        [POSTGRES, "052-other-dialects"],
        [SQLITE, "052-other-dialects-sqlite"],
      ] as const
    ).filter(([datasource]) => !serverSkipped(datasource.pluginId)),
  )(
    "givenOtherDialect_whenCompletingCou_thenCountWithItsSignature (%#)",
    async (datasource, evidence) => {
      const page = await launch(datasource);

      await completeAt(page, "SELECT cou");

      await option(page, "count").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await option(page, "count").locator(".cm-completionDetail").textContent()).toBe("(*) → integer");
      await captureWindow(page, evidence);
    },
    SCENARIO_TIMEOUT_MS,
  );
});
