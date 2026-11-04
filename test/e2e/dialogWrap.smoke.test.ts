/**
 * A notice whose title and message hold a long unbroken path wraps inside the dialog instead of
 * running past its edge, and a message taller than its box scrolls while the buttons stay in the
 * window. Gated, because it needs a display and a fresh build:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/dialog-wrap bun run test:smoke:headless test/e2e/dialogWrap.smoke.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  pressChord,
  SCENARIO_TIMEOUT_MS,
  SMOKE_ENABLED,
  setWindowSize,
  sqlEditor,
  waitUntilReady,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("dialog-wrap");

/** Far wider than a notice, and a single word, so only an anywhere break can fit it. */
const UNBROKEN_NAME = `${"unbroken_segment_".repeat(8)}missing.sql`;
const OPEN_FAILED = `Could not open ${UNBROKEN_NAME}`;

/**
 * Folders the missing file sits under, so the ENOENT message quotes a path dozens of lines long.
 * Each name stays under the 255-byte name limit and the whole path under Linux's 4096-byte PATH_MAX,
 * so the read fails with ENOENT rather than ENAMETOOLONG.
 */
const DEEP_FOLDERS = Array.from({ length: 30 }, (_, index) =>
  `deep_folder_${String(index).padStart(2, "0")}_`.repeat(6),
);
const SHORT_NAME = "missing.sql";

/** The few DOM members the evaluation touches; the e2e program is compiled without the DOM lib. */
interface MeasuredElement {
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

interface AnimatedElement {
  getAnimations(): readonly { readonly finished: Promise<unknown> }[];
}

/** The capture would otherwise catch the dialog half faded in, with the console showing through. */
async function settled(element: Locator): Promise<void> {
  await element.evaluate((node: AnimatedElement) => Promise.all(node.getAnimations().map((motion) => motion.finished)));
}

function overflowsSideways(element: Locator): Promise<boolean> {
  return element.evaluate((node: MeasuredElement) => node.scrollWidth > node.clientWidth);
}

function overflowsDownward(element: Locator): Promise<boolean> {
  return element.evaluate((node: MeasuredElement) => node.scrollHeight > node.clientHeight);
}

/** The box lies wholly inside the window's viewport. */
async function insideWindow(
  element: Locator,
  viewport: { readonly width: number; readonly height: number },
): Promise<boolean> {
  const box = await element.boundingBox();
  if (box === null) return false;
  return box.y >= 0 && box.x >= 0 && box.y + box.height <= viewport.height && box.x + box.width <= viewport.width;
}

/** The inner box lies wholly inside the outer one's width. */
async function insideWidth(outer: Locator, inner: Locator): Promise<boolean> {
  const [box, part] = await Promise.all([outer.boundingBox(), inner.boundingBox()]);
  if (box === null || part === null) return false;
  return part.x >= box.x && part.x + part.width <= box.x + box.width;
}

async function answerOpenDialog(app: ElectronApplication, paths: readonly string[]): Promise<void> {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [...picked] });
  }, paths);
}

describe.runIf(SMOKE_ENABLED)("notice wrapping live test", () => {
  let running: RunningApp | null = null;
  const scratch: string[] = [];

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
    for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
  }, CLOSE_HOOK_TIMEOUT_MS);

  it(
    "givenAnUnbrokenPathInTheNotice_whenItOpens_thenTitleMessageAndButtonsStayInsideTheDialog",
    async () => {
      running = await launchApp({ id: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } });
      const { app, page } = running;
      await setWindowSize(app, EVIDENCE_WINDOW);
      await waitUntilReady(page);
      const directory = mkdtempSync(join(tmpdir(), "table-craft-dialog-wrap-"));
      scratch.push(directory);

      await answerOpenDialog(app, [join(directory, UNBROKEN_NAME)]);
      await sqlEditor(page).click();
      await pressChord(page, "O");
      const notice = page.getByRole("dialog", { name: OPEN_FAILED });
      await notice.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      const message = notice.locator("p").filter({ hasText: UNBROKEN_NAME });
      await expect(message.textContent()).resolves.toContain(UNBROKEN_NAME);
      await settled(notice);
      await captureWindow(page, "unbroken-path-notice");

      expect(await overflowsSideways(notice)).toBe(false);
      expect(await overflowsSideways(message)).toBe(false);
      expect(await insideWidth(notice, notice.getByRole("heading", { name: OPEN_FAILED }))).toBe(true);
      expect(await insideWidth(notice, message)).toBe(true);
      expect(await insideWidth(notice, notice.getByRole("button", { name: "Show in Log", exact: true }))).toBe(true);
      const ok = notice.getByRole("button", { name: "OK", exact: true });
      expect(await insideWidth(notice, ok)).toBe(true);

      await ok.click();
      await notice.waitFor({ state: "hidden", timeout: LAUNCH_TIMEOUT_MS });
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenAMessageTallerThanItsBox_whenTheNoticeOpens_thenTheMessageScrollsAndTheButtonsStayInTheWindow",
    async () => {
      running = await launchApp({ id: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } });
      const { app, page } = running;
      await setWindowSize(app, EVIDENCE_WINDOW);
      await waitUntilReady(page);
      const directory = mkdtempSync(join(tmpdir(), "table-craft-dialog-tall-"));
      scratch.push(directory);

      await answerOpenDialog(app, [join(directory, ...DEEP_FOLDERS, SHORT_NAME)]);
      await sqlEditor(page).click();
      await pressChord(page, "O");
      const notice = page.getByRole("dialog", { name: `Could not open ${SHORT_NAME}` });
      await notice.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      const message = notice.locator("p > span").filter({ hasText: DEEP_FOLDERS[0] ?? "" });
      await expect(message.textContent()).resolves.toContain(DEEP_FOLDERS.at(-1));
      await settled(notice);
      await captureWindow(page, "tall-message-notice");

      const viewport = await page.evaluate(() => {
        const view = globalThis as unknown as { readonly innerWidth: number; readonly innerHeight: number };
        return { width: view.innerWidth, height: view.innerHeight };
      });
      expect(await overflowsDownward(message)).toBe(true);
      expect(await overflowsSideways(message)).toBe(false);
      expect(await insideWindow(notice, viewport)).toBe(true);
      const ok = notice.getByRole("button", { name: "OK", exact: true });
      expect(await insideWindow(notice.getByRole("button", { name: "Show in Log", exact: true }), viewport)).toBe(true);
      expect(await insideWindow(ok, viewport)).toBe(true);

      await ok.click();
      await notice.waitFor({ state: "hidden", timeout: LAUNCH_TIMEOUT_MS });
    },
    SCENARIO_TIMEOUT_MS,
  );
});
