/**
 * Plan 034's live test: scrollbars take the theme. Gated, because it needs a display and a fresh
 * build:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/034 bun run test:smoke:headless test/e2e/scrollbars.smoke.test.ts
 */
import type { Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { BUNDLED_THEMES, type BundledThemeId } from "@table-craft/desktop/appearance/themes.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  chooseTheme,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  EVIDENCE_WINDOW,
  evidenceFor,
  launchApp,
  pressChord,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  SMOKE_ENABLED,
  setWindowSize,
  themePickerTrigger,
  waitUntilReady,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("034");

const ROWS = 300;
/** Leading comment lines so the editor scrolls too, not only the grid. */
const EDITOR_PADDING_LINES = 60;
const QUERY = [
  ...Array.from({ length: EDITOR_PADDING_LINES }, (_, line) => `-- line ${String(line + 1)}`),
  `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${String(ROWS)})`,
  "SELECT i, 'row ' || i AS label FROM n",
].join("\n");
const THEMES: readonly BundledThemeId[] = ["dracula-dark", "solarized-light", "kanagawa-dark", "highContrast"];

/** The few DOM members the evaluation touches; the e2e program is compiled without the DOM lib. */
interface Element {
  readonly ownerDocument: {
    readonly defaultView: { getComputedStyle(element: Element): { readonly scrollbarColor: string } };
  };
}

function scrollbarColor(locator: Locator): Promise<string> {
  return locator
    .first()
    .evaluate((element: Element) => element.ownerDocument.defaultView.getComputedStyle(element).scrollbarColor);
}

function scrollers(page: Page): { root: Locator; grid: Locator; editor: Locator } {
  return {
    root: page.locator("html"),
    grid: page.getByRole("grid"),
    editor: page.locator('[data-testid="sql-editor"] .cm-scroller'),
  };
}

async function setTheme(page: Page, name: string): Promise<void> {
  await pressChord(page, ",");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.waitFor();
  await settings.getByRole("tab", { name: "Appearance", exact: true }).click();
  await themePickerTrigger(page).waitFor();
  await chooseTheme(page, name);
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(() => settings.count()).toBe(0);
}

describe.runIf(SMOKE_ENABLED)("themed scrollbars live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  it(
    "givenScrollingEditorAndGrid_whenThemesChosen_thenEveryScrollbarTakesTheThemeColour",
    async () => {
      running = await launchApp({ id: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } });
      const { page } = running;
      await setWindowSize(running.app, EVIDENCE_WINDOW);
      await waitUntilReady(page);
      await runStatement(page, QUERY);

      const seen = new Set<string>();
      for (const id of THEMES) {
        await setTheme(page, BUNDLED_THEMES[id].name);
        const { root, grid, editor } = scrollers(page);
        const colour = await scrollbarColor(root);
        expect(colour).not.toBe("auto");
        expect(await scrollbarColor(grid)).toBe(colour);
        expect(await scrollbarColor(editor)).toBe(colour);
        seen.add(colour);
        await captureWindow(page, id);
      }
      expect(seen.size).toBe(THEMES.length);
    },
    SCENARIO_TIMEOUT_MS * 2,
  );
});
