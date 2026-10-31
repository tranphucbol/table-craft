import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { EDITOR_TOOLTIP_RADIUS_PX } from "@table-craft/desktop/appearance/themes.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  runButton,
  SCENARIO_TIMEOUT_MS,
  seedSettings,
  setWindowSize,
  SMOKE_ENABLED,
  sqlEditor,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";

const SQLITE: Datasource = { id: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } };
const capture = evidenceFor("sql-tooltips");
const COMPLETION = ".cm-tooltip-autocomplete";
const PROBLEM = ".tc-problem-error";
const INSPECTION_TOOLTIP = ".tc-problem-tooltip";
const ERROR = ".tc-error-mark";
const ERROR_TOOLTIP = ".tc-error-tooltip";
const CONTEXT_ACTIONS = ".tc-intentions";
const CTE = "WITH t AS (SELECT id, name FROM customers) SELECT t.";
const UNRESOLVED = "select * from ordrs;";
const FAILED = "select * from missing_tooltip_table;";
const SHORT_WINDOW = { width: EVIDENCE_WINDOW.width, height: 300 } as const;
const SCROLL_CONTEXT_LINES = 20;
const SCROLLED_SQL = `${"-- context\n".repeat(SCROLL_CONTEXT_LINES)}select * from `;

interface Geometry {
  readonly top: number;
  readonly bottom: number;
  readonly anchorBottom: number;
  readonly radii: readonly string[];
}

async function expectRoundedBelow(page: Page, selector: string, anchor: string): Promise<void> {
  await page.locator(selector).waitFor();
  await expect
    .poll(async () => {
      const geometry = await page.evaluate<Geometry>(`(() => {
      const popup = document.querySelector(${JSON.stringify(selector)}).closest('.cm-tooltip');
      const rect = popup.getBoundingClientRect();
      const style = getComputedStyle(popup);
      const range = document.createRange();
      range.selectNodeContents(document.querySelector(${JSON.stringify(anchor)}));
      return {
        top: rect.top, bottom: rect.bottom,
        anchorBottom: range.getBoundingClientRect().bottom,
        radii: [style.borderTopLeftRadius, style.borderTopRightRadius,
          style.borderBottomRightRadius, style.borderBottomLeftRadius]
      };
    })()`);
      return (
        geometry.top >= geometry.anchorBottom &&
        geometry.bottom > geometry.top &&
        geometry.radii.every((radius) => radius === `${String(EDITOR_TOOLTIP_RADIUS_PX)}px`)
      );
    })
    .toBe(true);
}

describe.runIf(SMOKE_ENABLED)("SQL tooltip geometry", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(): Promise<Page> {
    const userDataDir = newProfile();
    seedSettings(userDataDir, { version: 1, appearance: { theme: "dark" } });
    running = await launchApp(SQLITE, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running.page;
  }

  it(
    "givenSqliteCompletion_whenRoomBelow_thenRoundedListBelowSql",
    async () => {
      const page = await launch();
      await sqlEditor(page).fill(CTE);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Control+Space");
      await page.locator(COMPLETION).getByRole("option").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expectRoundedBelow(page, COMPLETION, '[data-testid="sql-editor"] .cm-line');
      await expect
        .poll(() =>
          page.evaluate<string>(`getComputedStyle(document.querySelector('${COMPLETION} > ul')).borderTopLeftRadius`),
        )
        .toBe(`${String(EDITOR_TOOLTIP_RADIUS_PX)}px`);
      await capture(page, "completion-rounded-below");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSqliteCompletion_whenInsufficientRoomBelow_thenFallsBackAbove",
    async () => {
      const page = await launch();
      await setWindowSize((running as RunningApp).app, SHORT_WINDOW);
      await sqlEditor(page).fill(SCROLLED_SQL);
      await page.keyboard.press("Control+End");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Control+Space");
      await page.locator(COMPLETION).getByRole("option").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expect
        .poll(() =>
          page.evaluate<boolean>(`(() => {
        const popup = document.querySelector('${COMPLETION}').getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('[data-testid="sql-editor"] .cm-line:last-child'));
        return popup.bottom <= range.getBoundingClientRect().top && popup.top >= 0;
      })()`),
        )
        .toBe(true);
      await capture(page, "completion-fallback-above");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSqliteInspection_whenHoverAndContextActions_thenRoundedPopupsBelowSql",
    async () => {
      const page = await launch();
      await sqlEditor(page).fill(UNRESOLVED);
      const mark = sqlEditor(page).locator(PROBLEM).first();
      await mark.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await page.keyboard.press("Escape");
      await mark.hover();
      await expectRoundedBelow(page, INSPECTION_TOOLTIP, PROBLEM);
      await capture(page, "inspection-rounded-below");
      await mark.click();
      await page.mouse.move(0, 0);
      await page.keyboard.press("Alt+Enter");
      await expectRoundedBelow(page, CONTEXT_ACTIONS, PROBLEM);
      await capture(page, "context-actions-rounded-below");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSqliteFailure_whenHover_thenRoundedErrorBelowSql",
    async () => {
      const page = await launch();
      await sqlEditor(page).fill(FAILED);
      await runButton(page).click();
      const mark = sqlEditor(page).locator(ERROR).first();
      await mark.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await mark.hover();
      await expectRoundedBelow(page, ERROR_TOOLTIP, ERROR);
      await capture(page, "error-rounded-below");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
