/**
 * Plan 147's live test: with Islands, a stripe button sits one island gap from the window edge, one
 * gap from the island beside it, and level with that island's top and bottom; Classic keeps its
 * 36 px stripe with the buttons centred. SQLite in memory, so it needs only a display and a fresh build:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/147 bun run test:smoke:headless test/e2e/stripeGutters.smoke.test.ts
 */
import type { Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeApp,
  EVIDENCE_WINDOW,
  evidenceFor,
  launchApp,
  newProfile,
  seedSettings,
  showServices,
  SMOKE_ENABLED,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  toolWindow,
  waitUntilReady,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("147");

const ISLAND = "xpath=ancestor::div[contains(@class, 'rounded-island')][1]";
/** Sub-pixel layout of fractional panel sizes. */
const TOLERANCE_PX = 1;
const CLASSIC_STRIPE_PX = 36;
const CLASSIC_STRIPE_PADDING_PX = 4;

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** The one DOM member the evaluation touches; the e2e program is compiled without the DOM lib. */
interface Measured {
  getBoundingClientRect(): Box;
}

async function boxOf(locator: Locator): Promise<Box> {
  return locator.evaluate((element: Measured) => {
    const { left, right, top, bottom } = element.getBoundingClientRect();
    return { left, right, top, bottom };
  });
}

async function windowWidth(page: Page): Promise<number> {
  return page.evaluate(() => (globalThis as unknown as { readonly innerWidth: number }).innerWidth);
}

function stripeButtons(page: Page, side: "Left" | "Right"): Locator {
  return page.getByRole("navigation", { name: `${side} tool window stripe` }).getByRole("button");
}

function expectNear(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(TOLERANCE_PX);
}

describe.runIf(SMOKE_ENABLED)("stripe gutters live test", () => {
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
    await showServices(running.page);
    return running.page;
  }

  for (const { density, gap, evidence } of [
    { density: "comfortable", gap: 5, evidence: "01-islands-comfortable" },
    { density: "compact", gap: 4, evidence: "02-islands-compact" },
  ] as const) {
    it(
      `givenIslands_${density}_whenWindowOpens_thenStripeButtonsSitOneGapFromTheEdgeAndTheIslands`,
      async () => {
        const page = await launch({ theme: "dark", density, windowStyle: "islands" });
        const database = await boxOf(toolWindow(page, "Database").locator(ISLAND));
        const services = await boxOf(toolWindow(page, "Services").locator(ISLAND));
        const editor = await boxOf(page.getByRole("tablist", { name: "Editor tabs" }).locator(ISLAND));
        const leftFirst = await boxOf(stripeButtons(page, "Left").first());
        const leftLast = await boxOf(stripeButtons(page, "Left").last());
        const rightFirst = await boxOf(stripeButtons(page, "Right").first());

        expectNear(leftFirst.left, gap);
        expectNear(database.left - leftFirst.right, gap);
        expectNear(leftFirst.top, database.top);
        expectNear(leftLast.bottom, services.bottom);
        expectNear((await windowWidth(page)) - rightFirst.right, gap);
        expectNear(rightFirst.left - editor.right, gap);
        expectNear(rightFirst.top, editor.top);
        await captureWindow(page, evidence);
      },
      SCENARIO_TIMEOUT_MS,
    );
  }

  it(
    "givenClassic_whenWindowOpens_thenStripeKeepsItsWidthWithTheButtonsCentred",
    async () => {
      const page = await launch({ theme: "dark", windowStyle: "classic" });
      const stripe = await boxOf(page.getByRole("navigation", { name: "Left tool window stripe" }));
      const button = await boxOf(stripeButtons(page, "Left").first());

      expectNear(stripe.right - stripe.left, CLASSIC_STRIPE_PX);
      expectNear(button.left - stripe.left, stripe.right - button.right);
      expectNear(button.top - stripe.top, CLASSIC_STRIPE_PADDING_PX);
      await captureWindow(page, "03-classic");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
