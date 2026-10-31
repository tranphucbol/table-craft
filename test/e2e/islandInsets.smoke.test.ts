/**
 * Plan 134's live test: inside an island, the tool window headers stand as tall as the editor tabs and
 * the panes' content keeps the island's radius from its edge, the toolbar's first icon under the title;
 * Classic keeps its rows and insets. SQLite in memory, so it needs only a display and a fresh build:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/134 bun run test:smoke:headless test/e2e/islandInsets.smoke.test.ts
 */
import type { Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeApp,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  runAllButton,
  SCENARIO_TIMEOUT_MS,
  seedSettings,
  showServices,
  SMOKE_ENABLED,
  setWindowSize,
  sqlEditor,
  toolWindow,
  waitUntilReady,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("134");

const SAMPLE_QUERY = "SELECT 1 AS id, 'islands' AS style";
const ISLAND = "xpath=ancestor::div[contains(@class, 'rounded-island')][1]";
const TOOL_WINDOWS = ["Database", "Services"] as const;
/** Sub-pixel text and icon placement. */
const TOLERANCE_PX = 1;

interface Box {
  readonly left: number;
  readonly right: number;
  readonly height: number;
}

/** The few DOM members the evaluations touch; the e2e program is compiled without the DOM lib. */
interface Measured {
  readonly clientLeft: number;
  readonly clientWidth: number;
  getBoundingClientRect(): { readonly left: number; readonly right: number; readonly height: number };
  readonly ownerDocument: {
    readonly defaultView: {
      getComputedStyle(element: Measured): { readonly paddingLeft: string; readonly paddingRight: string };
    };
  };
}

/** The element's border box, or, with `inner`, the box inside its border. */
async function boxOf(locator: Locator, inner = false): Promise<Box> {
  return locator.evaluate((element: Measured, inside) => {
    const rect = element.getBoundingClientRect();
    if (!inside) return { left: rect.left, right: rect.right, height: rect.height };
    const left = rect.left + element.clientLeft;
    return { left, right: left + element.clientWidth, height: rect.height };
  }, inner);
}

async function paddingOf(locator: Locator, side: "paddingLeft" | "paddingRight"): Promise<string> {
  return locator.evaluate(
    (element: Measured, name) => element.ownerDocument.defaultView.getComputedStyle(element)[name],
    side,
  );
}

function header(page: Page, title: string): Locator {
  return toolWindow(page, title).locator("header");
}

function editorTabs(page: Page): Locator {
  return page.getByRole("tablist", { name: "Editor tabs" });
}

interface Insets {
  readonly headerHeight: number;
  readonly titleInset: number;
  readonly toolbarIconOffset: number;
  readonly treeRowPadding: string;
  readonly tabRowPadding: string;
  readonly cornerPadding: string;
}

/** What the scenarios compare, measured off the Database tool window and the editor island. */
async function insetsOf(page: Page): Promise<Insets> {
  const database = toolWindow(page, "Database");
  const title = await boxOf(header(page, "Database").getByRole("heading"));
  const icon = await boxOf(
    database.getByRole("toolbar", { name: "Database toolbar" }).getByRole("button").first().locator("svg"),
  );
  const island = await boxOf(database.locator(ISLAND), true);
  return {
    headerHeight: (await boxOf(header(page, "Database"))).height,
    titleInset: title.left - island.left,
    toolbarIconOffset: icon.left - title.left,
    treeRowPadding: await paddingOf(database.getByRole("treeitem").first(), "paddingLeft"),
    tabRowPadding: await paddingOf(editorTabs(page), "paddingLeft"),
    cornerPadding: await paddingOf(page.getByTestId("tab-strip-corner"), "paddingRight"),
  };
}

describe.runIf(SMOKE_ENABLED)("island insets live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  });

  async function launch(appearance: object): Promise<Page> {
    const userDataDir = newProfile();
    seedSettings(userDataDir, { version: 1, appearance });
    running = await launchApp(undefined, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    const { page } = running;
    await sqlEditor(page).fill(SAMPLE_QUERY);
    await sqlEditor(page).press("Escape");
    await runAllButton(page).click();
    await waitUntilReady(page);
    await page.getByRole("columnheader").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await showServices(page);
    return page;
  }

  for (const { density, radius, evidence } of [
    { density: "comfortable", radius: 10, evidence: "01-islands-comfortable" },
    { density: "compact", radius: 8, evidence: "02-islands-compact" },
  ] as const) {
    it(
      `givenIslands_${density}_whenWindowOpens_thenHeadersMatchTheTabsAndContentKeepsTheRadius`,
      async () => {
        const page = await launch({ theme: "dark", density, windowStyle: "islands" });
        const tab = await boxOf(editorTabs(page).getByRole("tab").first().locator("xpath=.."));

        for (const title of TOOL_WINDOWS) {
          expect((await boxOf(header(page, title))).height).toBe(tab.height);
          const island = await boxOf(toolWindow(page, title).locator(ISLAND), true);
          const heading = await boxOf(header(page, title).getByRole("heading"));
          expect(Math.abs(heading.left - island.left - radius)).toBeLessThanOrEqual(TOLERANCE_PX);
        }
        const insets = await insetsOf(page);
        expect(Math.abs(insets.toolbarIconOffset)).toBeLessThanOrEqual(TOLERANCE_PX);
        expect(insets.treeRowPadding).toBe(`${String(radius)}px`);
        expect(insets.tabRowPadding).toBe(`${String(radius - (density === "compact" ? 6 : 8))}px`);
        expect(insets.cornerPadding).toBe(`${String(radius - 4)}px`);
        await captureWindow(page, evidence);
      },
      SCENARIO_TIMEOUT_MS,
    );
  }

  it(
    "givenIslandsLight_whenWindowOpens_thenTheSameInsetsHold",
    async () => {
      const page = await launch({ theme: "light", windowStyle: "islands" });

      expect(await insetsOf(page)).toMatchObject({ headerHeight: 32, treeRowPadding: "10px" });
      await captureWindow(page, "03-islands-light");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenClassic_whenWindowOpens_thenRowsAndInsetsStayAsBefore",
    async () => {
      const page = await launch({ theme: "dark" });
      const database = toolWindow(page, "Database");

      expect((await boxOf(header(page, "Database"))).height).toBe(24);
      const title = await boxOf(header(page, "Database").getByRole("heading"));
      expect(title.left - (await boxOf(database, true)).left).toBe(8);
      expect(await paddingOf(database.getByRole("toolbar", { name: "Database toolbar" }), "paddingLeft")).toBe("4px");
      expect(await paddingOf(database.getByRole("treeitem").first(), "paddingLeft")).toBe("8px");
      expect(await paddingOf(editorTabs(page), "paddingLeft")).toBe("0px");
      expect(await paddingOf(page.getByTestId("tab-strip-corner"), "paddingRight")).toBe("4px");
      await captureWindow(page, "04-classic");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
