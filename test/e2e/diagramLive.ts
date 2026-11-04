/**
 * Plan 152's live-test helpers, shared by `diagram.smoke.test.ts` (SQLite) and
 * `diagramServers.smoke.test.ts` (Postgres, MySQL and Redis): finding the diagram's tables and edges,
 * editing it, switching the theme and exporting it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "playwright-core";
import { expect } from "vitest";
import {
  activeEditorTab,
  chooseOption,
  chooseTheme,
  evidenceFor,
  evidenceTextFor,
  newProfile,
  pressChord,
  themePickerTrigger,
  toolWindow,
} from "./harness.js";

export const captureWindow = evidenceFor("152");
export const writeEvidence = evidenceTextFor("152");

export const ERD_TABLES_GROUP = "tables 8";
/** What the rule infers on the `erd` seed: every `<table>_id` and `parent_id`, not `notes.person_id`. */
export const INFERRED_EDGES = 7;

export function treeRow(page: Page, name: string) {
  return toolWindow(page, "Database").getByRole("treeitem", { name, exact: true });
}

export function diagramEdges(page: Page, origin: string) {
  return page.locator(`[data-testid="diagram-edge"][data-edge-origin="${origin}"]`);
}

export function diagramEdge(page: Page, keyId: string) {
  return page.locator(`[data-testid="diagram-edge"][data-edge-id$=${JSON.stringify(`:${keyId}`)}]`);
}

/** The few SVG members `rightClickEdge` reads; the e2e program is compiled without the DOM lib. */
interface PathElement {
  getTotalLength(): number;
  getPointAtLength(length: number): { readonly x: number; readonly y: number };
  getScreenCTM(): {
    readonly a: number;
    readonly b: number;
    readonly c: number;
    readonly d: number;
    readonly e: number;
    readonly f: number;
  } | null;
}

/**
 * Opens an edge's context menu at the middle of its path: a click at its bounding box's centre can
 * miss a step path or land on a table drawn over it.
 */
export async function rightClickEdge(page: Page, keyId: string): Promise<void> {
  const hit = diagramEdge(page, keyId).locator(".tc-diagram-edge-hit");
  const point = await hit.evaluate((element) => {
    const path = element as unknown as PathElement;
    const middle = path.getPointAtLength(path.getTotalLength() / 2);
    const matrix = path.getScreenCTM();
    if (matrix === null) return middle;
    return {
      x: matrix.a * middle.x + matrix.c * middle.y + matrix.e,
      y: matrix.b * middle.x + matrix.d * middle.y + matrix.f,
    };
  });
  await hit.dispatchEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: point.x,
    clientY: point.y,
  });
}

export function tableNode(page: Page, table: string) {
  return page.locator(`.react-flow__node[data-id=${JSON.stringify(table)}]`);
}

/** Opens the diagram from the Tables group's Diagrams submenu. */
export async function showDiagram(page: Page, row = ERD_TABLES_GROUP): Promise<void> {
  await treeRow(page, row).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Diagrams" }).click();
  await page.getByRole("menuitem", { name: /^Show Diagram/ }).click();
  await expect.poll(() => activeEditorTab(page).locator('[data-tab-kind="diagram"]').count()).toBe(1);
}

export function toolbarButton(page: Page, name: string) {
  return page.getByTestId("diagram-toolbar").getByRole("button", { name, exact: true });
}

export async function addRelationship(
  page: Page,
  [from, column]: readonly [string, string],
  [to, target]: readonly [string, string],
): Promise<void> {
  await toolbarButton(page, "Add Relationship…").click();
  const dialog = page.getByTestId("relationship-dialog");
  await chooseOption(dialog.getByTestId("relationship-from"), from);
  await chooseOption(dialog.getByTestId("relationship-to"), to);
  await chooseOption(dialog.getByTestId("relationship-column-1"), column);
  await expect.poll(() => dialog.getByTestId("relationship-target-1").getAttribute("data-value")).toBe(target);
  await dialog.getByRole("button", { name: "Add Relationship", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
}

export async function dragTable(
  page: Page,
  table: string,
  by: { readonly x: number; readonly y: number },
): Promise<void> {
  const box = await tableNode(page, table).locator(".tc-diagram-header").boundingBox();
  if (box === null) throw new Error(`The ${table} table is not drawn.`);
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + by.x / 2, start.y + by.y / 2, { steps: 5 });
  await page.mouse.move(start.x + by.x, start.y + by.y, { steps: 5 });
  await page.mouse.up();
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const EXPORT_WAIT_MS = 10_000;

export async function setTheme(page: Page, name: string): Promise<void> {
  await pressChord(page, ",");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.waitFor();
  await settings.getByRole("tab", { name: "Appearance", exact: true }).click();
  await themePickerTrigger(page).waitFor();
  await chooseTheme(page, name);
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(() => settings.count()).toBe(0);
}

/** The few DOM members `rootVariable` reads; the e2e program is compiled without the DOM lib. */
interface Root {
  readonly ownerDocument: {
    readonly defaultView: {
      getComputedStyle(element: Root): { getPropertyValue(name: string): string };
    };
  };
}

export function rootVariable(page: Page, name: string): Promise<string> {
  return page
    .locator("html")
    .evaluate(
      (element: Root, variable) =>
        element.ownerDocument.defaultView.getComputedStyle(element).getPropertyValue(variable).trim(),
      name,
    );
}

const PNG_END = Buffer.from("IEND");
const SVG_END = "</svg>";

/** Whether the export at `path` is written through to its last chunk, not only created. */
function complete(path: string): boolean {
  if (!existsSync(path)) return false;
  const bytes = readFileSync(path);
  return path.endsWith(".png")
    ? bytes.subarray(-PNG_END.length - 4, -4).equals(PNG_END)
    : bytes.toString("utf8").trimEnd().endsWith(SVG_END);
}

/** A variable as the diagram's surface resolves it: the editor island remaps some of them. */
export function diagramVariable(page: Page, name: string): Promise<string> {
  return page
    .getByTestId("diagram-canvas")
    .evaluate(
      (element: Root, variable) =>
        element.ownerDocument.defaultView.getComputedStyle(element).getPropertyValue(variable).trim(),
      name,
    );
}

/** The fill of the first table's body in an exported SVG: the rect just inside its clip. */
function tableFill(svg: string): string | undefined {
  return /<g data-table="[^"]*">.*?<g clip-path="[^"]*"><rect [^>]*fill="([^"]+)"/.exec(svg)?.[1];
}

/** Exports the open diagram through the stubbed save dialog and checks what landed on disk. */
async function exportTo(app: ElectronApplication, page: Page, path: string, button: string): Promise<Buffer> {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: picked });
  }, path);
  await toolbarButton(page, button).click();
  await expect.poll(() => complete(path), { timeout: EXPORT_WAIT_MS }).toBe(true);
  return readFileSync(path);
}

/**
 * Exports SVG and PNG in the theme on screen: the SVG's background is that theme's canvas, the PNG is
 * a PNG, and both are kept beside a capture of the window for comparison.
 */
export async function exportBoth(app: ElectronApplication, page: Page, name: string): Promise<void> {
  const directory = newProfile();
  const canvas = await rootVariable(page, "--tc-canvas");
  const svg = (await exportTo(app, page, join(directory, `${name}.svg`), "Export Diagram as SVG…")).toString("utf8");
  expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  expect(svg).toContain(`fill="${canvas}"`);
  expect(tableFill(svg)).toBe(await diagramVariable(page, "--tc-panel"));
  expect(svg.match(/data-table=/g)?.length).toBe(await page.getByTestId("diagram-table").count());
  const png = await exportTo(app, page, join(directory, `${name}.png`), "Export Diagram as PNG…");
  expect([...png.subarray(0, PNG_SIGNATURE.length)]).toEqual(PNG_SIGNATURE);
  await captureWindow(page, `${name}-screen`);
  writeEvidence(`${name}-export.png`, png);
  writeEvidence(`${name}-export.svg`, svg);
}

/** Opens Settings on `page`'s tab, runs `change` in it and closes it again. */
export async function inSettings(page: Page, tab: string, change: (settings: Locator) => Promise<void>): Promise<void> {
  await pressChord(page, ",");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.waitFor();
  await settings.getByRole("tab", { name: tab, exact: true }).click();
  await change(settings);
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(() => settings.count()).toBe(0);
}

/**
 * How far, in screen pixels, the furthest end of any edge sits from the middle of the column row it
 * joins: each edge id names its key, `from(columns)->to(columns)`, and its line starts at the first
 * source column and ends at the first target one. Evaluated as text, because the e2e program is
 * compiled without the DOM lib.
 */
const EDGE_END_OFFSET = `(() => {
  const screen = (path, point) => {
    const matrix = path.getScreenCTM();
    return matrix === null ? point : point.matrixTransform(matrix);
  };
  const rowMiddle = (table, column) => {
    const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(table) + ']');
    const row = node?.querySelector('[data-column=' + JSON.stringify(column) + ']');
    if (row === null || row === undefined) return null;
    const box = row.getBoundingClientRect();
    return box.top + box.height / 2;
  };
  let worst = 0;
  let measured = 0;
  for (const edge of document.querySelectorAll('[data-testid="diagram-edge"]')) {
    const match = /:([^:(]+)\\(([^,)]+)[^)]*\\)->([^(]+)\\(([^,)]+)/.exec(edge.getAttribute("data-edge-id") ?? "");
    const line = edge.querySelector(".tc-diagram-edge-line");
    if (match === null || line === null) continue;
    const start = screen(line, line.getPointAtLength(0));
    const end = screen(line, line.getPointAtLength(line.getTotalLength()));
    const from = rowMiddle(match[1], match[2]);
    const to = rowMiddle(match[3], match[4]);
    if (from === null || to === null) continue;
    measured += 1;
    worst = Math.max(worst, Math.abs(start.y - from), Math.abs(end.y - to));
  }
  return { measured, worst };
})()`;

export function edgeEndOffset(page: Page): Promise<{ readonly measured: number; readonly worst: number }> {
  return page.evaluate<{ measured: number; worst: number }>(EDGE_END_OFFSET);
}

/**
 * Starts counting animation frames on the page, to tell whether the main thread kept drawing while
 * something ran: `frameGaps` reads the longest gap between two frames since.
 */
export async function watchFrames(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const watch = { last: performance.now(), longest: 0, frames: 0 };
    window.__diagramFrames = watch;
    const tick = (now) => {
      watch.longest = Math.max(watch.longest, now - watch.last);
      watch.last = now;
      watch.frames += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);
}

export async function frameGaps(page: Page): Promise<{ readonly longest: number; readonly frames: number }> {
  return page.evaluate<{ longest: number; frames: number }>(`(() => {
    const watch = window.__diagramFrames;
    const result = { longest: Math.round(watch.longest), frames: watch.frames };
    watch.longest = 0;
    watch.frames = 0;
    return result;
  })()`);
}
