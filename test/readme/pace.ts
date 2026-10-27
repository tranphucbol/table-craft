/**
 * Paces a README scenario for a reader rather than a test: keys typed one at a time, a pause after
 * every visible change, a drawn pointer that travels to what is clicked and a badge naming every
 * chord pressed. The pointer and the badge are plain DOM the recording injects; the app has neither,
 * because the screencast shows no OS cursor and a chord leaves no trace on screen.
 */
import type { Locator, Page } from "playwright-core";
import { type Chord, formatChord, type Platform } from "@table-craft/desktop/renderer/actions/chords.js";

export const KEY_DELAY_MS = 55;
export const STEP_PAUSE_MS = 700;
export const END_PAUSE_MS = 1500;
export const BADGE_MS = 900;
export const POINTER_MOVE_MS = 400;

const DOUBLE_SHIFT: Chord = "Shift Shift";
const MOD = "Mod";
const PLAYWRIGHT_MOD = "ControlOrMeta";
const CTRL = "Ctrl";
const PLAYWRIGHT_CTRL = "Control";
const STROKE_SEPARATOR = "+";
const POINTER_ID = "readme-pointer";
const BADGE_ID = "readme-badge";
/** Where the pointer rests before its first move: the editor, roughly the window's centre. */
const POINTER_HOME = { x: 640, y: 300 } as const;

const RECORDING_PLATFORM: Platform = process.platform === "darwin" ? "mac" : "other";

/** The badge's text for `chord`: `⇧⌘E` on macOS, `Ctrl+Shift+E` elsewhere, as the app's menus print it. */
export function badgeText(chord: Chord, platform: Platform = RECORDING_PLATFORM): string {
  return formatChord(chord, platform);
}

/** A registry chord (`Mod+Shift+E`) in Playwright's spelling (`ControlOrMeta+Shift+E`). */
export function playwrightKeys(chord: Chord): string {
  return chord
    .split(STROKE_SEPARATOR)
    .map((part) => (part === MOD ? PLAYWRIGHT_MOD : part === CTRL ? PLAYWRIGHT_CTRL : part))
    .join(STROKE_SEPARATOR);
}

/**
 * The overlay, as a string because the root program has no DOM lib. A white arrow with a dark rim
 * reads on every theme; the badge takes the app's own tokens so it looks like part of the window.
 */
const OVERLAY_SCRIPT = `(() => {
  if (document.getElementById(${JSON.stringify(POINTER_ID)}) !== null) return;
  const pointer = document.createElement("div");
  pointer.id = ${JSON.stringify(POINTER_ID)};
  pointer.style.cssText = "position:fixed;left:0;top:0;width:20px;height:28px;z-index:2147483647;" +
    "pointer-events:none;transition:transform ${POINTER_MOVE_MS}ms cubic-bezier(0.4,0,0.2,1);" +
    "transform:translate(${POINTER_HOME.x}px,${POINTER_HOME.y}px);filter:drop-shadow(0 1px 2px rgba(0,0,0,0.5))";
  pointer.innerHTML = '<svg width="20" height="28" viewBox="0 0 20 28"><path d="M1 1 L1 22 L6 17 L10 26 L13.5 24.5 L9.5 16 L17 16 Z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  const badge = document.createElement("div");
  badge.id = ${JSON.stringify(BADGE_ID)};
  badge.style.cssText = "position:fixed;right:24px;bottom:44px;z-index:2147483647;pointer-events:none;" +
    "padding:8px 16px;border-radius:8px;border:1px solid var(--tc-border);background:var(--tc-raised);" +
    "color:var(--tc-ink);font:600 22px var(--tc-font-ui);letter-spacing:0.08em;" +
    "box-shadow:0 4px 16px rgba(0,0,0,0.35);opacity:0;transition:opacity 120ms";
  document.body.append(pointer, badge);
})()`;

async function ensureOverlay(page: Page): Promise<void> {
  await page.evaluate(OVERLAY_SCRIPT);
}

export async function pause(page: Page, ms: number = STEP_PAUSE_MS): Promise<void> {
  await page.waitForTimeout(ms);
}

/** Types into whatever has focus, one key at a time. */
export async function typeSlowly(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: KEY_DELAY_MS });
}

async function movePointer(page: Page, x: number, y: number): Promise<void> {
  await ensureOverlay(page);
  await page.evaluate(
    `document.getElementById(${JSON.stringify(POINTER_ID)}).style.transform = "translate(${x}px, ${y}px)"`,
  );
  await page.mouse.move(x, y);
  await page.waitForTimeout(POINTER_MOVE_MS);
}

/** Moves the pointer to the target's centre, then clicks it. */
export async function clickVisibly(
  page: Page,
  target: Locator,
  options: { readonly button?: "left" | "right"; readonly double?: boolean; readonly shift?: boolean } = {},
): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box === null) throw new Error("The target to click is not visible; wait for it before clickVisibly.");
  await movePointer(page, box.x + box.width / 2, box.y + box.height / 2);
  if (options.double === true) await target.dblclick();
  else await target.click({ button: options.button ?? "left", modifiers: options.shift === true ? ["Shift"] : [] });
}

/** Moves the pointer to a point, then clicks there: for a word inside an editor line. */
export async function clickAtVisibly(page: Page, x: number, y: number): Promise<void> {
  await movePointer(page, x, y);
  await page.mouse.click(x, y);
}

/** Moves the pointer onto the target without clicking, e.g. to point at a result. */
export async function pointAt(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (box === null) throw new Error("The target to point at is not visible.");
  await movePointer(page, box.x + box.width / 2, box.y + box.height / 2);
}

async function showBadge(page: Page, text: string): Promise<void> {
  await ensureOverlay(page);
  await page.evaluate(`(() => {
    const badge = document.getElementById(${JSON.stringify(BADGE_ID)});
    badge.textContent = ${JSON.stringify(text)};
    badge.style.opacity = "1";
    clearTimeout(badge.hideTimer);
    badge.hideTimer = setTimeout(() => { badge.style.opacity = "0"; }, ${BADGE_MS});
  })()`);
}

/** Shows `chord` in the badge, then presses it; `chord` is spelled as the action registry does. */
export async function pressVisibly(page: Page, chord: Chord): Promise<void> {
  await showBadge(page, badgeText(chord));
  if (chord === DOUBLE_SHIFT) {
    await page.keyboard.press("Shift");
    await page.keyboard.press("Shift");
    return;
  }
  await page.keyboard.press(playwrightKeys(chord));
}
