/** Helpers the Redis live tests share (plans 058 and 060). */
import type { Page } from "playwright-core";
import { expect } from "vitest";
import redis from "@table-craft/plugin-redis";
import {
  findAction,
  LAUNCH_TIMEOUT_MS,
  runAllButton,
  sqlEditor,
  toolWindow,
  treeNode,
  waitUntilReady,
} from "./harness.js";

export const BASIC_COMPLETION = "Control+Space";

/** Runs `commands` on `config` through the plugin, outside the app. */
export async function onRedis(config: object, commands: readonly string[]): Promise<void> {
  const session = await redis.connect(config, { readOnly: false });
  try {
    for (const command of commands) await session.execute(command);
  } finally {
    await session.close();
  }
}

/** The DOM element as far as `attributes` needs it; this program has no DOM lib. */
interface AttributeElement {
  getAttribute(name: string): string | null;
}

/** One attribute of every element `locator` matches, read in one snapshot. */
export async function attributes(locator: ReturnType<Page["locator"]>, name: string): Promise<string[]> {
  return locator.evaluateAll(
    (elements: readonly AttributeElement[], attribute: string) =>
      elements.map((element) => element.getAttribute(attribute) ?? ""),
    name,
  );
}

export function explorer(page: Page) {
  return toolWindow(page, "Database");
}

export function treeRows(page: Page, kind: string) {
  return explorer(page).locator(`[role="treeitem"][data-kind="${kind}"]`);
}

export function treeRow(page: Page, kind: string, label: string | RegExp) {
  return treeRows(page, kind).filter({ hasText: label });
}

/** Expands a collapsed tree row by selecting it and pressing →. */
export async function expand(page: Page, row: ReturnType<typeof treeRow>): Promise<void> {
  await row.first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  if ((await row.first().getAttribute("aria-expanded")) === "true") return;
  await row.first().click();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => row.first().getAttribute("aria-expanded")).toBe("true");
}

export function keyTab(page: Page) {
  return page.getByTestId("key-tab");
}

export function keyCell(page: Page, row: number, column: number) {
  return keyTab(page).locator(`[role="gridcell"][data-row="${String(row)}"][data-col="${String(column)}"]`);
}

export function keyButton(page: Page, name: string) {
  return keyTab(page).getByRole("button", { name, exact: true });
}

export function outputLog(page: Page) {
  return page.getByRole("log", { name: "Output" });
}

export function dialog(page: Page) {
  return page.getByRole("dialog");
}

/** Opens `key` in a key tab through Go to Key…. */
export async function openKey(page: Page, key: string): Promise<void> {
  await findAction(page, "Go to Key");
  const modal = dialog(page);
  await modal.getByLabel("Key name", { exact: true }).fill(key);
  await modal.getByLabel("Key name", { exact: true }).press("Enter");
  await expect.poll(() => keyTab(page).getByTestId("key-name").textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(key);
  await expect.poll(() => keyTab(page).getAttribute("data-key-type"), { timeout: LAUNCH_TIMEOUT_MS }).not.toBeNull();
}

export async function keyHeaders(page: Page): Promise<string[]> {
  await keyTab(page).getByRole("columnheader").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  return keyTab(page).getByRole("columnheader").allTextContents();
}

/** Writes `text` into a key tab cell through the inline editor. */
export async function editKeyCell(page: Page, row: number, column: number, text: string): Promise<void> {
  await keyCell(page, row, column).click();
  await page.keyboard.press("Enter");
  const field = keyTab(page).locator("[data-editing] input");
  await field.waitFor();
  await field.fill(text);
  await field.press("Enter");
  await expect.poll(() => field.count()).toBe(0);
}

/** Runs one console command and waits for its Output line to contain `expected`. */
export async function runCommand(page: Page, command: string, expected: string | RegExp): Promise<void> {
  await sqlEditor(page).fill(command);
  await runAllButton(page).click();
  await expect.poll(() => outputLog(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toMatch(expected);
  await waitUntilReady(page);
}

export async function showFromDatasourceMenu(page: Page, datasource: string, item: RegExp): Promise<void> {
  await treeNode(page, datasource).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: item }).click();
}

/** Waits for the key tree's current database and its first pass of keys. */
export async function scanned(page: Page, label: RegExp): Promise<void> {
  await treeRow(page, "keyDatabase", label).first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await treeRows(page, "keyFolder").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
}
