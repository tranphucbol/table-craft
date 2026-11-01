/**
 * Plan 139's live test: the console's DataGrip-style find and replace bar on an in-memory SQLite
 * console. Gated, because it needs a display and a fresh build:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/139 bun run test:smoke:headless test/e2e/editorFind.smoke.test.ts
 */
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeApp,
  CLOSE_HOOK_TIMEOUT_MS,
  editorTabs,
  EVIDENCE_WINDOW,
  evidenceFor,
  launchApp,
  newProfile,
  pressChord,
  SCENARIO_TIMEOUT_MS,
  SCRATCH,
  seedSettings,
  setWindowSize,
  SMOKE_ENABLED,
  sqlEditor,
  waitUntilReady,
  type RunningApp,
} from "./harness.js";

const capture = evidenceFor("139");

const SCRIPT = [
  "SELECT o.id, o.customer_id, c.name FROM orders o",
  "JOIN customer c ON c.id = o.customer_id",
  "WHERE o.status = 'open' AND c.region = 'EU';",
  "SELECT * FROM orders WHERE customer_id IN (1, 2, 3);",
].join("\n");
const CASES = "Customer customer CUSTOMER";
const LARGE_LINES = 20_000;

type Theme = "dark" | "light";

function findBar(page: Page) {
  return page.getByRole("search", { name: "Find in console" });
}

function findInput(page: Page) {
  return page.getByTestId("editor-find-input");
}

function replaceInput(page: Page) {
  return page.getByTestId("editor-replace-input");
}

function findStatus(page: Page) {
  return page.getByTestId("editor-find-status");
}

function barButton(page: Page, name: string) {
  return findBar(page).getByRole("button", { name, exact: true });
}

/** The few DOM members `focused` reads; the e2e program is compiled without the DOM lib. */
interface FocusableElement {
  readonly ownerDocument: { readonly activeElement: unknown };
}

async function focused(locator: ReturnType<typeof findInput>): Promise<boolean> {
  return locator.evaluate((element: FocusableElement) => element === element.ownerDocument.activeElement);
}

async function editorText(page: Page): Promise<string> {
  return sqlEditor(page).innerText();
}

/** The console's selections, read from the editor's DOM. */
async function selectionCount(page: Page): Promise<number> {
  return page.locator(".cm-selectionBackground").count();
}

async function statusIs(page: Page, text: string): Promise<void> {
  await expect.poll(() => findStatus(page).innerText()).toBe(text);
}

describe.runIf(SMOKE_ENABLED)("console find and replace", () => {
  let running: RunningApp | null = null;
  afterEach(async () => {
    await closeApp(running?.app);
    running = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(text: string, theme: Theme = "dark"): Promise<Page> {
    const userDataDir = newProfile();
    seedSettings(userDataDir, { version: 1, appearance: { theme, motion: "off" } });
    running = await launchApp(SCRATCH, { userDataDir });
    const { app, page } = running;
    await setWindowSize(app, EVIDENCE_WINDOW);
    await waitUntilReady(page);
    await sqlEditor(page).fill(text);
    return page;
  }

  async function caretTo(page: Page, at: "start" | "end"): Promise<void> {
    await sqlEditor(page).focus();
    await pressChord(page, at === "start" ? "Home" : "End");
  }

  it(
    "givenConsole_whenModF_thenBarOnTopWithFocusedField",
    async () => {
      const page = await launch(SCRIPT);
      await caretTo(page, "start");

      await pressChord(page, "F");

      await findBar(page).waitFor();
      expect(await focused(findInput(page))).toBe(true);
      const bar = await findBar(page).boundingBox();
      const content = await page.locator(".cm-content").boundingBox();
      expect(bar !== null && content !== null && bar.y < content.y).toBe(true);
      expect(await replaceInput(page).count()).toBe(0);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenQuery_whenTyped_thenCounterShowsMatches",
    async () => {
      for (const theme of ["dark", "light"] as const) {
        const page = await launch(SCRIPT, theme);
        await caretTo(page, "start");
        await pressChord(page, "F");

        await findInput(page).pressSequentially("customer_id");

        await statusIs(page, "1/3");
        await page.keyboard.press("Enter");
        await statusIs(page, "2/3");
        await page.keyboard.press("Shift+Enter");
        await statusIs(page, "1/3");
        await barButton(page, "Match Case").click();
        await findInput(page).fill("CUSTOMER_ID");
        await statusIs(page, "0/0");
        await page.keyboard.press("Alt+KeyC");
        await statusIs(page, "1/3");
        expect(await barButton(page, "Match Case").getAttribute("aria-pressed")).toBe("false");
        await capture(page, theme === "dark" ? "01-find-bar" : "01-find-bar-light");
        await closeApp(running?.app);
        running = null;
      }
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it(
    "givenNoMatch_whenTyped_thenFieldRedAndZeroResults",
    async () => {
      const page = await launch(SCRIPT);
      await caretTo(page, "start");
      await pressChord(page, "F");

      await findInput(page).pressSequentially("invoice");

      await statusIs(page, "0/0");
      expect(await findStatus(page).getAttribute("class")).toContain("text-danger");
      expect(await focused(findInput(page))).toBe(true);
      expect(await findInput(page).locator("..").getAttribute("class")).toContain("border-danger");
      expect(await page.locator(".cm-editor.tc-find-open").count()).toBe(1);
      await capture(page, "02-no-results");
      await barButton(page, "Regex").click();
      await findInput(page).fill("customer(");
      await statusIs(page, "Bad pattern");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenFindOpen_whenModR_thenReplaceRowAppears",
    async () => {
      for (const theme of ["dark", "light"] as const) {
        const page = await launch(SCRIPT, theme);
        await caretTo(page, "start");
        await pressChord(page, "F");
        await findInput(page).pressSequentially("orders");

        await pressChord(page, "R");

        await replaceInput(page).waitFor();
        expect(await focused(findInput(page))).toBe(true);
        expect(await findInput(page).inputValue()).toBe("orders");
        await replaceInput(page).fill("purchases");
        await statusIs(page, "1/2");
        await capture(page, theme === "dark" ? "03-replace-row" : "03-replace-row-light");
        await page.keyboard.press("Enter");
        await expect.poll(() => editorText(page)).toContain("FROM purchases o");
        await pressChord(page, "F");
        await expect.poll(() => replaceInput(page).count()).toBe(0);
        await closeApp(running?.app);
        running = null;
      }
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it(
    "givenReplaceAll_whenUndone_thenOneUndoRestores",
    async () => {
      const page = await launch(SCRIPT);
      await caretTo(page, "start");
      await pressChord(page, "R");
      await findInput(page).pressSequentially("customer_id");
      await replaceInput(page).fill("client_id");

      await pressChord(page, "Alt+Enter");

      await expect.poll(() => editorText(page)).not.toContain("customer_id");
      await page.keyboard.press("Escape");
      await expect.poll(() => findBar(page).count()).toBe(0);
      await pressChord(page, "Z");
      await expect.poll(() => editorText(page)).toBe(SCRIPT);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenPreserveCase_whenReplaceAll_thenCasesKept",
    async () => {
      const page = await launch(CASES);
      await caretTo(page, "start");
      await pressChord(page, "R");
      await findInput(page).pressSequentially("customer");
      await replaceInput(page).fill("client");

      await barButton(page, "Preserve Case").click();
      await statusIs(page, "1/3");
      await capture(page, "05-preserve-case");
      await barButton(page, "Replace All").click();

      await expect.poll(() => editorText(page)).toBe("Client client CLIENT");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMultiLineSelection_whenModR_thenReplaceAllStaysInSelection",
    async () => {
      const page = await launch(SCRIPT);
      await caretTo(page, "start");
      await page.keyboard.press("Shift+ArrowDown");
      await page.keyboard.press("Shift+ArrowDown");
      await page.keyboard.press("Shift+End");

      await pressChord(page, "R");

      expect(await barButton(page, "In Selection").getAttribute("aria-pressed")).toBe("true");
      await findInput(page).pressSequentially("customer_id");
      await statusIs(page, "1/2");
      await replaceInput(page).fill("client_id");
      expect(await page.locator(".tc-find-scope").count()).toBeGreaterThan(0);
      expect(await page.locator(".tc-find-scope .cm-searchMatch").count()).toBe(2);
      await capture(page, "04-in-selection");
      await barButton(page, "Replace All").click();
      await expect
        .poll(() => editorText(page))
        .toContain(
          "JOIN customer c ON c.id = o.client_id\nWHERE o.status = 'open' AND c.region = 'EU';\nSELECT * FROM orders WHERE customer_id IN",
        );
      expect(await editorText(page)).toContain("SELECT o.id, o.client_id");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenExcludedMatch_whenReplaceAll_thenExcludedKept",
    async () => {
      const page = await launch(SCRIPT);
      await caretTo(page, "start");
      await pressChord(page, "R");
      await findInput(page).pressSequentially("customer_id");
      await replaceInput(page).fill("client_id");

      await barButton(page, "Exclude").click();
      await expect.poll(() => page.locator(".tc-find-excluded").count()).toBe(1);
      await expect.poll(() => findStatus(page).innerText()).not.toBe("");
      await capture(page, "06-exclude");
      await barButton(page, "Replace All").click();

      await expect.poll(() => editorText(page)).toContain("SELECT o.id, o.customer_id");
      expect(await editorText(page)).toContain("o.client_id\nWHERE");
      expect(await editorText(page)).toContain("WHERE client_id IN");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSelectAllOccurrences_whenRun_thenOneCursorPerMatch",
    async () => {
      const page = await launch(SCRIPT);
      await caretTo(page, "start");
      await pressChord(page, "F");
      await findInput(page).pressSequentially("orders");

      await pressChord(page, "Alt+Shift+J");

      await expect.poll(() => findBar(page).count()).toBe(0);
      await expect.poll(() => selectionCount(page)).toBe(2);
      await page.keyboard.type("sales");
      await expect.poll(() => editorText(page)).not.toContain("orders");
      await capture(page, "07-select-all");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenBarOpen_whenTabSwitchedAndBack_thenQueryAndBarRestored",
    async () => {
      const page = await launch(SCRIPT);
      await caretTo(page, "start");
      await pressChord(page, "R");
      await findInput(page).pressSequentially("customer_id");
      await replaceInput(page).fill("client_id");

      await pressChord(page, "Shift+L");
      await expect.poll(() => editorTabs(page).count()).toBe(2);
      await expect.poll(() => findBar(page).count()).toBe(0);
      await editorTabs(page).first().click();

      await findBar(page).waitFor();
      expect(await findInput(page).inputValue()).toBe("customer_id");
      expect(await replaceInput(page).inputValue()).toBe("client_id");
      await capture(page, "08-tab-switch");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenBarOpen_whenEscape_thenClosedAndEditorFocused",
    async () => {
      const page = await launch(SCRIPT);
      await caretTo(page, "start");
      await pressChord(page, "F");
      await findInput(page).pressSequentially("orders");
      await page.keyboard.press("Enter");

      await page.keyboard.press("Escape");

      await expect.poll(() => findBar(page).count()).toBe(0);
      expect(await focused(page.locator(".cm-content"))).toBe(true);
      await page.keyboard.press("F3");
      await page.keyboard.press("Shift+F3");
      await pressChord(page, "F");
      await findBar(page).waitFor();
      await findInput(page).fill("");
      await page.keyboard.press("Alt+ArrowDown");
      await page.getByTestId("editor-find-history").getByRole("option", { name: "orders" }).waitFor();
      await capture(page, "09-history");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenLargeConsole_whenEveryCharacterMatched_thenCounterCaps",
    async () => {
      const big = Array.from({ length: LARGE_LINES }, (_, index) => `SELECT ${String(index)};`).join("\n");
      const page = await launch("");
      await running?.app.evaluate(({ clipboard }, text) => clipboard.writeText(text), big);
      await sqlEditor(page).focus();
      await pressChord(page, "V");
      await caretTo(page, "start");
      await pressChord(page, "F");

      await findInput(page).pressSequentially("e");

      await statusIs(page, "1/10,000+");
      await capture(page, "10-large-doc");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
