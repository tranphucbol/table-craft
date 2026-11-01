/**
 * Performance benchmark of a user's 100k-id lookup on the 1M-row `perf_test.users`: copy 100k
 * ids (one per line), paste them into a console, Find/Replace regexp `\n` with `,`, wrap them in
 * `SELECT ... IN (...)`, run, fetch all and scroll to the last row, sampling the CPU and memory of
 * every app process. Writes `docs/evidence/perf-in-list/workflow.json` and screenshots. Load
 * `test/perf/seed.sql` first, then:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/perf-in-list bun run test:smoke:db:headless test/e2e/perfPasteWorkflow.smoke.test.ts
 */
import { afterEach, describe, expect, it } from "vitest";
import { IN_PREFIX, IN_SUFFIX, inListQuery, perfIds } from "../perf/fixtures.js";
import {
  closeApp,
  CLOSE_HOOK_TIMEOUT_MS,
  pressChord,
  runButton,
  sqlEditor,
  waitUntilReady,
  type RunningApp,
} from "./harness.js";
import {
  dirSize,
  domAttributeChars,
  editorDoc,
  launchPerfConsole,
  PERF_ENABLED,
  perfReport,
  resultState,
  SCENARIO_MS,
  scrollGridTo,
  STEP_TIMEOUT_MS,
  waitDoc,
  waitResultState,
} from "./perfProbe.js";

const TYPING_DELAY_MS = 60;
const PATTERN_TYPING_DELAY_MS = 180;
const BASELINE_MS = 5_000;
const IDLE_AFTER_MS = 10_000;
const LONG_SETTLE_MS = 3_000;

describe.runIf(PERF_ENABLED)("100k ids paste workflow", () => {
  let running: RunningApp | null = null;
  afterEach(async () => {
    await closeApp(running?.app);
    running = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  it(
    "givenHundredThousandIdsInClipboard_whenUserBuildsAndRunsTheInQuery_thenEveryStepIsMeasured",
    async () => {
      const ids = perfIds();
      const clipboard = `${ids.join("\n")}\n`;
      const expected = inListQuery(ids);
      const launched = await launchPerfConsole();
      running = launched;
      const { app, page } = launched;
      const { report, save, screenshot, step } = perfReport(launched, "workflow", {
        ids: ids.length,
        clipboardChars: clipboard.length,
        finalQueryChars: expected.length,
      });

      await step("0-idleBaseline", async () => page.waitForTimeout(BASELINE_MS), 0);

      await app.evaluate(({ clipboard: board }, text) => board.writeText(text), clipboard);
      await sqlEditor(page).focus();
      await step("1-paste", async () => {
        await pressChord(page, "V");
        await waitDoc(page, (doc) => doc.length === clipboard.length);
        return { doc: await editorDoc(page) };
      });
      await screenshot("01-pasted");

      const panel = page.locator(".cm-search");
      await step("2-openFindAndTypeRegex", async () => {
        await pressChord(page, "F");
        await panel.locator('input[name="search"]').waitFor({ timeout: STEP_TIMEOUT_MS });
        await panel.locator('input[name="search"]').pressSequentially("\\n", { delay: PATTERN_TYPING_DELAY_MS });
        await panel.locator('input[name="re"]').check();
      });
      await screenshot("02-find-regexp");

      await step(
        "3-replaceAll",
        async () => {
          await panel.locator('input[name="replace"]').pressSequentially(",", { delay: TYPING_DELAY_MS });
          const clicked = Date.now();
          await panel.locator('button[name="replaceAll"]').click();
          await waitDoc(page, (doc) => doc.lines === 1);
          return { replaceAllMs: Date.now() - clicked, doc: await editorDoc(page) };
        },
        LONG_SETTLE_MS,
      );
      await screenshot("03-replaced");

      // Close Find, drop the trailing comma, close the list, then type the SELECT before it.
      await step(
        "4-writeQuery",
        async () => {
          await page.keyboard.press("Escape");
          await panel.waitFor({ state: "detached", timeout: STEP_TIMEOUT_MS });
          await pressChord(page, "End");
          await page.keyboard.press("Backspace");
          await page.keyboard.type(IN_SUFFIX, { delay: TYPING_DELAY_MS });
          await pressChord(page, "Home");
          await page.keyboard.type(IN_PREFIX, { delay: TYPING_DELAY_MS });
          await page.keyboard.press("Escape");
          await waitDoc(page, (doc) => doc.length === expected.length);
          const doc = await editorDoc(page);
          expect(doc.head).toBe(expected.slice(0, doc.head.length));
          expect(doc.tail).toBe(expected.slice(-doc.tail.length));
          return { doc };
        },
        LONG_SETTLE_MS,
      );
      await screenshot("04-query");

      await step(
        "5-run",
        async () => {
          const clicked = Date.now();
          await runButton(page).click();
          await page.getByRole("columnheader").first().waitFor({ timeout: STEP_TIMEOUT_MS });
          const firstRowsMs = Date.now() - clicked;
          await waitResultState(page, /rows/);
          await waitUntilReady(page);
          return { firstRowsMs, state: await resultState(page).textContent() };
        },
        LONG_SETTLE_MS,
      );

      await step("6-fetchAll", async () => {
        await page
          .getByRole("toolbar", { name: "Result" })
          .getByRole("button", { name: "Fetch All", exact: true })
          .click();
        await waitResultState(page, /^100,000/);
        return { state: await resultState(page).textContent() };
      });
      await step("7-scrollToLastRow", async () => scrollGridTo(page, ids.length - 1));
      await screenshot("05-result");

      await step("8-idleAfter", async () => page.waitForTimeout(IDLE_AFTER_MS), 0);

      report["domAttrChars"] = await domAttributeChars(page);
      report["profileBytes"] = dirSize(launched.userDataDir);
      save();
    },
    SCENARIO_MS,
  );
});
