/**
 * Plan 136's live test: arranging the Database tree. Drag datasources and folders, select several,
 * move them up and down, and keep the order across a restart. SQLite only:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/136 bun run test:smoke:headless test/e2e/arrange.smoke.test.ts
 */
import type { Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  EVIDENCE_WINDOW,
  evidenceFor,
  findAction,
  launchApp,
  newProfile,
  readProfileFile,
  SCENARIO_TIMEOUT_MS,
  SCRATCH,
  seedDatasources,
  setWindowSize,
  SMOKE_ENABLED,
  toolWindow,
  treeNode,
  type Datasource,
  type RunningApp,
  type SavedDatasource,
} from "./harness.js";

const captureWindow = evidenceFor("136");

/** Longer than the renderer's `FOLDER_SPRING_OPEN_MS`, so a drag resting on a folder opens it. */
const SPRING_WAIT_MS = 1_000;
const DRAG_STEPS = 6;
/** Across the row, past the chevron and icon: a drag never starts on the chevron's button. */
const POINTER_ACROSS = 0.4;
const LONG_TREE = 40;
const EDGE_DRAGOVERS = 12;
/** Finite animations only: a spinner's runs forever. */
const ANIMATIONS_FINISHED =
  "Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished))";
const FOCUSED_LABEL = "document.activeElement?.getAttribute('aria-label') ?? null";

/** The DOM types the e2e program does not load, as far as these evaluations use them. */
interface AttributedElement {
  getAttribute(name: string): string | null;
}

interface Scrollable {
  readonly scrollTop: number;
}

function sqlite(name: string, folder: string | null = null): SavedDatasource {
  return { id: name, name, pluginId: "sqlite", folder, config: { path: ":memory:" } };
}

interface StoredFile {
  readonly version: number;
  readonly folders: readonly string[];
  readonly datasources: readonly { readonly name: string; readonly folder: string | null }[];
}

function storedFile(userDataDir: string): StoredFile {
  return JSON.parse(readProfileFile(userDataDir, "datasources.json") ?? "null") as StoredFile;
}

/** The folder and datasource rows, top to bottom, as `<level> <name>`, a folder ending in `/`. */
async function treeOrder(page: Page): Promise<string[]> {
  const rows = toolWindow(page, "Database").locator(
    '[role="treeitem"]:is([data-kind="folder"], [data-kind="datasource"])',
  );
  return rows.evaluateAll((items: readonly AttributedElement[]) =>
    items.map((item) => {
      const name = (item.getAttribute("aria-label") ?? "").split(", ")[0] ?? "";
      const suffix = item.getAttribute("data-kind") === "folder" ? "/" : "";
      return `${item.getAttribute("aria-level") ?? ""} ${name}${suffix}`;
    }),
  );
}

async function center(locator: Locator, fraction = 0.5): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("The row is not on screen.");
  return { x: box.x + box.width * POINTER_ACROSS, y: box.y + box.height * fraction };
}

/** Starts a drag on `source` and moves it over `target` at `fraction` of its height; the mouse stays down. */
async function dragOver(page: Page, source: Locator, target: Locator, fraction: number): Promise<void> {
  const from = await center(source);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const to = await center(target, fraction);
  await page.mouse.move(to.x, to.y, { steps: DRAG_STEPS });
  // Playwright's emulated drag fires no dragover after the last step's dragenter, where a real drag
  // repeats dragover while the pointer rests; one more pixel gives the target its dragover.
  await page.mouse.move(to.x + 1, to.y);
}

async function dragTo(page: Page, source: Locator, target: Locator, fraction: number): Promise<void> {
  await dragOver(page, source, target, fraction);
  await page.mouse.up();
}

/** Waits out the dialog's fade-in, so the capture shows it opaque. */
async function settled(page: Page): Promise<void> {
  await page.evaluate(ANIMATIONS_FINISHED);
}

function menuItem(page: Page, name: string) {
  return page.getByRole("menuitem", { name: new RegExp(`^${name}`) });
}

describe.runIf(SMOKE_ENABLED)("arrange the Database tree live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    await closeApp(running?.app);
    running = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(
    datasources: readonly SavedDatasource[],
    userDataDir = newProfile(),
    ephemeral: Datasource | null = null,
  ) {
    seedDatasources(userDataDir, datasources);
    return relaunch(userDataDir, ephemeral);
  }

  async function relaunch(userDataDir: string, ephemeral: Datasource | null = null) {
    await closeApp(running?.app);
    running = await launchApp(ephemeral, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await toolWindow(running.page, "Database").waitFor();
    return running;
  }

  it(
    "givenVersion1ProfileWithFolders_whenLaunched_thenTheTreeKeepsItsNameOrderAndTheFileBecomesVersion2",
    async () => {
      const { page, userDataDir } = await launch([
        sqlite("zeta"),
        sqlite("beta", "Prod"),
        sqlite("alpha"),
        sqlite("gamma", "Dev"),
        sqlite("Analytics", "Prod"),
      ]);
      await treeNode(page, "zeta").waitFor();

      expect(await treeOrder(page)).toEqual([
        "1 Dev/",
        "2 gamma",
        "1 Prod/",
        "2 Analytics",
        "2 beta",
        "1 alpha",
        "1 zeta",
      ]);
      await captureWindow(page, "01-migrated");

      await treeNode(page, "zeta").click();
      await page.keyboard.press("Alt+Shift+ArrowUp");
      await expect.poll(() => storedFile(userDataDir).version).toBe(2);
      const stored = storedFile(userDataDir);
      expect(stored.folders).toEqual(["Dev", "Prod"]);
      const topLevel = stored.datasources.filter((datasource) => datasource.folder === null);
      expect(topLevel.map((datasource) => datasource.name)).toEqual(["zeta", "alpha"]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenTwoDatasources_whenOneIsDraggedAboveTheOther_thenTheOrderSurvivesARestart",
    async () => {
      const { page, userDataDir } = await launch([sqlite("first"), sqlite("second")]);
      await treeNode(page, "second").waitFor();

      await dragTo(page, treeNode(page, "second"), treeNode(page, "first"), 0.2);

      await expect.poll(() => treeOrder(page)).toEqual(["1 second", "1 first"]);
      const again = await relaunch(userDataDir);
      await treeNode(again.page, "first").waitFor();
      expect(await treeOrder(again.page)).toEqual(["1 second", "1 first"]);
      await captureWindow(again.page, "02-reorder");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenThreeDatasourcesModSelected_whenDraggedOntoAFolder_thenAllLandInsideIt",
    async () => {
      const { page } = await launch([sqlite("inside", "Archive"), sqlite("one"), sqlite("two"), sqlite("three")]);
      await treeNode(page, "three").waitFor();
      await treeNode(page, "Archive").locator("button").first().click();
      await expect.poll(() => treeOrder(page)).toEqual(["1 Archive/", "1 one", "1 three", "1 two"]);

      await treeNode(page, "one").click();
      await treeNode(page, "two").click({ modifiers: ["ControlOrMeta"] });
      await treeNode(page, "three").click({ modifiers: ["ControlOrMeta"] });
      await expect.poll(() => toolWindow(page, "Database").locator('[aria-selected="true"]').count()).toBe(3);
      await dragOver(page, treeNode(page, "two"), treeNode(page, "Archive"), 0.5);
      await expect.poll(() => treeNode(page, "Archive").getAttribute("data-drop")).toBe("into");
      await page.waitForTimeout(SPRING_WAIT_MS);
      await expect.poll(() => treeNode(page, "Archive").getAttribute("aria-expanded")).toBe("true");
      const target = await center(treeNode(page, "Archive"));
      await page.mouse.move(target.x + 1, target.y);
      await page.mouse.up();

      await expect.poll(() => treeOrder(page)).toEqual(["1 Archive/", "2 inside", "2 one", "2 three", "2 two"]);
      await captureWindow(page, "03-multi-into-folder");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenFolder_whenDraggedIntoAnotherFolder_thenItNestsAndStaysExpanded",
    async () => {
      const { page, userDataDir } = await launch([
        sqlite("main", "Docker"),
        sqlite("eu", "Prod/EU"),
        sqlite("us", "Prod"),
      ]);
      await treeNode(page, "us").waitFor();

      await dragTo(page, treeNode(page, "Prod"), treeNode(page, "Docker"), 0.5);

      await expect.poll(() => treeOrder(page)).toEqual(["1 Docker/", "2 Prod/", "3 EU/", "4 eu", "3 us", "2 main"]);
      expect(storedFile(userDataDir).folders).toEqual(["Docker", "Docker/Prod", "Docker/Prod/EU"]);
      expect(storedFile(userDataDir).datasources.find((datasource) => datasource.name === "eu")?.folder).toBe(
        "Docker/Prod/EU",
      );
      await captureWindow(page, "04-folder-nest");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSiblingFolderWithTheSameName_whenMovedThere_thenTheDropIsRefusedAndTheNoticeNamesTheClash",
    async () => {
      const { page } = await launch([sqlite("prod-eu", "Prod/EU"), sqlite("staging-eu", "Staging/EU")]);
      await treeNode(page, "staging-eu").waitFor();
      const eu = toolWindow(page, "Database").locator('[data-kind="folder"][aria-label="EU, folder"]');

      await dragOver(page, eu.nth(1), treeNode(page, "Prod"), 0.5);
      expect(await treeNode(page, "Prod").getAttribute("data-drop")).toBeNull();
      await page.mouse.up();

      await eu.nth(1).click({ button: "right" });
      await menuItem(page, "Move to Folder").click();
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type("Prod");
      await page.keyboard.press("Enter");

      await expect.poll(() => page.getByText('Folder "Prod" already has a folder named "EU".').isVisible()).toBe(true);
      await settled(page);
      await captureWindow(page, "05-clash");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenDatasourceDraggedBetweenFolders_whenHovering_thenTheLineIsDrawnAboveTheFirstDatasource",
    async () => {
      const { page } = await launch([sqlite("a", "Alpha"), sqlite("b", "Beta"), sqlite("one"), sqlite("two")]);
      await treeNode(page, "two").waitFor();
      await treeNode(page, "Alpha").locator("button").first().click();
      await treeNode(page, "Beta").locator("button").first().click();

      await dragOver(page, treeNode(page, "two"), treeNode(page, "Beta"), 0.1);

      const line = page.getByTestId("drop-line");
      await expect.poll(() => line.isVisible()).toBe(true);
      const lineBox = await line.boundingBox();
      const betaBox = await treeNode(page, "Beta").boundingBox();
      expect(Math.abs((lineBox?.y ?? 0) + 1 - ((betaBox?.y ?? 0) + (betaBox?.height ?? 0)))).toBeLessThanOrEqual(2);
      await captureWindow(page, "06-drop-line");
      await page.mouse.up();
      await expect.poll(() => treeOrder(page)).toEqual(["1 Alpha/", "1 Beta/", "1 two", "1 one"]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenEmptyFolder_whenTheAppRestarts_thenItIsStillThere",
    async () => {
      const { page, userDataDir } = await launch([sqlite("only")]);
      await treeNode(page, "only").click();

      await findAction(page, "New Folder");
      await page.getByRole("dialog", { name: "New Folder" }).getByRole("textbox").fill("Archive");
      await page.keyboard.press("Enter");
      await expect.poll(() => treeOrder(page)).toEqual(["1 Archive/", "1 only"]);

      const again = await relaunch(userDataDir);
      await treeNode(again.page, "only").waitFor();
      expect(await treeOrder(again.page)).toEqual(["1 Archive/", "1 only"]);
      expect(storedFile(userDataDir).folders).toEqual(["Archive"]);
      await captureWindow(again.page, "07-empty-folder");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenTwoSelected_whenDeleteConfirmed_thenBothAreGone",
    async () => {
      const { page, userDataDir } = await launch([sqlite("a", "Old"), sqlite("b", "Old"), sqlite("keep")]);
      await treeNode(page, "keep").waitFor();

      await treeNode(page, "Old").click();
      await treeNode(page, "b").click({ modifiers: ["Shift"] });
      await treeNode(page, "b").click({ button: "right" });
      await menuItem(page, "Delete").click();
      const confirm = page.getByRole("dialog", { name: "Delete Data Source" });
      await expect.poll(() => confirm.getByText("Delete 2 data sources and 1 folder?").isVisible()).toBe(true);
      await settled(page);
      await captureWindow(page, "08-delete-many");
      await confirm.getByRole("button", { name: "Delete", exact: true }).click();

      await expect.poll(() => treeOrder(page)).toEqual(["1 keep"]);
      const stored = storedFile(userDataDir);
      expect(stored.folders).toEqual([]);
      expect(stored.datasources.map((datasource) => datasource.name)).toEqual(["keep"]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenEphemeralDatasource_whenDraggingAboveIt_thenItStaysFirstAndCannotBeDragged",
    async () => {
      const { page } = await launch([sqlite("saved"), sqlite("other")], newProfile(), SCRATCH);
      await treeNode(page, "saved").waitFor();
      const ephemeral = toolWindow(page, "Database").locator('[data-kind="datasource"]').first();
      expect(await ephemeral.getAttribute("draggable")).toBe("false");

      await dragOver(page, treeNode(page, "saved"), ephemeral, 0.1);
      await expect.poll(() => page.getByTestId("drop-line").isVisible()).toBe(true);
      await captureWindow(page, "09-ephemeral");
      await page.mouse.up();

      await expect.poll(async () => (await treeOrder(page)).slice(1)).toEqual(["1 saved", "1 other"]);
      expect((await treeOrder(page))[0]).not.toBe("1 saved");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenDatasource_whenAltShiftArrowUp_thenItMovesAboveItsSibling",
    async () => {
      const { page, userDataDir } = await launch([sqlite("a", "Folder"), sqlite("b", "Folder"), sqlite("c", "Folder")]);
      await treeNode(page, "c").click();

      await page.keyboard.press("Alt+Shift+ArrowUp");
      await expect.poll(() => treeOrder(page)).toEqual(["1 Folder/", "2 a", "2 c", "2 b"]);
      await page.keyboard.press("Alt+Shift+ArrowUp");
      await expect.poll(() => treeOrder(page)).toEqual(["1 Folder/", "2 c", "2 a", "2 b"]);
      expect(await treeNode(page, "c").getAttribute("aria-selected")).toBe("true");
      const label = await treeNode(page, "c").getAttribute("aria-label");
      await expect.poll(() => page.evaluate(FOCUSED_LABEL)).toBe(label);
      expect(storedFile(userDataDir).datasources.map((datasource) => datasource.name)).toEqual(["c", "a", "b"]);
      await captureWindow(page, "10-move-up");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenLongTree_whenDraggedToTheBottomEdge_thenItScrolls",
    async () => {
      const names = Array.from({ length: LONG_TREE }, (_, index) => `source-${String(index + 1).padStart(2, "0")}`);
      const { page } = await launch(names.map((name) => sqlite(name)));
      await treeNode(page, names[0] ?? "").waitFor();
      const scroller = page.getByTestId("database-tree-scroll").locator("..");
      expect(await scroller.evaluate((element: Scrollable) => element.scrollTop)).toBe(0);

      const from = await center(treeNode(page, names[0] ?? ""));
      const box = await scroller.boundingBox();
      if (box === null) throw new Error("The tree is not on screen.");
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      const edge = box.y + box.height - 4;
      for (let step = 0; step < EDGE_DRAGOVERS; step += 1) await page.mouse.move(from.x, edge - (step % 2));

      await expect.poll(() => scroller.evaluate((element: Scrollable) => element.scrollTop)).toBeGreaterThan(0);
      await captureWindow(page, "11-autoscroll");
      await page.keyboard.press("Escape");
      await page.mouse.up();
    },
    SCENARIO_TIMEOUT_MS,
  );
});
