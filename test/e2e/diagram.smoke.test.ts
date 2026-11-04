/**
 * Plan 152's live test: the ER diagram of a schema with inferred foreign keys, on the SQLite seed
 * `test/support/erd.sqlite.sql` whose keys are only naming conventions. Gated, because it needs a
 * display and a fresh build:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/152 bun run test:smoke:headless test/e2e/diagram.smoke.test.ts
 */
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { erdSqliteFile } from "../support/sqliteFixture.js";
import {
  activeEditorTab,
  chooseOption,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  readProfileFile,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  setWindowSize,
  SMOKE_ENABLED,
  toolWindow,
  treeNode,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("152");

const ERD_TABLES_GROUP = "tables 8";
/** What the rule infers on the seed: every `<table>_id` and `parent_id`, not `notes.person_id`. */
const INFERRED_EDGES = 7;

function erd(): Datasource {
  return { id: "erd", pluginId: "sqlite", config: { path: erdSqliteFile() } };
}

function treeRow(page: Page, name: string) {
  return toolWindow(page, "Database").getByRole("treeitem", { name, exact: true });
}

function diagramEdges(page: Page, origin: string) {
  return page.locator(`[data-testid="diagram-edge"][data-edge-origin="${origin}"]`);
}

function diagramEdge(page: Page, keyId: string) {
  return page.locator(`[data-testid="diagram-edge"][data-edge-id$=${JSON.stringify(`:${keyId}`)}]`);
}

/** The few SVG members `rightClickEdge` reads; the e2e program is compiled without the DOM lib. */
interface PathElement {
  getTotalLength(): number;
  getPointAtLength(length: number): { readonly x: number; readonly y: number };
  getScreenCTM(): {
    readonly a: number;
    readonly b: number;
    readonly c: number;
    readonly d: number;
    readonly e: number;
    readonly f: number;
  } | null;
}

/**
 * Opens an edge's context menu at the middle of its path: a click at its bounding box's centre can
 * miss a step path or land on a table drawn over it.
 */
async function rightClickEdge(page: Page, keyId: string): Promise<void> {
  const hit = diagramEdge(page, keyId).locator(".tc-diagram-edge-hit");
  const point = await hit.evaluate((element) => {
    const path = element as unknown as PathElement;
    const middle = path.getPointAtLength(path.getTotalLength() / 2);
    const matrix = path.getScreenCTM();
    if (matrix === null) return middle;
    return {
      x: matrix.a * middle.x + matrix.c * middle.y + matrix.e,
      y: matrix.b * middle.x + matrix.d * middle.y + matrix.f,
    };
  });
  await hit.dispatchEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: point.x,
    clientY: point.y,
  });
}

function tableNode(page: Page, table: string) {
  return page.locator(`.react-flow__node[data-id=${JSON.stringify(table)}]`);
}

/** Opens the diagram from the Tables group's Diagrams submenu. */
async function showDiagram(page: Page, row = ERD_TABLES_GROUP): Promise<void> {
  await treeRow(page, row).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Diagrams" }).click();
  await page.getByRole("menuitem", { name: /^Show Diagram/ }).click();
  await expect.poll(() => activeEditorTab(page).locator('[data-tab-kind="diagram"]').count()).toBe(1);
}

describe.runIf(SMOKE_ENABLED)("ER diagram", () => {
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
    await treeRow(running.page, ERD_TABLES_GROUP).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
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

function toolbarButton(page: Page, name: string) {
  return page.getByTestId("diagram-toolbar").getByRole("button", { name, exact: true });
}

async function addRelationship(
  page: Page,
  [from, column]: readonly [string, string],
  [to, target]: readonly [string, string],
): Promise<void> {
  await toolbarButton(page, "Add Relationship…").click();
  const dialog = page.getByTestId("relationship-dialog");
  await chooseOption(dialog.getByTestId("relationship-from"), from);
  await chooseOption(dialog.getByTestId("relationship-to"), to);
  await chooseOption(dialog.getByTestId("relationship-column-1"), column);
  await expect.poll(() => dialog.getByTestId("relationship-target-1").getAttribute("data-value")).toBe(target);
  await dialog.getByRole("button", { name: "Add Relationship", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
}

async function dragTable(page: Page, table: string, by: { readonly x: number; readonly y: number }): Promise<void> {
  const box = await tableNode(page, table).locator(".tc-diagram-header").boundingBox();
  if (box === null) throw new Error(`The ${table} table is not drawn.`);
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + by.x / 2, start.y + by.y / 2, { steps: 5 });
  await page.mouse.move(start.x + by.x, start.y + by.y, { steps: 5 });
  await page.mouse.up();
}
