/**
 * Plan 119's Redis live test: SQL-only snippets stay out of Redis while Redis-scoped
 * snippets can expand and run read-only commands against the seeded service.
 * Run with `TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/119 bun run test:smoke:db:headless:redis test/e2e/snippetsRedis.smoke.test.ts`.
 */
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { REDIS_CONFIG, WITHOUT_REDIS } from "../support/databases.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  findAction,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  pressChord,
  readProfileFile,
  runAllButton,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  sqlEditor,
  type Datasource,
  type RunningApp,
  waitUntilReady,
  chooseOption,
} from "./harness.js";

const captureWindow = evidenceFor("119");
const REDIS: Datasource = { id: "redis", pluginId: "redis", config: REDIS_CONFIG };
const ALL_TEXT_CONSOLES = "All text consoles";
const ALL_SQL_CONSOLES = "All SQL consoles";
const SQL_ONLY = {
  name: "SQL console only",
  prefix: "HGETALL",
  body: "SELECT 7 AS sql_only${cursor}",
};
const ALL_TEXT = {
  name: "Any console ping",
  prefix: "all_scope_probe",
  body: "PING${cursor}",
};
const REDIS_SNIPPET = {
  name: "Redis key read",
  prefix: "redis_probe",
  body: "MGET ${first} ${second} ${first}${cursor}",
};
const CARET_OFFSET = `(() => {
  const selection = document.getSelection();
  const line = document.querySelector('[data-testid="sql-editor"] .cm-line');
  if (!selection || !line || selection.anchorNode === null) return -1;
  const range = document.createRange();
  range.setStart(line, 0);
  range.setEnd(selection.anchorNode, selection.anchorOffset);
  return range.toString().length;
})()`;

async function editorText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="sql-editor"] .cm-line').allTextContents()).join("\n");
}

async function waitForChoice(page: Page, detailContains: string): Promise<void> {
  const readiness = `(() => {
    const popup = document.querySelector('.cm-tooltip-autocomplete');
    const selected = popup?.querySelector('[aria-selected]');
    if (!selected?.textContent?.includes(${JSON.stringify(detailContains)})) return false;
    const seen = (window.__snippetChoiceSeen ??= new WeakMap());
    if (!seen.has(selected)) seen.set(selected, performance.now());
    return performance.now() - seen.get(selected) >= 100;
  })()`;
  await expect.poll(() => page.evaluate<boolean>(readiness), { timeout: LAUNCH_TIMEOUT_MS }).toBe(true);
}

async function openSnippets(page: Page): Promise<void> {
  await findAction(page, "Snippets");
  await page.getByRole("dialog", { name: "Snippets" }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
}

function snippetDialog(page: Page) {
  return page.getByRole("dialog", { name: "Snippets" });
}

async function createSnippet(
  page: Page,
  snippet: typeof SQL_ONLY | typeof ALL_TEXT | typeof REDIS_SNIPPET,
  scope: string,
): Promise<void> {
  await snippetDialog(page).getByRole("button", { name: "New Snippet", exact: true }).click();
  await snippetDialog(page).locator("#snippet-name").fill(snippet.name);
  await snippetDialog(page).locator("#snippet-prefix").fill(snippet.prefix);
  await snippetDialog(page).locator("#snippet-body").fill(snippet.body);
  await chooseOption(snippetDialog(page).locator("#snippet-scope"), { label: scope });
  await snippetDialog(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(() => snippetDialog(page).getByRole("status").textContent())
    .toContain("Saved in this TableCraft profile.");
}

describe.runIf(DATABASES_ENABLED && !WITHOUT_REDIS)("Redis snippet scope live test", () => {
  let running: RunningApp | null = null;

  async function launch(profile: string): Promise<Page> {
    running = await launchApp(REDIS, { userDataDir: profile });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running.page;
  }

  async function stop(): Promise<void> {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }

  afterEach(stop, CLOSE_HOOK_TIMEOUT_MS);

  it(
    "givenSqlAllTextAndRedisScopes_whenUsedInRedisConsole_thenSqlScopeIsHiddenAndRedisSnippetRunsReadOnly",
    async () => {
      const profile = newProfile();
      const page = await launch(profile);
      await openSnippets(page);
      await createSnippet(page, SQL_ONLY, ALL_SQL_CONSOLES);
      await createSnippet(page, ALL_TEXT, ALL_TEXT_CONSOLES);
      await createSnippet(page, REDIS_SNIPPET, "Redis");
      await expect
        .poll(() => snippetDialog(page).getByTestId("snippet-preview").textContent())
        .toBe("MGET first second first");
      await captureWindow(page, "redis-snippets-manager");
      await snippetDialog(page).getByRole("button", { name: "Close", exact: true }).click();

      const popup = page.locator(".cm-tooltip-autocomplete");
      await sqlEditor(page).fill(ALL_TEXT.prefix);
      await expect
        .poll(() => popup.getByRole("option").filter({ hasText: ALL_TEXT.name }).count(), {
          timeout: LAUNCH_TIMEOUT_MS,
        })
        .toBe(1);
      await waitForChoice(page, ALL_TEXT.name);
      await page.keyboard.press("Tab");
      await expect.poll(() => editorText(page)).toBe("PING");
      await expect.poll(() => page.evaluate<number>(CARET_OFFSET)).toBe("PING".length);
      await pressChord(page, "Z");
      await expect.poll(() => editorText(page)).toBe(ALL_TEXT.prefix);

      await sqlEditor(page).fill("HGE");
      await page.keyboard.press("Control+Space");
      await expect
        .poll(() => popup.locator(".cm-completionLabel").allTextContents(), { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual(expect.arrayContaining(["HGETALL"]));
      await expect.poll(() => popup.getByRole("option").filter({ hasText: SQL_ONLY.name }).count()).toBe(0);
      await page.keyboard.press("Escape");

      await sqlEditor(page).fill(REDIS_SNIPPET.prefix);
      await expect
        .poll(() => popup.getByRole("option").filter({ hasText: REDIS_SNIPPET.name }).count(), {
          timeout: LAUNCH_TIMEOUT_MS,
        })
        .toBe(1);
      await waitForChoice(page, REDIS_SNIPPET.name);
      await page.keyboard.press("Enter");
      await expect.poll(() => editorText(page)).toBe("MGET first second first");
      await expect.poll(() => page.evaluate<string | undefined>("document.getSelection()?.toString()")).toBe("first");
      await pressChord(page, "Z");
      await expect.poll(() => editorText(page)).toBe(REDIS_SNIPPET.prefix);
      await sqlEditor(page).fill("redis_pro");
      await page.keyboard.type("be");
      await expect.poll(() => popup.getByRole("option").filter({ hasText: REDIS_SNIPPET.name }).count()).toBe(1);
      await waitForChoice(page, REDIS_SNIPPET.name);
      await page.keyboard.press("Enter");
      await expect.poll(() => editorText(page)).toBe("MGET first second first");
      await page.keyboard.type("type_probe:string");
      await page.keyboard.press("Tab");
      await page.keyboard.type("seed:probe");
      await expect.poll(() => editorText(page)).toBe("MGET type_probe:string seed:probe type_probe:string");
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.type("type_probe:string");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await expect.poll(() => editorText(page)).toBe("MGET type_probe:string seed:probe type_probe:string");
      await expect
        .poll(() => page.evaluate<number>(CARET_OFFSET))
        .toBe("MGET type_probe:string seed:probe type_probe:string".length);
      await expect.poll(() => page.evaluate<boolean | undefined>("document.getSelection()?.isCollapsed")).toBe(true);
      await captureWindow(page, "redis-snippet-keyboard-fields");

      await runAllButton(page).click();
      await expect
        .poll(() => page.locator('[role="gridcell"][data-col="1"]').allTextContents(), { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual(["hello", "1", "hello"]);
      await captureWindow(page, "redis-snippet-mget-executed");

      await stop();
      const persisted = JSON.parse(readProfileFile(profile, "snippets.json") ?? "null") as {
        version: number;
        snippets: { name: string; scope: unknown }[];
      };
      expect(persisted).toEqual({
        version: 2,
        snippets: [
          expect.objectContaining({ name: SQL_ONLY.name, scope: { kind: "sql" } }),
          expect.objectContaining({ name: ALL_TEXT.name, scope: { kind: "all" } }),
          expect.objectContaining({ name: REDIS_SNIPPET.name, scope: { kind: "plugin", pluginId: "redis" } }),
        ],
      });

      const reopened = await launch(profile);
      await openSnippets(reopened);
      await expect
        .poll(() =>
          snippetDialog(reopened)
            .getByRole("button", { name: /Redis key read.*redis_probe/ })
            .isVisible(),
        )
        .toBe(true);
      await captureWindow(reopened, "redis-snippets-restored");
    },
    SCENARIO_TIMEOUT_MS * 2,
  );
});
