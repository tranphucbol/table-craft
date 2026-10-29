/**
 * Plan 126's live test: JSON held in text columns opens formatted in the value panel, with the `{}`
 * toggle, Toggle JSON View, the Detect JSON setting and compact saves from the table editor, against
 * PostgreSQL and MySQL from the `test/db/compose.yml` databases:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/126 bun run test:smoke:db:headless:postgres test/e2e/jsonView.smoke.test.ts
 *
 * It creates `json_view_probe` beside the fixtures and drops it after.
 */
import type { Locator, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DatasourcePlugin } from "@table-craft/plugin-api";
import mysql from "@table-craft/plugin-mysql";
import postgres from "@table-craft/plugin-postgres";
import { MYSQL_CONFIG, POSTGRES_CONFIG, WITHOUT_POSTGRES } from "../support/databases.js";
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
  paletteInput,
  paletteRows,
  pressChord,
  runAllButton,
  SCENARIO_TIMEOUT_MS,
  seedSettings,
  setWindowSize,
  sqlEditor,
  toolWindow,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("126");

const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };
const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };

const TABLE = "json_view_probe";
const REASON =
  '{"domain":"UNSPECIFIED","reason":"UNSPECIFIED","metadata":{"pe_code":0,"retry":false,"tags":["a","b"]}}';
const REASON_EDITED = REASON.replace('"pe_code":0', '"pe_code":7');
const REASON_PRETTY_EDITED = [
  "{",
  '  "domain": "UNSPECIFIED",',
  '  "reason": "UNSPECIFIED",',
  '  "metadata": {',
  '    "pe_code": 7,',
  '    "retry": false,',
  '    "tags": [',
  '      "a",',
  '      "b"',
  "    ]",
  "  }",
  "}",
].join("\n");
const REASON_BROKEN = '{\n  "domain": "UNSPECIFIED",\n  "reason": \n}';
const SECOND_REASON = '{"domain":"PAYMENT","reason":"TIMEOUT","metadata":{"pe_code":504}}';
const STEPS = '[{"step":1,"ok":true},{"step":2,"ok":null}]';

function setupStatements(docType: string): string[] {
  return [
    `DROP TABLE IF EXISTS ${TABLE}`,
    `CREATE TABLE ${TABLE} (id INTEGER PRIMARY KEY, reason_status VARCHAR(500), steps TEXT, note TEXT, doc ${docType})`,
    `INSERT INTO ${TABLE} (id, reason_status, steps, note, doc) VALUES
      (1, '${REASON}', '${STEPS}', 'plain text', '{"kind": "document", "n": 1}'),
      (2, '${SECOND_REASON}', '["retry"]', NULL, '[1, 2, 3]')`,
  ];
}

/** Read-only: no key, so the panel is the viewer, not the editor. */
const READ_ONLY_QUERY = `SELECT reason_status, steps, note, doc FROM ${TABLE} ORDER BY id`;
const COLUMNS = { reason: 0, steps: 1, note: 2, doc: 3 } as const;
/** In the table editor, after `id`. */
const TABLE_REASON_COLUMN = 1;

async function asOwner(plugin: DatasourcePlugin, config: unknown, statements: readonly string[]): Promise<string[]> {
  const session = await plugin.connect(config, { readOnly: false });
  const values: string[] = [];
  try {
    for (const sql of statements) {
      const result = await session.execute(sql);
      for await (const row of result.rows) {
        const [value] = row;
        if (typeof value === "string") values.push(value);
      }
    }
  } finally {
    await session.close();
  }
  return values;
}

async function storedReason(plugin: DatasourcePlugin, config: unknown, id = 1): Promise<string | undefined> {
  const [value] = await asOwner(plugin, config, [`SELECT reason_status FROM ${TABLE} WHERE id = ${String(id)}`]);
  return value;
}

function panel(page: Page): Locator {
  return page.getByRole("complementary", { name: "Value" });
}

function toggle(page: Page): Locator {
  return panel(page).getByTestId("value-json-toggle");
}

function cell(page: Page, row: number, column: number, scope: Page | Locator = page): Locator {
  return scope.locator(`[role="gridcell"][data-row="${String(row)}"][data-col="${String(column)}"]`);
}

async function query(page: Page, sql: string): Promise<void> {
  await sqlEditor(page).fill(sql);
  await sqlEditor(page).press("Escape");
  await runAllButton(page).click();
  await waitUntilReady(page);
  await page.getByRole("columnheader").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
}

/** Focuses a cell and opens the value panel when it is not open yet. */
async function showValue(page: Page, row: number, column: number, scope: Page | Locator = page): Promise<void> {
  await cell(page, row, column, scope).click();
  if ((await panel(page).count()) === 0) await page.keyboard.press("Shift+Enter");
  await panel(page).waitFor();
}

/** The DOM members `jsonColours` reads; the root program has no DOM lib. */
interface Styled {
  readonly ownerDocument: { readonly defaultView: { getComputedStyle(element: Styled): { readonly color: string } } };
}

/** How many colours the formatted view draws its tokens in; one means unhighlighted. */
async function jsonColours(page: Page): Promise<number> {
  const spans = panel(page).locator(".cm-line span");
  await spans.first().waitFor();
  const colours = await spans.evaluateAll((elements: Styled[]) =>
    elements.map((element) => element.ownerDocument.defaultView.getComputedStyle(element).color),
  );
  return new Set(colours).size;
}

async function expectFormatted(page: Page, contains: string): Promise<void> {
  await expect.poll(() => toggle(page).getAttribute("data-on")).toBe("true");
  await expect.poll(() => panel(page).getByTestId("value-json").textContent()).toContain(contains);
  expect(await panel(page).getByTestId("value-json-hint").textContent()).toBe("JSON · shown formatted, stored as is");
}

async function expectRaw(page: Page, text: string): Promise<void> {
  await expect.poll(() => panel(page).getByTestId("value-text").textContent()).toBe(text);
  expect(await panel(page).getByTestId("value-json-hint").count()).toBe(0);
}

async function clickToggle(page: Page): Promise<void> {
  await toggle(page).getByRole("button").click();
}

function tableEditor(page: Page): Locator {
  return page.getByTestId("table-editor");
}

/** Opens the probe table from the Database pane: select it, press F4. */
async function openProbeTable(page: Page): Promise<void> {
  const explorer = toolWindow(page, "Database");
  const group = explorer.getByRole("treeitem", { name: /^tables \d+$/ });
  await group.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  if ((await group.getAttribute("aria-expanded")) !== "true") {
    await group.click();
    await page.keyboard.press("ArrowRight");
  }
  await explorer.getByRole("treeitem", { name: TABLE, exact: true }).click();
  await page.keyboard.press("F4");
  await expect.poll(() => activeEditorTab(page).textContent()).toContain(TABLE);
  await cell(page, 0, 0, tableEditor(page)).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  const orderBy = tableEditor(page).getByTestId("filter-order-by").locator(".cm-content");
  await orderBy.fill("id");
  await orderBy.press("Enter");
}

describe.runIf(DATABASES_ENABLED)("JSON view live test", () => {
  let running: RunningApp | null = null;

  async function setup(): Promise<void> {
    if (!WITHOUT_POSTGRES) await asOwner(postgres, POSTGRES_CONFIG, setupStatements("JSONB"));
    await asOwner(mysql, MYSQL_CONFIG, setupStatements("JSON"));
  }

  beforeAll(setup);
  afterAll(async () => {
    if (!WITHOUT_POSTGRES) await asOwner(postgres, POSTGRES_CONFIG, [`DROP TABLE IF EXISTS ${TABLE}`]);
    await asOwner(mysql, MYSQL_CONFIG, [`DROP TABLE IF EXISTS ${TABLE}`]);
  });

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
    await setup();
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource, settings?: object): Promise<Page> {
    const userDataDir = newProfile();
    if (settings !== undefined) seedSettings(userDataDir, { version: 1, ...settings });
    running = await launchApp(datasource, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running.page;
  }

  it.skipIf(WITHOUT_POSTGRES)(
    "givenJsonInTextColumns_whenValuePanelShown_thenFormattedAndTogglesPerColumn",
    async () => {
      const page = await launch(POSTGRES);
      await query(page, READ_ONLY_QUERY);

      await showValue(page, 0, COLUMNS.reason);
      await expectFormatted(page, '"pe_code": 0');
      expect(await jsonColours(page)).toBeGreaterThan(2);
      await captureWindow(page, "01-detected");

      await clickToggle(page);
      await expect.poll(() => toggle(page).getAttribute("data-on")).toBe("false");
      await expectRaw(page, REASON);
      await showValue(page, 1, COLUMNS.reason);
      await expectRaw(page, SECOND_REASON);
      await captureWindow(page, "02-toggled-off");

      await showValue(page, 0, COLUMNS.steps);
      await expectFormatted(page, '"step": 1');
      await captureWindow(page, "03-other-column");

      await showValue(page, 0, COLUMNS.note);
      await expectRaw(page, "plain text");
      expect(await toggle(page).count()).toBe(0);
      await showValue(page, 1, COLUMNS.note);
      await expect.poll(() => panel(page).textContent()).toContain("<null>");
      expect(await toggle(page).count()).toBe(0);
      await captureWindow(page, "04-plain-text");

      await showValue(page, 0, COLUMNS.doc);
      await expectFormatted(page, '"kind": "document"');
      expect(await jsonColours(page)).toBeGreaterThan(2);
      await clickToggle(page);
      await expectRaw(page, '{"n": 1, "kind": "document"}');
      await clickToggle(page);
      await expectFormatted(page, '"kind": "document"');
      await captureWindow(page, "05-json-column");

      await showValue(page, 0, COLUMNS.steps);
      await pressChord(page, "Alt+J");
      await expect.poll(() => toggle(page).getAttribute("data-on")).toBe("false");
      await expectRaw(page, STEPS);
      await pressChord(page, "Shift+A");
      await paletteInput(page, "Find Action").fill("Toggle JSON");
      await expect
        .poll(() => paletteRows(page).allTextContents())
        .toContainEqual(expect.stringContaining("Toggle JSON View"));
      await captureWindow(page, "06-shortcut");
      await page.keyboard.press("Enter");
      await expectFormatted(page, '"step": 1');
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenDetectJsonOff_whenJsonTextShown_thenRawUntilToggled",
    async () => {
      const page = await launch(POSTGRES, { data: { detectJson: false } });
      await query(page, READ_ONLY_QUERY);

      await showValue(page, 0, COLUMNS.reason);
      await expect.poll(() => toggle(page).getAttribute("data-on")).toBe("false");
      await expectRaw(page, REASON);
      await captureWindow(page, "07-setting-off");
      await showValue(page, 0, COLUMNS.doc);
      await expectFormatted(page, '"kind": "document"');

      await showValue(page, 0, COLUMNS.reason);
      await clickToggle(page);
      await expectFormatted(page, '"pe_code": 0');
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenCompactJsonText_whenEditedFormattedInTableEditor_thenStoredCompact",
    async () => {
      const page = await launch(POSTGRES);
      await openProbeTable(page);
      const editor = tableEditor(page);

      await showValue(page, 0, TABLE_REASON_COLUMN, editor);
      const value = panel(page).getByTestId("value-editor").locator(".cm-content");
      await expect.poll(() => value.textContent()).toContain('"pe_code": 0');
      await value.fill(REASON_PRETTY_EDITED);
      expect(await panel(page).getByTestId("value-json-invalid").count()).toBe(0);
      await pressChord(page, "Enter");

      await expect.poll(() => editor.getByTestId("pending-changes").textContent()).toBe("1 pending change");
      expect(await cell(page, 0, TABLE_REASON_COLUMN, editor).textContent()).toBe(REASON_EDITED);
      await editor.getByRole("button", { name: "Submit", exact: true }).click();
      await expect.poll(() => editor.getByTestId("table-notice").textContent()).toBe("Submitted 1 statement");
      expect(await storedReason(postgres, POSTGRES_CONFIG)).toBe(REASON_EDITED);
      await showValue(page, 0, TABLE_REASON_COLUMN, editor);
      await expect.poll(() => value.textContent()).toContain('"pe_code": 7');
      await captureWindow(page, "08-edit-compact");

      await showValue(page, 1, TABLE_REASON_COLUMN, editor);
      await expect.poll(() => value.textContent()).toContain('"pe_code": 504');
      await value.fill(REASON_BROKEN);
      await expect
        .poll(() => panel(page).getByTestId("value-json-invalid").textContent())
        .toBe("Not valid JSON — saved as typed");
      await captureWindow(page, "09-edit-invalid");
      await pressChord(page, "Enter");
      await expect.poll(() => editor.getByTestId("pending-changes").textContent()).toBe("1 pending change");
      await editor.getByRole("button", { name: "Submit", exact: true }).click();
      await expect.poll(() => storedReason(postgres, POSTGRES_CONFIG, 2)).toBe(REASON_BROKEN);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenDarkTheme_whenJsonShown_thenHighlightedInDarkColours",
    async () => {
      const page = await launch(POSTGRES, { appearance: { theme: "dark" } });
      await query(page, READ_ONLY_QUERY);

      await showValue(page, 0, COLUMNS.reason);
      await expectFormatted(page, '"pe_code": 0');
      expect(await jsonColours(page)).toBeGreaterThan(2);
      await captureWindow(page, "10-dark-theme");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlJsonInVarcharAndJsonColumn_whenShownAndEdited_thenFormattedAndStoredCompact",
    async () => {
      const page = await launch(MYSQL);
      await query(page, READ_ONLY_QUERY);

      await showValue(page, 0, COLUMNS.reason);
      await expectFormatted(page, '"pe_code": 0');
      expect(await jsonColours(page)).toBeGreaterThan(2);
      await captureWindow(page, "11-mysql-detected");
      await showValue(page, 0, COLUMNS.doc);
      await expectFormatted(page, '"kind": "document"');
      await clickToggle(page);
      await expectRaw(page, '{"n": 1, "kind": "document"}');

      await openProbeTable(page);
      const editor = tableEditor(page);
      await showValue(page, 0, TABLE_REASON_COLUMN, editor);
      const value = panel(page).getByTestId("value-editor").locator(".cm-content");
      await expect.poll(() => value.textContent()).toContain('"pe_code": 0');
      await value.fill(REASON_PRETTY_EDITED);
      await pressChord(page, "Enter");
      await expect.poll(() => cell(page, 0, TABLE_REASON_COLUMN, editor).textContent()).toBe(REASON_EDITED);
      await editor.getByRole("button", { name: "Submit", exact: true }).click();
      await expect.poll(() => editor.getByTestId("table-notice").textContent()).toBe("Submitted 1 statement");
      expect(await storedReason(mysql, MYSQL_CONFIG)).toBe(REASON_EDITED);
      await showValue(page, 0, TABLE_REASON_COLUMN, editor);
      await expect.poll(() => value.textContent()).toContain('"pe_code": 7');
      await captureWindow(page, "12-mysql-edit-compact");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
