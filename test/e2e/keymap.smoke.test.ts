/**
 * Plan 044's live test: Settings → Keymap, its search and Find by Shortcut, the recorder with its
 * clash, reserved and Escape handling, the labels and the native menu following an override, and
 * Reset All. On the in-memory SQLite console, so it needs no server:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/044 bun run test:smoke:headless test/e2e/keymap.smoke.test.ts
 *
 * The box is Linux, where Mod is Ctrl: the rebound chord is F9 rather than the plan's ⌃Enter, which
 * is Run's own chord there, and the reserved chord tried is Alt+F4 rather than ⌘Q.
 */
import type { ElectronApplication, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { formatChord, type Chord, type Platform } from "@table-craft/desktop/settings/chords.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  EVIDENCE_WINDOW,
  evidenceFor,
  evidenceTextFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  paletteInput,
  paletteRows,
  pressChord,
  readProfileFile,
  runButton,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  SMOKE_ENABLED,
  sqlEditor,
  waitUntilReady,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("044");
const writeEvidence = evidenceTextFor("044");

const PLATFORM: Platform = process.platform === "darwin" ? "mac" : "other";
const RUN = "console.run";
const REFORMAT = "console.reformat";
const NEW_CONSOLE = "console.new";
const REBOUND_RUN: Chord = "F9";
const REFORMAT_CHORD: Chord = "Mod+Alt+L";
const REBOUND_NEW_CONSOLE: Chord = "F8";
const RESERVED: Chord = PLATFORM === "mac" ? "Mod+Q" : "Alt+F4";
const RESERVED_OWNER = PLATFORM === "mac" ? "Quit TableCraft" : "Close Window";

function shown(chord: Chord): string {
  return formatChord(chord, PLATFORM);
}

/** Playwright's spelling of a chord: `Mod` is `ControlOrMeta`, as `pressChord` presses it. */
function playwrightKeys(chord: Chord): string {
  return chord.replace("Mod+", "ControlOrMeta+");
}

function settingsDialog(page: Page) {
  return page.getByRole("dialog", { name: "Settings" });
}

async function openKeymap(page: Page): Promise<void> {
  await pressChord(page, ",");
  await settingsDialog(page).waitFor();
  const tab = settingsDialog(page)
    .getByRole("tablist", { name: "Settings pages" })
    .getByRole("tab", { name: "Keymap", exact: true });
  await tab.click();
  await expect.poll(() => tab.getAttribute("aria-selected")).toBe("true");
}

async function closeSettings(page: Page): Promise<void> {
  await settingsDialog(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(() => settingsDialog(page).count()).toBe(0);
}

function keymapRow(page: Page, actionId: string) {
  return settingsDialog(page).locator(`[data-keymap-row="${actionId}"]`);
}

async function listedIds(page: Page): Promise<string[]> {
  const ids = await settingsDialog(page)
    .locator("[data-keymap-row]")
    .evaluateAll((rows: readonly { getAttribute(name: string): string | null }[]) =>
      rows.map((row) => row.getAttribute("data-keymap-row") ?? ""),
    );
  return ids;
}

async function rowChords(page: Page, actionId: string): Promise<string[]> {
  return keymapRow(page, actionId).locator("kbd").allTextContents();
}

async function startRecording(page: Page, actionId: string): Promise<void> {
  await keymapRow(page, actionId).getByRole("button", { name: "Add Shortcut", exact: true }).click();
  await expect.poll(() => keymapRow(page, actionId).locator("[data-chord-recorder]").count()).toBe(1);
}

/** The saved `keymap`, or undefined before the first save. */
function savedKeymap(userDataDir: string): Record<string, string[]> | undefined {
  const text = readProfileFile(userDataDir, "settings.json");
  return text === null ? undefined : (JSON.parse(text) as { keymap?: Record<string, string[]> }).keymap;
}

async function runsWith(page: Page, chord: Chord, column: string): Promise<void> {
  await sqlEditor(page).fill(`SELECT 1 AS ${column}`);
  await sqlEditor(page).click();
  await page.keyboard.press(playwrightKeys(chord));
  await page.getByRole("columnheader", { name: column, exact: true }).first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await waitUntilReady(page);
}

/** The accelerator of the first native menu item labelled `label`, searched through every submenu. */
async function menuAccelerator(app: ElectronApplication, label: string): Promise<string | null> {
  return app.evaluate(({ Menu }, wanted) => {
    type Item = { label: string; accelerator?: string | null; submenu?: { items: Item[] } | null };
    const walk = (items: readonly Item[]): Item | undefined => {
      for (const item of items) {
        if (item.label === wanted) return item;
        const found = item.submenu ? walk(item.submenu.items) : undefined;
        if (found !== undefined) return found;
      }
      return undefined;
    };
    const item = walk(Menu.getApplicationMenu()?.items ?? []);
    return item === undefined ? null : (item.accelerator ?? "");
  }, label);
}

describe.runIf(SMOKE_ENABLED)("custom keyboard shortcuts live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(): Promise<RunningApp> {
    running = await launchApp();
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running;
  }

  it(
    "givenKeymapPage_whenSearchedByNameAndByChord_thenMatchingActionsListed",
    async () => {
      const { page } = await launch();
      await openKeymap(page);

      await settingsDialog(page).getByRole("searchbox", { name: "Search actions" }).fill("format");
      await expect.poll(() => listedIds(page)).toContain(REFORMAT);
      expect(await rowChords(page, REFORMAT)).toEqual([shown(REFORMAT_CHORD)]);
      await captureWindow(page, "01-keymap-page");

      await settingsDialog(page).getByRole("button", { name: "Find by Shortcut", exact: true }).click();
      await settingsDialog(page).getByRole("searchbox", { name: "Find by shortcut" }).focus();
      await pressChord(page, "Enter");
      await expect
        .poll(() => listedIds(page))
        .toEqual(expect.arrayContaining([RUN, "table.submit", "table.applyValue"]));
      expect(await settingsDialog(page).getByRole("searchbox", { name: "Find by shortcut" }).inputValue()).toBe(
        shown("Mod+Enter"),
      );
      expect(await settingsDialog(page).count()).toBe(1);
      await captureWindow(page, "02-search-by-chord");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenRunRebound_whenRecordedClashedReservedAndReset_thenChordsLabelsAndMenuFollow",
    async () => {
      const { app, page, userDataDir } = await launch();
      await openKeymap(page);
      const search = settingsDialog(page).getByRole("searchbox", { name: "Search actions" });

      await search.fill("Run");
      await startRecording(page, RUN);
      await page.keyboard.press("Escape");
      await expect.poll(() => keymapRow(page, RUN).locator("[data-chord-recorder]").count()).toBe(0);
      expect(await settingsDialog(page).count()).toBe(1);

      await keymapRow(page, RUN)
        .getByRole("button", { name: `Remove ${shown("Mod+Enter")} from Run` })
        .click();
      await startRecording(page, RUN);
      await page.keyboard.press(REBOUND_RUN);
      await expect.poll(() => rowChords(page, RUN)).toEqual([shown(REBOUND_RUN)]);
      expect(await keymapRow(page, RUN).getByText("Modified", { exact: true }).count()).toBe(1);
      await expect.poll(() => savedKeymap(userDataDir)?.[RUN]).toEqual([REBOUND_RUN]);
      await closeSettings(page);
      await runsWith(page, REBOUND_RUN, "rebound");
      await captureWindow(page, "03-rebound-run");

      await openKeymap(page);
      await search.fill("Run");
      await startRecording(page, RUN);
      await page.keyboard.press(playwrightKeys(REFORMAT_CHORD));
      const clash = keymapRow(page, RUN).getByRole("alert");
      await expect.poll(() => clash.textContent()).toContain("Reformat Code (Console)");
      await captureWindow(page, "04-reassign");
      await clash.getByRole("button", { name: "Reassign", exact: true }).click();
      await expect.poll(() => rowChords(page, RUN)).toEqual([shown(REBOUND_RUN), shown(REFORMAT_CHORD)]);
      await expect.poll(() => savedKeymap(userDataDir)?.[REFORMAT]).toEqual([]);

      await startRecording(page, RUN);
      await page.keyboard.press(playwrightKeys(RESERVED));
      const refusal = keymapRow(page, RUN).getByRole("alert");
      await expect.poll(() => refusal.textContent()).toBe(`${shown(RESERVED)} belongs to ${RESERVED_OWNER}.`);
      expect(await settingsDialog(page).count()).toBe(1);
      await captureWindow(page, "05-reserved");
      await page.keyboard.press("Escape");

      await search.fill("New Console");
      await keymapRow(page, NEW_CONSOLE)
        .getByRole("button", { name: `Remove ${shown("Mod+Shift+L")} from New Console` })
        .click();
      await startRecording(page, NEW_CONSOLE);
      await page.keyboard.press(REBOUND_NEW_CONSOLE);
      await expect.poll(() => rowChords(page, NEW_CONSOLE)).toEqual([shown(REBOUND_NEW_CONSOLE)]);
      await expect.poll(() => menuAccelerator(app, "New Console")).toBe(REBOUND_NEW_CONSOLE);
      await closeSettings(page);

      await runButton(page).hover();
      await expect
        .poll(() => page.getByRole("tooltip").first().textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain(shown(REBOUND_RUN));
      await captureWindow(page, "06-labels-tooltip");
      await pressChord(page, "Shift+A");
      await paletteInput(page, "Find Action").fill("Run");
      await expect.poll(() => paletteRows(page).first().textContent()).toContain(shown(REBOUND_RUN));
      await captureWindow(page, "06-labels");
      await page.keyboard.press("Escape");

      await openKeymap(page);
      await settingsDialog(page).getByRole("button", { name: "Reset All", exact: true }).click();
      await expect.poll(() => savedKeymap(userDataDir)).toEqual({});
      await expect.poll(() => menuAccelerator(app, "New Console")).toBe("CmdOrCtrl+Shift+L");
      await search.fill("Run");
      expect(await rowChords(page, RUN)).toEqual([shown("Mod+Enter")]);
      await closeSettings(page);
      await runsWith(page, "Mod+Enter", "restored");
      await captureWindow(page, "07-reset-all");

      writeEvidence(
        "08-menu.txt",
        [
          `Platform: ${process.platform}`,
          `New Console rebound to ${REBOUND_NEW_CONSOLE}: the native menu item's accelerator became ${REBOUND_NEW_CONSOLE}.`,
          "After Reset All it was CmdOrCtrl+Shift+L again.",
        ].join("\n"),
      );
    },
    SCENARIO_TIMEOUT_MS * 2,
  );
});
