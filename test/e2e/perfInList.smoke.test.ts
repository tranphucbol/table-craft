/**
 * Performance benchmark of a ready 100k-id `IN (...)` SELECT on the 1M-row `perf_test.users`,
 * pasted on one line and on 10 ids a line: typing beside it, run, fetch all, scroll, completion
 * and typing inside it, re-run and Query History, sampling the CPU and memory of every app process.
 * Writes `docs/evidence/perf-in-list/<variant>.json` and a screenshot. Load `test/perf/seed.sql`
 * first, then:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/perf-in-list bun run test:smoke:db:headless test/e2e/perfInList.smoke.test.ts
 */
import { afterEach, describe, it } from "vitest";
import { IN_PREFIX, inListQuery, perfIds } from "../perf/fixtures.js";
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

const IDS_PER_LINE = 10;
const TYPING_DELAY_MS = 40;
const COMPLETION_TIMEOUT_MS = 30_000;
const LONG_SETTLE_MS = 3_000;
const WHERE_OFFSET = IN_PREFIX.indexOf("user_id");
const END_PROBE = "\n-- typing probe at end";

const VARIANTS = {
  oneline: undefined,
  multiline: IDS_PER_LINE,
} as const;

describe.runIf(PERF_ENABLED)("100k IN-list query", () => {
  let running: RunningApp | null = null;
  afterEach(async () => {
    await closeApp(running?.app);
    running = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  for (const [variant, perLine] of Object.entries(VARIANTS)) {
    it(
      `givenHundredThousandIdQuery_${variant}_whenPastedRunAndEdited_thenEveryStepIsMeasured`,
      async () => {
        const ids = perfIds();
        const sql = inListQuery(ids, perLine);
        const launched = await launchPerfConsole();
        running = launched;
        const { app, page } = launched;
        const { report, save, screenshot, step } = perfReport(launched, variant, { chars: sql.length });

        await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), sql);
        await sqlEditor(page).focus();
        await step(
          "1-paste",
          async () => {
            await pressChord(page, "V");
            await waitDoc(page, (doc) => doc.length === sql.length);
          },
          LONG_SETTLE_MS,
        );

        await step("2-typeAtEnd", async () => {
          await pressChord(page, "End");
          await page.keyboard.type(END_PROBE, { delay: TYPING_DELAY_MS });
        });
        await page.keyboard.press("Shift+Home");
        await page.keyboard.press("Backspace");
        await page.keyboard.press("Backspace");
        await waitDoc(page, (doc) => doc.length === sql.length);

        await step(
          "3-run",
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

        await step("4-fetchAll", async () => {
          await page
            .getByRole("toolbar", { name: "Result" })
            .getByRole("button", { name: "Fetch All", exact: true })
            .click();
          await waitResultState(page, /^100,000/);
          return { state: await resultState(page).textContent() };
        });
        await step("5-scrollToLastRow", async () => scrollGridTo(page, ids.length - 1));

        // Completion sends the whole document to the engine on every request.
        await sqlEditor(page).focus();
        await pressChord(page, "Home");
        for (let i = 0; i < WHERE_OFFSET; i += 1) await page.keyboard.press("ArrowRight");
        await step(
          "6-typeInStatement",
          async () => {
            const typed = Date.now();
            await page.keyboard.type("sta", { delay: TYPING_DELAY_MS });
            const popup = page.locator(".cm-tooltip-autocomplete").getByText("status", { exact: true }).first();
            let completionMs: number | string;
            try {
              await popup.waitFor({ timeout: COMPLETION_TIMEOUT_MS });
              completionMs = Date.now() - typed;
            } catch {
              completionMs = "no popup";
            }
            await page.keyboard.press("Escape");
            await page.keyboard.type("tus = 1 AND ", { delay: TYPING_DELAY_MS });
            await page.keyboard.press("Escape");
            return { completionMs };
          },
          LONG_SETTLE_MS,
        );

        await step(
          "7-runEdited",
          async () => {
            await runButton(page).click();
            await waitResultState(page, /^500\+ rows$/);
            await waitUntilReady(page);
            return { state: await resultState(page).textContent() };
          },
          LONG_SETTLE_MS,
        );

        await step("8-queryHistory", async () => {
          await pressChord(page, "Alt+E");
          const history = page.getByRole("dialog", { name: "Query History: perf" });
          await history.getByRole("option").first().waitFor({ timeout: STEP_TIMEOUT_MS });
          return { entries: await history.getByRole("option").count() };
        });
        await screenshot("history");
        await page.keyboard.press("Escape");

        report["domAttrChars"] = await domAttributeChars(page);
        report["profileBytes"] = dirSize(launched.userDataDir);
        save();
      },
      SCENARIO_MS,
    );
  }
});
