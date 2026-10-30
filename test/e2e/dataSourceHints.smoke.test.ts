/**
 * The Data Sources form scrolls under the wheel anywhere over it, gaps between rows included, and
 * its help sits behind (i) buttons. Needs only a display and a fresh build:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/remember-prompted-secrets bun run test:smoke:headless test/e2e/dataSourceHints.smoke.test.ts
 */
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeApp,
  CLOSE_HOOK_TIMEOUT_MS,
  dataSourcesDialog,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  SCENARIO_TIMEOUT_MS,
  SMOKE_ENABLED,
  setWindowSize,
  toolWindow,
  type RunningApp,
} from "./harness.js";

/** Short enough that MySQL's form overflows the dialog. */
const SHORT_WINDOW = { width: EVIDENCE_WINDOW.width, height: 560 } as const;
const WHEEL_PX = 300;
const captureWindow = evidenceFor("remember-prompted-secrets");

interface Scroller {
  readonly scrollTop: number;
}

describe.runIf(SMOKE_ENABLED)("Data Sources form scroll and hints", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function openForm(kind: string, size: { readonly width: number; readonly height: number }): Promise<Page> {
    running = await launchApp(null, { userDataDir: newProfile() });
    await setWindowSize(running.app, size);
    const { page } = running;
    await toolWindow(page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await toolWindow(page, "Database").getByRole("button", { name: "New Data Source…", exact: true }).click();
    await dataSourcesDialog(page)
      .getByRole("list", { name: "Database kinds" })
      .getByRole("button", { name: kind })
      .click();
    return page;
  }

  function openMysqlForm(): Promise<Page> {
    return openForm("MySQL", SHORT_WINDOW);
  }

  it(
    "givenLongForm_whenWheelOverGapBetweenRows_thenFormScrolls",
    async () => {
      const page = await openMysqlForm();
      const dialog = dataSourcesDialog(page);
      const form = dialog.getByTestId("datasource-form");
      const name = await dialog.getByLabel("Name", { exact: true }).boundingBox();
      const folder = await dialog.getByLabel("Folder", { exact: true }).boundingBox();
      if (name === null || folder === null) throw new Error("The Name and Folder fields are not shown.");
      expect(folder.y).toBeGreaterThan(name.y + name.height);

      await page.mouse.move(name.x + name.width / 2, (name.y + name.height + folder.y) / 2);
      await page.mouse.wheel(0, WHEEL_PX);

      await expect.poll(() => form.evaluate((element: Scroller) => element.scrollTop)).toBeGreaterThan(0);
      await captureWindow(page, "05-mysql-form-scrolled-over-row-gap");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenReadOnlyRow_whenInfoHovered_thenHintShowsInTooltip",
    async () => {
      const page = await openMysqlForm();
      const info = dataSourcesDialog(page).getByRole("button", { name: "About Read-only", exact: true });
      await info.scrollIntoViewIfNeeded();

      await info.hover();

      await expect.poll(() => page.getByRole("tooltip").textContent()).toContain("not a security boundary");
      await captureWindow(page, "06-mysql-read-only-hint-tooltip");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenEtcdForm_whenEndpointsInfoHovered_thenHintShowsInTooltip",
    async () => {
      const page = await openForm("etcd", EVIDENCE_WINDOW);
      const dialog = dataSourcesDialog(page);
      const info = dialog.getByRole("button", { name: "About endpoints", exact: true });
      await info.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "07-etcd-form-info-hints");

      await info.hover();

      await expect.poll(() => page.getByRole("tooltip").textContent()).toContain("Test Connection checks");
      await captureWindow(page, "08-etcd-form-endpoints-hint-tooltip");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
