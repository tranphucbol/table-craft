/**
 * Plan 152's live test: the ER diagram of a schema with inferred foreign keys, on the SQLite seed
 * `test/support/erd.sqlite.sql` whose keys are only naming conventions. Gated, because it needs a
 * display and a fresh build:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/152 bun run test:smoke:headless test/e2e/diagram.smoke.test.ts
 *
 * `diagramServers.smoke.test.ts` covers Postgres, MySQL and Redis.
 */
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { erdSqliteFile, wideErdSqliteFile } from "../support/sqliteFixture.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  EVIDENCE_WINDOW,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  readProfileFile,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  setWindowSize,
  SMOKE_ENABLED,
  treeNode,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";
import {
  addRelationship,
  captureWindow,
  diagramEdge,
  diagramEdges,
  dragTable,
  edgeEndOffset,
  ERD_TABLES_GROUP,
  exportBoth,
  frameGaps,
  INFERRED_EDGES,
  inSettings,
  rightClickEdge,
  setTheme,
  showDiagram,
  tableNode,
  toolbarButton,
  treeRow,
  watchFrames,
  writeEvidence,
} from "./diagramLive.js";

function erd(): Datasource {
  return { id: "erd", pluginId: "sqlite", config: { path: erdSqliteFile() } };
}

describe.runIf(SMOKE_ENABLED)("ER diagram", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource, tablesGroup = ERD_TABLES_GROUP): Promise<Page> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    await treeRow(running.page, tablesGroup).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    return running.page;
  }

  it(
    "givenSchemaWithoutDeclaredKeys_whenShowDiagram_thenInferredKeysDrawDashed",
    async () => {
      const page = await launch(erd());

      await showDiagram(page);

      await expect.poll(() => page.getByTestId("diagram-table").count()).toBe(8);
      await expect.poll(() => diagramEdges(page, "inferred").count()).toBe(INFERRED_EDGES);
      expect(await diagramEdges(page, "declared").count()).toBe(0);
      await expect.poll(() => page.getByTestId("diagram-status").textContent()).toMatch(/^8 of 8 tables/);
      await captureWindow(page, "01-sqlite-inferred");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenHiddenKeptAddedAndDragged_whenAppRestarts_thenDiagramRestored",
    async () => {
      const userDataDir = newProfile();
      seedDatasources(userDataDir, [SAVED_ERD]);
      let page = await relaunch(userDataDir);
      await showDiagram(page);
      await expect.poll(() => diagramEdges(page, "inferred").count()).toBe(INFERRED_EDGES);

      await rightClickEdge(page, HIDDEN_KEY);
      await page.getByRole("menuitem", { name: "Hide Inferred Key" }).click();
      await rightClickEdge(page, KEPT_KEY);
      await page.getByRole("menuitem", { name: "Keep as Virtual Key" }).click();
      await addRelationship(page, ["notes", "person_id"], ["people", "id"]);
      await dragTable(page, "people", DRAG);
      const moved = await tableNode(page, "people").getAttribute("style");
      await expectEdits(page);
      await expect
        .poll(() => readProfileFile(userDataDir, DIAGRAMS_FILE) ?? "", { timeout: SAVE_WAIT_MS })
        .toContain(`"person_id"`);
      // The add's save can land before the drag ends; closing before the drag's own save loses it.
      await expect
        .poll(() => savedPosition(userDataDir, "people"), { timeout: SAVE_WAIT_MS })
        .toEqual(translationOf(moved));

      await closeApp(running?.app);
      running = null;
      page = await relaunch(userDataDir);
      await showDiagram(page);
      await expectEdits(page);
      expect(await tableNode(page, "people").getAttribute("style")).toBe(moved);
      await toolbarButton(page, "Hidden Keys…").click();
      await expect.poll(() => page.getByTestId("diagram-hidden-key").count()).toBe(1);
      await captureWindow(page, "04-sqlite-restored");
      await page.keyboard.press("Escape");

      await toolbarButton(page, "Show Inferred Keys").click();
      await expect.poll(() => diagramEdges(page, "inferred").count()).toBe(0);
      await expect.poll(() => diagramEdges(page, "virtual").count()).toBe(2);
      await captureWindow(page, "05-sqlite-inference-off");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenDiagramInLightThenDark_whenExportedAsSvgAndPng_thenEachFileIsInTheShownTheme",
    async () => {
      const page = await launch(erd());
      if (running === null) throw new Error("The app is not running.");
      await showDiagram(page);
      await expect.poll(() => diagramEdges(page, "inferred").count()).toBe(INFERRED_EDGES);

      for (const theme of ["Light", "Dark"] as const) {
        await setTheme(page, theme);
        await exportBoth(running.app, page, `06-sqlite-${theme.toLowerCase()}`);
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenDiagramOpen_whenCompactDensityAndALargerGridFontChosen_thenEdgesStillMeetTheirRows",
    async () => {
      const page = await launch(erd());
      await showDiagram(page);
      await expect.poll(() => diagramEdges(page, "inferred").count()).toBe(INFERRED_EDGES);
      await expectEdgesOnRows(page);
      const comfortable = await tableNode(page, "orders").boundingBox();

      await inSettings(page, "Appearance", async (settings) => {
        await settings.getByRole("radio", { name: "Compact", exact: true }).check();
      });
      await inSettings(page, "Data Editor", async (settings) => {
        const size = settings.getByLabel("Size", { exact: true });
        await size.fill(String(LARGER_GRID_PX));
        await expect.poll(() => size.getAttribute("aria-invalid")).toBe("false");
      });

      await expect
        .poll(async () => (await tableNode(page, "orders").boundingBox())?.height)
        .not.toBe(comfortable?.height);
      await expectEdgesOnRows(page);
      await captureWindow(page, "09-sqlite-compact-density");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenFiveHundredTables_whenAllShown_thenLaidOutOffTheMainThreadAndPannable",
    async () => {
      const wideGroup = `tables ${String(WIDE_TABLES)}`;
      const page = await launch(
        { id: "wide", pluginId: "sqlite", config: { path: wideErdSqliteFile(WIDE_TABLES) } },
        wideGroup,
      );
      await showDiagram(page, wideGroup);
      const picker = page.getByTestId("diagram-tables-picker");
      await picker.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await page.getByTestId("diagram-table").count()).toBe(0);
      await captureWindow(page, "10-sqlite-500-tables-picker");

      await watchFrames(page);
      const started = Date.now();
      await picker.getByRole("button", { name: "Show All", exact: true }).click();
      await expect
        .poll(() => page.getByTestId("diagram-status").textContent(), { timeout: WIDE_LAYOUT_MS })
        .toMatch(new RegExp(`^${String(WIDE_TABLES)} of ${String(WIDE_TABLES)} tables`));
      const laidOutMs = Date.now() - started;
      const layout = await frameGaps(page);
      await page.keyboard.press("Escape");

      const canvas = page.getByTestId("diagram-canvas");
      const box = await canvas.boundingBox();
      if (box === null) throw new Error("The diagram is not drawn.");
      const viewport = page.locator(".react-flow__viewport");
      const fitted = await viewport.getAttribute("style");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let step = 0; step < WHEEL_STEPS; step += 1) await page.mouse.wheel(0, -WHEEL_DELTA);
      await expect.poll(() => viewport.getAttribute("style")).not.toBe(fitted);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 4, box.y + box.height / 4, { steps: 10 });
      await page.mouse.up();
      const panning = await frameGaps(page);

      writeEvidence(
        "10-sqlite-500-tables.txt",
        [
          `tables: ${String(WIDE_TABLES)}, inferred keys: ${String(WIDE_TABLES - 1)}`,
          `Show All to laid out: ${String(laidOutMs)} ms`,
          `while laying out: ${String(layout.frames)} frames, longest gap ${String(layout.longest)} ms`,
          `zoom and pan: ${String(panning.frames)} frames, longest gap ${String(panning.longest)} ms`,
          "",
        ].join("\n"),
      );
      expect(layout.frames).toBeGreaterThan(0);
      expect(panning.frames).toBeGreaterThan(0);
      await captureWindow(page, "10-sqlite-500-tables");
    },
    WIDE_SCENARIO_MS,
  );

  /** Every edge's two ends sit on the middles of the rows of the columns it joins. */
  async function expectEdgesOnRows(page: Page): Promise<void> {
    await expect
      .poll(async () => {
        const { measured, worst } = await edgeEndOffset(page);
        return measured === INFERRED_EDGES && worst <= ROW_TOLERANCE_PX;
      })
      .toBe(true);
  }

  /** One key hidden, one kept as virtual, one added: five inferred edges and two virtual ones. */
  async function expectEdits(page: Page): Promise<void> {
    await expect.poll(() => diagramEdges(page, "inferred").count()).toBe(INFERRED_EDGES - 2);
    await expect.poll(() => diagramEdges(page, "virtual").count()).toBe(2);
    expect(await diagramEdge(page, HIDDEN_KEY).count()).toBe(0);
  }

  async function relaunch(userDataDir: string): Promise<Page> {
    running = await launchApp(null, { userDataDir });
    const { page } = running;
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await treeNode(page, SAVED_ERD.name).click({ button: "right", timeout: LAUNCH_TIMEOUT_MS });
    await page.getByRole("menuitem", { name: /^Connect/ }).click();
    await treeRow(page, ERD_TABLES_GROUP).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    return page;
  }
});

const SAVED_ERD = { id: "erd", name: "erd", pluginId: "sqlite", config: { path: erdSqliteFile() } };
const DIAGRAMS_FILE = "diagrams.json";
/** Past the renderer's save debounce (`DIAGRAM_SAVE_DEBOUNCE_MS`) and main's write. */
const SAVE_WAIT_MS = 5_000;
const HIDDEN_KEY = "products(category_id)->categories(id)";
const KEPT_KEY = "order_items(product_id)->products(id)";
const DRAG = { x: 400, y: -120 };
const LARGER_GRID_PX = 16;
/** A screen pixel of rounding between the row's box and the edge's end. */
const ROW_TOLERANCE_PX = 1;
const WIDE_TABLES = 500;
const WIDE_LAYOUT_MS = 60_000;
const WIDE_SCENARIO_MS = 120_000;
const WHEEL_STEPS = 6;
const WHEEL_DELTA = 200;
const NODE_TRANSLATION = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/;

interface SavedDiagrams {
  readonly datasources: Readonly<
    Record<
      string,
      { readonly layouts: Readonly<Record<string, { readonly positions: Readonly<Record<string, unknown>> }>> }
    >
  >;
}

function translationOf(style: string | null): { x: number; y: number } | null {
  const match = NODE_TRANSLATION.exec(style ?? "");
  return match === null ? null : { x: Number(match[1]), y: Number(match[2]) };
}

function savedPosition(userDataDir: string, table: string): unknown {
  const text = readProfileFile(userDataDir, DIAGRAMS_FILE);
  if (text === null) return null;
  const layouts = (JSON.parse(text) as SavedDiagrams).datasources[SAVED_ERD.id]?.layouts ?? {};
  return Object.values(layouts)[0]?.positions[table] ?? null;
}
