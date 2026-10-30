/**
 * Plan 119's live test: profile-owned snippets for all text consoles, SQL consoles, or one plugin.
 * Run with `TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/119 bun run test:smoke:headless test/e2e/snippets.smoke.test.ts`.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  EVIDENCE_WINDOW,
  evidenceFor,
  findAction,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  readProfileFile,
  runAllButton,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  sqlEditor,
  type Datasource,
  type RunningApp,
  waitUntilReady,
  chooseOption,
  optionValue,
} from "./harness.js";

const captureWindow = evidenceFor("119");
const ALL_TEXT_CONSOLES = "All text consoles";
const ALL_SQL_CONSOLES = "All SQL consoles";
const CUSTOMER_LOOKUP = {
  name: "Customer lookup",
  prefix: "customer_lookup",
  body: "SELECT name FROM customers WHERE id = ${id} OR id = ${id}${cursor}",
};

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

function dialog(page: Page) {
  return page.getByRole("dialog", { name: "Snippets" });
}

async function makeSnippet(page: Page, snippet: typeof CUSTOMER_LOOKUP, scope: string): Promise<void> {
  await dialog(page).getByRole("button", { name: "New Snippet", exact: true }).click();
  await dialog(page).locator("#snippet-name").fill(snippet.name);
  await dialog(page).locator("#snippet-prefix").fill(snippet.prefix);
  await dialog(page).locator("#snippet-body").fill(snippet.body);
  await chooseOption(dialog(page).locator("#snippet-scope"), { label: scope });
  await dialog(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(() => dialog(page).getByRole("status").textContent())
    .toContain("Saved in this TableCraft profile.");
}

describe.runIf(process.env["TABLE_CRAFT_SMOKE"] === "1")("snippets smoke", () => {
  let running: RunningApp | null = null;

  async function launch(userDataDir?: string, datasource?: Datasource): Promise<Page> {
    running = await launchApp(datasource, userDataDir === undefined ? {} : { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running.page;
  }

  async function close(): Promise<void> {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }

  afterEach(close, CLOSE_HOOK_TIMEOUT_MS);

  it(
    "givenProfile_whenSnippetsCreatedEditedSearchedAndDeleted_thenV2ScopesPersist",
    async () => {
      const profile = newProfile();
      const page = await launch(profile);
      await page.getByRole("button", { name: "Snippets…", exact: true }).click();
      await expect.poll(() => dialog(page).isVisible()).toBe(true);
      await dialog(page).getByRole("button", { name: "Close", exact: true }).click();
      await openSnippets(page);
      await makeSnippet(page, CUSTOMER_LOOKUP, ALL_SQL_CONSOLES);
      await dialog(page)
        .getByRole("button", { name: /Customer lookup.*customer_lookup/ })
        .waitFor();
      await expect
        .poll(() => dialog(page).getByTestId("snippet-preview").textContent())
        .toBe("SELECT name FROM customers WHERE id = id OR id = id");
      await captureWindow(page, "snippet-created");

      const search = dialog(page).getByRole("textbox", { name: "Search snippets" });
      await search.fill("not present");
      await expect.poll(() => dialog(page).getByText("No matching snippets.").isVisible()).toBe(true);
      await search.fill("customer_lookup");
      await dialog(page)
        .getByRole("button", { name: /Customer lookup.*customer_lookup/ })
        .click();
      await dialog(page).locator("#snippet-name").fill("Customer lookup edited");
      await dialog(page).locator("#snippet-prefix").fill("customer_by_id");
      await dialog(page).getByRole("button", { name: "Save", exact: true }).click();
      await expect
        .poll(() => dialog(page).getByRole("status").textContent())
        .toContain("Saved in this TableCraft profile.");
      await captureWindow(page, "snippet-edited");
      await close();

      const document = JSON.parse(readProfileFile(profile, "snippets.json") ?? "null") as {
        version: number;
        snippets: { id: string; name: string; prefix: string; body: string; scope: unknown }[];
      };
      expect(document).toEqual({
        version: 2,
        snippets: [
          expect.objectContaining({
            name: "Customer lookup edited",
            prefix: "customer_by_id",
            body: CUSTOMER_LOOKUP.body,
            scope: { kind: "sql" },
          }),
        ],
      });
      expect(document.snippets[0]?.id).toMatch(/^[A-Za-z0-9_-]+$/);

      const reopened = await launch(profile);
      await openSnippets(reopened);
      await expect
        .poll(() =>
          dialog(reopened)
            .getByRole("button", { name: /Customer lookup edited.*customer_by_id/ })
            .isVisible(),
        )
        .toBe(true);
      await dialog(reopened).getByRole("button", { name: "Delete…", exact: true }).click();
      const confirm = reopened.getByRole("dialog", { name: "Delete snippet" });
      await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect
        .poll(() =>
          dialog(reopened)
            .getByRole("button", { name: /Customer lookup edited.*customer_by_id/ })
            .isVisible(),
        )
        .toBe(true);
      await dialog(reopened).getByRole("button", { name: "Delete…", exact: true }).click();
      await reopened
        .getByRole("dialog", { name: "Delete snippet" })
        .getByRole("button", { name: "Delete", exact: true })
        .click();
      await expect.poll(() => dialog(reopened).getByText("No snippets yet.").isVisible()).toBe(true);
      expect(JSON.parse(readProfileFile(profile, "snippets.json") ?? "null")).toEqual({ version: 2, snippets: [] });
      await captureWindow(reopened, "snippet-deleted");
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it(
    "givenInvalidPrefix_whenSave_thenShowsValidationAndKeepsDraft",
    async () => {
      const page = await launch();
      await openSnippets(page);
      await dialog(page).getByRole("button", { name: "New Snippet", exact: true }).click();
      expect(await dialog(page).getByRole("button", { name: "Delete…", exact: true }).isDisabled()).toBe(true);
      expect(await dialog(page).getByTestId("snippet-preview").textContent()).toBe("(empty)");
      await dialog(page).locator("#snippet-name").fill("Invalid snippet");
      await dialog(page).locator("#snippet-prefix").fill("not valid");
      await dialog(page).locator("#snippet-body").fill("SELECT 1");
      await chooseOption(dialog(page).locator("#snippet-scope"), { label: ALL_SQL_CONSOLES });
      await dialog(page).getByRole("button", { name: "Save", exact: true }).click();
      await expect.poll(() => dialog(page).getByRole("alert").textContent()).toContain("Enter a prefix");
      await expect.poll(() => dialog(page).locator("#snippet-prefix").inputValue()).toBe("not valid");
      expect(await dialog(page).locator("#snippet-prefix").getAttribute("aria-invalid")).toBe("true");
      expect(await dialog(page).getByRole("button", { name: "Save", exact: true }).isDisabled()).toBe(true);
      await captureWindow(page, "snippet-validation");
      await dialog(page).getByRole("button", { name: "Dismiss", exact: true }).click();
      await expect.poll(() => dialog(page).getByRole("alert").count()).toBe(0);
      expect(await dialog(page).getByRole("button", { name: "Save", exact: true }).isDisabled()).toBe(true);
      await dialog(page).locator("#snippet-prefix").fill("valid_prefix");
      expect(await dialog(page).locator("#snippet-prefix").getAttribute("aria-invalid")).toBe("false");
      expect(await dialog(page).getByRole("button", { name: "Save", exact: true }).isEnabled()).toBe(true);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenConsoleSelection_whenImported_thenCompactFormPreservesCancelAndOffersOpenSavedSnippet",
    async () => {
      const profile = newProfile();
      const sqlite: Datasource = { id: "sqlite", pluginId: "sqlite", config: { path: seededSqliteFile() } };
      const page = await launch(profile, sqlite);
      const editor = sqlEditor(page);
      const line = page.locator('[data-testid="sql-editor"] .cm-line').first();
      await editor.fill("SELECT ${field}${cursor}");
      await editor.press("ArrowRight");
      await line.click({ button: "right", position: { x: 8, y: 8 } });
      let menu = page.getByRole("menu");
      await menu.waitFor();
      expect(
        await menu.getByRole("menuitem", { name: "Import into Snippet…" }).getAttribute("data-disabled"),
      ).not.toBeNull();
      await page.keyboard.press("Escape");
      await expect.poll(() => page.getByRole("menu").count()).toBe(0);

      await editor.press("ControlOrMeta+A");
      await line.click({ button: "right", position: { x: 8, y: 8 } });
      menu = page.getByRole("menu");
      for (const label of ["Cut", "Copy", "Paste"])
        expect(await menu.getByRole("menuitem", { name: new RegExp(label) }).isVisible()).toBe(true);
      await menu.getByRole("menuitem", { name: "Import into Snippet…" }).click();
      let importing = page.getByRole("dialog", { name: "Import into Snippet", exact: true });
      await importing.waitFor();
      expect(await importing.locator("#snippet-body").inputValue()).toBe("SELECT ${field}${cursor}");
      expect(await importing.getByTestId("snippet-preview").textContent()).toBe("SELECT field");
      expect(await importing.locator("#snippet-prefix").inputValue()).toMatch(/^[a-z_][a-z0-9_]*$/);
      expect(await optionValue(importing.locator("#snippet-scope"))).toBe("plugin:sqlite");
      await captureWindow(page, "snippet-selection-dialog");
      await importing.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect.poll(() => importing.count()).toBe(0);
      expect(await editorText(page)).toBe("SELECT ${field}${cursor}");
      expect(await page.evaluate<string | undefined>("document.getSelection()?.toString()")).toBe(
        "SELECT ${field}${cursor}",
      );

      await line.click({ button: "right", position: { x: 8, y: 8 } });
      await page.getByRole("menuitem", { name: "Import into Snippet…" }).click();
      importing = page.getByRole("dialog", { name: "Import into Snippet", exact: true });
      await importing.locator("#snippet-name").fill("Imported field");
      await importing.locator("#snippet-prefix").fill("imported_field");
      await importing.getByRole("button", { name: "Create Snippet", exact: true }).click();
      await expect.poll(() => importing.count()).toBe(0);
      const notice = page.getByRole("status").filter({ hasText: "Imported field" });
      await notice.waitFor();
      expect(await notice.textContent()).toContain("imported_field");
      await captureWindow(page, "snippet-selection-notice");
      await notice.getByRole("button", { name: "Open Snippets", exact: true }).click();
      await dialog(page).waitFor();
      expect(await dialog(page).locator("#snippet-name").inputValue()).toBe("Imported field");
      expect(
        await dialog(page)
          .getByRole("button", { name: /Imported field.*imported_field.*SQLite/ })
          .getAttribute("aria-current"),
      ).toBe("true");
      await captureWindow(page, "snippet-selection-imported");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSplitConsoles_whenImportingFromUnfocusedGroup_thenUsesItsSelectionAndKeepsNoticeInSourceConsole",
    async () => {
      const sqlite: Datasource = { id: "sqlite", pluginId: "sqlite", config: { path: seededSqliteFile() } };
      const page = await launch(newProfile(), sqlite);
      const leftText = "SELECT ${left_value}${cursor}";
      const rightText = "SELECT ${right_value}${cursor}";
      await sqlEditor(page).fill(leftText);
      await sqlEditor(page).press("ControlOrMeta+A");
      await findAction(page, "Duplicate");
      await findAction(page, "Split Right");
      const groups = page.getByTestId("editor-group");
      await expect.poll(() => groups.count()).toBe(2);
      const left = groups.first();
      const right = groups.last();
      const leftEditor = left.getByRole("textbox", { name: "SQL console", exact: true });
      const rightEditor = right.getByRole("textbox", { name: "SQL console", exact: true });
      await rightEditor.fill(rightText);
      await rightEditor.press("ControlOrMeta+A");
      expect(await right.getAttribute("data-focused")).toBe("true");
      await left
        .locator('[data-testid="sql-editor"] .cm-line')
        .first()
        .click({ button: "right", position: { x: 8, y: 8 } });
      await page.getByRole("menuitem", { name: "Import into Snippet…" }).click();
      const importing = page.getByRole("dialog", { name: "Import into Snippet", exact: true });
      await importing.waitFor();
      expect(await importing.locator("#snippet-body").inputValue()).toBe(leftText);
      expect(await optionValue(importing.locator("#snippet-scope"))).toBe("plugin:sqlite");
      await importing.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect.poll(() => importing.count()).toBe(0);
      expect(await left.getAttribute("data-focused")).toBe("true");
      await expect
        .poll(() =>
          page.evaluate<boolean>(
            "document.activeElement === document.querySelector('[data-group-id=left] .cm-content')",
          ),
        )
        .toBe(true);
      await expect.poll(() => page.evaluate<string | undefined>("document.getSelection()?.toString()")).toBe(leftText);
      expect(await rightEditor.innerText()).toBe(rightText);
      await rightEditor.focus();
      await expect.poll(() => page.evaluate<string | undefined>("document.getSelection()?.toString()")).toBe(rightText);
      await left
        .locator('[data-testid="sql-editor"] .cm-line')
        .first()
        .click({ button: "right", position: { x: 8, y: 8 } });
      await page.getByRole("menuitem", { name: "Import into Snippet…" }).click();
      await importing.locator("#snippet-name").fill("Left console snippet");
      await importing.locator("#snippet-prefix").fill("left_console");
      await importing.getByRole("button", { name: "Create Snippet", exact: true }).click();
      await expect.poll(() => importing.count()).toBe(0);
      const notice = left.getByRole("status").filter({ hasText: "Left console snippet" });
      await notice.waitFor();
      expect(await right.getByRole("button", { name: "Open Snippets", exact: true }).count()).toBe(0);
      expect(await leftEditor.innerText()).toBe(leftText);
      expect(await rightEditor.innerText()).toBe(rightText);
      await rightEditor.press("ControlOrMeta+z");
      await expect.poll(() => rightEditor.innerText()).toBe(leftText);
      await rightEditor.press("ControlOrMeta+Shift+z");
      await expect.poll(() => rightEditor.innerText()).toBe(rightText);
      await leftEditor.press("ControlOrMeta+z");
      await expect.poll(() => leftEditor.innerText()).toBe("");
      await leftEditor.press("ControlOrMeta+Shift+z");
      await expect.poll(() => leftEditor.innerText()).toBe(leftText);
      await captureWindow(page, "snippet-split-console-notice");
      await notice.getByRole("button", { name: "Open Snippets", exact: true }).click();
      await dialog(page).waitFor();
      expect(await dialog(page).locator("#snippet-body").inputValue()).toBe(leftText);
      expect(await dialog(page).locator("#snippet-name").inputValue()).toBe("Left console snippet");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenDirtyDraft_whenClose_thenUnsavedGuardCanCancelOrDiscard",
    async () => {
      const page = await launch();
      await openSnippets(page);
      await makeSnippet(page, CUSTOMER_LOOKUP, ALL_SQL_CONSOLES);
      await dialog(page).getByRole("button", { name: "New Snippet", exact: true }).click();
      await dialog(page).locator("#snippet-name").fill("Discard me");
      await dialog(page).locator("#snippet-prefix").fill("discard_me");
      await dialog(page).locator("#snippet-body").fill("SELECT 2");
      await chooseOption(dialog(page).locator("#snippet-scope"), { label: ALL_TEXT_CONSOLES });
      await dialog(page).getByRole("button", { name: "Close", exact: true }).click();
      let guard = page.getByRole("dialog", { name: "Unsaved snippet" });
      await guard.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect.poll(() => dialog(page).isVisible()).toBe(true);
      await dialog(page).getByRole("button", { name: "Close", exact: true }).click();
      guard = page.getByRole("dialog", { name: "Unsaved snippet" });
      await guard.getByRole("button", { name: "Discard Changes", exact: true }).click();
      await expect.poll(() => dialog(page).count()).toBe(0);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenV1SqlSnippet_whenOpenedThenSaved_thenMigratesWithoutRewritingBeforeMutation",
    async () => {
      const profile = newProfile();
      const legacy = {
        version: 1,
        snippets: [
          {
            id: "legacy_sqlite",
            name: "Legacy SQLite read",
            prefix: "legacy_read",
            body: "SELECT 1${cursor}",
            dialect: "sqlite",
          },
        ],
      };
      const original = JSON.stringify(legacy, null, 2);
      writeFileSync(join(profile, "snippets.json"), original);
      const page = await launch(profile);
      await openSnippets(page);
      await expect
        .poll(() =>
          dialog(page)
            .getByRole("button", { name: /Legacy SQLite read.*legacy_read/ })
            .isVisible(),
        )
        .toBe(true);
      expect(readProfileFile(profile, "snippets.json")).toBe(original);
      await dialog(page).locator("#snippet-name").fill("Migrated SQLite read");
      await dialog(page).getByRole("button", { name: "Save", exact: true }).click();
      await expect
        .poll(() => dialog(page).getByRole("status").textContent())
        .toContain("Saved in this TableCraft profile.");
      expect(JSON.parse(readProfileFile(profile, "snippets.json") ?? "null")).toEqual({
        version: 2,
        snippets: [
          {
            id: "legacy_sqlite",
            name: "Migrated SQLite read",
            prefix: "legacy_read",
            body: "SELECT 1${cursor}",
            scope: { kind: "sql", highlight: "sqlite" },
          },
        ],
      });
      await captureWindow(page, "snippet-v1-migrated");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenAllSqlSnippet_whenCompletedInSqlConsole_thenEnterInsertsAndSqlCompletionStillWorks",
    async () => {
      const profile = newProfile();
      const sqlite: Datasource = { id: "sqlite", pluginId: "sqlite", config: { path: seededSqliteFile() } };
      const page = await launch(profile, sqlite);
      await openSnippets(page);
      await makeSnippet(page, CUSTOMER_LOOKUP, ALL_SQL_CONSOLES);
      await dialog(page).getByRole("button", { name: "Close", exact: true }).click();

      await sqlEditor(page).fill(CUSTOMER_LOOKUP.prefix);
      const popup = page.locator(".cm-tooltip-autocomplete");
      await expect.poll(() => popup.getByRole("option").count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(1);
      await waitForChoice(page, CUSTOMER_LOOKUP.name);
      await page.keyboard.press("Enter");
      await expect.poll(() => editorText(page)).toBe("SELECT name FROM customers WHERE id = id OR id = id");
      await page.keyboard.type("1");
      await expect.poll(() => editorText(page)).toBe("SELECT name FROM customers WHERE id = 1 OR id = 1");
      await runAllButton(page).click();
      await expect.poll(() => page.getByRole("columnheader", { name: "name" }).isVisible()).toBe(true);
      await expect.poll(() => page.getByRole("gridcell").first().textContent()).toBe("Ada Lovelace");
      await captureWindow(page, "sql-scope-completion-execution");

      await sqlEditor(page).fill("SELECT * FROM cust");
      await page.keyboard.press("Control+Space");
      await expect
        .poll(() => popup.locator(".cm-completionLabel").allTextContents(), { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual(expect.arrayContaining(["customers"]));
      await captureWindow(page, "sql-completion-coexists");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenCorruptSnippetProfile_whenReloadSucceeds_thenLoadErrorCanBeRecoveredWithoutOverwritingFile",
    async () => {
      const profile = newProfile();
      const broken = "{ invalid json";
      writeFileSync(join(profile, "snippets.json"), broken);
      const page = await launch(profile);
      await openSnippets(page);
      await expect.poll(() => dialog(page).getByRole("alert").isVisible()).toBe(true);
      expect(readProfileFile(profile, "snippets.json")).toBe(broken);
      writeFileSync(join(profile, "snippets.json"), JSON.stringify({ version: 2, snippets: [] }));
      await dialog(page).getByRole("button", { name: "Retry Load", exact: true }).click();
      await expect.poll(() => dialog(page).getByText("No snippets yet.").isVisible()).toBe(true);
      await expect.poll(() => dialog(page).getByRole("alert").count()).toBe(0);
      await captureWindow(page, "snippet-load-recovered");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
