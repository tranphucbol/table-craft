/**
 * The editor tab strip scrolls without showing a scrollbar. Gated, because it needs a display and a
 * fresh build:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/tab-strip bun run test:smoke:headless test/e2e/tabStrip.smoke.test.ts
 */
import type { Locator } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  activeEditorTab,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  editorTabs,
  EVIDENCE_WINDOW,
  evidenceFor,
  launchApp,
  openConsoleOn,
  SCENARIO_TIMEOUT_MS,
  SMOKE_ENABLED,
  setWindowSize,
  waitUntilReady,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("tab-strip");

/** Enough consoles to overflow the evidence window's editor width. */
const CONSOLES = 8;
const WHEEL_TURN = 4000;

/** The few DOM members the evaluation touches; the e2e program is compiled without the DOM lib. */
interface StripElement {
  readonly scrollLeft: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly offsetHeight: number;
  readonly clientHeight: number;
  readonly ownerDocument: {
    readonly defaultView: {
      getComputedStyle(element: StripElement): { readonly scrollbarWidth: string; readonly borderBottomWidth: string };
    };
  };
}

interface StripMetrics {
  readonly scrollLeft: number;
  readonly overflows: boolean;
  readonly barHeight: number;
  readonly scrollbarWidth: string;
  readonly borderBottomWidth: string;
}

function metrics(strip: Locator): Promise<StripMetrics> {
  return strip.evaluate((element: StripElement) => {
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    return {
      scrollLeft: element.scrollLeft,
      overflows: element.scrollWidth > element.clientWidth,
      barHeight: element.offsetHeight - element.clientHeight - parseFloat(style.borderBottomWidth),
      scrollbarWidth: style.scrollbarWidth,
      borderBottomWidth: style.borderBottomWidth,
    };
  });
}

/** The tab lies wholly inside the strip's visible width, not clipped by its scroll. */
async function shownWhole(strip: Locator, tab: Locator): Promise<boolean> {
  const [outer, inner] = await Promise.all([strip.boundingBox(), tab.boundingBox()]);
  if (outer === null || inner === null) return false;
  return inner.x >= outer.x && inner.x + inner.width <= outer.x + outer.width;
}

describe.runIf(SMOKE_ENABLED)("editor tab strip live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  it(
    "givenMoreTabsThanFit_whenStripOverflows_thenNoScrollbarAndWheelAndActivationStillScroll",
    async () => {
      running = await launchApp({ id: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } });
      const { page } = running;
      await setWindowSize(running.app, EVIDENCE_WINDOW);
      await waitUntilReady(page);
      for (let opened = 1; opened < CONSOLES; opened += 1) {
        await openConsoleOn(page, "lite");
        await expect.poll(() => editorTabs(page).count()).toBe(opened + 1);
      }
      await waitUntilReady(page);
      const strip = page.getByRole("tablist", { name: "Editor tabs" });
      await captureWindow(page, "overflowing-tabs-last-active");

      const opened = await metrics(strip);
      expect(opened.overflows).toBe(true);
      expect(opened.scrollbarWidth).toBe("none");
      expect(opened.barHeight).toBe(0);
      expect(opened.borderBottomWidth).toBe("1px");
      expect(opened.scrollLeft).toBeGreaterThan(0);
      expect(await shownWhole(strip, activeEditorTab(page))).toBe(true);

      await strip.hover();
      await page.mouse.wheel(0, -WHEEL_TURN);
      await expect.poll(async () => (await metrics(strip)).scrollLeft).toBe(0);
      expect(await shownWhole(strip, editorTabs(page).first())).toBe(true);
      await captureWindow(page, "wheel-scrolled-to-first-tab");

      await editorTabs(page).first().click();
      await page.mouse.wheel(0, WHEEL_TURN);
      await expect.poll(async () => (await metrics(strip)).scrollLeft).toBeGreaterThan(0);
      expect(await shownWhole(strip, editorTabs(page).last())).toBe(true);
      await captureWindow(page, "wheel-scrolled-to-last-tab");
    },
    SCENARIO_TIMEOUT_MS * 2,
  );
});
