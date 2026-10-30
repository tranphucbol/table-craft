/**
 * Plan 043's live test: selection aggregates, transpose, binary values to and from files, and the
 * boolean and temporal cell editors, against MySQL, TiDB and a seeded SQLite file, plus PostgreSQL
 * when `TABLE_CRAFT_DATABASES` selects it. Gated, because it needs a display, a fresh build and the
 * containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/043 bun run test:smoke:db:headless:postgres test/e2e/gridHelpers.smoke.test.ts
 *
 * The containers are shared with the other suites, so every scenario that writes puts the rows back.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { ElectronApplication, Locator, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DatasourcePlugin } from "@table-craft/plugin-api";
import mysql from "@table-craft/plugin-mysql";
import postgres from "@table-craft/plugin-postgres";
import { MYSQL_CONFIG, POSTGRES_CONFIG, TIDB_CONFIG, WITHOUT_POSTGRES } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  activeEditorTab,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  pressChord,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  seedSettings,
  setWindowSize,
  toolWindow,
  waitUntilReady,
  type Datasource,
  type RunningApp,
  chooseOption,
} from "./harness.js";

const captureWindow = evidenceFor("043");
const pickerEvidence = evidenceFor("111");
const dropdownEvidence = evidenceFor("129");
const COMPLETION_WAIT_MS = 1_000;
const PICKER_APPEARANCES = [
  ["DarkComfortable", "dark", "comfortable"],
  ["HighContrastCompact", "highContrast", "compact"],
] as const;
const FIELD_FOCUSED = "document.activeElement?.matches('[data-editing] input') === true";
const PICKER_SETTLED =
  "Promise.all(document.querySelector('[data-testid=temporal-picker]').getAnimations({ subtree: true }).map((a) => a.finished))";

const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };
const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };
const TIDB: Datasource = { id: "tidb", pluginId: "mysql", config: TIDB_CONFIG };

function sqlite(): Datasource {
  return { id: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } };
}

const TABLES_GROUP = "tables 6";
/** `type_probe`'s columns, as every fixture declares them. */
const FLAG = 5;
const PAYLOAD = 7;
const DAY = 8;
const MOMENT = 9;

const RESET_MYSQL = ["UPDATE type_probe SET payload = NULL WHERE id = 2"] as const;
const RESET_POSTGRES = ["UPDATE type_probe SET flag = TRUE WHERE id = 1"] as const;

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
  if (!WITHOUT_POSTGRES) await asOwner(postgres, POSTGRES_CONFIG, RESET_POSTGRES);
  await asOwner(mysql, MYSQL_CONFIG, RESET_MYSQL);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

const IMAGE_SIDE = 48;

/** A four-colour PNG, so the value panel's preview is plain to see in the evidence. */
function quadrantPng(): Buffer {
  const half = IMAGE_SIDE / 2;
  const colours = [
    [220, 60, 60],
    [60, 160, 220],
    [60, 200, 90],
    [240, 200, 40],
  ] as const;
  const lines: Buffer[] = [];
  for (let y = 0; y < IMAGE_SIDE; y += 1) {
    const line = [0];
    for (let x = 0; x < IMAGE_SIDE; x += 1)
      line.push(...(colours[(y < half ? 0 : 2) + (x < half ? 0 : 1)] ?? colours[0]));
    lines.push(Buffer.from(line));
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(IMAGE_SIDE, 0);
  header.writeUInt32BE(IMAGE_SIDE, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(lines))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function explorer(page: Page) {
  return toolWindow(page, "Database");
}

function treeRow(page: Page, name: string) {
  return explorer(page).getByRole("treeitem", { name, exact: true });
}

function editor(page: Page) {
  return page.getByTestId("table-editor");
}

function cellIn(scope: Page | Locator, row: number, column: number) {
  return scope.locator(`[role="gridcell"][data-row="${String(row)}"][data-col="${String(column)}"]`);
}

function aggregate(page: Page, name: string) {
  return page.getByTestId("aggregate-line").locator(`[data-aggregate="${name}"]`);
}

function pending(page: Page) {
  return editor(page).getByTestId("pending-changes");
}

function dialog(page: Page) {
  return page.getByRole("dialog");
}

async function openFromTree(page: Page, name: string): Promise<void> {
  const groupRow = treeRow(page, TABLES_GROUP);
  await groupRow.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  if ((await groupRow.getAttribute("aria-expanded")) !== "true") {
    await groupRow.click();
    await page.keyboard.press("ArrowRight");
  }
  await treeRow(page, name).click();
  await page.keyboard.press("F4");
  await expect.poll(() => activeEditorTab(page).textContent()).toContain(name);
  await cellIn(editor(page), 0, 0).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
}

async function selectBlock(scope: Page | Locator, from: [number, number], to: [number, number]): Promise<void> {
  await cellIn(scope, from[0], from[1]).click();
  await cellIn(scope, to[0], to[1]).click({ modifiers: ["Shift"] });
}

async function answerOpenDialog(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog: dialogs }, picked) => {
    dialogs.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [picked] });
  }, path);
}

async function answerSaveDialog(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog: dialogs }, picked) => {
    dialogs.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: picked });
  }, path);
}

async function clipboardText(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ clipboard }) => clipboard.readText());
}

function fileHex(path: string): string {
  try {
    return readFileSync(path).toString("hex");
  } catch {
    return "";
  }
}

/** Loads `path` into a cell through its context menu. */
async function loadIntoCell(running: RunningApp, cell: Locator, path: string): Promise<void> {
  await answerOpenDialog(running.app, path);
  await cell.click({ button: "right" });
  await running.page.getByRole("menuitem", { name: "Load File into Cell…" }).click();
}

function picker(page: Page) {
  return page.getByTestId("temporal-picker");
}

function cellField(page: Page) {
  return editor(page).locator("[data-editing] input");
}

/** Opens the picker from the calendar button and waits out its entry, so a capture shows it whole. */
async function clickPicker(page: Page, name: string): Promise<void> {
  await editor(page)
    .getByRole("button", { name: `Pick ${name}` })
    .click();
  await picker(page).waitFor();
  await page.evaluate(PICKER_SETTLED);
}

/** Edits the cell and opens its picker from the calendar button. */
async function openPicker(page: Page, row: number, column: number, name: string): Promise<void> {
  await cellIn(editor(page), row, column).click();
  await page.keyboard.press("Enter");
  await clickPicker(page, name);
}

/**
 * The completion popup over the grid would take the clicks that follow, and while it is open
 * Enter accepts a completion instead of applying the clause, so it is closed first.
 */
async function orderById(page: Page): Promise<void> {
  const clause = editor(page).getByTestId("filter-order-by").locator(".cm-content");
  const completions = page.locator(".cm-tooltip-autocomplete");
  await clause.fill("id");
  await completions.waitFor({ timeout: COMPLETION_WAIT_MS }).catch(() => undefined);
  if (await completions.isVisible()) await clause.press("Escape");
  await clause.press("Enter");
  await expect.poll(() => editor(page).getByTestId("filter-order-by").getAttribute("data-invalid")).toBe("false");
  await expect.poll(() => cellIn(editor(page), 0, 0).textContent()).toBe("1");
  await completions.waitFor({ state: "hidden" });
}

async function previewTexts(page: Page): Promise<string[]> {
  await pressChord(page, "Shift+P");
  const statements = dialog(page).getByRole("list", { name: "Statements" }).getByRole("listitem");
  await expect.poll(() => statements.count()).toBeGreaterThan(0);
  return statements.allTextContents();
}

describe.runIf(DATABASES_ENABLED)("grid helpers live test", () => {
  let running: RunningApp | null = null;
  let scratch = "";

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "table-craft-043-"));
    await resetFixtures();
  });
  afterAll(async () => {
    rmSync(scratch, { recursive: true, force: true });
    await resetFixtures();
  });

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
    await resetFixtures();
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource, userDataDir?: string): Promise<RunningApp> {
    running = await launchApp(datasource, userDataDir === undefined ? {} : { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running;
  }

  it(
    "givenMysqlDecimals_whenThreeCellsSelected_thenExactSumAndAverageAndCopied",
    async () => {
      const { app, page } = await launch(MYSQL);
      await runStatement(page, "SELECT id, total FROM orders ORDER BY id");

      await selectBlock(page, [0, 1], [2, 1]);

      await expect.poll(() => aggregate(page, "sum").textContent()).toBe("Sum: 145.49");
      expect(await aggregate(page, "count").textContent()).toBe("Count: 3");
      expect(await aggregate(page, "avg").textContent()).toBe("Avg: 48.49666667");
      expect(await aggregate(page, "min").textContent()).toBe("Min: 5.00");
      expect(await aggregate(page, "max").textContent()).toBe("Max: 120.50");
      await captureWindow(page, "aggregates-mysql");

      await page.getByTestId("aggregate-copy").click();
      await expect.poll(() => clipboardText(app)).toContain("Sum: 145.49");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenTidbDecimals_whenSelected_thenSumHasNoFloatError",
    async () => {
      const { page } = await launch(TIDB);
      await runStatement(page, "SELECT 0.1 AS v UNION ALL SELECT 0.2 UNION ALL SELECT 0.3");

      await selectBlock(page, [0, 0], [2, 0]);

      await expect.poll(() => aggregate(page, "sum").textContent()).toBe("Sum: 0.6");
      expect(await aggregate(page, "avg").textContent()).toBe("Avg: 0.2");
      await captureWindow(page, "aggregates-tidb");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSqliteMixedColumns_whenSelected_thenCountAndDistinctOnlyAndChooserHidesOne",
    async () => {
      const { page } = await launch(sqlite());
      await runStatement(page, "SELECT id, customer_id, placed_at FROM orders ORDER BY id");

      await selectBlock(page, [0, 1], [2, 2]);

      await expect.poll(() => aggregate(page, "count").textContent()).toBe("Count: 6");
      expect(await aggregate(page, "distinct").textContent()).toBe("Distinct: 5");
      expect(await aggregate(page, "sum").count()).toBe(0);

      await page.getByRole("button", { name: "Choose aggregates" }).click();
      await page.getByRole("checkbox", { name: "Distinct" }).uncheck();
      await expect.poll(() => aggregate(page, "distinct").count()).toBe(0);
      await captureWindow(page, "aggregates-chooser");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlTypeProbe_whenTransposed_thenColumnsBecomeRows",
    async () => {
      const { page } = await launch(MYSQL);
      await runStatement(page, "SELECT * FROM type_probe ORDER BY id");

      await cellIn(page, 0, 0).click();
      await pressChord(page, "Alt+T");

      const grid = page.locator("[data-transposed]");
      await grid.waitFor();
      const names = await grid.locator("[data-transposed-name]").allTextContents();
      expect(names.slice(0, 3).map((name) => name.trim())).toEqual(["id", "small_int", "big_int"]);
      expect(await cellIn(grid, 1, 0).textContent()).toBe("2");
      await captureWindow(page, "transpose-mysql");

      await pressChord(page, "Alt+T");
      await expect.poll(() => page.locator("[data-transposed]").count()).toBe(0);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPostgresTypeProbe_whenTransposed_thenEveryColumnARow",
    async () => {
      const { page } = await launch(POSTGRES);
      await runStatement(page, "SELECT * FROM type_probe ORDER BY id");

      await cellIn(page, 0, 0).click();
      await pressChord(page, "Alt+T");

      const grid = page.locator("[data-transposed]");
      await grid.waitFor();
      expect(await grid.locator("[data-transposed-name]").count()).toBe(10);
      await captureWindow(page, "transpose-postgres");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenTransposedTable_whenEditCell_thenEditBufferHitsSameCell",
    async () => {
      const { page } = await launch(sqlite());
      await openFromTree(page, "edit_probe");
      await cellIn(editor(page), 0, 1).click();
      await pressChord(page, "Alt+T");
      const grid = editor(page).locator("[data-transposed]");
      await grid.waitFor();

      await cellIn(grid, 0, 1).click();
      await page.keyboard.press("Enter");
      const field = editor(page).locator("[data-editing] input");
      await field.fill("changed");
      await field.press("Enter");

      await expect.poll(() => cellIn(grid, 0, 1).getAttribute("data-edit")).toBe("modified");
      await expect.poll(() => pending(page).textContent()).toBe("1 pending change");
      await captureWindow(page, "transpose-edit");

      await pressChord(page, "Alt+T");
      await expect.poll(() => cellIn(editor(page), 0, 1).textContent()).toBe("changed");
      expect(await cellIn(editor(page), 0, 1).getAttribute("data-edit")).toBe("modified");
      expect(await cellIn(editor(page), 1, 1).textContent()).toBe("second");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSqliteBlob_whenSaveToFile_thenFullBytesWritten",
    async () => {
      const running = await launch(sqlite());
      const { page } = running;
      await openFromTree(page, "type_probe");
      const path = join(scratch, "sqlite-payload.bin");
      await answerSaveDialog(running.app, path);

      await cellIn(editor(page), 0, PAYLOAD).click();
      await page.keyboard.press("Shift+Enter");
      await page.getByTestId("value-bytes").waitFor();
      await page.getByRole("button", { name: "Save Value to File…" }).click();

      await expect.poll(() => fileHex(path)).toBe("deadbeef");
      await captureWindow(page, "save-bytes");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPostgresBytea_whenSaveToFileFromConsole_thenFullBytesWritten",
    async () => {
      const running = await launch(POSTGRES);
      const { page } = running;
      await runStatement(page, "SELECT id, payload FROM type_probe ORDER BY id");
      const path = join(scratch, "postgres-payload.bin");
      await answerSaveDialog(running.app, path);

      await cellIn(page, 0, 1).click();
      await page.keyboard.press("Shift+Enter");
      await page.getByRole("button", { name: "Save Value to File…" }).click();

      await expect.poll(() => fileHex(path)).toBe("deadbeef");
      await captureWindow(page, "save-postgres");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenPngFile_whenLoadedIntoBlobAndSubmitted_thenValuePanelPreviewsTheImage",
    async () => {
      const running = await launch(sqlite());
      const { page } = running;
      await openFromTree(page, "type_probe");
      const png = quadrantPng();
      const path = join(scratch, "quadrants.png");
      writeFileSync(path, png);

      await loadIntoCell(running, cellIn(editor(page), 1, PAYLOAD), path);

      await expect.poll(() => cellIn(editor(page), 1, PAYLOAD).textContent()).toMatch(/^0x89504e47/u);
      expect(await cellIn(editor(page), 1, PAYLOAD).getAttribute("data-edit")).toBe("modified");
      const texts = await previewTexts(page);
      expect(texts[0]).toContain(`of ${String(png.length)} bytes`);
      await captureWindow(page, "load-preview");
      await dialog(page).getByRole("button", { name: "Submit" }).click();
      await expect.poll(() => pending(page).count()).toBe(0);

      await cellIn(editor(page), 1, PAYLOAD).click();
      await page.keyboard.press("Shift+Enter");
      const image = page.getByTestId("value-image");
      await image.waitFor();
      await expect
        .poll(() => image.evaluate((element: { readonly naturalWidth: number }) => element.naturalWidth))
        .toBe(IMAGE_SIDE);
      await captureWindow(page, "image-preview");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlVarbinary_whenSmallFileLoadedAndSubmitted_thenEveryByteStored",
    async () => {
      const running = await launch(MYSQL);
      const { page } = running;
      await openFromTree(page, "type_probe");
      const bytes = Buffer.from(Array.from({ length: 40 }, (_, n) => n));
      const path = join(scratch, "forty.bin");
      writeFileSync(path, bytes);

      await loadIntoCell(running, cellIn(editor(page), 1, PAYLOAD), path);
      await expect.poll(() => pending(page).textContent()).toBe("1 pending change");
      await editor(page).getByRole("button", { name: "Submit", exact: true }).click();
      await expect.poll(() => pending(page).count()).toBe(0);

      const saved = join(scratch, "forty-back.bin");
      await answerSaveDialog(running.app, saved);
      await cellIn(editor(page), 1, PAYLOAD).click();
      await page.keyboard.press("Shift+Enter");
      await page.getByRole("button", { name: "Save Value to File…" }).click();
      await expect.poll(() => fileHex(saved)).toBe(bytes.toString("hex"));
      await captureWindow(page, "load-mysql");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenOversizeFile_whenLoad_thenRefusedNamingTheSetting",
    async () => {
      const userDataDir = newProfile();
      seedSettings(userDataDir, { version: 1, data: { blobLimitMb: 1 } });
      const running = await launch(sqlite(), userDataDir);
      const { page } = running;
      await openFromTree(page, "type_probe");
      const path = join(scratch, "too-big.bin");
      writeFileSync(path, Buffer.alloc(1536 * 1024));

      await loadIntoCell(running, cellIn(editor(page), 1, PAYLOAD), path);

      await expect.poll(() => editor(page).getByTestId("table-error").textContent()).toContain("BLOB file limit");
      expect(await pending(page).count()).toBe(0);
      await captureWindow(page, "oversize");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSqliteBooleanCell_whenSpace_thenTogglesAndSubmitsFalse",
    async () => {
      const { page } = await launch(sqlite());
      await openFromTree(page, "type_probe");

      await cellIn(editor(page), 0, FLAG).click();
      await page.keyboard.press("Space");

      await expect.poll(() => cellIn(editor(page), 0, FLAG).textContent()).toBe("false");
      const texts = await previewTexts(page);
      expect(texts[0]).toContain("FALSE");
      await captureWindow(page, "boolean-toggle");
      await dialog(page).getByRole("button", { name: "Submit" }).click();
      await expect.poll(() => pending(page).count()).toBe(0);
      expect(await cellIn(editor(page), 0, FLAG).getAttribute("data-edit")).toBeNull();
      expect(await cellIn(editor(page), 0, FLAG).textContent()).toBe("false");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSqliteBooleanCell_whenEnter_thenDropdownWritesTheChoice",
    async () => {
      const { page } = await launch(sqlite());
      await openFromTree(page, "type_probe");

      await cellIn(editor(page), 1, FLAG).click();
      await page.keyboard.press("Enter");
      const select = editor(page).locator('[data-editing] [role="combobox"]');
      await select.waitFor();
      await page.getByRole("listbox").waitFor();
      await captureWindow(page, "boolean-editor");
      await dropdownEvidence(page, "05-boolean-editor");
      await chooseOption(select, "true");

      await expect.poll(() => cellIn(editor(page), 1, FLAG).textContent()).toBe("true");
      expect(await pending(page).textContent()).toBe("1 pending change");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPostgresBoolean_whenSpaceAndSubmitted_thenStoredFalse",
    async () => {
      const { page } = await launch(POSTGRES);
      await openFromTree(page, "type_probe");
      await editor(page).getByTestId("filter-order-by").locator(".cm-content").fill("id");
      await editor(page).getByTestId("filter-order-by").locator(".cm-content").press("Enter");

      await cellIn(editor(page), 0, FLAG).click();
      await page.keyboard.press("Space");
      await expect.poll(() => cellIn(editor(page), 0, FLAG).textContent()).toBe("false");
      await editor(page).getByRole("button", { name: "Submit", exact: true }).click();

      await expect.poll(() => pending(page).count()).toBe(0);
      await expect.poll(() => cellIn(editor(page), 0, FLAG).textContent()).toBe("false");
      await captureWindow(page, "boolean-postgres");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlTemporalCells_whenPicked_thenWrittenInTheCellsShape",
    async () => {
      const { page } = await launch(MYSQL);
      await openFromTree(page, "type_probe");
      await orderById(page);
      const field = cellField(page);

      await openPicker(page, 0, DAY, "day");
      expect(await picker(page).locator("[data-picker-kind]").getAttribute("data-picker-kind")).toBe("date");
      expect(await picker(page).locator("[data-month]").getAttribute("data-month")).toBe("2024-02");
      await captureWindow(page, "temporal-picker");
      await pickerEvidence(page, "date-picker");
      await picker(page).getByRole("button", { name: "Next month" }).click();
      await picker(page).getByRole("gridcell", { name: "2024-03-15" }).click();
      await expect.poll(() => picker(page).count()).toBe(0);
      await expect.poll(() => field.inputValue()).toBe("2024-03-15");
      await expect.poll(() => page.evaluate(FIELD_FOCUSED)).toBe(true);
      await field.press("Enter");

      await openPicker(page, 0, MOMENT, "moment");
      expect(await picker(page).locator("[data-picker-kind]").getAttribute("data-picker-kind")).toBe("datetime");
      await picker(page).getByRole("button", { name: "Next month" }).click();
      await picker(page).getByRole("gridcell", { name: "2024-03-15" }).click();
      await expect.poll(() => field.inputValue()).toBe("2024-03-15 13:45:30");
      await picker(page).getByRole("spinbutton", { name: "Hour" }).click();
      await page.keyboard.type("083000");
      await expect.poll(() => field.inputValue()).toBe("2024-03-15 08:30:00");
      await pickerEvidence(page, "datetime-picker");
      await page.keyboard.press("Enter");
      await expect.poll(() => picker(page).count()).toBe(0);
      await field.press("Enter");

      await expect.poll(() => cellIn(editor(page), 0, DAY).textContent()).toBe("2024-03-15");
      expect(await cellIn(editor(page), 0, MOMENT).textContent()).toBe("2024-03-15 08:30:00");
      const texts = await previewTexts(page);
      expect(texts[0]).toContain("'2024-03-15'");
      expect(texts[0]).toContain("'2024-03-15 08:30:00'");
      await captureWindow(page, "temporal-preview");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPostgresTimestamp_whenPicked_thenWrittenInTheCellsShape",
    async () => {
      const { page } = await launch(POSTGRES);
      await openFromTree(page, "type_probe");
      await orderById(page);
      await expect.poll(() => cellIn(editor(page), 0, MOMENT).textContent()).toBe("2024-02-29 13:45:30");
      const field = cellField(page);

      await openPicker(page, 0, MOMENT, "moment");
      await picker(page).getByRole("gridcell", { name: "2024-02-01" }).click();
      const hour = picker(page).getByRole("spinbutton", { name: "Hour" });
      await hour.click();
      await page.keyboard.press("ArrowUp");
      await expect.poll(() => field.inputValue()).toBe("2024-02-01 14:45:30");
      await hour.hover();
      await page.mouse.wheel(0, 100);
      await expect.poll(() => field.inputValue()).toBe("2024-02-01 13:45:30");
      await captureWindow(page, "temporal-postgres");
      await pickerEvidence(page, "datetime-postgres");
      await page.keyboard.press("Escape");
      await expect.poll(() => picker(page).count()).toBe(0);
      await expect.poll(() => field.inputValue()).toBe("2024-02-01 13:45:30");
    },
    SCENARIO_TIMEOUT_MS,
  );

  for (const [appearance, theme, density] of PICKER_APPEARANCES)
    it.skipIf(WITHOUT_POSTGRES)(
      `given${appearance}_whenPickerOpens_thenItTakesTheTheme`,
      async () => {
        const userDataDir = newProfile();
        seedSettings(userDataDir, { version: 1, appearance: { theme, density } });
        const { page } = await launch(POSTGRES, userDataDir);
        await openFromTree(page, "type_probe");
        await orderById(page);

        await openPicker(page, 0, MOMENT, "moment");
        await expect
          .poll(() => picker(page).getByRole("gridcell", { selected: true }).getAttribute("aria-label"))
          .toBe("2024-02-29");
        await pickerEvidence(page, `picker-${theme}-${density}`);
      },
      SCENARIO_TIMEOUT_MS,
    );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPostgresMicroseconds_whenDayPicked_thenFractionKept",
    async () => {
      const { page } = await launch(POSTGRES);
      await openFromTree(page, "type_probe");
      await orderById(page);
      const field = cellField(page);

      await cellIn(editor(page), 0, MOMENT).click();
      await page.keyboard.press("Enter");
      await field.fill("2026-02-25 16:54:26.742623");
      await clickPicker(page, "moment");
      expect(await picker(page).locator("[data-month]").getAttribute("data-month")).toBe("2026-02");
      await picker(page).getByRole("gridcell", { name: "2026-02-20" }).click();
      await expect.poll(() => field.inputValue()).toBe("2026-02-20 16:54:26.742623");
      await pickerEvidence(page, "fraction-kept");
      await page.keyboard.press("Enter");
      await field.press("Enter");

      await expect.poll(() => cellIn(editor(page), 0, MOMENT).textContent()).toBe("2026-02-20 16:54:26.742623");
      const texts = await previewTexts(page);
      expect(texts[0]).toContain("'2026-02-20 16:54:26.742623'");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenDatePicker_whenKeyboardOnly_thenArrowsAndEnterPick",
    async () => {
      const { page } = await launch(MYSQL);
      await openFromTree(page, "type_probe");
      await orderById(page);
      const field = cellField(page);

      await openPicker(page, 0, DAY, "day");
      const cursor = picker(page).locator("[data-cursor]");
      await expect.poll(() => cursor.getAttribute("aria-label")).toBe("2024-02-29");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowDown");
      await expect.poll(() => cursor.getAttribute("aria-label")).toBe("2024-03-08");
      await page.keyboard.press("PageDown");
      await expect.poll(() => cursor.getAttribute("aria-label")).toBe("2024-04-08");
      await page.keyboard.press("Shift+PageUp");
      await expect.poll(() => cursor.getAttribute("aria-label")).toBe("2023-04-08");
      await page.keyboard.press("PageUp");
      await expect.poll(() => picker(page).locator("[data-month]").getAttribute("data-month")).toBe("2023-03");
      await pickerEvidence(page, "keyboard-cursor");
      await page.keyboard.press("Enter");

      await expect.poll(() => picker(page).count()).toBe(0);
      await expect.poll(() => field.inputValue()).toBe("2023-03-08");
      await page.keyboard.press("Enter");
      await expect.poll(() => cellIn(editor(page), 0, DAY).textContent()).toBe("2023-03-08");
      await expect.poll(() => pending(page).count()).toBe(1);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenOpenPicker_whenClickAnotherCell_thenEditCommits",
    async () => {
      const { page } = await launch(MYSQL);
      await openFromTree(page, "type_probe");
      await orderById(page);

      await openPicker(page, 0, MOMENT, "moment");
      await picker(page).getByRole("gridcell", { name: "2024-02-15" }).click();
      await expect.poll(() => cellField(page).inputValue()).toBe("2024-02-15 13:45:30");
      await cellIn(editor(page), 0, DAY).click();

      await expect.poll(() => picker(page).count()).toBe(0);
      await expect.poll(() => cellField(page).count()).toBe(0);
      await expect.poll(() => cellIn(editor(page), 0, MOMENT).textContent()).toBe("2024-02-15 13:45:30");
      await pickerEvidence(page, "outside-commit");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
